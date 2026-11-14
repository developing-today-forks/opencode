import { describe, expect, test } from "bun:test"
import { ModelPlan } from "@opencode/core/model-plan"
import { SessionRunnerRenderCard as RenderCard } from "@opencode/core/session/runner/render-card"

/**
 * A fake render tool: stands in for the host-provided
 * `openchamber_render` (slice 1) with a canned answer, in exactly
 * the result shape the OpenChamber plugin returns — so the trigger
 * and the answer application are covered with no live host
 * (opencode#2384 acceptance 4).
 */
const fakeRenderTool = (answer: unknown) => ({
  name: RenderCard.RENDER_TOOL_NAME,
  call: (input: { action: string; title: string; html: string; awaitAnswer: boolean }) => {
    expect(input.action).toBe("render.page")
    expect(input.awaitAnswer).toBe(true)
    expect(input.html).toContain("openchamber.submit")
    return JSON.stringify({ ok: true, action: input.action, data: { answer } })
  },
})

const tiers: RenderCard.TierOption[] = [
  { tier: "cheap", model: "deepseek/deepseek-chat", inputPerM: 0.27, outputPerM: 1.1 },
  { tier: "standard", model: "anthropic/claude-sonnet-5" },
  { tier: "frontier", model: "anthropic/claude-opus-4-8" },
]

const wall: RenderCard.QuotaWall = {
  providerID: "anthropic",
  modelID: "claude-sonnet-5",
  resetAt: Date.UTC(2026, 10, 15, 0, 0, 0),
  message: "Quota exhausted for anthropic.",
}

const actions: RenderCard.FallbackAction[] = [
  { kind: "switch-provider", provider: "openai", tier: "standard" },
  { kind: "downgrade-tier", provider: "anthropic", tier: "cheap" },
  { kind: "wait-for-reset", provider: "anthropic", tier: "standard" },
]

describe("tool detection", () => {
  test("recognizes the host render tool and nothing else", () => {
    expect(RenderCard.hasRenderTool(["bash", RenderCard.RENDER_TOOL_NAME])).toBe(true)
    expect(RenderCard.hasRenderTool(["bash", "openchamber_memory"])).toBe(false)
    expect(RenderCard.hasRenderTool([])).toBe(false)
  })
})

describe("cards", () => {
  test("tier chooser card submits { tier, model } per tile", () => {
    const html = RenderCard.tierChooserCard({ tiers })
    expect(html).toContain("Select Execution Tier")
    expect(html).toContain('data-payload="{&quot;tier&quot;:&quot;cheap&quot;,&quot;model&quot;:&quot;deepseek/deepseek-chat&quot;}"')
    expect(html).toContain("Selected Cheap Tier (deepseek/deepseek-chat)")
    expect(html).toContain("$0.27 in / $1.1 out per 1M")
  })

  test("tier chooser card escapes interpolated values", () => {
    const html = RenderCard.tierChooserCard({ tiers: [{ tier: "cheap", model: 'x"><script>alert(1)</script>' }] })
    expect(html).not.toContain('"><script>alert(1)</script>')
  })

  test("quota fallback card requires all three kinds and submits { action, provider, tier }", () => {
    const html = RenderCard.quotaFallbackCard({ message: wall.message, currentProvider: "anthropic", actions })
    expect(html).toContain("Quota Limit Reached")
    expect(html).toContain('data-payload="{&quot;action&quot;:&quot;fallback&quot;,&quot;provider&quot;:&quot;openai&quot;,&quot;tier&quot;:&quot;standard&quot;}"')
    expect(() => RenderCard.quotaFallbackCard({ actions: actions.slice(0, 2) })).toThrow("needs a wait-for-reset action")
  })
})

describe("triggers", () => {
  test("chooser fires only for a bare route, once, with the tool present", () => {
    expect(RenderCard.tierChooserTrigger({ hasRenderTool: true, routeBare: true, alreadyAsked: false })).toBe(true)
    expect(RenderCard.tierChooserTrigger({ hasRenderTool: false, routeBare: true, alreadyAsked: false })).toBe(false)
    expect(RenderCard.tierChooserTrigger({ hasRenderTool: true, routeBare: false, alreadyAsked: false })).toBe(false)
    expect(RenderCard.tierChooserTrigger({ hasRenderTool: true, routeBare: true, alreadyAsked: true })).toBe(false)
  })

  test("quota fallback fires only on an exhausted wall with no failover served", () => {
    expect(RenderCard.quotaFallbackTrigger({ hasRenderTool: true, quotaExhausted: true, failoverServed: false })).toBe(true)
    expect(RenderCard.quotaFallbackTrigger({ hasRenderTool: true, quotaExhausted: true, failoverServed: true })).toBe(false)
    expect(RenderCard.quotaFallbackTrigger({ hasRenderTool: false, quotaExhausted: true, failoverServed: false })).toBe(false)
  })

  test("directives name the tool, carry the card, and state the application", () => {
    const chooser = RenderCard.tierChooserDirective(tiers)
    expect(chooser).toContain(RenderCard.RENDER_TOOL_NAME)
    expect(chooser).toContain("awaitAnswer: true")
    expect(chooser).toContain("Select Execution Tier")
    const fallback = RenderCard.quotaFallbackDirective(wall, actions)
    expect(fallback).toContain("Quota Limit Reached")
    expect(fallback).toContain("2026-11-15T00:00:00.000Z")
  })
})

describe("answer application with a fake render tool", () => {
  test("chooser answer is applied through the model plan", () => {
    const tool = fakeRenderTool({ tier: "frontier", model: "anthropic/claude-opus-4-8" })
    const result = tool.call(RenderCard.renderCall({ title: "Select Execution Tier", html: RenderCard.tierChooserCard({ tiers }) }))
    const answer = RenderCard.parseRenderAnswer(result)
    expect(answer.type).toBe("tier-choice")
    if (answer.type !== "tier-choice") throw new Error("unreachable")
    const applied = RenderCard.applyTierChoice(ModelPlan.emptyStore(), answer.choice, "2026-11-14T00:00:00Z")
    expect(applied.store.models["anthropic/claude-opus-4-8"]?.tier).toBe("frontier")
    expect(applied.note.source).toBe("user")
    expect(applied.note.text).toContain("claude-opus-4-8")
  })

  test("quota fallback switch answer becomes a switch instruction", () => {
    const tool = fakeRenderTool({ action: "fallback", provider: "openai", tier: "standard" })
    const result = tool.call(RenderCard.renderCall({ title: "Quota Limit Reached", html: RenderCard.quotaFallbackCard({ actions }) }))
    const answer = RenderCard.parseRenderAnswer(result, { currentProvider: "anthropic", currentTier: "standard" })
    expect(answer.type).toBe("quota-fallback")
    if (answer.type !== "quota-fallback") throw new Error("unreachable")
    const applied = RenderCard.applyQuotaFallback(answer.choice, wall)
    expect(applied.instruction).toEqual({ kind: "switch", providerID: "openai", tier: "standard" })
  })

  test("quota fallback answer naming the walled provider/tier is a wait", () => {
    const answer = RenderCard.parseRenderAnswer(
      JSON.stringify({ ok: true, action: "render.page", data: { answer: { action: "fallback", provider: "anthropic", tier: "standard" } } }),
      { currentProvider: "anthropic", currentTier: "standard" },
    )
    expect(answer.type).toBe("quota-fallback")
    if (answer.type !== "quota-fallback") throw new Error("unreachable")
    expect(answer.choice.kind).toBe("wait")
    expect(RenderCard.applyQuotaFallback(answer.choice, wall).instruction).toEqual({
      kind: "wait",
      until: wall.resetAt,
    })
  })

  test("typing in chat aborts the wait and surfaces the protocol note", () => {
    const tool = fakeRenderTool({ answered: false, reason: "chat" })
    const result = tool.call(RenderCard.renderCall({ title: "t", html: RenderCard.tierChooserCard({ tiers }) }))
    // The host adds the note beside the answer; the fake returns the
    // bare answer, so the parser supplies the protocol note itself.
    const answer = RenderCard.parseRenderAnswer(result)
    expect(answer.type).toBe("chat")
    if (answer.type !== "chat") throw new Error("unreachable")
    expect(answer.note).toBe(RenderCard.RENDER_PAGE_CLOSED_IN_CHAT_NOTE)
  })

  test("failed calls and malformed answers parse to none, never a guess", () => {
    expect(RenderCard.parseRenderAnswer(JSON.stringify({ ok: false, error: "nope" })).type).toBe("none")
    expect(RenderCard.parseRenderAnswer(JSON.stringify({ ok: true, data: { answer: { tier: "huge", model: "x" } } })).type).toBe("none")
    expect(RenderCard.parseRenderAnswer("not json").type).toBe("none")
    expect(RenderCard.parseRenderAnswer(undefined).type).toBe("none")
  })
})
