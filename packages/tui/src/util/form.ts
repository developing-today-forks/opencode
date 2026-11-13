import type { FormField, FormValue } from "@opencode/client"

export type FormAnswerField = Exclude<FormField, { type: "external" }>

export type FormRow = {
  value: string | boolean
  label: string
  description?: string
}

export function isFormAnswerField(field: FormField): field is FormAnswerField {
  return field.type !== "external"
}

export function formLabel(field: FormField) {
  return field.title ?? (field.type === "external" ? field.url : field.key)
}

export function formInitialValues(fields: ReadonlyArray<FormField>) {
  return {
    answers: Object.fromEntries(
      fields.flatMap((field) =>
        isFormAnswerField(field) && field.default !== undefined ? [[field.key, field.default]] : [],
      ),
    ) as Record<string, FormValue | undefined>,
    custom: Object.fromEntries(
      fields.flatMap((field) => {
        if (field.type !== "string" || !field.options || !field.custom || typeof field.default !== "string") return []
        if (field.options.some((option) => option.value === field.default)) return []
        return [[field.key, field.default]]
      }),
    ) as Record<string, string>,
  }
}

export function formTextual(field: FormField | undefined) {
  if (!field) return false
  return field.type === "number" || field.type === "integer" || (field.type === "string" && !field.options)
}

export function formCustom(field: FormField | undefined) {
  if (!field) return false
  if (field.type === "string" && field.options) return field.custom === true
  return field.type === "multiselect" && field.custom === true
}

export function formRows(field: FormField | undefined): FormRow[] {
  if (!field) return []
  if (field.type === "boolean")
    return [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ]
  const options = field.type === "multiselect" ? field.options : field.type === "string" ? field.options : undefined
  if (!options) return []
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }))
}

export function formSelected(field: FormField | undefined, value: FormValue | undefined) {
  if (!field || value === undefined || Array.isArray(value)) return 0
  const rows = formRows(field)
  const index = rows.findIndex((row) => row.value === value)
  if (index !== -1) return index
  if (typeof value === "string" && formCustom(field)) return rows.length
  return 0
}

/** Convert typed text for a number/integer field with the strict plain-decimal
 * grammar /^-?\d+(?:\.\d+)?$/ (the #682/#711 precedent family, as in
 * ToolInputRepair), applied to the trimmed text. Empty/whitespace text yields
 * undefined, so a required field reports "Answer required" and an optional
 * field is skipped; any other non-decimal spelling ("0x10", "0b101", "1e3",
 * "Infinity", "+1", ".5") yields NaN, which the validators report as
 * "Expected a number", instead of the different value bare Number() would
 * silently reinterpret it as (#844). Integer-ness stays with the validators:
 * "1.5" converts to 1.5 and they report "Expected an integer". */
export function formNumberValue(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/** Render a numeric value as plain-decimal text that formNumberValue accepts.
 * String(value) uses exponent notation outside the plain-decimal range
 * (String(1e-7) is "1e-7", String(1e21) is "1e+21"), so a numeric default
 * pre-filled with String(field.default) could not be confirmed unchanged
 * once #844 made typed answers parse with the strict grammar (#1065).
 * Expand the exponent spelling into the equivalent plain-decimal text;
 * the value itself is unchanged, and typed exponent spellings stay
 * rejected because formNumberValue is untouched. */
export function formNumberText(value: number): string {
  const text = String(value)
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text)
  if (!match) return text
  const digits = match[2] + (match[3] ?? "")
  const point = match[2].length + Number(match[4])
  if (point <= 0) return `${match[1]}0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return `${match[1]}${digits}${"0".repeat(point - digits.length)}`
  return `${match[1]}${digits.slice(0, point)}.${digits.slice(point)}`
}

export function formValidateValue(field: FormAnswerField, value: FormValue | undefined): string | undefined {
  if (value === undefined) return field.required ? "Answer required" : undefined
  if (field.required && (value === "" || (Array.isArray(value) && value.length === 0)))
    return field.type === "multiselect" ? "Select at least one option" : "Answer required"
  if (field.type === "string") {
    if (typeof value !== "string") return "Expected text"
    if (field.minLength !== undefined && value.length < field.minLength)
      return `Must be at least ${field.minLength} characters`
    if (field.maxLength !== undefined && value.length > field.maxLength)
      return `Must be at most ${field.maxLength} characters`
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Must match pattern: ${field.pattern}`
      } catch {
        return `Invalid pattern: ${field.pattern}`
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Expected an email address"
    if (field.format === "uri" && !validURL(value)) return "Expected a URL"
    if (field.format === "date" && !validDate(value)) return "Expected a date (YYYY-MM-DD)"
    if (field.format === "date-time" && !validDateTime(value)) return "Expected a date and time"
    if (field.options && !field.custom && !field.options.some((option) => option.value === value))
      return "Select an available option"
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Expected a number"
    if (field.type === "integer" && !Number.isInteger(value)) return "Expected an integer"
    if (typeof field.minimum === "number" && value < field.minimum) return `Must be at least ${field.minimum}`
    if (typeof field.maximum === "number" && value > field.maximum) return `Must be at most ${field.maximum}`
    return
  }
  if (field.type === "boolean") return typeof value === "boolean" ? undefined : "Expected yes or no"
  if (!Array.isArray(value)) return "Expected selections"
  if (field.minItems !== undefined && value.length < field.minItems) return `Select at least ${field.minItems}`
  if (field.maxItems !== undefined && value.length > field.maxItems) return `Select at most ${field.maxItems}`
  if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item)))
    return "Select only available options"
}

export function formDisplayValue(field: FormAnswerField, value: FormValue | undefined, emptyMultiselect: string) {
  if (value === undefined) return ""
  const label = (item: string | number | boolean) =>
    formRows(field).find((row) => row.value === item)?.label ??
    (typeof item === "number" ? formNumberText(item) : String(item))
  if (Array.isArray(value)) return value.length === 0 ? emptyMultiselect : value.map(label).join(", ")
  return label(value)
}

export function formToggleMultiselect(value: FormValue | undefined, item: string) {
  const values = Array.isArray(value) ? value : []
  const index = values.indexOf(item)
  return index === -1 ? [...values, item] : values.toSpliced(index, 1)
}

export function formSetMultiselectCustom(value: FormValue | undefined, previous: string | undefined, next: string) {
  const values = Array.isArray(value) ? value : []
  const index = previous ? values.indexOf(previous) : -1
  const current = index === -1 ? [...values] : values.toSpliced(index, 1)
  return next && !current.includes(next) ? [...current, next] : current
}

function validURL(value: string) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
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

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
