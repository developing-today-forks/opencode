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
  const date = Date.parse(text)
  return Number.isNaN(date) ? undefined : Math.max(0, date - at)
}

// The zone designator is part of the capture: dropping it would make Date.parse read a
// "…T00:00:00Z" timestamp as local time, shifting the instant by the reader's UTC offset.
const ABSOLUTE_TIME =
  /(?:retry|try again|wait|back|resume|reset|returns?|until|available|expires?(?: at)?)[a-z ]{0,20}(?:after|at|on|by)?\s*(\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?)/
// A relative wait is one amount+unit part or a compound sequence of them ("in 1 hour 30
// minutes"), and an amount may be decimal ("in 1.5 hours") — providers phrase resets both ways.
const RELATIVE_PART = String.raw`\d+(?:\.\d+)?\s*(?:second|minute|hour|day|sec|s)s?(?![a-z])`
const RELATIVE_TIME = new RegExp(String.raw`in\s+(${RELATIVE_PART}(?:[\s,]+(?:and\s+)?${RELATIVE_PART})*)`)
const RELATIVE_PARTS = /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|sec|s)s?(?![a-z])/g
const RELATIVE_UNITS = { second: 1_000, sec: 1_000, s: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as Record<
  string,
  number
>

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
  const absolute = ABSOLUTE_TIME.exec(message.toLowerCase())?.[1]
  if (absolute) {
    const date = Date.parse(absolute)
    if (!Number.isNaN(date)) return date
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

/** The windows a snapshot describes, with numbers parsed. */
export const windows = (value: Snapshot): Window[] =>
  Object.entries(value.remaining ?? {}).flatMap(([name, raw]) => {
    const remaining = Number(raw)
    if (!Number.isFinite(remaining)) return []
    const limit = Number(value.limit?.[name])
    const reset = value.reset?.[name] === undefined ? undefined : resetMs(value.reset[name], value.at)
    return [
      {
        name,
        remaining,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        resetAt: reset === undefined ? undefined : value.at + reset,
      },
    ]
  })

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
