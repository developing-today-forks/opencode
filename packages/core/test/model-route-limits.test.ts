import { describe, expect, test } from "bun:test"
import { ModelRouteLimits } from "@opencode/core/model-route-limits"

const at = 1_000_000

describe("ModelRouteLimits.resetMs", () => {
  test("reads durations in the forms providers write them", () => {
    expect(ModelRouteLimits.resetMs("1s", at)).toBe(1_000)
    expect(ModelRouteLimits.resetMs("250ms", at)).toBe(250)
    expect(ModelRouteLimits.resetMs("6m0s", at)).toBe(360_000)
    expect(ModelRouteLimits.resetMs("1h2m3.5s", at)).toBe(3_723_500)
    expect(ModelRouteLimits.resetMs("1d", at)).toBe(86_400_000)
  })

  test("reads plain seconds and timestamps relative to the response time", () => {
    expect(ModelRouteLimits.resetMs("30", at)).toBe(30_000)
    expect(ModelRouteLimits.resetMs("0.5", at)).toBe(500)
    expect(ModelRouteLimits.resetMs(new Date(at + 90_000).toISOString(), at)).toBe(90_000)
    expect(ModelRouteLimits.resetMs(new Date(at - 5_000).toISOString(), at)).toBe(0)
  })

  test("returns undefined for anything else", () => {
    expect(ModelRouteLimits.resetMs("", at)).toBeUndefined()
    expect(ModelRouteLimits.resetMs("soon", at)).toBeUndefined()
    expect(ModelRouteLimits.resetMs("5 minutes", at)).toBeUndefined()
  })
})

describe("ModelRouteLimits.snapshot", () => {
  test("is undefined when the response advertised nothing", () => {
    expect(ModelRouteLimits.snapshot(undefined, at)).toBeUndefined()
    expect(ModelRouteLimits.snapshot({ limit: {}, remaining: {}, reset: {} }, at)).toBeUndefined()
  })

  test("keeps only what was advertised", () => {
    expect(ModelRouteLimits.snapshot({ remaining: { requests: "9" }, retryAfterMs: 500 }, at)).toEqual({
      at,
      remaining: { requests: "9" },
      retryAfterMs: 500,
    })
  })
})

describe("ModelRouteLimits.holdUntil", () => {
  const snap = (value: Omit<ModelRouteLimits.Snapshot, "at">): ModelRouteLimits.Snapshot => ({ at, ...value })

  test("holds an emptied window until it resets", () => {
    const until = ModelRouteLimits.holdUntil(
      snap({ limit: { requests: "60" }, remaining: { requests: "0" }, reset: { requests: "20s" } }),
      at,
    )
    expect(until).toBe(at + 20_000)
  })

  test("holds a nearly spent window with a stated reset, but not a healthy one", () => {
    const nearly = snap({ limit: { tokens: "1000" }, remaining: { tokens: "40" }, reset: { tokens: "6m0s" } })
    expect(ModelRouteLimits.holdUntil(nearly, at)).toBe(at + 360_000)
    const healthy = snap({ limit: { tokens: "1000" }, remaining: { tokens: "400" }, reset: { tokens: "6m0s" } })
    expect(ModelRouteLimits.holdUntil(healthy, at)).toBe(0)
  })

  test("without a stated reset only an empty window is held, and only for a minute", () => {
    expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: "0" } }), at)).toBe(at + 60_000)
    expect(ModelRouteLimits.holdUntil(snap({ limit: { requests: "100" }, remaining: { requests: "3" } }), at)).toBe(0)
  })

  test("takes the latest of several windows and honours retry-after", () => {
    const value = snap({
      limit: { requests: "60", "input-tokens": "1000" },
      remaining: { requests: "0", "input-tokens": "0" },
      reset: { requests: "10s", "input-tokens": "45s" },
      retryAfterMs: 5_000,
    })
    expect(ModelRouteLimits.holdUntil(value, at)).toBe(at + 45_000)
    expect(ModelRouteLimits.holdUntil(snap({ retryAfterMs: 8_000 }), at)).toBe(at + 8_000)
  })

  test("ignores windows already over and caps what a day is", () => {
    const old = snap({ remaining: { requests: "0" }, reset: { requests: "10s" } })
    expect(ModelRouteLimits.holdUntil(old, at + 30_000)).toBe(0)
    const huge = snap({ remaining: { requests: "0" }, reset: { requests: "30d" } })
    expect(ModelRouteLimits.holdUntil(huge, at)).toBe(at + 86_400_000)
  })

  test("skips values that are not numbers", () => {
    expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: "lots" }, reset: { requests: "1s" } }), at)).toBe(0)
  })

  test("skips non-decimal remaining and limit spellings instead of reinterpreting them (#711)", () => {
    for (const spelling of ["0x0", "0b0", "0o0", "1e3", "+5", "-5", "0x64"]) {
      expect(ModelRouteLimits.windows(snap({ remaining: { requests: spelling } }))).toEqual([])
      expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: spelling } }), at)).toBe(0)
    }
    // The #672 failure through another spelling: "0x0" must not bench a target as a spent window.
    expect(
      ModelRouteLimits.holdUntil(
        snap({ limit: { requests: "100" }, remaining: { requests: "0x0" }, reset: { requests: "60s" } }),
        at,
      ),
    ).toBe(0)
    // A non-decimal limit yields an undefined limit, so no near-empty fraction is fabricated:
    // remaining 3 of "0x64" (100 if reinterpreted) would otherwise hold until the reset.
    const badLimit = snap({
      limit: { requests: "0x64" },
      remaining: { requests: "3" },
      reset: { requests: "60s" },
    })
    expect(ModelRouteLimits.windows(badLimit)).toEqual([
      { name: "requests", remaining: 3, limit: undefined, resetAt: at + 60_000 },
    ])
    expect(ModelRouteLimits.holdUntil(badLimit, at)).toBe(0)
    // Plain decimals are unchanged.
    expect(ModelRouteLimits.windows(snap({ limit: { requests: "100" }, remaining: { requests: "3.5" } }))).toEqual([
      { name: "requests", remaining: 3.5, limit: 100, resetAt: undefined },
    ])
    expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: "0" } }), at)).toBe(at + 60_000)
  })

  test("skips blank remaining values instead of reading them as zero", () => {
    const blank = snap({ limit: { requests: "100" }, remaining: { requests: "" }, reset: { requests: "60s" } })
    expect(ModelRouteLimits.windows(blank)).toEqual([])
    expect(ModelRouteLimits.holdUntil(blank, at)).toBe(0)
    const whitespace = snap({ remaining: { requests: "  " } })
    expect(ModelRouteLimits.windows(whitespace)).toEqual([])
    expect(ModelRouteLimits.holdUntil(whitespace, at)).toBe(0)
    expect(ModelRouteLimits.holdUntil(snap({ remaining: { requests: "0" } }), at)).toBe(at + 60_000)
  })

  test("looks up limit and reset entries only when they are own properties", () => {
    const constructor = snap({
      limit: { requests: "100" },
      remaining: { constructor: "5", requests: "50" },
    })
    expect(ModelRouteLimits.windows(constructor)).toEqual([
      { name: "constructor", remaining: 5, limit: undefined, resetAt: undefined },
      { name: "requests", remaining: 50, limit: 100, resetAt: undefined },
    ])
    expect(ModelRouteLimits.holdUntil(constructor, at)).toBe(0)

    const toString = snap({
      limit: { requests: "100" },
      remaining: { toString: "0", requests: "50" },
      reset: { requests: "30s" },
    })
    expect(ModelRouteLimits.windows(toString)).toEqual([
      { name: "toString", remaining: 0, limit: undefined, resetAt: undefined },
      { name: "requests", remaining: 50, limit: 100, resetAt: at + 30_000 },
    ])
    expect(ModelRouteLimits.holdUntil(toString, at)).toBe(at + 60_000)
  })

  test("handles a JSON-parsed snapshot with an own __proto__ window", () => {
    const value = JSON.parse(
      `{"at":${at},"remaining":{"__proto__":"0","requests":"3"},"limit":{"requests":"100"}}`,
    ) as ModelRouteLimits.Snapshot

    expect(Object.hasOwn(value.remaining ?? {}, "__proto__")).toBe(true)
    expect(ModelRouteLimits.windows(value)).toEqual([
      { name: "__proto__", remaining: 0, limit: undefined, resetAt: undefined },
      { name: "requests", remaining: 3, limit: 100, resetAt: undefined },
    ])
    expect(ModelRouteLimits.holdUntil(value, at)).toBe(at + 60_000)
  })
})

describe("ModelRouteLimits.retryHintFromMessage", () => {
  const at = 1_000_000

  test("reads waits stated in the error text", () => {
    expect(ModelRouteLimits.retryHintFromMessage("retry after 2026-01-01T00:00:00Z", at)).toBe(
      Date.parse("2026-01-01T00:00:00Z") - at,
    )
    // A stated zone is honoured as written, whatever the reader's local timezone is.
    expect(ModelRouteLimits.retryHintFromMessage("retry after 2026-01-01T05:30:00+05:30", at)).toBe(
      Date.parse("2026-01-01T00:00:00Z") - at,
    )
    expect(ModelRouteLimits.retryHintFromMessage("try again in 45 seconds", at)).toBe(45_000)
    expect(ModelRouteLimits.retryHintFromMessage("try again in 45s", at)).toBe(45_000)
    expect(ModelRouteLimits.retryHintFromMessage("try again in 45 sec", at)).toBe(45_000)
    expect(ModelRouteLimits.retryHintFromMessage("wait in 2 hours", at)).toBe(7_200_000)
  })

  test("scans past an unparseable first date to a later valid reset", () => {
    expect(
      ModelRouteLimits.resetAtFromMessage("quota reset at 2026-13-01, back at 2026-01-02T00:00:00Z", at),
    ).toBe(Date.parse("2026-01-02T00:00:00Z"))
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at not-a-date 2026-01-02T00:00:00Z", at)).toBe(
      Date.parse("2026-01-02T00:00:00Z"),
    )
    // An invalid date alone still states no reset.
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at 2026-13-01", at)).toBeUndefined()
  })

  test("treats calendar-invalid dates as unparseable instead of rolling them forward", () => {
    // Date.parse rolls Feb 30 to Mar 2 and Apr 31 to May 1; neither states a reset.
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at 2026-02-30", at)).toBeUndefined()
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at 2026-04-31T00:00:00Z", at)).toBeUndefined()
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at 2026-02-29", at)).toBeUndefined()
    // Scanning continues past the rolled date to the valid reset stated after it.
    expect(
      ModelRouteLimits.resetAtFromMessage("quota reset at 2026-02-30, back at 2026-03-05T00:00:00Z", at),
    ).toBe(Date.parse("2026-03-05T00:00:00Z"))
    // Valid dates parse exactly as before, Feb 29 on a leap year included.
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at 2024-02-29", at)).toBe(Date.parse("2024-02-29"))
    expect(ModelRouteLimits.resetAtFromMessage("quota reset at 2026-02-28", at)).toBe(Date.parse("2026-02-28"))
    // The header form agrees: a calendar-invalid timestamp states no reset.
    expect(ModelRouteLimits.resetMs("2026-04-31", at)).toBeUndefined()
    expect(ModelRouteLimits.resetMs("2026-02-30", at)).toBeUndefined()
  })

  test("treats hour-24 ISO date-times as unparseable instead of rolling into the next day", () => {
    // V8 parses hour 24 as midnight of the following day; RFC 3339 time-hour is 00-23.
    for (const value of [
      "2026-01-01T24:00:00Z",
      "2026-01-01T24:00:00.000Z",
      "2026-01-01T24:00:00+05:00",
      "2025-12-31T24:00:00Z",
    ]) {
      expect(ModelRouteLimits.parseAbsoluteTime(value)).toBeUndefined()
      expect(ModelRouteLimits.resetMs(value, at)).toBeUndefined()
      expect(ModelRouteLimits.resetAtFromMessage(`quota reset at ${value}`, at)).toBeUndefined()
    }
    // Valid boundary times still parse exactly as before.
    for (const value of ["2026-01-01T23:59:59Z", "2026-01-01T00:00:00Z", "2024-02-29T23:59:59Z"]) {
      expect(ModelRouteLimits.parseAbsoluteTime(value)).toBe(Date.parse(value))
    }
  })

  test("treats calendar-invalid non-ISO dates as unparseable instead of rolling them forward (#798)", () => {
    // The ISO round-trip does not reach named or slash-ordered forms, but V8 rolls their
    // overflow days the same way: Feb 30 states no reset in any spelling.
    for (const value of ["Feb 30 2026", "Feb 30, 2026", "30 Feb 2026", "2026/02/30", "April 31 2026", "2026/04/31"]) {
      expect(ModelRouteLimits.parseAbsoluteTime(value)).toBeUndefined()
    }
    // Hour 24 is rejected in non-ISO forms too, not only ISO ones.
    expect(ModelRouteLimits.parseAbsoluteTime("Feb 28 2026 24:00")).toBeUndefined()
    // Valid non-ISO forms parse exactly as before, leap day included.
    for (const value of ["Jan 5 2026", "5 Jan 2026", "Feb 29 2024", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      expect(ModelRouteLimits.parseAbsoluteTime(value)).toBe(Date.parse(value))
    }
  })

  test("reads decimal and compound relative waits as the total", () => {
    expect(ModelRouteLimits.retryHintFromMessage("try again in 1.5 hours", at)).toBe(5_400_000)
    expect(ModelRouteLimits.resetAtFromMessage("try again in 1.5 hours", at)).toBe(at + 5_400_000)
    expect(ModelRouteLimits.retryHintFromMessage("try again in 1 hour 30 minutes", at)).toBe(5_400_000)
    expect(ModelRouteLimits.resetAtFromMessage("try again in 1 hour 30 minutes", at)).toBe(at + 5_400_000)
    expect(ModelRouteLimits.retryHintFromMessage("try again in 1 hour and 30 minutes", at)).toBe(5_400_000)
    expect(ModelRouteLimits.retryHintFromMessage("try again in 2.5 minutes", at)).toBe(150_000)
  })

  test("reads compact relative units (resets in 6d 13h)", () => {
    const total = 6 * 86_400_000 + 13 * 3_600_000
    expect(ModelRouteLimits.retryHintFromMessage("your quota resets in 6d 13h", at)).toBe(total)
    expect(ModelRouteLimits.resetAtFromMessage("your quota resets in 6d 13h", at)).toBe(at + total)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 2d", at)).toBe(at + 2 * 86_400_000)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 3h", at)).toBe(at + 3 * 3_600_000)
    // The letter units must not eat the head of a word: these state no wait at all.
    expect(ModelRouteLimits.resetAtFromMessage("come back in 5 deals", at)).toBeUndefined()
    expect(ModelRouteLimits.resetAtFromMessage("come back in 2 homes", at)).toBeUndefined()
    expect(ModelRouteLimits.resetAtFromMessage("come back in 5 marks", at)).toBeUndefined()
  })

  test("reads week units, single and compound (#2096)", () => {
    const week = 7 * 86_400_000
    expect(ModelRouteLimits.resetAtFromMessage("resets in 1 week", at)).toBe(at + week)
    expect(ModelRouteLimits.retryHintFromMessage("resets in 1 week", at)).toBe(week)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 2 weeks", at)).toBe(at + 2 * week)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 1 wk", at)).toBe(at + week)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 2 wks", at)).toBe(at + 2 * week)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 1 w", at)).toBe(at + week)
    // Compounds sum the week instead of silently dropping it, in either order.
    expect(ModelRouteLimits.resetAtFromMessage("resets in 1 week 2 days", at)).toBe(at + 9 * 86_400_000)
    expect(ModelRouteLimits.resetAtFromMessage("resets in 2 days and 1 week", at)).toBe(at + 9 * 86_400_000)
    // The compact "w" unit must not eat the head of a word.
    expect(ModelRouteLimits.resetAtFromMessage("come back in 5 windows", at)).toBeUndefined()
  })

  test("reads compact minute units and adjacent compact compounds (#996)", () => {
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 30m", at)).toBe(at + 1_800_000)
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 30min", at)).toBe(at + 1_800_000)
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 30mins", at)).toBe(at + 1_800_000)
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 1h 30m", at)).toBe(at + 5_400_000)
    // Adjacent compact parts sum too: "1h30m" is a 90-minute wait, not 1 hour.
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 1h30m", at)).toBe(at + 5_400_000)
    // "ms" is not "m": a millisecond wait stays milliseconds.
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 30ms", at)).toBe(at + 30)
  })

  test("reads every absolute-time keyword parseQuotaReset reads (paired with model-route-tuning)", () => {
    const instant = Date.parse("2026-01-02T00:00:00Z")
    for (const message of [
      "quota expires at 2026-01-02T00:00:00Z",
      "quota retry at 2026-01-02T00:00:00Z",
      "quota wait until 2026-01-02T00:00:00Z",
      "quota try again at 2026-01-02T00:00:00Z",
      "quota available at 2026-01-02T00:00:00Z",
      "quota resets at 2026-01-02T00:00:00Z",
    ])
      expect(ModelRouteLimits.resetAtFromMessage(message, at)).toBe(instant)
  })

  test("does not guess at anything else", () => {
    expect(ModelRouteLimits.retryHintFromMessage("server exploded", at)).toBeUndefined()
    expect(ModelRouteLimits.retryHintFromMessage(undefined, at)).toBeUndefined()
  })
})
