import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { DELEGATION_STANCE, OptimizePlugin } from "../src/plugin/optimize.js"
import PROMPT_ANTHROPIC from "../src/plugin/system-prompt/anthropic.txt"
import PROMPT_GPT from "../src/plugin/system-prompt/gpt.txt"
import PROMPT_ASTRA from "../src/plugin/system-prompt/gpt-astra.txt"
import PROMPT_KIMI from "../src/plugin/system-prompt/kimi.txt"
import PROMPT_META from "../src/plugin/system-prompt/meta.txt"
import PROMPT_TRINITY from "../src/plugin/system-prompt/trinity.txt"

const STANCE =
  "Do not spawn subagents unless the user or applicable AGENTS.md/skill instructions explicitly ask for subagents, delegation, or parallel agent work."

const families = {
  gpt: PROMPT_GPT,
  "gpt-astra": PROMPT_ASTRA,
  kimi: PROMPT_KIMI,
  meta: PROMPT_META,
  trinity: PROMPT_TRINITY,
  anthropic: PROMPT_ANTHROPIC,
} as const

describe("family prompt delegation stance (#1888)", () => {
  test("every family prompt carries the same delegation stance", () => {
    for (const [family, prompt] of Object.entries(families)) {
      expect(prompt, family).toContain(STANCE)
    }
    expect(DELEGATION_STANCE).toContain(STANCE)
  })

  test("no family prompt contradicts the stance", () => {
    for (const [family, prompt] of Object.entries(families)) {
      expect(prompt, family).not.toContain("proactively use the `subagent` tool")
      expect(prompt, family).not.toContain("prefer to use the subagent tool in order to reduce context usage")
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
    expect(OptimizePlugin.fallbackDelegationPrompt(Model.Info.default("mistral", "mistral-large-latest"))).toBe(
      DELEGATION_STANCE,
    )
    expect(OptimizePlugin.fallbackDelegationPrompt(Model.Info.default("deepseek", "deepseek-chat"))).toBeUndefined()
    expect(OptimizePlugin.fallbackDelegationPrompt(Model.Info.default("openai", "gpt-5"))).toBeUndefined()
    expect(OptimizePlugin.fallbackDelegationPrompt(Model.Info.default("anthropic", "claude-sonnet-5"))).toBeUndefined()
  })
})
