import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AIError, LanguageModel, LLM, LLMEvent, QuotaExceededError } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { ModelPlan } from "@opencode/core/model-plan"
import { ModelRoute } from "@opencode/core/model-route"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionRunnerRenderCard as RenderCard } from "@opencode/core/session/runner/render-card"
import { SessionRunnerRenderWiring as Wiring } from "@opencode/core/session/runner/render-wiring"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { ToolOutput } from "@opencode/core/tool-output"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit, Layer } from "effect"
import { testEffect } from "./lib/effect"

/**
 * Live wiring for the render-card seam (opencode#2384 slices 2–3):
 * the runner-level decisions and plan-store application that consume
 * the seam module, driven here with a fake render tool — the result
 * shape the OpenChamber host returns — so no live host is needed.
 */

const tempDirs: Array<string> = []
const tempDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-wiring-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const seedStore = (dataDir: string) => {
  const now = "2026-11-14T00:00:00Z"
  let store = ModelPlan.emptyStore()
  store = ModelPlan.setModel(store, "deepseek/deepseek-chat", { tier: "cheap" }, now)
  store = ModelPlan.setModel(store, "anthropic/claude-sonnet-5", { tier: "standard" }, now)
  store = ModelPlan.setModel(store, "anthropic/claude-opus-4-8", { tier: "frontier" }, now)
  store = ModelPlan.setModel(store, "openai/gpt-5.1", { tier: "standard" }, now)
  ModelPlan.writeStore(store, dataDir)
  return store
}

const hostResult = (answer: unknown) => JSON.stringify({ ok: true, action: "render.page", data: { answer } })

describe("card inputs from the plan store", () => {
  test("tiers come one per tier, in tier order", () => {
    const store = seedStore(tempDataDir())
    expect(Wiring.tiersFromStore(store)).toEqual([
      { tier: "cheap", model: "deepseek/deepseek-chat" },
      { tier: "standard", model: "anthropic/claude-sonnet-5" },
      { tier: "frontier", model: "anthropic/claude-opus-4-8" },
    ])
    expect(Wiring.tiersFromStore(ModelPlan.emptyStore())).toEqual([])
  })

  test("fallback actions derive switch, downgrade, and wait from the store", () => {
    const store = seedStore(tempDataDir())
    const wall: RenderCard.QuotaWall = { providerID: "anthropic", modelID: "claude-sonnet-5" }
    expect(Wiring.fallbackActionsFor(store, wall)).toEqual([
      { kind: "switch-provider", provider: "deepseek", tier: "standard" },
      { kind: "downgrade-tier", provider: "anthropic", tier: "cheap" },
      { kind: "wait-for-reset", provider: "anthropic", tier: "standard" },
    ])
  })

  test("fallback actions are undefined when a kind cannot be derived", () => {
    const now = "2026-11-14T00:00:00Z"
    let store = ModelPlan.emptyStore()
    store = ModelPlan.setModel(store, "deepseek/deepseek-chat", { tier: "cheap" }, now)
    // The walled model is already cheap: no downgrade exists, so no card.
    expect(
      Wiring.fallbackActionsFor(store, { providerID: "deepseek", modelID: "deepseek-chat" }),
    ).toBeUndefined()
    // No second provider anywhere: no switch exists, so no card.
    store = ModelPlan.setModel(store, "anthropic/claude-sonnet-5", { tier: "standard" }, now)
    const only = ModelPlan.setModel(ModelPlan.emptyStore(), "anthropic/claude-sonnet-5", { tier: "standard" }, now)
    expect(
      Wiring.fallbackActionsFor(only, { providerID: "anthropic", modelID: "claude-sonnet-5" }),
    ).toBeUndefined()
  })
})

describe("wall directive latch (#2468)", () => {
  test("a wall whose actions cannot be derived does not stay latched; a later wall can offer again", () => {
    // The thin-store setup the fallback card exists to rescue: the
    // plan store cannot supply the card's actions yet.
    const dataDir = tempDataDir()
    const sessionID = "ses_render_wiring_wall_latch"
    Wiring.clearSession(sessionID)
    const wall: RenderCard.QuotaWall = { providerID: "anthropic", modelID: "claude-sonnet-5" }
    Wiring.offerWall(sessionID, wall)
    expect(Wiring.wallDirective(sessionID, wall, dataDir)).toBeUndefined()
    // No card was built, so no wall stays offered: the next wall in
    // this session is not suppressed by a latch nothing can settle.
    expect(Wiring.offeredWall(sessionID)).toBeUndefined()
    // Once the store gains the inputs, a second wall offers again and
    // its directive is built; that wall stays latched for its answer.
    seedStore(dataDir)
    Wiring.offerWall(sessionID, wall)
    expect(Wiring.wallDirective(sessionID, wall, dataDir)).toBeDefined()
    expect(Wiring.offeredWall(sessionID)).toBeDefined()
    Wiring.clearSession(sessionID)
  })
})

describe("chooser directive", () => {
  test("fires once for a bare route with the render tool, then latches", () => {
    const dataDir = tempDataDir()
    seedStore(dataDir)
    const sessionID = "ses_render_wiring_chooser"
    Wiring.clearSession(sessionID)
    const first = Wiring.chooserDirective({
      sessionID,
      toolNames: ["bash", RenderCard.RENDER_TOOL_NAME],
      routeBare: true,
      dataDir,
    })
    expect(first).toContain(RenderCard.RENDER_TOOL_NAME)
    expect(first).toContain("Select Execution Tier")
    expect(
      Wiring.chooserDirective({ sessionID, toolNames: [RenderCard.RENDER_TOOL_NAME], routeBare: true, dataDir }),
    ).toBeUndefined()
    Wiring.clearSession(sessionID)
  })

  test("does not fire without the tool, without a bare route, or without tiered models", () => {
    const dataDir = tempDataDir()
    seedStore(dataDir)
    const sessionID = "ses_render_wiring_chooser_gates"
    Wiring.clearSession(sessionID)
    expect(
      Wiring.chooserDirective({ sessionID, toolNames: ["bash"], routeBare: true, dataDir }),
    ).toBeUndefined()
    expect(
      Wiring.chooserDirective({ sessionID, toolNames: [RenderCard.RENDER_TOOL_NAME], routeBare: false, dataDir }),
    ).toBeUndefined()
    expect(
      Wiring.chooserDirective({
        sessionID,
        toolNames: [RenderCard.RENDER_TOOL_NAME],
        routeBare: true,
        dataDir: tempDataDir(),
      }),
    ).toBeUndefined()
    Wiring.clearSession(sessionID)
  })
})

describe("answer application through the plan store", () => {
  test("a tier-choice answer sets the model's tier and records a user note", () => {
    const dataDir = tempDataDir()
    seedStore(dataDir)
    const sessionID = "ses_render_wiring_apply_tier"
    Wiring.clearSession(sessionID)
    const applied = Wiring.applyToolResult({
      sessionID,
      result: hostResult({ tier: "frontier", model: "openai/gpt-5.1" }),
      dataDir,
      now: "2026-11-14T01:00:00Z",
    })
    expect(applied?.answer.type).toBe("tier-choice")
    expect(ModelPlan.readStore(dataDir).models["openai/gpt-5.1"]?.tier).toBe("frontier")
    const notes = ModelPlan.readNotes({ modelID: "openai/gpt-5.1" }, dataDir)
    expect(notes.notes).toHaveLength(1)
    expect(notes.notes[0]?.source).toBe("user")
    expect(notes.notes[0]?.text).toContain("Tier chooser answer")
    Wiring.clearSession(sessionID)
  })

  test("a quota-fallback switch answer records the note and returns the switch instruction", () => {
    const dataDir = tempDataDir()
    seedStore(dataDir)
    const sessionID = "ses_render_wiring_apply_switch"
    Wiring.clearSession(sessionID)
    const wall: RenderCard.QuotaWall = {
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
      resetAt: Date.UTC(2026, 10, 15),
    }
    Wiring.offerWall(sessionID, wall)
    const applied = Wiring.applyToolResult({
      sessionID,
      result: hostResult({ action: "fallback", provider: "openai", tier: "standard" }),
      dataDir,
      now: "2026-11-14T01:00:00Z",
    })
    expect(applied?.instruction).toEqual({ kind: "switch", providerID: "openai", tier: "standard" })
    expect(ModelPlan.readNotes({ providerID: "openai" }, dataDir).notes[0]?.source).toBe("user")
    // The answer settles the offered wall.
    expect(Wiring.offeredWall(sessionID)).toBeUndefined()
    Wiring.clearSession(sessionID)
  })

  test("a quota-fallback answer naming the walled provider/tier is a wait for the reset", () => {
    const dataDir = tempDataDir()
    seedStore(dataDir)
    const sessionID = "ses_render_wiring_apply_wait"
    Wiring.clearSession(sessionID)
    const resetAt = Date.UTC(2026, 10, 15)
    Wiring.offerWall(sessionID, { providerID: "anthropic", modelID: "claude-sonnet-5", resetAt })
    const applied = Wiring.applyToolResult({
      sessionID,
      result: hostResult({ action: "fallback", provider: "anthropic", tier: "standard" }),
      dataDir,
      now: "2026-11-14T01:00:00Z",
    })
    expect(applied?.instruction).toEqual({ kind: "wait", until: resetAt })
    Wiring.clearSession(sessionID)
  })

  test("chat answers and answerless results change nothing", () => {
    const dataDir = tempDataDir()
    seedStore(dataDir)
    const sessionID = "ses_render_wiring_apply_none"
    Wiring.clearSession(sessionID)
    const chat = Wiring.applyToolResult({
      sessionID,
      result: hostResult({ answered: false, reason: "chat" }),
      dataDir,
    })
    expect(chat?.answer.type).toBe("chat")
    expect(
      Wiring.applyToolResult({ sessionID, result: JSON.stringify({ ok: false, error: "nope" }), dataDir }),
    ).toBeUndefined()
    expect(ModelPlan.readNotes({}, dataDir).notes).toHaveLength(0)
    Wiring.clearSession(sessionID)
  })
})

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node, FileAccess.node]),
      [
        Bus.node.replace(Bus.configured({ persist: true })),
        Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make("/project") }))),
      ],
    ),
    TestLLM.testLayer(),
  ),
)

const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
  },
]
const limit = { context: 100_000, output: 1_000 }

const setupStep = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const steps = yield* SessionStep.make.pipe(
    Effect.provide(
      Layer.mock(Snapshot.Service)({
        capture: () => Effect.succeed(undefined),
        files: () => Effect.succeed([]),
      }),
    ),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  return steps
})

const insertSession = (sessionID: Session.ID, slug: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug, directory: "/project", version: "test" })
      .run()
  })

describe("live step wiring", () => {
  it.effect("a quota failure with exhausted failover ends in the quota-wall state when the render tool is present", () =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const llm = yield* TestLLM.Test
      const steps = yield* setupStep
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      yield* insertSession(sessionID, "render-wall")
      const primary = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
        { capabilities, cost, limit },
      )
      const model = SessionRunnerModel.resolved(primary.model, {
        capabilities,
        cost,
        limit,
        routing: {
          routeID: Model.ID.make("render-wall-route"),
          target: primary.ref,
          attempts: 1,
          policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
          fallback: () => Effect.succeed(undefined),
        },
      })
      yield* llm.push(TestLLM.failAfter(new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) })))
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          toolNames: ["bash", RenderCard.RENDER_TOOL_NAME],
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          },
          retry: () => Effect.succeed({ retry: false as const }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isSuccess(result)) {
        expect(result.value._tag).toBe("QuotaWall")
        if (result.value._tag === "QuotaWall") {
          expect(result.value.wall.providerID).toBe("openai")
          expect(result.value.wall.modelID).toBe("primary")
        }
      }
      // The wall is offered exactly once: a second identical failure falls through as before.
      expect(Wiring.offeredWall(sessionID)).toBeDefined()
      Wiring.clearSession(sessionID)
    }),
  )

  it.effect("the same quota failure without the render tool keeps the bare-error ending", () =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const llm = yield* TestLLM.Test
      const steps = yield* setupStep
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      yield* insertSession(sessionID, "render-wall-absent")
      const primary = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
        { capabilities, cost, limit },
      )
      const model = SessionRunnerModel.resolved(primary.model, {
        capabilities,
        cost,
        limit,
        routing: {
          routeID: Model.ID.make("render-wall-route"),
          target: primary.ref,
          attempts: 1,
          policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
          fallback: () => Effect.succeed(undefined),
        },
      })
      yield* llm.push(TestLLM.failAfter(new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) })))
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          },
          retry: () => Effect.succeed({ retry: false as const }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result) && result.value._tag === "QuotaWall").toBe(false)
      expect(Wiring.offeredWall(sessionID)).toBeUndefined()
    }),
  )

  it.effect("a real render tool result is parsed and applied through the plan store during the step", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Test
      const steps = yield* setupStep
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      yield* insertSession(sessionID, "render-apply")
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "chooser-model", provider: "test", route: OpenAIChat.route }),
        { capabilities, cost, limit },
      )
      const chosenModel = `test/render-wiring-choice-${sessionID}`
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: "stop" },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-render", name: RenderCard.RENDER_TOOL_NAME, input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          toolNames: [RenderCard.RENDER_TOOL_NAME],
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Choose a tier" }),
            options: {},
            executeTool: () =>
              Effect.succeed({
                content: [
                  {
                    type: "text" as const,
                    text: hostResult({ tier: "frontier", model: chosenModel }),
                  },
                ],
              }),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      // The application landed in the plan store the resolver reads (default data dir).
      expect(ModelPlan.readStore().models[chosenModel]?.tier).toBe("frontier")
      const notes = ModelPlan.readNotes({ modelID: chosenModel })
      expect(notes.notes.at(-1)?.source).toBe("user")
    }),
  )
})
