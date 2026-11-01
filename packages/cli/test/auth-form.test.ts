import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { FormFields } from "@opencode/client"
import { formNumberText } from "@opencode/tui/util/form"
import { answerForm, validateText } from "../src/commands/handlers/auth/form"

test("resolves hidden defaults without an interactive terminal", async () => {
  const fields = [
    { type: "string", key: "server", hidden: true, default: "https://example.com/console" },
    { type: "boolean", key: "enabled", hidden: true, default: false },
    { type: "integer", key: "count", hidden: true, default: 0 },
    { type: "string", key: "optional", hidden: true },
  ] satisfies FormFields
  expect(await Effect.runPromise(answerForm(fields))).toEqual({
    server: "https://example.com/console",
    enabled: false,
    count: 0,
  })
  expect(await Effect.runPromise(answerForm(fields, ["server=https://staging.example.com/console"]))).toEqual({
    server: "https://staging.example.com/console",
    enabled: false,
    count: 0,
  })
})

test("validateText applies the strict decimal grammar to numeric answers (#844)", () => {
  const count = { type: "integer", key: "count", required: true } satisfies FormFields[number]
  expect(validateText(count, "")).toBe("Required")
  expect(validateText(count, " ")).toBe("Required")
  expect(validateText(count, "0x10")).toBe("Expected a number")
  expect(validateText(count, "0b101")).toBe("Expected a number")
  expect(validateText(count, "1e3")).toBe("Expected a number")
  expect(validateText(count, "1.5")).toBe("Expected an integer")
  expect(validateText(count, "42")).toBeUndefined()
  expect(validateText(count, "-3")).toBeUndefined()
  const rate = { type: "number", key: "rate" } satisfies FormFields[number]
  expect(validateText(rate, " ")).toBeUndefined()
  expect(validateText(rate, "0o17")).toBe("Expected a number")
  expect(validateText(rate, "1.5")).toBeUndefined()
})

test("renders exponent-notation defaults as plain-decimal text validateText accepts (#1065)", () => {
  // The CLI auth form pre-fills a numeric default with formNumberText, the
  // shared helper from the TUI form utils; the rendered text must pass the
  // same validateText the prompt runs, while the raw exponent spelling
  // a user might type stays rejected.
  const rate = { type: "number", key: "rate", required: true } satisfies FormFields[number]
  expect(formNumberText(1e-7)).toBe("0.0000001")
  expect(formNumberText(1e21)).toBe("1000000000000000000000")
  expect(validateText(rate, formNumberText(1e-7))).toBeUndefined()
  expect(validateText(rate, formNumberText(1e21))).toBeUndefined()
  expect(validateText(rate, "1e-7")).toBe("Expected a number")
})

test("parses typed answers and evaluates conditions in form order", async () => {
  const fields = [
    { type: "string", key: "deployment", options: [{ value: "enterprise", label: "Enterprise" }] },
    { type: "string", key: "host", when: [{ key: "deployment", op: "eq", value: "enterprise" }] },
    { type: "boolean", key: "enabled" },
    { type: "integer", key: "count", minimum: 0 },
    { type: "number", key: "rate" },
    { type: "multiselect", key: "scopes", options: [{ value: "read", label: "Read" }] },
  ] satisfies FormFields
  expect(
    await Effect.runPromise(
      answerForm(fields, [
        "host=example.com",
        "deployment=enterprise",
        "enabled=false",
        "count=0",
        "rate=1.5",
        'scopes=["read"]',
      ]),
    ),
  ).toEqual({ deployment: "enterprise", host: "example.com", enabled: false, count: 0, rate: 1.5, scopes: ["read"] })
})

test("preserves empty strings and equals signs in supplied text", async () => {
  expect(
    await Effect.runPromise(
      answerForm(
        [
          { type: "string", key: "server" },
          { type: "string", key: "optional" },
        ],
        ["server=https://example.com/console?tenant=a=b", "optional="],
      ),
    ),
  ).toEqual({ server: "https://example.com/console?tenant=a=b", optional: "" })
})

const invalidAnswers: { fields: FormFields | undefined; supplied: string[]; error: string }[] = [
  { fields: undefined, supplied: ["missing-separator"], error: "Expected --answer key=value" },
  { fields: undefined, supplied: ["=missing-key"], error: "Expected --answer key=value" },
  { fields: undefined, supplied: ["unknown=value"], error: "Unknown form field: unknown" },
  {
    fields: [{ type: "string", key: "known" }],
    supplied: ["unknown=value"],
    error: "Unknown form field: unknown",
  },
  {
    fields: [
      { type: "boolean", key: "enabled", hidden: true, default: false },
      { type: "string", key: "host", when: [{ key: "enabled", op: "eq", value: true }] },
    ],
    supplied: ["host=example.com"],
    error: "Form field is not active: host",
  },
  { fields: [{ type: "integer", key: "count" }], supplied: ["count=1.5"], error: "Expected an integer" },
  { fields: [{ type: "boolean", key: "enabled" }], supplied: ["enabled=yes"], error: "Expected a JSON value" },
  {
    fields: [{ type: "string", key: "when", format: "date-time" }],
    supplied: ["when=2026-02-30T10:00:00Z"],
    error: "Expected a date and time",
  },
  {
    fields: [{ type: "string", key: "when", format: "date-time" }],
    supplied: ["when=2025-02-29T10:00:00Z"],
    error: "Expected a date and time",
  },
  {
    fields: [{ type: "string", key: "when", format: "date-time" }],
    supplied: ["when=2026-01-01T24:00:00Z"],
    error: "Expected a date and time",
  },
  {
    fields: [{ type: "string", key: "server", format: "uri", hidden: true }],
    supplied: ["server=not a URL"],
    error: "Expected a URL",
  },
  {
    fields: [{ type: "string", key: "required", hidden: true, required: true }],
    supplied: [],
    error: "Answer required",
  },
  {
    fields: [{ type: "multiselect", key: "scopes", options: [{ value: "read", label: "Read" }] }],
    supplied: ['scopes=["write"]'],
    error: "Select only available options",
  },
  {
    fields: [{ type: "external", key: "approve", url: "https://example.com" }],
    supplied: ["approve=true"],
    error: "requires interactive confirmation",
  },
]

test.each(invalidAnswers)("rejects invalid form answers: $error", async (input) => {
  await expect(Effect.runPromise(answerForm(input.fields, input.supplied))).rejects.toThrow(input.error)
})

test("accepts valid date-time form answers", async () => {
  const fields = [{ type: "string", key: "when", format: "date-time" }] satisfies FormFields
  expect(await Effect.runPromise(answerForm(fields, ["when=2024-02-29T10:00:00Z"]))).toEqual({
    when: "2024-02-29T10:00:00Z",
  })
  expect(await Effect.runPromise(answerForm(fields, ["when=2026-01-01T10:00:00+05:00"]))).toEqual({
    when: "2026-01-01T10:00:00+05:00",
  })
})
