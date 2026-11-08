export * as Form from "./form.js"

import { Form } from "@opencode/schema/form"
import { Cache, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "./bus.js"

const RETENTION = Duration.minutes(10)

export const ID = Form.ID
export type ID = typeof ID.Type

export const Info = Form.Info
export type Info = typeof Info.Type

export const Field = Form.Field
export type Field = Form.Field

export const Fields = Form.Fields
export type Fields = Form.Fields

export const When = Form.When
export type When = Form.When

export const State = Form.State
export type State = typeof State.Type
export type TerminalState = Exclude<State, { readonly status: "pending" }>

export const Answer = Form.Answer
export type Answer = typeof Answer.Type

export const Reply = Form.Reply
export type Reply = typeof Reply.Type

export { Event } from "@opencode/schema/form"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Form.NotFoundError", {
  id: ID,
}) {
  override get message() {
    return `Form not found: ${this.id}`
  }
}

export class AlreadySettledError extends Schema.TaggedError<AlreadySettledError>()("Form.AlreadySettledError", {
  id: ID,
}) {
  override get message() {
    return `Form already settled: ${this.id}`
  }
}

export class AlreadyExistsError extends Schema.TaggedError<AlreadyExistsError>()("Form.AlreadyExistsError", {
  id: ID,
}) {
  override get message() {
    return `Form already exists: ${this.id}`
  }
}

export class InvalidAnswerError extends Schema.TaggedError<InvalidAnswerError>()("Form.InvalidAnswerError", {
  id: ID,
  message: Schema.String,
}) {}

export class InvalidFormError extends Schema.TaggedError<InvalidFormError>()("Form.InvalidFormError", {
  message: Schema.String,
}) {}

export type CreateInput = Omit<Form.Info, "id"> & { readonly id?: ID }

export interface ReplyInput {
  readonly id: ID
  readonly answer: Answer
}

export interface CancelOptions {
  readonly message?: string
}

export interface ListInput {
  readonly sessionID?: Form.Info["sessionID"]
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly create: (input: CreateInput) => Effect.Effect<Info, AlreadyExistsError | InvalidFormError>
  readonly ask: (input: CreateInput) => Effect.Effect<TerminalState, AlreadyExistsError | InvalidFormError>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly state: (id: ID) => Effect.Effect<State, NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  readonly cancel: (id: ID, options?: CancelOptions) => Effect.Effect<void, AlreadySettledError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Form") {}

interface Entry {
  readonly form: Info
  readonly state: State
  readonly deferred: Deferred.Deferred<TerminalState>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    let closed = false
    const forms = yield* Cache.makeWith<ID, Entry>(
      () => Effect.die(new Error("Form cache must be used via set/getSuccess, never get")),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.state.status === "pending" ? Duration.infinity : RETENTION,
      },
    )

    const requireEntry = Effect.fn("Form.requireEntry")((id: ID) =>
      Cache.getSuccess(forms, id).pipe(
        Effect.flatMap((entry) => Effect.fromOption(entry, () => new NotFoundError({ id }))),
      ),
    )

    const create = Effect.fn("Form.create")((input: CreateInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const id = input.id ?? ID.create()
          const existing = yield* Cache.getSuccess(forms, id)
          if (Option.isSome(existing)) return yield* new AlreadyExistsError({ id })
          const invalid = validateFields(input.fields)
          if (invalid) return yield* new InvalidFormError({ message: invalid })
          const form: Info = {
            id,
            sessionID: input.sessionID,
            title: input.title,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            fields: input.fields,
          }
          const entry: Entry = {
            form,
            state: { status: "pending" },
            deferred: yield* Deferred.make<TerminalState>(),
          }
          yield* Cache.set(forms, id, entry)
          yield* bus.publish(Form.Event.Created, { form }).pipe(Effect.onError(() => Cache.invalidate(forms, id)))
          if (closed) yield* cancel(id).pipe(Effect.orDie)
          return form
        }),
      ),
    )

    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const form = yield* create(input)
          const entry = yield* requireEntry(form.id).pipe(Effect.orDie)
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.onInterrupt(() => Effect.ignore(cancel(form.id))),
          )
        }),
      ),
    )

    const get = Effect.fn("Form.get")(function* (id: ID) {
      return (yield* requireEntry(id)).form
    })

    const list = Effect.fn("Form.list")(function* (input?: ListInput) {
      const entries = yield* Cache.values(forms)
      return Array.from(entries)
        .filter((entry) => entry.state.status === "pending")
        .filter((entry) => input?.sessionID === undefined || entry.form.sessionID === input.sessionID)
        .map((entry) => entry.form)
    })

    const state = Effect.fn("Form.state")(function* (id: ID) {
      return (yield* requireEntry(id)).state
    })

    const reply = Effect.fn("Form.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = yield* requireEntry(input.id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id: input.id })
          const invalid = validateAnswer(entry.form.fields, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          const next: TerminalState = { status: "answered", answer: input.answer }
          yield* bus.publish(Form.Event.Replied, {
            id: input.id,
            sessionID: entry.form.sessionID,
            answer: input.answer,
          })
          yield* Cache.set(forms, input.id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    const cancel = Effect.fn("Form.cancel")((id: ID, options?: CancelOptions) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = yield* requireEntry(id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id })
          const next: TerminalState = {
            status: "cancelled",
            ...(options?.message === undefined ? {} : { message: options.message }),
          }
          yield* bus.publish(Form.Event.Cancelled, { id, sessionID: entry.form.sessionID })
          yield* Cache.set(forms, id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    const close = Effect.sync(() => {
      closed = true
    }).pipe(
      Effect.andThen(Cache.values(forms)),
      Effect.flatMap((entries) =>
        Effect.forEach(
          Array.from(entries).filter((entry) => entry.state.status === "pending"),
          (entry) => cancel(entry.form.id).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
    yield* Effect.addFinalizer(() => close)

    return Service.of({ create, ask, get, list, state, reply, cancel, close })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node] })

export function validateAnswer(form: ReadonlyArray<Form.Field>, answer: Answer) {
  const fields = new Map(form.map((field) => [field.key, field] as const))
  for (const key of Object.keys(answer)) {
    if (!fields.has(key)) return `Unknown form field: ${key}`
  }
  for (const field of form) {
    const value = answer[field.key]
    if (field.type === "external") {
      if (value !== true) return `External form field must be acknowledged: ${field.key}`
      continue
    }
    const active = isActive(field, answer)
    if (value === undefined) {
      if (field.required && active) return `Missing required form field: ${field.key}`
      continue
    }
    if (!active) return `Form field is not active: ${field.key}`
    const invalid = validateField(field, value)
    if (invalid) return invalid
  }
}

type InputField = Exclude<Form.Field, Form.ExternalField>

function isActive(field: InputField, answer: Answer) {
  if (!field.when) return true
  return field.when.every((when) => matches(when, answer[when.key]))
}

// An unanswered referenced field makes the condition false for both ops. Combined with inactive
// fields being unanswerable, this cascades: hiding a field falsifies every condition referencing it.
function matches(when: Form.When, value: Form.Value | undefined) {
  if (value === undefined) return false
  const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value
  return when.op === "eq" ? hit : !hit
}

// Create-time validation of field definitions and `when` references: a field's own bounds must
// be satisfiable (min <= max, enough options for minItems, an integer inside an integer range)
// and a string pattern must compile, and each `when` condition must point at an earlier field,
// carry a value matching that field's type, and use a declared option when the field's options
// are closed. Rejecting these at creation surfaces authoring mistakes to the caller instead of
// silently never matching.
export function validateFields(fields: ReadonlyArray<Form.Field>) {
  if (fields.length === 0) return "Form must have at least one field"
  const earlier = new Map<string, Form.Field>()
  const keys = new Set<string>()
  for (const field of fields) {
    if (keys.has(field.key)) return `Duplicate form field key: ${field.key}`
    keys.add(field.key)
    // External fields count as defined for `when` references too (as they already do for
    // duplicate keys): an acknowledgement is a boolean answer, so a field may gate on it.
    if (field.type === "external") {
      earlier.set(field.key, field)
      continue
    }
    if (field.type === "string") {
      if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength)
        return `Form field has minLength greater than maxLength: ${field.key}`
      // A required string needs at least one character: with maxLength 0 the
      // empty answer is missing-required and any non-empty answer is too long.
      if (field.required && field.maxLength === 0)
        return `Form field has maxLength 0 but is required: ${field.key}`
      // A required string with a closed empty options list has no valid
      // answer: the empty answer is missing-required and any other value is
      // not one of the (zero) declared options.
      if (field.required && field.options !== undefined && !field.custom && field.options.length === 0)
        return `Form field has no options but is required: ${field.key}`
      if (field.pattern !== undefined) {
        try {
          new RegExp(field.pattern)
        } catch {
          return `Form field has invalid pattern: ${field.key}`
        }
      }
    }
    if (field.type === "number" || field.type === "integer") {
      if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
        return `Form field has minimum greater than maximum: ${field.key}`
      // An integer range that contains no integer (1.2..1.8) passes the pairwise check
      // but no answer can ever satisfy it: integers below the range are too small,
      // integers above it are too large, and non-integers are rejected outright.
      if (
        field.type === "integer" &&
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        Math.ceil(field.minimum) > Math.floor(field.maximum)
      )
        return `Form field range contains no integer: ${field.key}`
    }
    if (field.type === "multiselect") {
      if (field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems)
        return `Form field has minItems greater than maxItems: ${field.key}`
      // A closed multiselect's answers may only contain declared options, so asking
      // for more selections than there are options can never be satisfied.
      if (!field.custom && field.minItems !== undefined && field.minItems > field.options.length)
        return `Form field has minItems greater than its number of options: ${field.key}`
      // A required multiselect needs at least one selection: with maxItems 0
      // the empty answer is missing-required and any selection is too many.
      if (field.required && field.maxItems === 0)
        return `Form field has maxItems 0 but is required: ${field.key}`
      // A required closed multiselect with no options has no valid answer:
      // the empty answer is missing-required and any selection is not one of
      // the (zero) declared options.
      if (field.required && !field.custom && field.options.length === 0)
        return `Form field has no options but is required: ${field.key}`
    }
    for (const when of field.when ?? []) {
      const target = earlier.get(when.key)
      if (!target) return `Form field condition must reference an earlier field: ${field.key} -> ${when.key}`
      const invalid = validateWhen(when, target)
      if (invalid) return `${invalid}: ${field.key} -> ${when.key}`
    }
    earlier.set(field.key, field)
  }
}

function validateWhen(when: Form.When, target: Form.Field) {
  // External targets are boolean too, but their only answerable value is the `true`
  // acknowledgement (validateAnswer rejects everything else), so `eq`/`false` and
  // `neq`/`true` are constant-false in `matches` and the gated field could never
  // activate — the same never-answerable class as #705, #708 and #712.
  if (target.type === "boolean" || target.type === "external") {
    if (typeof when.value !== "boolean") return "Form field condition value must be a boolean"
    if (target.type === "external" && (when.op === "eq" ? when.value === false : when.value === true))
      return "Form field condition can never match the external field's acknowledgement"
    return
  }
  if (target.type === "number" || target.type === "integer") {
    if (typeof when.value !== "number") return "Form field condition value must be a number"
    // Non-finite values can never be a valid answer (validateField rejects them), so eq
    // could never match and neq would always match — the never-answerable class of #853.
    if (!Number.isFinite(when.value)) return "Form field condition value must be a finite number"
    if (target.type === "integer" && !Number.isInteger(when.value))
      return "Form field condition value must be an integer"
    if (
      (target.minimum !== undefined && when.value < target.minimum) ||
      (target.maximum !== undefined && when.value > target.maximum)
    )
      return "Form field condition value must be within the field's declared bounds"
    return
  }
  // string and multiselect targets both compare against string values
  if (typeof when.value !== "string") return "Form field condition value must be a string"
  const closed = target.type === "multiselect" ? !target.custom : target.options !== undefined && !target.custom
  if (closed) {
    if (!target.options?.some((option) => option.value === when.value)) {
      return "Form field condition value must be one of the field's options"
    }
    return
  }
  if (target.type !== "string") return
  // A non-closed string target's answers must still satisfy its own length,
  // pattern, and format constraints (the checks validateField makes), so a
  // condition value violating them can never be answered and the gate would
  // silently never match (eq) or always match (neq) — #708. The predicates
  // are validateField's own: the email regex, URL.canParse, isDate, and
  // isDateTime.
  if (target.minLength !== undefined && when.value.length < target.minLength)
    return `Form field condition value must be at least ${target.minLength} characters`
  if (target.maxLength !== undefined && when.value.length > target.maxLength)
    return `Form field condition value must be at most ${target.maxLength} characters`
  if (target.pattern !== undefined && !new RegExp(target.pattern).test(when.value))
    return "Form field condition value must match the field's pattern"
  if (target.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(when.value))
    return "Form field condition value must be an email"
  if (target.format === "uri" && !URL.canParse(when.value)) return "Form field condition value must be a URI"
  if (target.format === "date" && !isDate(when.value)) return "Form field condition value must be a date"
  if (target.format === "date-time" && !isDateTime(when.value))
    return "Form field condition value must be a date-time"
}

function validateField(field: InputField, value: Form.Value): string | undefined {
  if (field.type === "string") {
    if (typeof value !== "string") return `Expected string for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minLength !== undefined && value.length < field.minLength) return `Form field is too short: ${field.key}`
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Form field is too long: ${field.key}`
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Form field does not match pattern: ${field.key}`
      } catch {
        return `Form field has invalid pattern: ${field.key}`
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return `Expected email for form field: ${field.key}`
    if (field.format === "uri" && !URL.canParse(value)) return `Expected URI for form field: ${field.key}`
    if (field.format === "date" && !isDate(value)) return `Expected date for form field: ${field.key}`
    if (field.format === "date-time" && !isDateTime(value)) return `Expected date-time for form field: ${field.key}`
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) {
      return `Invalid option for form field: ${field.key}`
    }
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `Expected number for form field: ${field.key}`
    if (field.type === "integer" && !Number.isInteger(value)) return `Expected integer for form field: ${field.key}`
    if (field.minimum !== undefined && value < field.minimum) return `Form field is too small: ${field.key}`
    if (field.maximum !== undefined && value > field.maximum) return `Form field is too large: ${field.key}`
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `Expected boolean for form field: ${field.key}`
    return
  }
  if (field.type === "multiselect") {
    if (!isStringArray(value)) return `Expected string array for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    // Selections are distinct by definition — the create-time check for a closed
    // multiselect counts declared options, not answer entries — so a repeated
    // entry is rejected outright instead of being counted again toward
    // minItems/maxItems or checked again against the declared options.
    if (new Set(value).size !== value.length) return `Duplicate selection for form field: ${field.key}`
    if (field.minItems !== undefined && value.length < field.minItems)
      return `Too few selections for form field: ${field.key}`
    if (field.maxItems !== undefined && value.length > field.maxItems)
      return `Too many selections for form field: ${field.key}`
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) {
      return `Invalid option for form field: ${field.key}`
    }
  }
}

function isStringArray(value: Form.Value): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Calendar components of a non-ISO date whose parts are named or ordered unambiguously
 * (#798): "Feb 30 2026", "30 Feb 2026", "2026/02/30". Ambiguous numeric forms (02/03/2026)
 * and shapes without named components keep the lenient bare-parse behaviour. */
function namedDateParts(text: string): readonly [number, number, number] | undefined {
  const ymd = /(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?!\d)/.exec(text)
  if (ymd) return [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  const monthFirst =
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/i.exec(text)
  if (monthFirst)
    return [Number(monthFirst[3]), MONTH_NUMBERS[monthFirst[1].toLowerCase()], Number(monthFirst[2])]
  const dayFirst =
    /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})(?!\d)/i.exec(text)
  if (dayFirst) return [Number(dayFirst[3]), MONTH_NUMBERS[dayFirst[2].toLowerCase()], Number(dayFirst[1])]
  return undefined
}

function isDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  // Date parsing rolls calendar-overflow days into the next month instead of failing, so an
  // ISO date part must round-trip through a real calendar date (the same check isDate and
  // ModelRouteLimits.parseAbsoluteTime make). Values without an ISO date part keep the
  // existing lenient behaviour.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const parts = iso ? ([Number(iso[1]), Number(iso[2]), Number(iso[3])] as const) : namedDateParts(value)
  if (parts) {
    const [year, month, day] = parts
    const probe = new Date(0)
    probe.setUTCFullYear(year, month - 1, day)
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day)
      return false
  }
  // V8 rolls hour 24 into the next day instead of returning NaN (minutes/seconds 60+ are
  // Invalid), so a time part must not carry hour > 23 (RFC 3339 time-hour is 00-23).
  const time = /[T ](\d{2}):\d{2}/i.exec(value)
  if (time && Number(time[1]) > 23) return false
  return true
}
