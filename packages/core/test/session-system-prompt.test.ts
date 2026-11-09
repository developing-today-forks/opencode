import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import DELEGATION_PROMPT from "../src/session/runner/prompt/delegation.txt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).not.toContain("${OPENCODE_DELEGATION_GUIDANCE}")
  expect(prompt).toContain(DELEGATION_PROMPT.trim())
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})
