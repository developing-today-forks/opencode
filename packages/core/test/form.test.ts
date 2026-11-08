import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Form } from "@opencode/core/form"
import { SessionSchema } from "@opencode/core/session/schema"
import { testEffect } from "./lib/effect"

const forms = AppNodeBuilder.build(LayerNode.group([Bus.node, Form.node]))
const it = testEffect(forms)

const formID = Form.ID.create("frm_test")
const input = {
  id: formID,
  sessionID: SessionSchema.ID.make("ses_test"),
  title: "Test form",
  fields: [{ key: "name", type: "string", required: true }],
} satisfies Form.CreateInput

describe("Form", () => {
  it.effect("validates absolute URI formats without restricting schemes", () =>
    Effect.sync(() => {
      const fields = [{ key: "uri", type: "string", format: "uri" }] satisfies ReadonlyArray<Form.Field>

      expect(Form.validateAnswer(fields, { uri: "https://example.com/path" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { uri: "mailto:user@example.com" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { uri: "relative/path" })).toBe("Expected URI for form field: uri")
      expect(Form.validateAnswer(fields, { uri: "://invalid" })).toBe("Expected URI for form field: uri")
    }),
  )

  it.effect("rejects calendar-invalid date-time formats while keeping valid and non-ISO values", () =>
    Effect.sync(() => {
      const fields = [{ key: "at", type: "string", format: "date-time" }] satisfies ReadonlyArray<Form.Field>

      for (const value of ["2026-02-30T10:00:00Z", "2026-02-29T10:00:00Z", "2026-04-31T10:00:00Z"]) {
        expect(Form.validateAnswer(fields, { at: value })).toBe("Expected date-time for form field: at")
      }
      expect(Form.validateAnswer(fields, { at: "2024-02-29T10:00:00Z" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { at: "2026-01-15T10:30:00Z" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { at: "2026-01-15T10:30:00+02:00" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { at: "2026-01-01T25:00:00Z" })).toBe(
        "Expected date-time for form field: at",
      )
      expect(Form.validateAnswer(fields, { at: "2026-01-01T10:60:00Z" })).toBe(
        "Expected date-time for form field: at",
      )
      expect(Form.validateAnswer(fields, { at: "not-a-date" })).toBe("Expected date-time for form field: at")
      // Non-ISO forms carry no YYYY-MM-DD part, so their existing leniency is unchanged.
      expect(Form.validateAnswer(fields, { at: "Jan 5 2026" })).toBeUndefined()
    }),
  )

  it.effect("rejects hour-24 ISO date-times that roll into the next day (#666)", () =>
    Effect.sync(() => {
      const fields = [{ key: "at", type: "string", format: "date-time" }] satisfies ReadonlyArray<Form.Field>

      for (const value of [
        "2026-01-01T24:00:00Z",
        "2026-01-01T24:00:00.000Z",
        "2026-01-01T24:00:00+05:00",
        "2025-12-31T24:00:00Z",
      ]) {
        expect(Form.validateAnswer(fields, { at: value })).toBe("Expected date-time for form field: at")
      }
      for (const value of ["2026-01-01T23:59:59Z", "2026-01-01T00:00:00Z", "2024-02-29T23:59:59Z"]) {
        expect(Form.validateAnswer(fields, { at: value })).toBeUndefined()
      }
    }),
  )

  it.effect("rejects calendar-invalid non-ISO date-times while keeping valid ones (#798)", () =>
    Effect.sync(() => {
      const fields = [{ key: "at", type: "string", format: "date-time" }] satisfies ReadonlyArray<Form.Field>

      for (const value of ["Feb 30 2026", "Feb 30, 2026", "30 Feb 2026", "2026/02/30", "Feb 30 2026 24:00"]) {
        expect(Form.validateAnswer(fields, { at: value })).toBe("Expected date-time for form field: at")
      }
      for (const value of ["Jan 5 2026", "January 5, 2026", "5 Jan 2026", "Feb 29 2024"]) {
        expect(Form.validateAnswer(fields, { at: value })).toBeUndefined()
      }
    }),
  )

  it.effect("pins date format behaviour alongside date-time", () =>
    Effect.sync(() => {
      const fields = [{ key: "day", type: "string", format: "date" }] satisfies ReadonlyArray<Form.Field>

      expect(Form.validateAnswer(fields, { day: "2026-02-30" })).toBe("Expected date for form field: day")
      expect(Form.validateAnswer(fields, { day: "2026-02-29" })).toBe("Expected date for form field: day")
      expect(Form.validateAnswer(fields, { day: "2024-02-29" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { day: "2026-01-15" })).toBeUndefined()
    }),
  )

  it.effect("returns a terminal cancelled state from ask", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)

      yield* service.cancel(form.id)

      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
      expect(yield* service.state(form.id)).toEqual({ status: "cancelled" })
    }),
  )

  it.effect("supports the temporary global mcp elicitation owner", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "MCP input",
        fields: [{ key: "name", type: "string", required: true }],
      })
      expect(created.sessionID).toBe("global")
      expect(created.title).toBe("MCP input")

      const owned = yield* service.list({ sessionID: "global" })
      expect(owned.map((form) => form.id)).toEqual([created.id])
      expect(yield* service.list({ sessionID: "other" })).toEqual([])

      yield* service.reply({ id: created.id, answer: { name: "Ava" } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { name: "Ava" } })

      const externalOnly = yield* service.create({
        sessionID: "global",
        title: "External setup",
        fields: [{ key: "setup", type: "external", url: "https://example.com/setup" }],
      })
      yield* service.reply({ id: externalOnly.id, answer: { setup: true } })
      expect(yield* service.state(externalOnly.id)).toEqual({ status: "answered", answer: { setup: true } })
    }),
  )

  it.effect("gates required fields and rejects inactive answers via when", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Conditional form",
        fields: [
          { key: "confirm", type: "boolean", required: true },
          { key: "reason", type: "string", required: true, when: [{ key: "confirm", op: "eq", value: false }] },
        ],
      })

      const inactive = yield* service
        .reply({ id: created.id, answer: { confirm: true, reason: "x" } })
        .pipe(Effect.flip)
      expect(inactive).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: reason" }),
      )

      const missing = yield* service.reply({ id: created.id, answer: { confirm: false } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: reason" }),
      )

      yield* service.reply({ id: created.id, answer: { confirm: false, reason: "not ready" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { confirm: false, reason: "not ready" },
      })
    }),
  )

  it.effect("evaluates when against multiselect answers as inclusion", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const options = [
        { value: "go", label: "Go" },
        { value: "ts", label: "TypeScript" },
      ]
      const created = yield* service.create({
        sessionID: "global",
        title: "Multiselect form",
        fields: [
          { key: "langs", type: "multiselect", options },
          { key: "goVersion", type: "string", required: true, when: [{ key: "langs", op: "eq", value: "go" }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { langs: ["go", "ts"] } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: goVersion" }),
      )

      yield* service.reply({ id: created.id, answer: { langs: ["ts"] } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { langs: ["ts"] } })
    }),
  )

  it.effect("requires every when condition to match and treats empty when as active", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Dependent form",
        fields: [
          { key: "a", type: "boolean" },
          { key: "b", type: "boolean" },
          {
            key: "x",
            type: "string",
            required: true,
            when: [
              { key: "a", op: "eq", value: true },
              { key: "b", op: "eq", value: true },
            ],
          },
          { key: "z", type: "string", required: true, when: [] },
        ],
      })

      const missingX = yield* service.reply({ id: created.id, answer: { a: true, b: true, z: "ok" } }).pipe(Effect.flip)
      expect(missingX).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: x" }),
      )

      const inactiveX = yield* service
        .reply({ id: created.id, answer: { a: true, b: false, x: "nope", z: "ok" } })
        .pipe(Effect.flip)
      expect(inactiveX).toEqual(new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: x" }))

      const missingZ = yield* service.reply({ id: created.id, answer: { a: true, b: false } }).pipe(Effect.flip)
      expect(missingZ).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: z" }),
      )

      yield* service.reply({ id: created.id, answer: { a: true, b: false, z: "ok" } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { a: true, b: false, z: "ok" } })
    }),
  )

  it.effect("evaluates neq against multiselect answers as non-inclusion", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const options = [
        { value: "go", label: "Go" },
        { value: "ts", label: "TypeScript" },
      ]
      const created = yield* service.create({
        sessionID: "global",
        title: "Selection form",
        fields: [
          { key: "langs", type: "multiselect", options },
          { key: "note", type: "string", required: true, when: [{ key: "langs", op: "neq", value: "go" }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { langs: ["ts"] } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: note" }),
      )

      // an answered-but-empty multiselect also satisfies neq
      const missingEmpty = yield* service.reply({ id: created.id, answer: { langs: [] } }).pipe(Effect.flip)
      expect(missingEmpty).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: note" }),
      )

      const inactive = yield* service.reply({ id: created.id, answer: { langs: ["go"], note: "x" } }).pipe(Effect.flip)
      expect(inactive).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: note" }),
      )

      yield* service.reply({ id: created.id, answer: { langs: ["go"] } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { langs: ["go"] } })
    }),
  )

  it.effect("treats unanswered when references as false and cascades inactivity", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Cascading form",
        fields: [
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: true }] },
          // neq also fails against an unanswered reference, and hiding b cascades here through
          // the reject-inactive-answers rule: b can never be answered while a is false.
          { key: "c", type: "string", required: true, when: [{ key: "b", op: "neq", value: "x" }] },
        ],
      })

      const inactive = yield* service.reply({ id: created.id, answer: { a: false, b: "yes" } }).pipe(Effect.flip)
      expect(inactive).toEqual(new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: b" }))

      yield* service.reply({ id: created.id, answer: { a: false } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { a: false } })
    }),
  )

  it.effect("rejects invalid when definitions at creation", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const flipCreate = (fields: Form.CreateInput["fields"]) =>
        service.create({ sessionID: "global", title: "Invalid form", fields }).pipe(Effect.flip)

      expect(
        yield* flipCreate([{ key: "b", type: "string", when: [{ key: "missing", op: "eq", value: "x" }] }]),
      ).toEqual(
        new Form.InvalidFormError({ message: "Form field condition must reference an earlier field: b -> missing" }),
      )

      expect(
        yield* flipCreate([
          { key: "a", type: "string" },
          { key: "a", type: "string" },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Duplicate form field key: a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "external", url: "https://example.com" },
          { key: "a", type: "string" },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Duplicate form field key: a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "yes" }] },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Form field condition value must be a boolean: b -> a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "external", url: "https://example.com" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "yes" }] },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Form field condition value must be a boolean: b -> a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "string", options: [{ value: "x", label: "X" }] },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "y" }] },
        ]),
      ).toEqual(
        new Form.InvalidFormError({
          message: "Form field condition value must be one of the field's options: b -> a",
        }),
      )
    }),
  )

  it.effect("rejects when values a string target can never answer (#708)", () =>
    Effect.sync(() => {
      const gated = (target: Form.Field, value: string, op: "eq" | "neq" = "eq") =>
        Form.validateFields([target, { key: "b", type: "string", when: [{ key: "a", op, value }] }])

      // A date-format target can never answer "not-a-date", for either op.
      expect(gated({ key: "a", type: "string", format: "date" }, "not-a-date")).toBe(
        "Form field condition value must be a date: b -> a",
      )
      expect(gated({ key: "a", type: "string", format: "date" }, "2026-02-30", "neq")).toBe(
        "Form field condition value must be a date: b -> a",
      )
      expect(gated({ key: "a", type: "string", format: "date" }, "2026-01-15")).toBeUndefined()
      expect(gated({ key: "a", type: "string", format: "date-time" }, "2026-02-30T00:00:00Z")).toBe(
        "Form field condition value must be a date-time: b -> a",
      )
      expect(gated({ key: "a", type: "string", format: "date-time" }, "2026-01-15T00:00:00Z")).toBeUndefined()
      expect(gated({ key: "a", type: "string", format: "email" }, "not-an-email")).toBe(
        "Form field condition value must be an email: b -> a",
      )
      expect(gated({ key: "a", type: "string", format: "email" }, "a@example.com")).toBeUndefined()
      expect(gated({ key: "a", type: "string", format: "uri" }, "not a uri")).toBe(
        "Form field condition value must be a URI: b -> a",
      )
      expect(gated({ key: "a", type: "string", format: "uri" }, "https://example.com")).toBeUndefined()

      // A patterned target can never answer a non-matching value.
      expect(gated({ key: "a", type: "string", pattern: "^\\d+$" }, "abc")).toBe(
        "Form field condition value must match the field's pattern: b -> a",
      )
      expect(gated({ key: "a", type: "string", pattern: "^\\d+$" }, "123")).toBeUndefined()

      // Length bounds bind condition values too.
      expect(gated({ key: "a", type: "string", minLength: 5 }, "abc")).toBe(
        "Form field condition value must be at least 5 characters: b -> a",
      )
      expect(gated({ key: "a", type: "string", minLength: 5 }, "abcde")).toBeUndefined()
      expect(gated({ key: "a", type: "string", maxLength: 3 }, "abcdef")).toBe(
        "Form field condition value must be at most 3 characters: b -> a",
      )

      // Closed-options targets stay decided by membership alone, even when an
      // option value would fail the target's other constraints.
      expect(
        gated(
          { key: "a", type: "string", minLength: 5, options: [{ value: "abc", label: "ABC" }] },
          "abc",
        ),
      ).toBeUndefined()
      // Custom string targets still get the checks: options do not bind answers.
      expect(
        gated(
          { key: "a", type: "string", custom: true, minLength: 5, options: [{ value: "abc", label: "ABC" }] },
          "abc",
        ),
      ).toBe("Form field condition value must be at least 5 characters: b -> a")
    }),
  )

  it.effect("rejects unsatisfiable field bounds and uncompilable patterns at creation (#681)", () =>
    Effect.sync(() => {
      expect(Form.validateFields([{ key: "name", type: "string", minLength: 10, maxLength: 5 }])).toBe(
        "Form field has minLength greater than maxLength: name",
      )
      expect(Form.validateFields([{ key: "age", type: "number", minimum: 10, maximum: 5 }])).toBe(
        "Form field has minimum greater than maximum: age",
      )
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 10, maximum: 5 }])).toBe(
        "Form field has minimum greater than maximum: count",
      )
      expect(
        Form.validateFields([
          {
            key: "tags",
            type: "multiselect",
            options: [{ value: "a", label: "A" }],
            minItems: 3,
            maxItems: 1,
          },
        ]),
      ).toBe("Form field has minItems greater than maxItems: tags")
      expect(Form.validateFields([{ key: "code", type: "string", pattern: "[" }])).toBe(
        "Form field has invalid pattern: code",
      )
      // Equal bounds and one-sided bounds are satisfiable and still create.
      expect(Form.validateFields([{ key: "name", type: "string", minLength: 5, maxLength: 5 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "name", type: "string", minLength: 5 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "age", type: "number", minimum: 5, maximum: 5 }])).toBeUndefined()
      expect(
        Form.validateFields([
          {
            key: "tags",
            type: "multiselect",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
            minItems: 2,
            maxItems: 2,
          },
        ]),
      ).toBeUndefined()
      expect(Form.validateFields([{ key: "code", type: "string", pattern: "^a+$" }])).toBeUndefined()
    }),
  )

  it.effect("rejects when values a numeric target can never answer (#705)", () =>
    Effect.sync(() => {
      // Fractional value on an integer target: no valid answer can equal it, for either op.
      expect(
        Form.validateFields([
          { key: "count", type: "integer", minimum: 1, maximum: 10 },
          { key: "b", type: "string", when: [{ key: "count", op: "eq", value: 1.5 }] },
        ]),
      ).toBe("Form field condition value must be an integer: b -> count")
      expect(
        Form.validateFields([
          { key: "count", type: "integer" },
          { key: "b", type: "string", when: [{ key: "count", op: "neq", value: 1.5 }] },
        ]),
      ).toBe("Form field condition value must be an integer: b -> count")
      // Value outside the target's declared bounds, for either op.
      expect(
        Form.validateFields([
          { key: "age", type: "number", minimum: 10, maximum: 20 },
          { key: "b", type: "string", when: [{ key: "age", op: "eq", value: 5 }] },
        ]),
      ).toBe("Form field condition value must be within the field's declared bounds: b -> age")
      expect(
        Form.validateFields([
          { key: "age", type: "number", maximum: 20 },
          { key: "b", type: "string", when: [{ key: "age", op: "neq", value: 21 }] },
        ]),
      ).toBe("Form field condition value must be within the field's declared bounds: b -> age")
      expect(
        Form.validateFields([
          { key: "count", type: "integer", minimum: 1, maximum: 10 },
          { key: "b", type: "string", when: [{ key: "count", op: "eq", value: 11 }] },
        ]),
      ).toBe("Form field condition value must be within the field's declared bounds: b -> count")
      // Matchable controls still create: in-bounds integers on integer targets, in-bounds
      // numbers on number targets, bound-equal values, and one-sided bounds.
      expect(
        Form.validateFields([
          { key: "count", type: "integer", minimum: 1, maximum: 10 },
          { key: "b", type: "string", when: [{ key: "count", op: "eq", value: 3 }] },
        ]),
      ).toBeUndefined()
      expect(
        Form.validateFields([
          { key: "age", type: "number", minimum: 0, maximum: 20 },
          { key: "b", type: "string", when: [{ key: "age", op: "eq", value: 5 }] },
        ]),
      ).toBeUndefined()
      expect(
        Form.validateFields([
          { key: "age", type: "number", minimum: 10, maximum: 20 },
          { key: "b", type: "string", when: [{ key: "age", op: "neq", value: 20 }] },
        ]),
      ).toBeUndefined()
      expect(
        Form.validateFields([
          { key: "age", type: "number", minimum: 10 },
          { key: "b", type: "string", when: [{ key: "age", op: "eq", value: 15.5 }] },
        ]),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects non-finite when values on a number target (#853)", () =>
    Effect.sync(() => {
      const gated = (value: number, op: "eq" | "neq" = "eq") =>
        Form.validateFields([
          { key: "age", type: "number" },
          { key: "b", type: "string", when: [{ key: "age", op, value }] },
        ])
      // No valid answer is non-finite, so eq can never match and neq always matches.
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(gated(value)).toBe("Form field condition value must be a finite number: b -> age")
        expect(gated(value, "neq")).toBe("Form field condition value must be a finite number: b -> age")
      }
      // A finite control still creates.
      expect(gated(5)).toBeUndefined()
      expect(gated(5, "neq")).toBeUndefined()
    }),
  )

  it.effect("rejects when values an external target can never answer (#732)", () =>
    Effect.sync(() => {
      const gated = (value: boolean, op: "eq" | "neq" = "eq") =>
        Form.validateFields([
          { key: "a", type: "external", url: "https://example.com" },
          { key: "b", type: "string", when: [{ key: "a", op, value }] },
        ])

      // The only answerable value is the `true` acknowledgement, so eq/false and
      // neq/true are constant-false and the gated field could never activate.
      expect(gated(false)).toBe("Form field condition can never match the external field's acknowledgement: b -> a")
      expect(gated(true, "neq")).toBe(
        "Form field condition can never match the external field's acknowledgement: b -> a",
      )
      // The two satisfiable combinations stay accepted.
      expect(gated(true)).toBeUndefined()
      expect(gated(false, "neq")).toBeUndefined()
      // Boolean targets still accept both values.
      expect(
        Form.validateFields([
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: false }] },
        ]),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects field definitions no answer can satisfy: too few options, integer-free range (#696)", () =>
    Effect.sync(() => {
      // A closed multiselect may only be answered with declared options, so
      // minItems beyond the option count is unsatisfiable.
      expect(
        Form.validateFields([
          {
            key: "tags",
            type: "multiselect",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
            minItems: 3,
          },
        ]),
      ).toBe("Form field has minItems greater than its number of options: tags")
      // An integer range containing no integer is unsatisfiable.
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 1.2, maximum: 1.8 }])).toBe(
        "Form field range contains no integer: count",
      )
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 0.5, maximum: 0.9 }])).toBe(
        "Form field range contains no integer: count",
      )
      // Satisfiable controls still create: minItems within the option count, a
      // custom multiselect (answers are not limited to the declared options),
      // integer ranges containing an integer, equal integer bounds, one-sided
      // integer bounds, and fractional bounds on a plain number field.
      expect(
        Form.validateFields([
          {
            key: "tags",
            type: "multiselect",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
            minItems: 2,
          },
        ]),
      ).toBeUndefined()
      expect(
        Form.validateFields([
          {
            key: "tags",
            type: "multiselect",
            options: [{ value: "a", label: "A" }],
            minItems: 3,
            custom: true,
          },
        ]),
      ).toBeUndefined()
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 1, maximum: 2 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 1.2, maximum: 2.8 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 2, maximum: 2 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "count", type: "integer", minimum: 1.2 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "count", type: "integer", maximum: 1.8 }])).toBeUndefined()
      expect(Form.validateFields([{ key: "age", type: "number", minimum: 1.2, maximum: 1.8 }])).toBeUndefined()
    }),
  )

  it.effect("rejects required fields no answer can satisfy: zero caps, closed empty options (#712)", () =>
    Effect.sync(() => {
      // A required answer needs at least one character / selection, so a zero
      // cap makes every answer fail: empty is missing-required, non-empty is
      // too long / too many.
      expect(Form.validateFields([{ key: "name", type: "string", required: true, maxLength: 0 }])).toBe(
        "Form field has maxLength 0 but is required: name",
      )
      expect(
        Form.validateFields([
          {
            key: "tags",
            type: "multiselect",
            required: true,
            options: [{ value: "a", label: "A" }],
            maxItems: 0,
          },
        ]),
      ).toBe("Form field has maxItems 0 but is required: tags")
      // A required field with a closed empty options list has no valid
      // answer: empty is missing-required, any value is an invalid option.
      expect(Form.validateFields([{ key: "name", type: "string", required: true, options: [] }])).toBe(
        "Form field has no options but is required: name",
      )
      expect(
        Form.validateFields([{ key: "tags", type: "multiselect", required: true, options: [] }]),
      ).toBe("Form field has no options but is required: tags")
      // Satisfiable controls still create: the same shapes without required
      // (0 stays a legal cap for optional fields), a cap of 1, and custom
      // fields whose answers are not limited to the declared options.
      expect(Form.validateFields([{ key: "name", type: "string", maxLength: 0 }])).toBeUndefined()
      expect(
        Form.validateFields([
          { key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }], maxItems: 0 },
        ]),
      ).toBeUndefined()
      expect(Form.validateFields([{ key: "name", type: "string", options: [] }])).toBeUndefined()
      expect(Form.validateFields([{ key: "tags", type: "multiselect", options: [] }])).toBeUndefined()
      expect(Form.validateFields([{ key: "name", type: "string", required: true, maxLength: 1 }])).toBeUndefined()
      expect(
        Form.validateFields([
          { key: "tags", type: "multiselect", required: true, options: [{ value: "a", label: "A" }], maxItems: 1 },
        ]),
      ).toBeUndefined()
      expect(
        Form.validateFields([{ key: "name", type: "string", required: true, options: [], custom: true }]),
      ).toBeUndefined()
      expect(
        Form.validateFields([{ key: "tags", type: "multiselect", required: true, options: [], custom: true }]),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects duplicate multiselect selections instead of counting them twice (#707)", () =>
    Effect.sync(() => {
      const options = [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ]
      // Repeating one option must not satisfy minItems 2 with a single distinct selection.
      expect(
        Form.validateAnswer([{ key: "tags", type: "multiselect", options, minItems: 2 }], { tags: ["a", "a"] }),
      ).toBe("Duplicate selection for form field: tags")
      // Same for a custom multiselect: three copies of one value are not three selections.
      expect(
        Form.validateAnswer(
          [{ key: "tags", type: "multiselect", options: [{ value: "x", label: "X" }], custom: true, minItems: 3 }],
          { tags: ["x", "x", "x"] },
        ),
      ).toBe("Duplicate selection for form field: tags")
      // And against maxItems 1 the duplicate is reported as a duplicate, not as
      // two selections exceeding the bound.
      expect(
        Form.validateAnswer([{ key: "tags", type: "multiselect", options, maxItems: 1 }], { tags: ["a", "a"] }),
      ).toBe("Duplicate selection for form field: tags")
      // The rule applies even with no item bounds at all.
      expect(Form.validateAnswer([{ key: "tags", type: "multiselect", options }], { tags: ["b", "b"] })).toBe(
        "Duplicate selection for form field: tags",
      )
      // Answers without duplicates behave exactly as before.
      expect(
        Form.validateAnswer([{ key: "tags", type: "multiselect", options, minItems: 2 }], { tags: ["a", "b"] }),
      ).toBeUndefined()
      expect(
        Form.validateAnswer([{ key: "tags", type: "multiselect", options, maxItems: 1 }], { tags: ["a"] }),
      ).toBeUndefined()
      expect(
        Form.validateAnswer([{ key: "tags", type: "multiselect", options, minItems: 2 }], { tags: ["a"] }),
      ).toBe("Too few selections for form field: tags")
    }),
  )

  it.effect("gates fields on an external acknowledgement via when", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "External gated form",
        fields: [
          { key: "authorization", type: "external", url: "https://example.com/setup", title: "Open setup" },
          { key: "code", type: "string", required: true, when: [{ key: "authorization", op: "eq", value: true }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { authorization: true } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: code" }),
      )

      yield* service.reply({ id: created.id, answer: { authorization: true, code: "x" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { authorization: true, code: "x" },
      })
    }),
  )

  it.effect("requires external field acknowledgements", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "External setup",
        fields: [
          { key: "authorization", type: "external", url: "https://example.com/setup", title: "Open setup" },
          { key: "name", type: "string", required: true },
        ],
      })

      const invalidAnswers: ReadonlyArray<Form.Answer> = [
        { name: "Ava" },
        { authorization: false, name: "Ava" },
        { authorization: "yes", name: "Ava" },
      ]
      for (const answer of invalidAnswers) {
        expect(yield* service.reply({ id: created.id, answer }).pipe(Effect.flip)).toEqual(
          new Form.InvalidAnswerError({
            id: created.id,
            message: "External form field must be acknowledged: authorization",
          }),
        )
      }

      yield* service.reply({ id: created.id, answer: { authorization: true, name: "Ava" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { authorization: true, name: "Ava" },
      })
    }),
  )

  it.effect("cleans up created forms when event publication fails", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Created.type ? Effect.die("create listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(Exit.isFailure(yield* Effect.exit(service.create(input)))).toBe(true)
      expect(yield* service.get(formID).pipe(Effect.flip)).toEqual(new Form.NotFoundError({ id: formID }))

      yield* unsubscribe
      expect(yield* service.create(input)).toMatchObject({ id: formID })
    }),
  )

  it.effect("keeps forms pending when reply event publication fails", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      yield* service.create(input)
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Replied.type ? Effect.die("reply listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(Exit.isFailure(yield* Effect.exit(service.reply({ id: formID, answer: { name: "Ava" } })))).toBe(true)
      expect(yield* service.state(formID)).toEqual({ status: "pending" })

      yield* unsubscribe
      yield* service.reply({ id: formID, answer: { name: "Ava" } })
      expect(yield* service.state(formID)).toEqual({ status: "answered", answer: { name: "Ava" } })
    }),
  )
})
