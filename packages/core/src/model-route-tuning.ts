export * as ModelRouteTuning from "./model-route-tuning.js"

import { Duration, Effect, Option } from "effect"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { ModelRoute } from "./model-route.js"
import { ModelRouteLog, type ErrorBreakdown, type HourlyStat, type TargetStats } from "./model-route-log.js"
import { ModelRouteLimits } from "./model-route-limits.js"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"

/** Adjustments the routing history argues for. Deterministic and conservative: they only ever
 * lower a target's share or skip it, they expire on their own, and each is replaced (same id) by
 * the next run instead of piling up. Anything cleverer is left to the agent reading the same data. */
export interface Input {
  readonly stats: readonly TargetStats[]
  readonly errors: readonly ErrorBreakdown[]
  readonly now: number
  /** Minimum attempts before a target's record is judged. */
  readonly minAttempts?: number
  /** How long a suggested adjustment lasts. */
  readonly holdMs?: number
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const targetKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`

/** The furthest out a stated quota reset may skip a target. Provider error text is untrusted
 * input, and a user note is only a hint: a reset stated further than this — a year-9999
 * timestamp, "in 100000 days" — is a runaway value, not a schedule, so it is bounded to this
 * ceiling instead of benching the target effectively forever (or, past the Date range,
 * throwing when the instant is rendered). Resets within the ceiling are honoured as written.
 * The default is today's behavior; the value in force follows the quota gate
 * (ModelRoute.currentConstants().quotaGate.maxMs), so a non-default gate ceiling moves the
 * tuning predictions with it instead of silently disagreeing. */
export const MAX_QUOTA_RESET_MS = 30 * 86_400_000

/** The quota-reset ceiling in force: an explicit override wins, otherwise the configured
 * quota-gate ceiling, which is the single source of truth both the gate and the tuning
 * predictions bound stated resets by. */
export const quotaResetCeilingMs = (override?: number, location?: string): number => {
  if (override !== undefined) return override
  return ModelRoute.currentConstants(location).quotaGate.maxMs
}

export const suggest = (input: Input): ModelRoute.Adjustment[] => {
  const minAttempts = input.minAttempts ?? 5
  const holdMs = input.holdMs ?? 30 * 60_000
  const until = input.now + holdMs
  const result: ModelRoute.Adjustment[] = []
  const typicalFirstToken = median(
    input.stats.flatMap((row) => (row.avgFirstTokenMs === null ? [] : [row.avgFirstTokenMs])),
  )

  for (const row of input.stats) {
    const key = targetKey(row.providerID, row.modelID)
    const base = { id: `auto:${key}`, match: key, until }
    const quotaFailures = input.errors
      .filter(
        (error) =>
          error.providerID === row.providerID && error.modelID === row.modelID && error.tag === "QuotaExceeded",
      )
      .reduce((sum, error) => sum + error.count, 0)
    if (quotaFailures > 0) {
      result.push({ ...base, action: "skip", note: `${quotaFailures} quota-exceeded failures in the window` })
      continue
    }
    if (row.attempts < minAttempts) continue
    const failureRate = row.failures / row.attempts
    if (failureRate >= 0.5) {
      result.push({
        ...base,
        action: "weight",
        factor: 0.1,
        note: `${Math.round(failureRate * 100)}% of ${row.attempts} attempts failed`,
      })
    } else if (failureRate >= 0.2) {
      result.push({
        ...base,
        action: "weight",
        factor: 0.5,
        note: `${Math.round(failureRate * 100)}% of ${row.attempts} attempts failed`,
      })
    } else if (
      typicalFirstToken !== undefined &&
      input.stats.length >= 3 &&
      row.avgFirstTokenMs !== null &&
      row.avgFirstTokenMs > typicalFirstToken * 2.5
    ) {
      result.push({
        ...base,
        action: "weight",
        factor: 0.5,
        note: `first output ${Math.round(row.avgFirstTokenMs)}ms against a typical ${Math.round(typicalFirstToken)}ms`,
      })
    }
  }
  return result
}

export interface Prediction {
  readonly target: string
  /** `busy-hour` means this target has been unreliable at this hour; `quota-reset` comes from the
   * provider's own error message; `steady` when there is no reason to think otherwise. */
  readonly state: "steady" | "busy-hour" | "quota-reset"
  readonly detail: string
  /** For `quota-reset`, when the provider said the quota comes back. */
  readonly until?: number
}

/** Reads the pattern of when each target tends to fail: a target that only fails at certain hours
 * is different from one that fails all the time. Off by default, and only confident with enough
 * attempts in the hour. */
export const predict = (input: {
  readonly hourly: readonly HourlyStat[]
  readonly errors: readonly ErrorBreakdown[]
  readonly now: number
  readonly minHourlyAttempts?: number
  readonly hourRatio?: number
  readonly minHourlySamples?: number
  /** Overrides the quota-reset ceiling; defaults to the configured quota-gate ceiling. */
  readonly maxResetMs?: number
  /** The Location directory whose quota gate judges the ceiling (#1461): without it the
   * unscoped read falls back to the defaults when several Locations are registered,
   * instead of borrowing whichever Location registered last. */
  readonly location?: string
}): Prediction[] => {
  const minAttempts = input.minHourlyAttempts ?? 5
  const ratio = input.hourRatio ?? 2
  const minSamples = input.minHourlySamples ?? 3
  const maxResetMs = quotaResetCeilingMs(input.maxResetMs, input.location)
  const hour = new Date(input.now).getUTCHours()
  const result: Prediction[] = []
  const byTarget = new Map<string, HourlyStat[]>()
  for (const row of input.hourly) {
    const key = `${row.providerID}/${row.modelID}`
    byTarget.set(key, [...(byTarget.get(key) ?? []), row])
  }
  for (const [target, rows] of byTarget) {
    // The baseline is this target at every other hour: including the hour being judged would
    // inflate it and hide exactly the spike being looked for.
    const other = rows.filter((row) => row.hour !== hour)
    const baselineTotal = other.reduce((sum, row) => sum + row.attempts, 0)
    const baseline = baselineTotal === 0 ? 0 : other.reduce((sum, row) => sum + row.failures, 0) / baselineTotal
    const atHour = rows.filter((row) => row.hour === hour)
    const attempts = atHour.reduce((sum, row) => sum + row.attempts, 0)
    const failures = atHour.reduce((sum, row) => sum + row.failures, 0)
    const rate = failures / attempts
    // Enough attempts in this hour, and enough history elsewhere, to say anything.
    if (attempts < minAttempts || baselineTotal < minSamples) continue
    if (rate > Math.max(0.05, baseline * ratio))
      result.push({
        target,
        state: "busy-hour",
        detail: `${Math.round(rate * 100)}% of ${attempts} attempts failed at hour ${hour}, against ${Math.round(baseline * 100)}% at other hours`,
      })
  }
  for (const error of input.errors) {
    const target = `${error.providerID}/${error.modelID}`
    const stated = ModelRouteLimits.resetAtFromMessage(error.lastMessage ?? undefined, input.now)
    if (!stated) continue
    // Bound before the detail is built: an out-of-Date-range stated reset would throw in
    // toISOString and void the whole review, and a merely absurd one would bench the target.
    const ceiling = input.now + maxResetMs
    const capped = stated > ceiling
    const reset = capped ? ceiling : stated
    const prior = result.find((entry) => entry.target === target)
    if (prior) continue
    result.push({
      target,
      state: "quota-reset",
      // Say which it is: route_stats shows this line, so a capped prediction must not read as
      // the provider's own stated reset.
      detail: capped
        ? `provider message states a reset past the ${maxResetMs / 86_400_000}-day ceiling; predicting ${new Date(reset).toISOString()}`
        : `provider message says the quota returns ${new Date(reset).toISOString()}`,
      until: reset,
    })
  }
  return result
}

/**
 * When a provider says a quota comes back, from the text of its error. Two forms are read: an
 * absolute time ("resets at 2026-01-01T00:00:00Z", "back at 2026-01-01") and a relative one
 * ("in 3 hours", "in 30 minutes", "in 45s"). Nothing else is guessed at.
 */
export const parseQuotaReset = (
  message: string | undefined,
  now: number,
  maxResetMs?: number,
  location?: string,
): number | undefined => {
  const ceilingMs = quotaResetCeilingMs(maxResetMs, location)
  if (!message) return undefined
  const text = message.toLowerCase()
  if (!/(?:quota|limit|rate limit)/.test(text)) return undefined
  // The zone designator stays in the capture so Date.parse honours it instead of reading the
  // timestamp as local time (see ModelRouteLimits.resetAtFromMessage).
  // The absolute branch shares ModelRouteLimits.ABSOLUTE_TIME so the two parsers cannot
  // drift apart on keywords again; the quota gate above stays local to this parser.
  // Scan every absolute candidate: an unparseable first date (e.g. month 13) must not shadow
  // a later valid reset stated in the same message.
  for (const [, absolute] of text.matchAll(new RegExp(ModelRouteLimits.ABSOLUTE_TIME.source, "g"))) {
    const date = ModelRouteLimits.parseAbsoluteTime(absolute)
    if (date !== undefined) return Math.min(date, now + ceilingMs)
  }
  // The relative form mirrors ModelRouteLimits: decimal amounts ("in 1.5 hours") and compound
  // sequences ("in 1 hour 30 minutes", summed) both read as the total wait.
  const part = String.raw`\d+(?:\.\d+)?\s*(?:second|minute|hour|day|sec|s)s?(?![a-z])`
  const sequence = new RegExp(String.raw`in\s+(${part}(?:[\s,]+(?:and\s+)?${part})*)`).exec(text)?.[1]
  if (sequence) {
    const unit = { second: 1_000, sec: 1_000, s: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as Record<
      string,
      number
    >
    let total = 0
    for (const [, amount, name] of sequence.matchAll(/(\d+(?:\.\d+)?)\s*(second|minute|hour|day|sec|s)s?(?![a-z])/g))
      total += Number(amount) * (unit[name] ?? 1_000)
    return Math.min(now + total, now + ceilingMs)
  }
  return undefined
}

export interface Settings {
  readonly enabled?: boolean
  readonly intervalMinutes?: number
  readonly windowHours?: number
  /**
   * What the user knows that the history cannot say: provider documentation, a stated quota reset,
   * a plan to keep. One note per line, `match: text`, where `match` is a case-insensitive substring
   * of provider/model and the text may state when to come back ("skip until 2026-01-01T06:00:00Z",
   * "reset at 2026-01-01", "back in 3 hours").
   */
  readonly notes?: readonly string[]
}

export interface Note {
  readonly match: string
  readonly text: string
}

/** Parses the `match: text` lines from the settings notes. Config loading reports and drops a line that does
 * not match NOTE_LINE; any line that reaches here unchecked is skipped by the same rule. */
export const parseNotes = (notes: readonly string[] | undefined): Note[] =>
  (notes ?? []).flatMap((line) => {
    if (!ConfigModelRoutes.NOTE_LINE.test(line)) return []
    const separator = line.indexOf(":")
    return [{ match: line.slice(0, separator).trim(), text: line.slice(separator + 1).trim() }]
  })

/** The adjustments the notes argue for: a stated reset time skips the target until it arrives. */
export const noteAdjustments = (
  notes: readonly Note[],
  now: number,
  holdMs: number,
  maxResetMs?: number,
  location?: string,
): ModelRoute.Adjustment[] =>
  notes.flatMap((note) => {
    const until = ModelRouteLimits.resetAtFromMessage(note.text, now)
    if (until === undefined) return []
    return [
      {
        id: `note:${note.match}`,
        match: note.match,
        action: "skip" as const,
        // A user-stated reset can be days out; only a runaway value is bounded.
        until: Math.min(until, now + quotaResetCeilingMs(maxResetMs, location)),
        note: note.text,
      },
    ]
  })

export const DEFAULT_INTERVAL_MINUTES = 15
export const DEFAULT_WINDOW_HOURS = 24

/** One review: reads the recent history and puts the resulting adjustments in force. Returns them. */
export const review = (options: {
  readonly windowHours: number
  readonly holdMs: number
  readonly notes?: readonly string[]
  /** Skip time-of-day and error-text prediction. Defaults to false. */
  readonly withoutPredictions?: boolean
  /** The least autonomy a route needs for the review's adjustments to apply to it. */
  readonly floor: ModelRouteAutonomy.Level
  /** The Location directory whose quota gate judges this review's ceilings (#1461). */
  readonly location?: string
}) =>
  Effect.gen(function* () {
    const now = Date.now()
    const since = now - options.windowHours * 3_600_000
    const read = yield* ModelRouteLog.withDb((db) =>
      Effect.all({
        stats: ModelRouteLog.targetStats(db, since),
        errors: ModelRouteLog.errorBreakdown(db, since),
      }).pipe(Effect.orDie),
    )
    const readHourly = yield* ModelRouteLog.withDb((db) => ModelRouteLog.hourlyStats(db, since).pipe(Effect.orDie))
    const { stats, errors } = Option.getOrElse(read, () => ({ stats: [], errors: [] }))
    const hourly = Option.getOrElse(readHourly, () => [] as ModelRouteLog.HourlyStat[])
    const predictions = options.withoutPredictions ? [] : predict({ hourly, errors, now, location: options.location })
    const suggestions: ModelRoute.Adjustment[] = [
      ...suggest({ stats, errors, now, holdMs: options.holdMs }),
      ...noteAdjustments(parseNotes(options.notes), now, options.holdMs, undefined, options.location),
    ].map((item) => ({
      ...item,
      id: options.location ? `${item.id}:${encodeURIComponent(options.location)}` : item.id,
      requires: options.floor,
      ...(options.location === undefined ? {} : { location: options.location }),
    }))
    // A target that has been unreliable at this hour is down-weighted for a while, and one whose
    // message says when its quota returns is skipped until then. Only `predictive` routes apply these.
    for (const prediction of predictions) {
      if (prediction.state === "busy-hour")
        suggestions.push({
          id: `auto-hourly:${prediction.target}${options.location ? `:${encodeURIComponent(options.location)}` : ""}`,
          match: prediction.target,
          action: "weight",
          factor: 0.5,
          until: now + options.holdMs,
          note: prediction.detail,
          requires: "predictive",
          ...(options.location === undefined ? {} : { location: options.location }),
        })
      else if (prediction.until !== undefined)
        suggestions.push({
          id: `auto-quota:${prediction.target}${options.location ? `:${encodeURIComponent(options.location)}` : ""}`,
          match: prediction.target,
          action: "skip",
          until: prediction.until,
          note: prediction.detail,
          requires: "predictive",
          ...(options.location === undefined ? {} : { location: options.location }),
        })
    }
    for (const item of suggestions) ModelRoute.addAdjustment(item, item.note)
    return suggestions
  })

/** Reviews on a schedule for as long as the scope lives. The settings are read again before every
 * cycle, so enabling, disabling or retiming takes effect without a restart. Each adjustment names the
 * least level a route needs, so a route only takes the review and predictions its own level reaches. */
export const schedule = (
  read: () => Settings | undefined,
  levels: () => readonly (ModelRouteAutonomy.Level | undefined)[] = () => [],
  location?: string,
) =>
  Effect.gen(function* () {
    while (true) {
      const interval = Math.max(1, read()?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)
      yield* Effect.sleep(Duration.minutes(interval))
      const settings = read()
      const enabled = settings?.enabled === true
      if (!ModelRouteAutonomy.reviews(levels(), enabled)) continue
      const applied = yield* review({
        notes: settings?.notes,
        withoutPredictions: !ModelRouteAutonomy.predicts(levels()),
        floor: ModelRouteAutonomy.reviewFloor(enabled),
        windowHours: settings?.windowHours ?? DEFAULT_WINDOW_HOURS,
        // Long enough to bridge to the next review, so an adjustment does not flicker off in between.
        holdMs: Math.max(1, settings?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 2 * 60_000,
        location,
      }).pipe(Effect.catchCause(() => Effect.succeed([] as ModelRoute.Adjustment[])))
      if (applied.length > 0)
        yield* Effect.logInfo("model route tuning applied adjustments", {
          adjustments: applied.map((item) => `${item.action} ${item.match}`),
        })
    }
  })
