import { confirm, log, multiselect, password, select, text, type Option } from "@clack/prompts"
import { Effect, Schema } from "effect"
import { Form } from "@opencode/schema/form"
import { formNumberText, formNumberValue, formValidateValue } from "@opencode/tui/util/form"
import type { FormAnswer, FormField, FormFields } from "@opencode/client"
import { openUrl, prompt, requireInteractive } from "../../../ui/prompt"

const skip = Symbol("skip")
const custom = Symbol("custom")
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Form.Value))

export const answerForm = Effect.fn("cli.auth.form")(function* (
  fields: FormFields | undefined,
  input: ReadonlyArray<string> = [],
) {
  const supplied = new Map<string, string>()
  for (const item of input) {
    const separator = item.indexOf("=")
    if (separator < 1) return yield* Effect.fail(new Error("Expected --answer key=value"))
    const key = item.slice(0, separator)
    if (!fields?.some((field) => field.key === key)) {
      return yield* Effect.fail(new Error(`Unknown form field: ${key}`))
    }
    supplied.set(key, item.slice(separator + 1))
  }
  if (!fields) return undefined
  const answer: FormAnswer = {}
  for (const field of fields) {
    if (!active(field, answer)) {
      if (supplied.has(field.key)) {
        return yield* Effect.fail(new Error(`Form field is not active: ${field.key}`))
      }
      continue
    }
    const provided = supplied.get(field.key)
    const value =
      provided !== undefined
        ? yield* suppliedAnswer(field, provided)
        : field.type !== "external" && field.hidden
          ? field.default
          : yield* answerField(field)
    if (field.type !== "external") {
      const invalid = formValidateValue(field, value)
      if (invalid) return yield* Effect.fail(new Error(`${field.key}: ${invalid}`))
    }
    if (value !== undefined) answer[field.key] = value
  }
  return answer
})

const suppliedAnswer = Effect.fn("cli.auth.form.answer")(function* (field: FormField, input: string) {
  if (field.type === "external") {
    return yield* Effect.fail(new Error(`External form field requires interactive confirmation: ${field.key}`))
  }
  if (field.type === "string") return input
  const value = decodeAnswer(input)
  if (value._tag === "None") {
    return yield* Effect.fail(new Error(`Expected a JSON value for form field: ${field.key}`))
  }
  return typeof value.value === "object" ? [...value.value] : value.value
})

export const secret = Effect.fn("cli.auth.secret")(function* (message: string) {
  yield* requireInteractive("API key input requires an interactive terminal")
  return yield* prompt<string>(() => password({ message, validate: (value) => (!value ? "Required" : undefined) }))
})

const answerField = Effect.fn("cli.auth.form.field")(function* (field: FormField) {
  yield* requireInteractive("Authentication form input requires an interactive terminal")
  const message = field.title ?? field.key
  if (field.description) log.info(field.description)
  if (field.type === "external") {
    log.info(field.url)
    yield* openUrl(field.url)
    const acknowledged = yield* prompt<boolean>(() =>
      confirm({ message: message || "Continue after completing this step?", initialValue: true }),
    )
    if (!acknowledged) return yield* Effect.fail(new Error(`${message || "External step"} is required`))
    return true
  }
  if (field.type === "boolean") {
    if (field.required) return yield* prompt<boolean>(() => confirm({ message, initialValue: field.default ?? true }))
    const options: Array<Option<boolean | typeof skip>> = [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
      { value: skip, label: "Skip" },
    ]
    const value = yield* prompt<boolean | typeof skip>(() =>
      select<boolean | typeof skip>({
        message,
        options,
        initialValue: field.default ?? skip,
      }),
    )
    if (value === skip) return undefined
    return value
  }
  if (field.type === "multiselect") {
    const options: Array<Option<string | typeof custom>> = field.options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.description,
    }))
    if (field.custom) options.push({ value: custom, label: "Type another value" })
    const values = yield* prompt<Array<string | typeof custom>>(() =>
      multiselect<string | typeof custom>({
        message,
        options,
        initialValues: field.default,
        required: field.required || (field.minItems ?? 0) > 0,
      }),
    )
    const selected = values.filter((value): value is string => value !== custom)
    if (values.includes(custom)) {
      selected.push(yield* prompt<string>(() => text({ message: "Enter value", validate: required })))
    }
    if (field.minItems !== undefined && selected.length < field.minItems) {
      return yield* Effect.fail(new Error(`Select at least ${field.minItems}`))
    }
    if (field.maxItems !== undefined && selected.length > field.maxItems) {
      return yield* Effect.fail(new Error(`Select at most ${field.maxItems}`))
    }
    return selected
  }
  if (field.type === "string" && field.options) {
    const options: Array<Option<string | typeof custom | typeof skip>> = field.options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.description,
    }))
    if (field.custom) options.push({ value: custom, label: "Type your own answer" })
    if (!field.required) options.push({ value: skip, label: "Skip" })
    const value = yield* prompt<string | typeof custom | typeof skip>(() =>
      select<string | typeof custom | typeof skip>({ message, options, initialValue: field.default }),
    )
    if (value === skip) return undefined
    if (value !== custom) return value
  }
  const value = yield* prompt<string>(() =>
    text({
      message,
      placeholder: field.type === "string" ? field.placeholder : undefined,
      initialValue:
        field.default === undefined
          ? undefined
          : typeof field.default === "number"
            ? formNumberText(field.default)
            : String(field.default),
      validate: (input) => validateText(field, input),
    }),
  )
  if (!value && !field.required) return undefined
  if (field.type === "string") return value
  return formNumberValue(value)
})

function active(field: FormField, answer: FormAnswer) {
  if (field.type === "external" || !field.when) return true
  return field.when.every((condition) => {
    const value = answer[condition.key]
    if (value === undefined) return false
    const matches = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value
    return condition.op === "eq" ? matches : !matches
  })
}

function required(value: string | undefined) {
  return value ? undefined : "Required"
}

export function validateText(field: Exclude<FormField, { type: "boolean" | "external" | "multiselect" }>, value?: string) {
  if (!value) return field.required ? "Required" : undefined
  if (field.type === "number" || field.type === "integer") {
    if (!value.trim()) return field.required ? "Required" : undefined
    const number = formNumberValue(value)
    if (number === undefined || !Number.isFinite(number)) return "Expected a number"
    if (field.type === "integer" && !Number.isInteger(number)) return "Expected an integer"
    if (typeof field.minimum === "number" && number < field.minimum) return `Must be at least ${field.minimum}`
    if (typeof field.maximum === "number" && number > field.maximum) return `Must be at most ${field.maximum}`
    return undefined
  }
  if (field.minLength !== undefined && value.length < field.minLength)
    return `Must be at least ${field.minLength} characters`
  if (field.maxLength !== undefined && value.length > field.maxLength)
    return `Must be at most ${field.maxLength} characters`
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) return "Invalid format"
    } catch {
      return "Invalid format"
    }
  }
  if (field.format === "uri" && !URL.canParse(value)) return "Expected a URL"
  if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Expected an email address"
  if (field.format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Expected a date"
    const date = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "Expected a date"
  }
  if (field.format === "date-time" && !validDateTime(value)) return "Expected a date and time"
  return undefined
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

function validDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  // Date parsing rolls calendar-overflow days into the next month instead of failing, so an
  // ISO date part must round-trip through a real calendar date (matching core isDateTime).
  // Values without an ISO date part keep the existing lenient behaviour.
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
