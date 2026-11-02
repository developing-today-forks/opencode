export * as ModelRouteLimits from "./model-route-limits.js"

/** What a provider said about its rate-limit windows on one response. Header values stay as the
 * provider wrote them (counts, durations such as "6m0s", or timestamps) so the record is exact;
 * `limit`, `remaining` and `reset` are keyed by window ("requests", "tokens", "input-tokens"...). */
export interface Snapshot {
  /** When the response arrived, ms since the epoch. Reset values are relative to this. */
  readonly at: number
  readonly limit?: Readonly<Record<string, string>>
  readonly remaining?: Readonly<Record<string, string>>
  readonly reset?: Readonly<Record<string, string>>
  readonly retryAfterMs?: number
}

export interface Details {
  readonly limit?: Readonly<Record<string, string>> | undefined
  readonly remaining?: Readonly<Record<string, string>> | undefined
  readonly reset?: Readonly<Record<string, string>> | undefined
  readonly retryAfterMs?: number | undefined
}

/** A snapshot of the details, or undefined when the response advertised none. */
export const snapshot = (details: Details | undefined, at: number): Snapshot | undefined => {
  if (!details) return undefined
  const present = (value: Readonly<Record<string, string>> | undefined) =>
    value && Object.keys(value).length > 0 ? value : undefined
  const limit = present(details.limit)
  const remaining = present(details.remaining)
  const reset = present(details.reset)
  if (!limit && !remaining && !reset && details.retryAfterMs === undefined) return undefined
  return {
    at,
    ...(limit ? { limit } : {}),
    ...(remaining ? { remaining } : {}),
    ...(reset ? { reset } : {}),
    ...(details.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
  }
}

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Date.parse with a calendar check, shared by every quota-reset parser in this surface
 * (resetMs, resetAtFromMessage here, ModelRouteTuning.parseQuotaReset): Date.parse silently
 * rolls overflow days such as Feb 30 into the next month instead of returning NaN, so an
 * ISO date's components must round-trip through a real calendar date (the same check
 * Model.parseReleaseDate makes) before the parsed instant is trusted. */
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

export const parseAbsoluteTime = (text: string): number | undefined => {
  const date = Date.parse(text)
  if (Number.isNaN(date)) return undefined
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  const parts = iso ? ([Number(iso[1]), Number(iso[2]), Number(iso[3])] as const) : namedDateParts(text)
  if (parts) {
    const [year, month, day] = parts
    const probe = new Date(0)
    probe.setUTCFullYear(year, month - 1, day)
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day)
      return undefined
  }
  // V8 rolls hour 24 into the next day instead of returning NaN (minutes/seconds 60+ are
  // Invalid), so a time part must not carry hour > 23 (RFC 3339 time-hour is 00-23).
  const time = /[T ](\d{2}):\d{2}/i.exec(text)
  if (time && Number(time[1]) > 23) return undefined
  return date
}

/** Milliseconds until a reset, from the forms providers use: a duration ("1s", "6m0s", "250ms",
 * "1h2m3.5s"), plain seconds, or a timestamp. Undefined when the value is none of those. */
export const resetMs = (value: string, at: number): number | undefined => {
  const text = value.trim()
  if (text === "") return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1_000
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) {
    let total = 0
    for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) total += Number(amount) * UNITS[unit]
    return total
  }
  const date = parseAbsoluteTime(text)
  return date === undefined ? undefined : Math.max(0, date - at)
}

// The zone designator is part of the capture: dropping it would make Date.parse read a
// "…T00:00:00Z" timestamp as local time, shifting the instant by the reader's UTC offset.
// The one absolute-time keyword set both quota-reset parsers accept (this parser and
// ModelRouteTuning.parseQuotaReset, which shares this pattern): a message honoured by one
// door must be honoured by the other. The filler between the keyword and the date also
// allows hyphens, so a hyphenated non-date word ("reset at not-a-date 2026-01-02...") does
// not break the match before the real date.
export const ABSOLUTE_TIME =
  /(?:retry|try again|wait|back|resume|reset|returns?|available|until|expires?(?: at)?)[-a-z ]{0,20}(?:after|at|on|by)?\s*(\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?)/

// A relative wait is one amount+unit part or a compound sequence of them ("in 1 hour 30
// minutes"), and an amount may be decimal ("in 1.5 hours") — providers phrase resets both
// ways, and some use compact units ("resets in 6d 13h"). The letter units are safe here:
// every part must start with an amount and the (?![a-z]) guard keeps a unit from matching
// the head of a following word ("in 5 deals" states no wait).
const RELATIVE_PART = String.raw`\d+(?:\.\d+)?\s*(?:second|minute|hour|day|sec|h|d|s)s?(?![a-z])`
const RELATIVE_TIME = new RegExp(String.raw`in\s+(${RELATIVE_PART}(?:[\s,]+(?:and\s+)?${RELATIVE_PART})*)`)
const RELATIVE_PARTS = /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|sec|h|d|s)s?(?![a-z])/g
const RELATIVE_UNITS = {
  second: 1_000,
  sec: 1_000,
  s: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  h: 3_600_000,
  day: 86_400_000,
  d: 86_400_000,
} as Record<string, number>

/** The total wait a relative phrase states, summed over its parts; undefined when it states none. */
const relativeMs = (message: string): number | undefined => {
  const sequence = RELATIVE_TIME.exec(message)?.[1]
  if (!sequence) return undefined
  let total = 0
  for (const [, amount, unit] of sequence.matchAll(RELATIVE_PARTS))
    total += Number(amount) * (RELATIVE_UNITS[unit] ?? 1_000)
  return total
}

/**
 * The instant a provider said a limit returns, from the text of its error or a user's note: an
 * absolute time ("reset at 2026-01-01T00:00:00Z", "back on 2026-01-01") or a relative one ("in 3
 * hours"). Undefined when the text states no time. Absolute times are honoured as written.
 */
export const resetAtFromMessage = (message: string | undefined, now: number): number | undefined => {
  if (!message) return undefined
  // Scan every absolute candidate: an unparseable first date (e.g. month 13) must not shadow
  // a later valid reset stated in the same message.
  for (const [, absolute] of message.toLowerCase().matchAll(new RegExp(ABSOLUTE_TIME.source, "g"))) {
    const date = parseAbsoluteTime(absolute)
    if (date !== undefined) return date
  }
  const relative = relativeMs(message.toLowerCase())
  return relative === undefined ? undefined : now + relative
}

/**
 * A wait time a provider stated in the text of its error, for cases where the headers say nothing.
 * Never negative: an absolute time in the past means no wait at all.
 */
export const retryHintFromMessage = (message: string | undefined, now: number): number | undefined => {
  const at = resetAtFromMessage(message, now)
  return at === undefined ? undefined : Math.max(0, at - now)
}

/** Deliberate invariants, not settings knobs (#1424): per-window rate-limit holds stay
 * bounded by provider-window semantics, not by the quota-gate ceiling. MAX_WINDOW_MS caps how
 * far one window's stated reset may hold a target (a day — windows roll over far sooner than
 * quota grants), and UNKNOWN_RESET_MS is the assumed hold for an emptied window that states
 * no reset (a minute — the next request may well fit, unlike the quota gate's 30-minute
 * fallback for an exhaustion reading with no usable reset). Wiring either to
 * quotaGate.maxMs/fallbackMs would conflate the two mechanisms. */
const MAX_WINDOW_MS = 86_400_000
/** With nothing said about when it resets, an emptied window is assumed to last this long. */
const UNKNOWN_RESET_MS = 60_000
/** A window with this fraction or less of its allowance left counts as spent. */
export const NEAR_FRACTION = 0.05

export interface Window {
  readonly name: string
  readonly remaining: number
  readonly limit: number | undefined
  /** When the window resets, ms since the epoch; undefined when the provider didn't say. */
  readonly resetAt: number | undefined
}

// Counts are plain unsigned decimals — digits with an optional fraction, the
// grammar the sibling numeric-header parsers already enforce (the ai
// executor's retry-after grammars, SpeechStream.headerUsage). Bare Number()
// also reinterprets hex/binary/octal/exponent/signed spellings (#711):
// "0x0" would read as a spent window and bench the target, "1e3" and "0x64"
// would fabricate the near-empty fraction. A non-plain spelling is
// unparseable here, exactly like "lots": the window drops / the limit is
// undefined.
const PLAIN_COUNT = /^\d+(?:\.\d+)?$/
const plainCount = (raw: string | undefined): number => {
  if (raw === undefined) return Number.NaN
  const text = raw.trim()
  return PLAIN_COUNT.test(text) ? Number(text) : Number.NaN
}

/** The windows a snapshot describes, with numbers parsed. */
export const windows = (value: Snapshot): Window[] =>
  Object.entries(value.remaining ?? {}).flatMap(([name, raw]) => {
    if (raw.trim() === "") return []
    const remaining = plainCount(raw)
    if (!Number.isFinite(remaining)) return []
    const limitValue = Object.hasOwn(value.limit ?? {}, name) ? value.limit?.[name] : undefined
    const resetValue = Object.hasOwn(value.reset ?? {}, name) ? value.reset?.[name] : undefined
    const limit = plainCount(limitValue)
    const reset = resetValue === undefined ? undefined : resetMs(resetValue, value.at)
    return [
      {
        name,
        remaining,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        resetAt: reset === undefined ? undefined : value.at + reset,
      },
    ]
  })

/** The latest future reset among this fresh snapshot's actually exhausted windows. A nearby
 * unexhausted window is not evidence of when a quota failure can recover. */
export const exhaustedWindowResetAt = (value: Snapshot, now: number, maxAgeMs: number): number | undefined => {
  if (value.at > now || now - value.at > maxAgeMs) return undefined
  const resets = windows(value).flatMap((window) =>
    window.remaining <= 0 && window.resetAt !== undefined && window.resetAt > now ? [window.resetAt] : [],
  )
  return resets.length > 0 ? Math.max(...resets) : undefined
}

/**
 * When the provider's own numbers say a target should be left alone until: a window that is empty,
 * or nearly so with a stated reset, holds the target back until it resets. Zero when nothing needs
 * waiting for. An empty window with no stated reset is held for a minute; a nearly empty one with no
 * stated reset is not held, since the next request may well fit.
 */
export const holdUntil = (value: Snapshot, now: number, near = NEAR_FRACTION) => {
  let until = 0
  if (value.retryAfterMs !== undefined) until = Math.max(until, value.at + value.retryAfterMs)
  for (const window of windows(value)) {
    const empty = window.remaining <= 0
    const nearlyEmpty = window.limit !== undefined && window.remaining / window.limit <= near
    if (!empty && !nearlyEmpty) continue
    if (window.resetAt !== undefined) until = Math.max(until, window.resetAt)
    else if (empty) until = Math.max(until, value.at + UNKNOWN_RESET_MS)
  }
  return until > now ? Math.min(until, now + MAX_WINDOW_MS) : 0
}
