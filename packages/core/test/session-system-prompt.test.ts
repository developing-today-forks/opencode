import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
  expect(prompt).toContain("You cannot change your own model or route in-session")
  expect(prompt).toContain("ask your launcher to change it")
  expect(prompt).toContain("next model call")
  expect(prompt).toContain("invalidates the prompt cache")
})
