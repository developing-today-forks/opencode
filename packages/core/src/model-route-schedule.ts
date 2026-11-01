export * as ModelRouteSchedule from "./model-route-schedule.js"

/**
 * Recurring time windows for routing rules: a date and time-of-day filter the operator (or a
 * sentence the interpreter understood) attaches to a weight change. A window never talks to the
 * provider; it only says when a rule is in force, so the same structure describes "weekdays 9 to
 * 5 America/Chicago" and "the 1st and 15th of every month".
 *
 * Canonical shape, as stored in config and override files:
 *
 *   { "daysOfWeek": ["mon", "tue"], "start": "09:00", "end": "17:00", "timezone": "America/Chicago" }
 *
 * `parse` normalizes the friendly forms (day names, "9:30") to this shape and rejects an object it
 * cannot read, so a typo makes a rule disappear rather than apply at the wrong time. `active`
 * evaluates it; a window with no constraints is always active.
 */
export interface Window {
  /** 0 (Sunday) to 6 (Saturday). Empty or absent means every day. */
  readonly daysOfWeek?: readonly number[]
  /** 1 to 31, plus -1 for the last day of the month. Empty or absent means every day. */
  readonly daysOfMonth?: readonly number[]
  /** Local start of the daily window, "HH:mm". Absent means from the start of the day. */
  readonly start?: string
  /** Local end of the daily window, "HH:mm", exclusive. Absent means to the end of the day. */
  readonly end?: string
  /** IANA timezone such as "America/Chicago"; absent means the host's local timezone. */
  readonly timezone?: string
  /** Specific local calendar dates the window is active on: "YYYY-MM-DD" entries or inclusive
   * "YYYY-MM-DD/YYYY-MM-DD" ranges, read in the window's timezone. Absent means every date. */
  readonly dates?: readonly string[]
  /** Local calendar dates (same entry shape as `dates`) on which the window is never active.
   * Exclusions win over every other field. */
  readonly excludeDates?: readonly string[]
  /** Names of windows in experimental.model_route_windows; while any of them is active this
   * window is not. Resolved by `resolveExclusions` at config load, or by `active`'s map argument. */
  readonly excludeWindows?: readonly string[]
  /** The `excludeWindows` references already resolved to window objects (set by
   * `resolveExclusions`); `active` judges these when present instead of the names. */
  readonly excludedWindows?: readonly Window[]
  /** First instant the window may be active, epoch milliseconds. */
  readonly from?: number
  /** Last instant the window may be active, epoch milliseconds; exclusive. */
  readonly until?: number
}

const DAY_NAMES: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

const field = (value: unknown, name: string) =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined

/** A day number from a number, a numeric string, or a case-insensitive day name. */
const dayOfWeek = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) return value
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase()
  if (/^0?[0-6]$/.test(text)) return Number(text)
  // Own-property lookup only: a plain index reads through Object.prototype, so
  // "constructor" and "__proto__" would resolve to inherited values (#791).
  return Object.hasOwn(DAY_NAMES, text) ? DAY_NAMES[text] : undefined
}

/** A day of month from a number or numeric string: 1..31, or -1 for the last day. */
const dayOfMonth = (value: unknown): number | undefined => {
  const number = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof number !== "number" || !Number.isInteger(number)) return undefined
  if (number === -1 || (number >= 1 && number <= 31)) return number
  return undefined
}

const DATE_ENTRY = /^(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?$/

/** A real calendar date check: 2026-02-30 matches the shape but is not a date. */
const isRealDate = (text: string): boolean => {
  const [year, month, day] = text.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** One `dates`/`excludeDates` entry canonicalised: a single "YYYY-MM-DD" day, or an inclusive
 * "YYYY-MM-DD/YYYY-MM-DD" range. A one-day range collapses to the single day. */
const dateEntry = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const match = DATE_ENTRY.exec(value.trim())
  if (!match) return undefined
  const start = match[1]
  const end = match[2]
  if (!isRealDate(start) || (end !== undefined && !isRealDate(end))) return undefined
  if (end !== undefined && end < start) return undefined
  return end === undefined || end === start ? start : `${start}/${end}`
}

export const isDateEntry = (value: unknown): value is string => dateEntry(value) !== undefined

/** A window name, the same pattern the config schema uses for model_route_windows keys. */
const WINDOW_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export const isDayOfWeek = (value: unknown): value is number | string => dayOfWeek(value) !== undefined
export const isDayOfMonth = (value: unknown): value is number | string => dayOfMonth(value) !== undefined

/** "9:30", "09:30", "23:59", "9:5", "9:30:15" or "9:30:5" as minutes since local midnight. Seconds round down. */
export const minutesOf = (value: string): number | undefined => {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(value.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] === undefined ? 0 : Number(match[3])
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined
  return hours * 60 + minutes
}

/** "9:30" as canonical "HH:mm". */
export const normalizeTime = (value: string): string | undefined => {
  const minutes = minutesOf(value)
  if (minutes === undefined) return undefined
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

const timezoneFormat = (timezone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
  } catch {
    return undefined
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The canonical IANA name for a timezone, or undefined when the runtime does not know it. */
export const timezoneName = (value: string): string | undefined => {
  const format = timezoneFormat(value)
  return format?.resolvedOptions().timeZone
}

const formatterFor = (timezone: string | undefined) => {
  const key = timezone ?? ""
  const cached = formatters.get(key)
  if (cached) return cached
  // An invalid name is refused at parse time; a window built by hand falls back to the host zone
  // rather than making a routing decision throw.
  const format =
    (timezone === undefined ? undefined : timezoneFormat(key)) ??
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
  formatters.set(key, format)
  return format
}

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly dayOfMonth: number
  readonly dayOfWeek: number
  readonly minutes: number
}

const SHORT_DAYS: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const partsAt = (format: Intl.DateTimeFormat, at: number): LocalParts => {
  const values: Record<string, string> = {}
  for (const part of format.formatToParts(new Date(at))) if (part.type !== "literal") values[part.type] = part.value
  return {
    year: Number(values.year),
    month: Number(values.month),
    dayOfMonth: Number(values.day),
    dayOfWeek: SHORT_DAYS[values.weekday.toLowerCase()] ?? 0,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  }
}

const daysInMonth = (parts: Pick<LocalParts, "year" | "month">) =>
  // Day 0 of the following month is the last day of this one.
  new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()

/** The local calendar day before `parts`, derived from the date itself. Subtracting the day's
 * elapsed wall-clock minutes from the absolute instant is not equivalent: on the DST fall-back
 * night the repeated hour makes that subtraction land on the same local day (#585). */
const previousDay = (parts: LocalParts): LocalParts => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth) - 86_400_000)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    dayOfMonth: date.getUTCDate(),
    dayOfWeek: date.getUTCDay(),
    minutes: 0,
  }
}

/**
 * Reads a window from user input. Returns undefined when the object is not a window at all (an
 * invalid timezone, an unreadable day list or time), and an always-active window for `{}`. Fields
 * that read as empty lists are dropped so the canonical value is as small as the config.
 */
export const parse = (value: unknown): Window | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") return undefined
  const result: {
    daysOfWeek?: number[]
    daysOfMonth?: number[]
    dates?: string[]
    excludeDates?: string[]
    excludeWindows?: string[]
    start?: string
    end?: string
    timezone?: string
    from?: number
    until?: number
  } = {}

  const rawDaysOfWeek = field(value, "daysOfWeek")
  if (rawDaysOfWeek !== undefined) {
    if (!Array.isArray(rawDaysOfWeek)) return undefined
    const parsed = rawDaysOfWeek.map(dayOfWeek)
    // Any unreadable entry rejects the window: dropping it would silently narrow the days
    // the rule applies on, instead of making a typo'd rule disappear as the header promises.
    if (parsed.length === 0 || parsed.some((day) => day === undefined)) return undefined
    const days = [...new Set(parsed as number[])].sort((left, right) => left - right)
    result.daysOfWeek = days
  }

  const rawDaysOfMonth = field(value, "daysOfMonth")
  if (rawDaysOfMonth !== undefined) {
    if (!Array.isArray(rawDaysOfMonth)) return undefined
    const parsed = rawDaysOfMonth.map(dayOfMonth)
    if (parsed.length === 0 || parsed.some((day) => day === undefined)) return undefined
    // Canonical order, like daysOfWeek: numeric days ascending, with the -1 "last day"
    // sentinel last — a raw numeric sort would put the sentinel first.
    const days = [...new Set(parsed as number[])].sort((left, right) => {
      if (left === -1) return 1
      if (right === -1) return -1
      return left - right
    })
    result.daysOfMonth = days
  }

  for (const name of ["dates", "excludeDates"] as const) {
    const raw = field(value, name)
    if (raw === undefined) continue
    if (!Array.isArray(raw)) return undefined
    const parsed = raw.map(dateEntry)
    // Same rule as the day lists: an empty list, or any unreadable entry, rejects the window.
    if (parsed.length === 0 || parsed.some((entry) => entry === undefined)) return undefined
    // ISO dates sort chronologically as strings, so the canonical form is a plain sort.
    result[name] = [...new Set(parsed as string[])].sort()
  }

  const rawExcludeWindows = field(value, "excludeWindows")
  if (rawExcludeWindows !== undefined) {
    if (!Array.isArray(rawExcludeWindows)) return undefined
    const names = rawExcludeWindows.map((name) =>
      typeof name === "string" && WINDOW_NAME.test(name.trim()) ? name.trim() : undefined,
    )
    if (names.length === 0 || names.some((name) => name === undefined)) return undefined
    result.excludeWindows = [...new Set(names as string[])].sort()
  }

  const rawStart = field(value, "start")
  if (rawStart !== undefined) {
    if (typeof rawStart !== "string") return undefined
    const start = normalizeTime(rawStart)
    if (start === undefined) return undefined
    result.start = start
  }

  const rawEnd = field(value, "end")
  if (rawEnd !== undefined) {
    if (typeof rawEnd !== "string") return undefined
    const end = normalizeTime(rawEnd)
    if (end === undefined) return undefined
    result.end = end
  }

  const rawTimezone = field(value, "timezone")
  if (rawTimezone !== undefined) {
    const canonical = typeof rawTimezone === "string" ? timezoneName(rawTimezone.trim()) : undefined
    if (canonical === undefined) return undefined
    result.timezone = canonical
  }

  for (const [name, key] of [
    ["from", "from"],
    ["until", "until"],
  ] as const) {
    const raw = field(value, name)
    if (raw === undefined) continue
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
    result[key] = raw
  }
  if (result.from !== undefined && result.until !== undefined && result.from >= result.until) return undefined
  // Equal start/end is the same empty range: minuteMatches can never activate it, so the rule would
  // silently never fire. An all-day window is expressed by omitting both fields.
  if (result.start !== undefined && result.start === result.end) return undefined

  return result
}

const dateKey = (parts: LocalParts) =>
  `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.dayOfMonth).padStart(2, "0")}`

/** ISO date strings compare chronologically, so a range check is a string comparison. */
const dateEntryMatches = (entry: string, key: string) => {
  const slash = entry.indexOf("/")
  if (slash === -1) return entry === key
  return key >= entry.slice(0, slash) && key <= entry.slice(slash + 1)
}

const dayMatches = (window: Window, parts: LocalParts) =>
  (!window.daysOfWeek?.length || window.daysOfWeek.includes(parts.dayOfWeek)) &&
  (!window.daysOfMonth?.length ||
    window.daysOfMonth.some((day) => day === parts.dayOfMonth || (day === -1 && parts.dayOfMonth === daysInMonth(parts)))) &&
  (!window.dates?.length || window.dates.some((entry) => dateEntryMatches(entry, dateKey(parts)))) &&
  (!window.excludeDates?.length || !window.excludeDates.some((entry) => dateEntryMatches(entry, dateKey(parts))))

const minuteMatches = (window: Window, minutes: number) => {
  const start = window.start === undefined ? undefined : minutesOf(window.start)
  const end = window.end === undefined ? undefined : minutesOf(window.end)
  if (start === undefined && end === undefined) return true
  if (start === undefined) return minutes < end!
  if (end === undefined) return minutes >= start
  if (start === end) return false
  if (start < end) return minutes >= start && minutes < end
  // A window that runs past midnight: the tail belongs to the day it started on.
  return minutes >= start || minutes < end
}

/**
 * Replaces a window's `excludeWindows` names with the windows they name, recursively, so the
 * runtime can judge exclusions without a registry. Returns undefined when a name is unknown or
 * the references cycle (a self-reference included): the window is dropped, the same fate as a
 * schedule that names an unknown window, rather than applying without its exclusion.
 * `seen` carries the names on the current resolution path (callers resolving a named window
 * pass its own name so a self-reference is a cycle).
 */
export const resolveExclusions = (
  window: Window,
  windows: ReadonlyMap<string, Window>,
  seen: ReadonlySet<string> = new Set(),
): Window | undefined => {
  if (!window.excludeWindows?.length) return window
  const resolved: Window[] = [...(window.excludedWindows ?? [])]
  for (const name of window.excludeWindows) {
    if (seen.has(name)) return undefined
    const referenced = windows.get(name)
    if (!referenced) return undefined
    const inner = resolveExclusions(referenced, windows, new Set(seen).add(name))
    if (!inner) return undefined
    resolved.push(inner)
  }
  return { ...window, excludedWindows: resolved }
}

/** The evaluation behind `active`: undefined means the window is dropped (an `excludeWindows`
 * name that cannot be resolved, or a reference cycle), which `active` reports as inactive. */
const evaluate = (
  window: Window,
  now: number,
  windows: ReadonlyMap<string, Window> | undefined,
  seenNames: ReadonlySet<string>,
  seenWindows: ReadonlySet<Window>,
): boolean | undefined => {
  if (seenWindows.has(window)) return undefined
  const path = new Set(seenWindows).add(window)
  if (window.from !== undefined && now < window.from) return false
  if (window.until !== undefined && now >= window.until) return false
  // Exclusions win over everything else in the window.
  if (window.excludedWindows !== undefined) {
    for (const excluded of window.excludedWindows) {
      const state = evaluate(excluded, now, windows, seenNames, path)
      if (state === undefined) return undefined
      if (state) return false
    }
  } else if (window.excludeWindows?.length) {
    for (const name of window.excludeWindows) {
      if (seenNames.has(name)) return undefined
      const referenced = windows?.get(name)
      if (!referenced) return undefined
      const state = evaluate(referenced, now, windows, new Set(seenNames).add(name), path)
      if (state === undefined) return undefined
      if (state) return false
    }
  }
  const hasDays = Boolean(window.daysOfWeek?.length || window.daysOfMonth?.length || window.dates?.length || window.excludeDates?.length)
  const hasTime = window.start !== undefined || window.end !== undefined
  if (!hasDays && !hasTime) return true
  const format = formatterFor(window.timezone)
  const current = partsAt(format, now)
  if (!minuteMatches(window, current.minutes)) return false
  if (!hasDays) return true
  const wraps =
    window.start !== undefined && window.end !== undefined && minutesOf(window.start)! > minutesOf(window.end)!
  if (wraps && current.minutes < minutesOf(window.end)!)
    // Before the end of a wrapping window means it began on the previous local day: the date
    // checks (dates/excludeDates included) judge that start day too.
    return dayMatches(window, previousDay(current))
  return dayMatches(window, current)
}

/** True while the wall clock in the window's timezone is inside it. A window whose
 * `excludeWindows` names cannot be resolved from `windows` (or cycle) is inactive, never
 * applied without its exclusion; windows resolved by `resolveExclusions` need no map. */
export const active = (window: Window, now = Date.now(), windows?: ReadonlyMap<string, Window>): boolean =>
  evaluate(window, now, windows, new Set(), new Set()) ?? false

const dayList = (window: Window) =>
  window.daysOfWeek?.length ? window.daysOfWeek.map((day) => DAY_LABELS[day]).join(", ") : "every day"

const monthList = (window: Window) =>
  window.daysOfMonth?.length
    ? window.daysOfMonth.map((day) => (day === -1 ? "last day" : String(day))).join(", ")
    : undefined

const timeRange = (window: Window) => {
  if (window.start === undefined && window.end === undefined) return "all day"
  if (window.start !== undefined && window.end === undefined) return `from ${window.start}`
  if (window.start === undefined) return `until ${window.end}`
  return `${window.start}-${window.end}`
}

/** A one-line English summary, used in logs and by editors that show a rule back to its author. */
export const describe = (window: Window): string => {
  const when = `${dayList(window)} ${timeRange(window)}`
  const month = monthList(window)
  const zone = window.timezone ? ` (${window.timezone})` : ""
  const bounds =
    window.from !== undefined || window.until !== undefined
      ? ` between ${window.from === undefined ? "always" : new Date(window.from).toISOString()} and ${
          window.until === undefined ? "always" : new Date(window.until).toISOString()
        }`
      : ""
  const dates = window.dates?.length ? ` on ${window.dates.join(", ")}` : ""
  const excludedDates = window.excludeDates?.length ? ` except ${window.excludeDates.join(", ")}` : ""
  const excludedNames = window.excludeWindows?.length
    ? ` except when ${window.excludeWindows.join(", ")} is active`
    : window.excludedWindows?.length
      ? ` except when an excluded window is active`
      : ""
  return `${month ? `${when}; day ${month} of the month` : when}${zone}${bounds}${dates}${excludedDates}${excludedNames}`
}
