import { describe, expect, test } from "bun:test"
import type { FormField, FormInfo } from "@opencode/client/promise"
import {
  createFormBodyState,
  formAcknowledge,
  formAnswer,
  formCommitInput,
  formPick,
  formReply,
  formSetExternalReady,
  formSetField,
  formSetSelected,
  formUnsupported,
  formValidate,
} from "../../src/mini/form.shared"

function request(fields: FormField[]): FormInfo {
  return { id: "frm_1", sessionID: "ses_1", title: "Input", fields: fields as FormInfo["fields"] }
}

describe("Mini form state", () => {
  test("builds every supported answer and preserves owner location", () => {
    const form = request([
      { key: "choice", type: "string", options: [{ value: "fast", label: "Fast" }], default: "fast" },
      { key: "count", type: "number" },
      { key: "whole", type: "integer", default: 2 },
      { key: "enabled", type: "boolean", default: false },
      { key: "tags", type: "multiselect", options: [], custom: true },
      { key: "external", type: "external", url: "https://example.com/action" },
    ])
    let state = formSetField(createFormBodyState(form), form, 1)
    state = formCommitInput(state, form, "1.5")
    state = formSetField(state, form, 4)
    state = formSetSelected(state, 0)
    state = formPick(state, form)
    state = formCommitInput(state, form, "custom")
    state = formSetField(state, form, 5)
    state = formAcknowledge(formSetExternalReady(state, "external"), form)

    const answer = { choice: "fast", count: 1.5, whole: 2, enabled: false, tags: ["custom"], external: true }
    expect(formAnswer(form, state)).toEqual(answer)
    expect(formReply({ ...form, location: { directory: "/tmp", workspaceID: "wrk_1" } }, state)).toEqual({
      sessionID: "ses_1",
      formID: "frm_1",
      answer,
      location: { directory: "/tmp", workspaceID: "wrk_1" },
    })
  })

  test("rejects non-decimal numeric spellings and empty required answers (#844)", () => {
    const form = request([
      { key: "count", type: "integer", required: true },
      { key: "rate", type: "number" },
    ])
    let state = createFormBodyState(form)
    state = formCommitInput(state, form, "0x10")
    expect(state.error).toBe("Expected a number")
    expect(state.answers.count).toBeUndefined()
    state = formCommitInput(state, form, "")
    expect(state.error).toBe("Answer required")
    state = formCommitInput(state, form, "42")
    expect(state.error).toBe("")
    expect(state.answers.count).toBe(42)
    state = formSetField(state, form, 1)
    state = formCommitInput(state, form, "1e3")
    expect(state.error).toBe("Expected a number")
    expect(state.answers.rate).toBeUndefined()
    state = formCommitInput(state, form, "")
    expect(state.error).toBe("")
    expect(state.answers.rate).toBeUndefined()
  })

  test("rejects invalid and deliberately unsupported shapes", () => {
    const invalid = request([
      { key: "required", type: "string", required: true },
      { key: "external", type: "external", url: "https://example.com" },
    ])
    expect(formValidate(invalid, createFormBodyState(invalid))).toContain("Answer required")
    expect(formUnsupported(request([{ key: "value", type: "string", pattern: "^a" }]))).toContain("Pattern")
    expect(
      formUnsupported(
        request([
          { key: "toggle", type: "boolean" },
          { key: "value", type: "string", when: [{ key: "toggle", op: "eq", value: true }] },
        ]),
      ),
    ).toContain("Conditional")
  })
})
