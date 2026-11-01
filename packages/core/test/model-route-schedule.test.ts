import { describe, expect, test } from "bun:test"
import { ModelRouteSchedule } from "@opencode/core/model-route-schedule"

// January 5, 2026 is a Monday; 15:00 UTC is mid-afternoon there.
const monday = Date.UTC(2026, 0, 5, 15, 0)
const HOUR = 3_600_000

describe("ModelRouteSchedule.parse", () => {
  test("normalizes names, numbers and times to one canonical shape", () => {
    expect(
      ModelRouteSchedule.parse({ daysOfWeek: ["Mon", 5, "saturday"], start: "9:5", end: "17:00" }),
    ).toEqual({ daysOfWeek: [1, 5, 6], start: "09:05", end: "17:00" })
    expect(ModelRouteSchedule.parse({ daysOfMonth: ["1", 15, -1] })).toEqual({ daysOfMonth: [1, 15, -1] })
    expect(ModelRouteSchedule.parse({ start: "9:30:59" })).toEqual({ start: "09:30" })
    // Single-digit seconds are accepted like single-digit hours and minutes (#528).
    expect(ModelRouteSchedule.parse({ start: "9:30:5" })).toEqual({ start: "09:30" })
    expect(ModelRouteSchedule.parse({ end: "17:00:9" })).toEqual({ end: "17:00" })
    expect(ModelRouteSchedule.parse({})).toEqual({})
  })

  test("sorts daysOfMonth to the same canonical order regardless of input order", () => {
    expect(ModelRouteSchedule.parse({ daysOfMonth: [15, 1, 15] })).toEqual({ daysOfMonth: [1, 15] })
    expect(ModelRouteSchedule.parse({ daysOfMonth: [1, 15] })).toEqual({ daysOfMonth: [1, 15] })
    // The -1 "last day" sentinel stays last, not first as a numeric sort would put it.
    expect(ModelRouteSchedule.parse({ daysOfMonth: [-1, 15, 1] })).toEqual({ daysOfMonth: [1, 15, -1] })
  })

  test("refuses a window it cannot read instead of guessing", () => {
    expect(ModelRouteSchedule.parse("weekdays")).toBeUndefined()
    expect(ModelRouteSchedule.parse({ timezone: "Mars/Olympus" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "25:00" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "9:30:60" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ end: "17:00:99" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ end: "noon" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: [] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [0, 42] })).toBeUndefined()
    // A mixed list is rejected too: dropping the unreadable entry would narrow the window.
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", "frieday"] })).toBeUndefined()
    // Prototype names are not day names: a plain DAY_NAMES index would read them
    // through Object.prototype and keep the window with a corrupted day list (#791).
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["constructor"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["__proto__"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", "constructor"] })).toBeUndefined()
    expect(ModelRouteSchedule.isDayOfWeek("constructor")).toBe(false)
    expect(ModelRouteSchedule.isDayOfWeek("__proto__")).toBe(false)
    expect(ModelRouteSchedule.isDayOfWeek("Constructor")).toBe(false)
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", 7] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [1, 32] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [15, 0] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ from: 100, until: 100 })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "09:00", end: "09:00" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "9:00", end: "09:00:00" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "09:00" })).toEqual({ start: "09:00" })
    expect(ModelRouteSchedule.parse({ end: "09:00" })).toEqual({ end: "09:00" })
  })

  test("accepts zero-padded weekday strings like days of month", () => {
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["06"] })).toEqual({ daysOfWeek: [6] })
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["00", "01", 2] })).toEqual({ daysOfWeek: [0, 1, 2] })
    // Padding does not widen the range, and a mixed list is still rejected whole.
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["07"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["06", "frieday"] })).toBeUndefined()
  })

  test("keeps named days from every conventional spelling", () => {
    const parsed = ModelRouteSchedule.parse({ daysOfWeek: ["tues", "thurs", "sun"] })
    expect(parsed?.daysOfWeek).toEqual([0, 2, 4])
  })
})

describe("ModelRouteSchedule.active", () => {
  test("a window with no constraints is always active", () => {
    expect(ModelRouteSchedule.active({}, monday)).toBe(true)
  })

  test("weekdays and times are judged in the window's timezone", () => {
    const window = ModelRouteSchedule.parse({
      daysOfWeek: ["mon"],
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    })!
    expect(ModelRouteSchedule.active(window, monday)).toBe(true)
    expect(ModelRouteSchedule.active(window, monday + 3 * HOUR)).toBe(false) // 18:00
    expect(ModelRouteSchedule.active(window, monday + 24 * HOUR)).toBe(false) // Tuesday
  })

  test("a timezone moves the wall clock the days are read on", () => {
    // 01:00 UTC on Monday is Sunday evening in Chicago.
    const window = ModelRouteSchedule.parse({
      daysOfWeek: ["sun"],
      start: "18:00",
      end: "23:00",
      timezone: "America/Chicago",
    })!
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 5, 1, 0))).toBe(true)
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 5, 6, 0))).toBe(false)
  })

  test("a window that starts before midnight runs into the following morning", () => {
    const window = ModelRouteSchedule.parse({ daysOfWeek: ["mon"], start: "22:00", end: "02:00", timezone: "UTC" })!
    expect(ModelRouteSchedule.active(window, monday + 7 * HOUR)).toBe(true) // Mon 22:00
    expect(ModelRouteSchedule.active(window, monday + 9 * HOUR)).toBe(true) // Tue 01:00
    expect(ModelRouteSchedule.active(window, monday + 11 * HOUR)).toBe(false) // Tue 03:00
    expect(ModelRouteSchedule.active(window, monday - 2 * HOUR)).toBe(false) // Sun 13:00
  })

  test("a wrapping window's tail belongs to the previous day on the DST fall-back night", () => {
    // DST ends in Chicago on Sun 2026-11-01: 02:00 CDT falls back to 01:00 CST, so 01:30 occurs twice.
    const saturday = ModelRouteSchedule.parse({
      daysOfWeek: ["sat"],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    const sunday = ModelRouteSchedule.parse({
      daysOfWeek: ["sun"],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    const first = Date.UTC(2026, 10, 1, 6, 30) // Sun 01:30 CDT, first occurrence
    const repeated = Date.UTC(2026, 10, 1, 7, 30) // Sun 01:30 CST, repeated hour
    expect(ModelRouteSchedule.active(saturday, first)).toBe(true)
    expect(ModelRouteSchedule.active(saturday, repeated)).toBe(true)
    expect(ModelRouteSchedule.active(saturday, Date.UTC(2026, 10, 1, 7, 59))).toBe(true) // 01:59 CST
    expect(ModelRouteSchedule.active(sunday, repeated)).toBe(false)
    // Normal week control: Sun 2026-11-08 01:30 CST is Saturday Nov 7's tail.
    expect(ModelRouteSchedule.active(saturday, Date.UTC(2026, 10, 8, 7, 30))).toBe(true)
  })

  test("a wrapping window's tail judges days of month on the previous day", () => {
    // Oct 31 2026 is the last day of October; its 22:00-02:00 window runs into Nov 1.
    const window = ModelRouteSchedule.parse({
      daysOfMonth: [-1],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 10, 1, 7, 30))).toBe(true) // Nov 1 01:30 CST, repeated hour
    const first = ModelRouteSchedule.parse({
      daysOfMonth: [1],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    expect(ModelRouteSchedule.active(first, Date.UTC(2026, 10, 1, 7, 30))).toBe(false)
  })

  test("an end with no start means until that time, and a start with no end means from it", () => {
    const morning = ModelRouteSchedule.parse({ daysOfWeek: ["mon"], end: "09:00", timezone: "UTC" })!
    expect(ModelRouteSchedule.active(morning, monday - 7 * HOUR)).toBe(true) // Mon 08:00
    expect(ModelRouteSchedule.active(morning, monday)).toBe(false)
    const late = ModelRouteSchedule.parse({ daysOfWeek: ["mon"], start: "18:00", timezone: "UTC" })!
    expect(ModelRouteSchedule.active(late, monday + 4 * HOUR)).toBe(true)
    expect(ModelRouteSchedule.active(late, monday)).toBe(false)
  })

  test("days of month match, including the last day", () => {
    const fifth = ModelRouteSchedule.parse({ daysOfMonth: [5] })!
    expect(ModelRouteSchedule.active(fifth, monday)).toBe(true)
    expect(ModelRouteSchedule.active(fifth, monday + 24 * HOUR)).toBe(false)
    const last = ModelRouteSchedule.parse({ daysOfMonth: [-1] })!
    expect(ModelRouteSchedule.active(last, Date.UTC(2026, 0, 31, 12, 0))).toBe(true)
    expect(ModelRouteSchedule.active(last, Date.UTC(2026, 1, 28, 12, 0))).toBe(true)
    expect(ModelRouteSchedule.active(last, Date.UTC(2026, 0, 30, 12, 0))).toBe(false)
  })

  test("absolute bounds end a recurring window", () => {
    const window = ModelRouteSchedule.parse({ start: "00:00", from: monday, until: monday + HOUR })!
    expect(ModelRouteSchedule.active(window, monday + 30 * 60_000)).toBe(true)
    expect(ModelRouteSchedule.active(window, monday + 2 * HOUR)).toBe(false)
    expect(ModelRouteSchedule.active(window, monday - 1)).toBe(false)
  })

  test("an equal start and end is an empty window, not a full day", () => {
    // parse rejects this shape (see the parse tests), so construct it directly:
    // active must still treat a hand-built equal window as empty, never a full day.
    const window = { start: "09:00", end: "09:00" }
    expect(ModelRouteSchedule.active(window, monday)).toBe(false)
  })
})

describe("ModelRouteSchedule date windows (#821)", () => {
  // 2026-10-01 is a Thursday; 10:00 in Asia/Shanghai is 02:00 UTC.
  const holiday = Date.UTC(2026, 9, 1, 2, 0)
  const ordinaryThursday = Date.UTC(2026, 9, 8, 2, 0)
  const peak = {
    daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
    start: "09:00",
    end: "17:00",
    timezone: "Asia/Shanghai",
  }

  test("parse canonicalises date entries sorted and deduped, collapsing one-day ranges", () => {
    expect(ModelRouteSchedule.parse({ dates: ["2026-10-02", "2026-10-01", "2026-10-01"] })).toEqual({
      dates: ["2026-10-01", "2026-10-02"],
    })
    expect(ModelRouteSchedule.parse({ excludeDates: ["2026-10-01/2026-10-01"] })).toEqual({
      excludeDates: ["2026-10-01"],
    })
    expect(ModelRouteSchedule.parse({ excludeDates: ["2026-09-30/2026-10-02"] })).toEqual({
      excludeDates: ["2026-09-30/2026-10-02"],
    })
    expect(ModelRouteSchedule.parse({ excludeWindows: ["cn-holidays", "cn-holidays"] })).toEqual({
      excludeWindows: ["cn-holidays"],
    })
  })

  test("parse rejects malformed dates, reversed ranges and empty lists whole", () => {
    expect(ModelRouteSchedule.parse({ dates: [] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ excludeDates: [] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ excludeWindows: [] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ dates: ["2026-13-01"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ dates: ["2026-02-30"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ dates: ["2026-10-1"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ dates: ["Oct 1 2026"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ excludeDates: ["2026-10-02/2026-10-01"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ dates: ["2026-10-01", "bogus"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ excludeWindows: ["bad name"] })).toBeUndefined()
    expect(ModelRouteSchedule.isDateEntry("2026-09-30/2026-10-02")).toBe(true)
    expect(ModelRouteSchedule.isDateEntry("2026-02-30")).toBe(false)
  })

  test("a weekday holiday in excludeDates suspends a peak window for the whole day", () => {
    const window = ModelRouteSchedule.parse({ ...peak, excludeDates: ["2026-10-01"] })!
    expect(ModelRouteSchedule.active(window, holiday)).toBe(false)
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 9, 1, 1, 0))).toBe(false) // 09:00 Shanghai
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 9, 1, 8, 59))).toBe(false) // 16:59 Shanghai
    expect(ModelRouteSchedule.active(window, ordinaryThursday)).toBe(true)
  })

  test("an exclusion range crossing a month boundary suspends every day in it and no more", () => {
    const window = ModelRouteSchedule.parse({ excludeDates: ["2026-09-30/2026-10-02"], timezone: "Asia/Shanghai" })!
    const at = (month: number, day: number) => Date.UTC(2026, month, day, 2, 0) // 10:00 Shanghai; month is 0-based
    expect(ModelRouteSchedule.active(window, at(8, 30))).toBe(false) // Sep 30
    expect(ModelRouteSchedule.active(window, at(9, 1))).toBe(false) // Oct 1
    expect(ModelRouteSchedule.active(window, at(9, 2))).toBe(false) // Oct 2
    expect(ModelRouteSchedule.active(window, at(9, 3))).toBe(true) // Oct 3
    expect(ModelRouteSchedule.active(window, at(8, 29))).toBe(true) // Sep 29
  })

  test("dates act as an active-on list, ANDed with the other fields", () => {
    const window = ModelRouteSchedule.parse({ ...peak, dates: ["2026-10-01"] })!
    expect(ModelRouteSchedule.active(window, holiday)).toBe(true)
    expect(ModelRouteSchedule.active(window, ordinaryThursday)).toBe(false)
  })

  test("weekend and ordinary-weekday behaviour is unchanged by date fields", () => {
    const saturday = Date.UTC(2026, 9, 3, 2, 0) // Sat 2026-10-03 10:00 Shanghai
    const plain = ModelRouteSchedule.parse(peak)!
    const dated = ModelRouteSchedule.parse({ ...peak, excludeDates: ["2026-10-01"] })!
    expect(ModelRouteSchedule.active(plain, saturday)).toBe(false)
    expect(ModelRouteSchedule.active(dated, saturday)).toBe(false)
    expect(ModelRouteSchedule.active(dated, ordinaryThursday)).toBe(ModelRouteSchedule.active(plain, ordinaryThursday))
  })

  test("a wrapping window's exclusion applies to the day the window started on", () => {
    const window = ModelRouteSchedule.parse({
      start: "22:00",
      end: "02:00",
      timezone: "UTC",
      excludeDates: ["2026-01-05"], // Monday
    })!
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 5, 23, 0))).toBe(false) // Mon 23:00
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 6, 1, 0))).toBe(false) // Tue 01:00, started Mon
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 6, 23, 0))).toBe(true) // Tue 23:00
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 7, 1, 0))).toBe(true) // Wed 01:00, started Tue
  })

  test("excludeWindows subtracts a named holiday calendar, via a map or resolved ahead of time", () => {
    const holidays = ModelRouteSchedule.parse({ dates: ["2026-10-01"], timezone: "Asia/Shanghai" })!
    const windows = new Map([["cn-holidays", holidays]])
    const window = ModelRouteSchedule.parse({ ...peak, excludeWindows: ["cn-holidays"] })!
    expect(ModelRouteSchedule.active(window, holiday, windows)).toBe(false)
    expect(ModelRouteSchedule.active(window, ordinaryThursday, windows)).toBe(true)
    const resolved = ModelRouteSchedule.resolveExclusions(window, windows)!
    expect(resolved).toBeDefined()
    expect(ModelRouteSchedule.active(resolved, holiday)).toBe(false)
    expect(ModelRouteSchedule.active(resolved, ordinaryThursday)).toBe(true)
  })

  test("an unknown or cyclic excludeWindows reference drops the window instead of throwing", () => {
    const window = ModelRouteSchedule.parse({ ...peak, excludeWindows: ["cn-holidays"] })!
    expect(ModelRouteSchedule.active(window, ordinaryThursday, new Map())).toBe(false)
    expect(ModelRouteSchedule.resolveExclusions(window, new Map())).toBeUndefined()
    const a = ModelRouteSchedule.parse({ excludeWindows: ["b"] })!
    const b = ModelRouteSchedule.parse({ excludeWindows: ["a"] })!
    const cycle = new Map([
      ["a", a],
      ["b", b],
    ])
    expect(ModelRouteSchedule.active(a, ordinaryThursday, cycle)).toBe(false)
    expect(ModelRouteSchedule.resolveExclusions(a, cycle, new Set(["a"]))).toBeUndefined()
    const self = ModelRouteSchedule.parse({ excludeWindows: ["self"] })!
    expect(ModelRouteSchedule.resolveExclusions(self, new Map([["self", self]]), new Set(["self"]))).toBeUndefined()
  })

  test("describe mentions dates and exclusions", () => {
    const window = ModelRouteSchedule.parse({ ...peak, excludeDates: ["2026-10-01"], excludeWindows: ["cn-holidays"] })!
    expect(ModelRouteSchedule.describe(window)).toContain("except 2026-10-01")
    expect(ModelRouteSchedule.describe(window)).toContain("cn-holidays")
    const dated = ModelRouteSchedule.parse({ dates: ["2026-10-01"] })!
    expect(ModelRouteSchedule.describe(dated)).toContain("on 2026-10-01")
  })
})
