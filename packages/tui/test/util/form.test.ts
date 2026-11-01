import { expect, test } from "bun:test"
import type { FormField, FormValue } from "@opencode/client"
import {
  formCustom,
  formDisplayValue,
  formInitialValues,
  formLabel,
  formNumberText,
  formNumberValue,
  formRows,
  formSelected,
  formSetMultiselectCustom,
  formTextual,
  formToggleMultiselect,
  formValidateValue,
  isFormAnswerField,
} from "../../src/util/form"
import type { FormAnswerField } from "../../src/util/form"

const option = {
  key: "choice",
  type: "string",
  options: [{ value: "one", label: "One" }],
  custom: true,
} satisfies FormField
const selection = {
  key: "tags",
  type: "multiselect",
  options: [
    { value: "one", label: "One" },
    { value: "two", label: "Two" },
  ],
  custom: true,
} satisfies FormAnswerField

test("initializes configured and custom defaults", () => {
  expect(
    formInitialValues([
      { key: "mode", type: "string", options: [{ value: "fast", label: "Fast" }], default: "fast" },
      { ...option, key: "note", default: "detailed" },
      { ...option, key: "configured", default: "one" },
      { key: "count", type: "number", default: 0 },
      { key: "authorize", type: "external", url: "https://example.com" },
    ]),
  ).toEqual({
    answers: { mode: "fast", note: "detailed", configured: "one", count: 0 },
    custom: { note: "detailed" },
  })
})

test("validates every supported field constraint", () => {
  const validate = (field: FormAnswerField, value: FormValue | undefined, error: string | undefined) =>
    expect(formValidateValue(field, value)).toBe(error)
  const string = (extra: Partial<Extract<FormAnswerField, { type: "string" }>> = {}) =>
    ({ key: "value", type: "string", ...extra }) satisfies FormAnswerField
  const multi = (extra: Partial<Extract<FormAnswerField, { type: "multiselect" }>> = {}) =>
    ({ key: "value", type: "multiselect", options: [], ...extra }) satisfies FormAnswerField

  validate(string({ required: true }), undefined, "Answer required")
  validate(multi({ required: true }), [], "Select at least one option")
  validate(string(), true, "Expected text")
  validate(string({ minLength: 3 }), "ab", "Must be at least 3 characters")
  validate(string({ maxLength: 2 }), "abc", "Must be at most 2 characters")
  validate(string({ pattern: "^a+$" }), "bbb", "Must match pattern: ^a+$")
  validate(string({ pattern: "[" }), "value", "Invalid pattern: [")
  validate(string({ format: "email" }), "invalid", "Expected an email address")
  validate(string({ format: "uri" }), "not a URL", "Expected a URL")
  validate(string({ format: "date" }), "2025-02-29", "Expected a date (YYYY-MM-DD)")
  validate(string({ format: "date-time" }), "not a date", "Expected a date and time")
  validate(string({ format: "date-time" }), "2026-02-30T10:00:00Z", "Expected a date and time")
  validate(string({ format: "date-time" }), "2026-13-01T10:00:00Z", "Expected a date and time")
  validate(string({ format: "date-time" }), "2025-02-29T10:00:00Z", "Expected a date and time")
  validate(string({ format: "date-time" }), "2026-01-01T24:00:00Z", "Expected a date and time")
  validate(string({ format: "date-time" }), "2024-02-29T10:00:00Z", undefined)
  validate(string({ format: "date-time" }), "2026-01-01T10:00:00+05:00", undefined)
  validate(string({ options: [{ value: "yes", label: "Yes" }] }), "no", "Select an available option")
  validate({ key: "value", type: "number" }, Number.NaN, "Expected a number")
  validate({ key: "value", type: "integer" }, 1.5, "Expected an integer")
  validate({ key: "value", type: "number", minimum: 2 }, 1, "Must be at least 2")
  validate({ key: "value", type: "number", maximum: 2 }, 3, "Must be at most 2")
  validate({ key: "value", type: "boolean" }, "yes", "Expected yes or no")
  validate(multi(), "yes", "Expected selections")
  validate(multi({ minItems: 2 }), ["one"], "Select at least 2")
  validate(multi({ maxItems: 1 }), ["one", "two"], "Select at most 1")
  validate(multi({ options: [{ value: "one", label: "One" }] }), ["two"], "Select only available options")
  validate(multi({ custom: true }), ["custom"], undefined)
})

test("parses typed numeric answers with the strict decimal grammar (#844)", () => {
  expect(formNumberValue("42")).toBe(42)
  expect(formNumberValue("-3")).toBe(-3)
  expect(formNumberValue("1.5")).toBe(1.5)
  expect(formNumberValue("")).toBeUndefined()
  expect(formNumberValue("  ")).toBeUndefined()
  for (const spelling of ["0x10", "0b101", "0o17", "1e3", "Infinity", "+1", ".5", "5.", "abc"])
    expect(formNumberValue(spelling)).toBeNaN()
  // The converted value is what formValidateValue sees: a required field fed
  // empty text must report required, never submit the 0 bare Number() made.
  const required = { key: "value", type: "integer", required: true } satisfies FormAnswerField
  expect(formValidateValue(required, formNumberValue(""))).toBe("Answer required")
  expect(formValidateValue(required, formNumberValue("0x10"))).toBe("Expected a number")
  expect(formValidateValue(required, formNumberValue("1.5"))).toBe("Expected an integer")
  const optional = { key: "value", type: "number" } satisfies FormAnswerField
  expect(formValidateValue(optional, formNumberValue(""))).toBeUndefined()
  expect(formValidateValue(optional, formNumberValue("1.5"))).toBeUndefined()
})

test("renders numeric defaults in plain-decimal text the strict grammar accepts (#1065)", () => {
  expect(formNumberText(1e-7)).toBe("0.0000001")
  expect(formNumberText(1e21)).toBe("1000000000000000000000")
  expect(formNumberText(-1.5e-7)).toBe("-0.00000015")
  expect(formNumberText(42)).toBe("42")
  expect(formNumberText(1.5)).toBe("1.5")
  expect(formNumberText(0)).toBe("0")
  // The pre-filled default confirms unchanged: rendering then parsing
  // round-trips the original value and passes validation, in both the
  // number and integer cases, while typed exponents stay rejected above.
  const rate = { key: "value", type: "number", required: true } satisfies FormAnswerField
  for (const value of [1e-7, 1e21, -2.5e21]) {
    expect(formNumberValue(formNumberText(value))).toBe(value)
    expect(formValidateValue(rate, formNumberValue(formNumberText(value)))).toBeUndefined()
  }
  const count = { key: "value", type: "integer", required: true } satisfies FormAnswerField
  expect(formValidateValue(count, formNumberValue(formNumberText(1e21)))).toBeUndefined()
  expect(formDisplayValue(rate, 1e-7, "")).toBe("0.0000001")
})

test("shares field classification, rows, selection, and display", () => {
  const text = { key: "name", type: "string", title: "Name" } satisfies FormField
  const external = { key: "authorize", type: "external", url: "https://example.com" } satisfies FormField
  expect([isFormAnswerField(text), isFormAnswerField(external)]).toEqual([true, false])
  expect([formLabel(text), formLabel(external)]).toEqual(["Name", "https://example.com"])
  expect([formTextual(text), formTextual(option), formCustom(option)]).toEqual([true, false, true])
  expect(formRows({ key: "value", type: "boolean" })).toEqual([
    { value: true, label: "Yes" },
    { value: false, label: "No" },
  ])
  expect(formRows({ ...option, options: [{ value: "one", label: "One", description: "First" }] })).toEqual([
    { value: "one", label: "One", description: "First" },
  ])
  expect(formRows({ key: "value", type: "number" })).toEqual([])
  expect([
    formSelected(selection, "two"),
    formSelected(selection, "custom"),
    formSelected(selection, undefined),
  ]).toEqual([1, 2, 0])
  expect(formDisplayValue(selection, ["one", "custom"], "(none)")).toBe("One, custom")
  expect([formDisplayValue(selection, [], ""), formDisplayValue(selection, [], "(none)")]).toEqual(["", "(none)"])
})

test("updates multiselects without mutating their source", () => {
  const source = ["one", "custom"]
  expect(formToggleMultiselect(source, "one")).toEqual(["custom"])
  expect(formToggleMultiselect(source, "two")).toEqual(["one", "custom", "two"])
  expect(formSetMultiselectCustom(source, "custom", "replacement")).toEqual(["one", "replacement"])
  expect(source).toEqual(["one", "custom"])
})
