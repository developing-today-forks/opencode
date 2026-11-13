import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { DELEGATION_GUIDANCE, OptimizePlugin } from "../src/plugin/optimize.js"
import { SessionSystemPrompt } from "../src/session/system-prompt.js"
import PROMPT_ANTHROPIC from "../src/plugin/system-prompt/anthropic.txt"
import PROMPT_GPT from "../src/plugin/system-prompt/gpt.txt"
import PROMPT_ASTRA from "../src/plugin/system-prompt/gpt-astra.txt"
import PROMPT_KIMI from "../src/plugin/system-prompt/kimi.txt"
import PROMPT_META from "../src/plugin/system-prompt/meta.txt"
import PROMPT_TRINITY from "../src/plugin/system-prompt/trinity.txt"

const families = {
  gpt: PROMPT_GPT,
  "gpt-astra": PROMPT_ASTRA,
  kimi: PROMPT_KIMI,
  meta: PROMPT_META,
  trinity: PROMPT_TRINITY,
  anthropic: PROMPT_ANTHROPIC,
} as const

describe("family prompt delegation stance (#1888)", () => {
  test("every family prompt renders the shared delegation guidance", () => {
    for (const [family, prompt] of Object.entries(families)) {
      expect(SessionSystemPrompt.render(prompt, []), family).toContain(DELEGATION_GUIDANCE)
    }
    expect(DELEGATION_GUIDANCE).toContain(
      "Do not spawn subagents unless the user or applicable AGENTS.md/skill instructions explicitly ask",
    )
  })

  test("shared guidance covers the subsession behavior", () => {
    for (const requirement of [
      "`subagent` tool",
      "experimental.subagent_depth",
      "working directory",
      "model/route",
      "synthetic turn",
      "`comms` namespace",
      "cannot switch models in place",
      "Detached sessions must never call the interactive `question` tool",
    ]) {
      expect(DELEGATION_GUIDANCE).toContain(requirement)
    }
  })

  test("no family prompt contradicts the stance", () => {
    for (const [family, prompt] of Object.entries(families)) {
      const rendered = SessionSystemPrompt.render(prompt, [])
      expect(rendered, family).not.toContain("proactively use the `subagent` tool")
      expect(rendered, family).not.toContain("prefer to use the subagent tool in order to reduce context usage")
      expect(rendered, family).not.toContain("If the `subagent` tool is available, you can use it")
    }
  })

  test("selection registers a DeepSeek entry and the fallback, fallback last", () => {
    const ids = OptimizePlugin.Plugins.map((plugin) => plugin.id)
    expect(ids).toContain("opencode.prompt.deepseek")
    expect(ids[ids.length - 1]).toBe("opencode.prompt.fallback")
  })

  test("the fallback gives an unmatched model the stance and leaves family models to their prompts", () => {
    // Oracle: the fallback matcher itself — an unmatched model id resolves to the
    // stance block (appended to the base prompt), a family id resolves to nothing.
    expect(
      OptimizePlugin.fallbackDelegationPrompt(
        Model.Info.default(Provider.ID.make("mistral"), Model.ID.make("mistral-large-latest")),
      ),
    ).toBe(DELEGATION_GUIDANCE)
    expect(
      OptimizePlugin.fallbackDelegationPrompt(
        Model.Info.default(Provider.ID.make("deepseek"), Model.ID.make("deepseek-chat")),
      ),
    ).toBeUndefined()
    expect(
      OptimizePlugin.fallbackDelegationPrompt(Model.Info.default(Provider.ID.make("openai"), Model.ID.make("gpt-5"))),
    ).toBeUndefined()
    expect(
      OptimizePlugin.fallbackDelegationPrompt(
        Model.Info.default(Provider.ID.make("anthropic"), Model.ID.make("claude-sonnet-5")),
      ),
    ).toBeUndefined()
  })
})
