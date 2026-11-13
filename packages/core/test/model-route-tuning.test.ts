import { afterEach, describe, expect, test } from "bun:test"
import type { ErrorBreakdown, TargetStats } from "@opencode/core/model-route-log"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteLimits } from "@opencode/core/model-route-limits"
import { ModelRouteTuning } from "@opencode/core/model-route-tuning"

afterEach(() => {
  ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS)
})

const stats = (modelID: string, over: Partial<TargetStats> = {}): TargetStats => ({
  providerID: "p",
  modelID,
  attempts: 20,
  failures: 0,
  policyRejections: 0,
  timeouts: 0,
  avgFirstTokenMs: 500,
  avgResponseMs: 4_000,
  avgTokensPerSecond: 50,
  ...over,
})

const quota = (modelID: string): ErrorBreakdown => ({
  providerID: "p",
  modelID,
  tag: "QuotaExceeded",
  code: null,
  status: 429,
  count: 3,
  lastTime: 1,
  lastMessage: "out of quota",
})

describe("ModelRouteTuning.suggest", () => {
  const now = 1_000_000

  test("leaves healthy and thinly sampled targets alone", () => {
    expect(
      ModelRouteTuning.suggest({
        stats: [stats("ok"), stats("new", { attempts: 2, failures: 2 })],
        errors: [],
        now,
      }),
    ).toEqual([])
  })

  test("lowers the share of a failing target in proportion to how badly it fails", () => {
    const result = ModelRouteTuning.suggest({
      stats: [stats("bad", { failures: 12 }), stats("shaky", { failures: 5 }), stats("ok")],
      errors: [],
      now,
    })
    expect(result.map((item) => [item.match, item.action, item.factor])).toEqual([
      ["p/bad", "weight", 0.1],
      ["p/shaky", "weight", 0.5],
    ])
    expect(result[0].id).toBe("auto:p/bad")
    expect(result[0].until).toBe(now + 30 * 60_000)
  })

  test("skips a target that reported an exhausted quota, even with little data", () => {
    const result = ModelRouteTuning.suggest({
      stats: [stats("dry", { attempts: 3, failures: 3 })],
      errors: [quota("dry")],
      now,
    })
    expect(result).toMatchObject([{ match: "p/dry", action: "skip" }])
  })

  test("downweights a target far slower to first output than its peers", () => {
    const result = ModelRouteTuning.suggest({
      stats: [stats("a"), stats("b"), stats("slow", { avgFirstTokenMs: 4_000 })],
      errors: [],
      now,
    })
    expect(result.map((item) => item.match)).toEqual(["p/slow"])
  })

  test("averages the two middle first-token times for an even peer count (#534)", () => {
    const result = ModelRouteTuning.suggest({
      stats: [
        stats("a", { avgFirstTokenMs: 100 }),
        stats("b", { avgFirstTokenMs: 100 }),
        stats("c", { avgFirstTokenMs: 400 }),
        stats("slow", { avgFirstTokenMs: 1_000 }),
      ],
      errors: [],
      now,
    })
    expect(result.map((item) => [item.match, item.action, item.factor])).toEqual([["p/slow", "weight", 0.5]])
  })
})

describe("ModelRouteTuning predictions", () => {
  const hourly = [
    { providerID: "p", modelID: "m", hour: 3, attempts: 20, failures: 1, policyRejections: 0 },
    { providerID: "p", modelID: "m", hour: 14, attempts: 20, failures: 12, policyRejections: 0 },
    { providerID: "q", modelID: "n", hour: 3, attempts: 20, failures: 1, policyRejections: 0 },
    { providerID: "q", modelID: "n", hour: 14, attempts: 20, failures: 1, policyRejections: 0 },
  ]

  test("flags a target that has been unreliable at this hour, not one that has not", () => {
    const at = Date.UTC(2026, 0, 1, 14, 0, 0)
    const predictions = ModelRouteTuning.predict({ hourly, errors: [], now: at })
    expect(predictions).toEqual([
      {
        target: "p/m",
        state: "busy-hour",
        detail: "60% of 20 attempts failed at hour 14, against 5% at other hours",
      },
    ])
  })

  test("says nothing without enough attempts in the hour", () => {
    const sparse = [{ providerID: "p", modelID: "m", hour: 14, attempts: 2, failures: 2, policyRejections: 0 }]
    expect(ModelRouteTuning.predict({ hourly: sparse, errors: [], now: Date.UTC(2026, 0, 1, 14) })).toEqual([])
  })

  test("reads a quota reset out of the provider's own message", () => {
    const at = Date.UTC(2026, 0, 1, 14)
    const errors = [
      {
        providerID: "q",
        modelID: "n",
        tag: "QuotaExceeded",
        code: null,
        status: 429,
        count: 3,
        lastTime: at,
        lastMessage: "quota exceeded; try again in 3 hours",
      },
    ]
    expect(ModelRouteTuning.predict({ hourly, errors, now: at })).toContainEqual({
      target: "q/n",
      state: "quota-reset",
      detail: `provider message says the quota returns ${new Date(at + 3 * 3_600_000).toISOString()}`,
      until: at + 3 * 3_600_000,
    })
  })

  test("bounds a runaway quota reset at the 30-day ceiling instead of benching the target or throwing (#933)", () => {
    const at = Date.UTC(2026, 0, 1, 14)
    const ceiling = at + 30 * 86_400_000
    for (const lastMessage of [
      "quota exceeded; reset at 9999-01-01T00:00:00Z",
      "quota exceeded; try again in 100000 days",
      // Past the representable Date range: building the detail used to throw RangeError here.
      "quota exceeded; try again in 999999999 days",
    ]) {
      const errors = [
        {
          providerID: "q",
          modelID: "n",
          tag: "QuotaExceeded",
          code: null,
          status: 429,
          count: 3,
          lastTime: at,
          lastMessage,
        },
      ]
      expect(ModelRouteTuning.predict({ hourly, errors, now: at })).toContainEqual({
        target: "q/n",
        state: "quota-reset",
        // Capped predictions say so instead of repeating the capped date as the provider's.
        detail: `provider message states a reset past the 30-day ceiling; predicting ${new Date(ceiling).toISOString()}`,
        until: ceiling,
      })
    }
  })

  test("a non-default quota-gate ceiling moves the tuning prediction ceiling with it (#1424)", () => {
    const at = Date.UTC(2026, 0, 1, 14)
    ModelRoute.configureConstants({ quotaGate: { maxMs: 7 * 86_400_000 } })
    expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 100000 days", at)).toBe(at + 7 * 86_400_000)
    expect(ModelRouteTuning.quotaResetCeilingMs()).toBe(7 * 86_400_000)
    const errors = [
      {
        providerID: "q",
        modelID: "n",
        tag: "QuotaExceeded",
        code: null,
        status: 429,
        count: 3,
        lastTime: at,
        lastMessage: "quota exceeded; try again in 100000 days",
      },
    ]
    expect(ModelRouteTuning.predict({ hourly, errors, now: at })).toContainEqual({
      target: "q/n",
      state: "quota-reset",
      detail: `provider message states a reset past the 7-day ceiling; predicting ${new Date(at + 7 * 86_400_000).toISOString()}`,
      until: at + 7 * 86_400_000,
    })
    // Within the tighter ceiling the stated reset is honoured as written.
    expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 3 hours", at)).toBe(at + 3 * 3_600_000)
  })

  test("the default tuning ceiling is the 30-day quota-gate default (#1424)", () => {
    expect(ModelRouteTuning.quotaResetCeilingMs()).toBe(ModelRoute.DEFAULT_CONSTANTS.quotaGate.maxMs)
    expect(ModelRouteTuning.quotaResetCeilingMs()).toBe(30 * 86_400_000)
  })

  test("two Locations with divergent quotaGate.maxMs each judge tuning ceilings by their own gate (#1461)", () => {
    const at = Date.UTC(2026, 0, 1, 14)
    const offA = ModelRoute.onSettingsConfig(() => ({ quotaGate: { maxMs: 7 * 86_400_000 } }), "/loc/a")
    const offB = ModelRoute.onSettingsConfig(() => ({ quotaGate: { maxMs: 2 * 86_400_000 } }), "/loc/b")
    try {
      expect(ModelRouteTuning.quotaResetCeilingMs(undefined, "/loc/a")).toBe(7 * 86_400_000)
      expect(ModelRouteTuning.quotaResetCeilingMs(undefined, "/loc/b")).toBe(2 * 86_400_000)
      // An unscoped read with two Locations registered falls back to the defaults
      // rather than borrowing whichever Location registered last.
      expect(ModelRouteTuning.quotaResetCeilingMs()).toBe(30 * 86_400_000)
      expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 100000 days", at, undefined, "/loc/a")).toBe(
        at + 7 * 86_400_000,
      )
      expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 100000 days", at, undefined, "/loc/b")).toBe(
        at + 2 * 86_400_000,
      )
      const errors = [
        {
          providerID: "q",
          modelID: "n",
          tag: "QuotaExceeded",
          code: null,
          status: 429,
          count: 3,
          lastTime: at,
          lastMessage: "quota exceeded; try again in 100000 days",
        },
      ]
      expect(ModelRouteTuning.predict({ hourly: [], errors, now: at, location: "/loc/a" })).toContainEqual({
        target: "q/n",
        state: "quota-reset",
        detail: `provider message states a reset past the 7-day ceiling; predicting ${new Date(at + 7 * 86_400_000).toISOString()}`,
        until: at + 7 * 86_400_000,
      })
      expect(ModelRouteTuning.predict({ hourly: [], errors, now: at, location: "/loc/b" })).toContainEqual({
        target: "q/n",
        state: "quota-reset",
        detail: `provider message states a reset past the 2-day ceiling; predicting ${new Date(at + 2 * 86_400_000).toISOString()}`,
        until: at + 2 * 86_400_000,
      })
      // Notes are bounded by the judging Location's ceiling too: a reset stated
      // three days out is honoured under A's 7-day ceiling, capped under B's 2-day one.
      const note = [{ match: "q", text: "quota reset at 2026-01-04T14:00:00Z" }]
      expect(ModelRouteTuning.noteAdjustments(note, at, 60_000, undefined, "/loc/a")[0]?.until).toBe(at + 3 * 86_400_000)
      expect(ModelRouteTuning.noteAdjustments(note, at, 60_000, undefined, "/loc/b")[0]?.until).toBe(at + 2 * 86_400_000)
    } finally {
      offA()
      offB()
    }
  })
})

describe("ModelRouteTuning.parseQuotaReset", () => {
  const at = Date.UTC(2026, 0, 1, 14)

  test("reads absolute and relative reset times", () => {
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted; resets at 2026-01-01T18:00:00Z", at)).toBe(
      Date.UTC(2026, 0, 1, 18),
    )
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted; resets at 2026-01-01T23:30:00+05:30", at)).toBe(
      Date.UTC(2026, 0, 1, 18),
    )
    expect(ModelRouteTuning.parseQuotaReset("rate limit reached, back in 30 minutes", at)).toBe(at + 1_800_000)
    // The documented short form: "in 45s" (and "sec") read as 45 seconds.
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted, back in 45s", at)).toBe(at + 45_000)
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted, back in 45 sec", at)).toBe(at + 45_000)
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted, back in 45 seconds", at)).toBe(at + 45_000)
    // Decimal and compound relative forms read as the total wait, like in ModelRouteLimits.
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted, back in 1.5 hours", at)).toBe(at + 5_400_000)
    expect(ModelRouteTuning.parseQuotaReset("quota exhausted, back in 1 hour 30 minutes", at)).toBe(at + 5_400_000)
    // Paired with model-route-limits: every absolute-time keyword reads the same instant here.
    const instant = Date.parse("2026-01-02T00:00:00Z")
    for (const message of [
      "quota expires at 2026-01-02T00:00:00Z",
      "quota retry at 2026-01-02T00:00:00Z",
      "quota wait until 2026-01-02T00:00:00Z",
      "quota try again at 2026-01-02T00:00:00Z",
      "quota available at 2026-01-02T00:00:00Z",
      "quota resets at 2026-01-02T00:00:00Z",
    ])
      expect(ModelRouteTuning.parseQuotaReset(message, at)).toBe(instant)
    // The quota gate is unchanged: the same keywords without a quota/limit mention read nothing.
    expect(ModelRouteTuning.parseQuotaReset("available at 2026-01-02T00:00:00Z", at)).toBeUndefined()
    expect(ModelRouteTuning.parseQuotaReset("try in 5 minutes", at)).toBeUndefined()
    expect(ModelRouteTuning.parseQuotaReset(undefined, at)).toBeUndefined()
  })

  test("reads the same relative units as ModelRouteLimits over a shared case table (#996)", () => {
    // Paired parity: both doors honour the same relative grammar — the tuning parser
    // shares ModelRouteLimits.relativeMs, and this table pins the two entry points to
    // identical results so a future grammar edit cannot drift them apart silently.
    for (const [message, wait] of [
      ["quota resets in 6d 13h", 6 * 86_400_000 + 13 * 3_600_000],
      ["quota exhausted, resets in 3h", 3 * 3_600_000],
      ["quota resets in 2d", 2 * 86_400_000],
      ["quota resets in 30m", 1_800_000],
      ["quota resets in 30min", 1_800_000],
      ["quota resets in 30mins", 1_800_000],
      ["quota resets in 45s", 45_000],
      ["quota resets in 1 hour 30 minutes", 5_400_000],
      ["quota resets in 1h30m", 5_400_000],
      ["quota resets in 30ms", 30],
      ["quota resets in 1 week", 7 * 86_400_000],
      ["quota resets in 2 weeks", 14 * 86_400_000],
      ["quota resets in 1 wk", 7 * 86_400_000],
      ["quota resets in 1 week 2 days", 9 * 86_400_000],
      ["quota resets in 2 days and 1 week", 9 * 86_400_000],
    ] as const) {
      expect(ModelRouteLimits.resetAtFromMessage(message, at)).toBe(at + wait)
      expect(ModelRouteTuning.parseQuotaReset(message, at)).toBe(at + wait)
    }
    for (const message of [
      "quota, come back in 5 deals",
      "quota, come back in 2 homes",
      "quota, come back in 5 marks",
      "quota, come back in 5 windows",
    ])
      expect(ModelRouteTuning.parseQuotaReset(message, at)).toBeUndefined()
  })

  test("scans past an unparseable first date to a later valid reset", () => {
    expect(
      ModelRouteTuning.parseQuotaReset("quota reset at 2026-13-01, back at 2026-01-02T00:00:00Z", at),
    ).toBe(Date.parse("2026-01-02T00:00:00Z"))
    expect(ModelRouteTuning.parseQuotaReset("quota reset at not-a-date 2026-01-02T00:00:00Z", at)).toBe(
      Date.parse("2026-01-02T00:00:00Z"),
    )
    // An invalid date alone still states no reset.
    expect(ModelRouteTuning.parseQuotaReset("quota reset at 2026-13-01", at)).toBeUndefined()
  })

  test("bounds runaway resets at the 30-day ceiling and never throws (#933)", () => {
    const ceiling = at + 30 * 86_400_000
    expect(ModelRouteTuning.parseQuotaReset("quota exceeded; reset at 9999-01-01T00:00:00Z", at)).toBe(ceiling)
    expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 100000 days", at)).toBe(ceiling)
    // 999999999 days is beyond the maximum representable Date; it caps instead of overflowing.
    expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 999999999 days", at)).toBe(ceiling)
    // Within the ceiling the stated reset is honoured as written.
    expect(ModelRouteTuning.parseQuotaReset("quota exceeded, back in 3 hours", at)).toBe(at + 3 * 3_600_000)
  })

  test("treats calendar-invalid dates as unparseable, like ModelRouteLimits", () => {
    expect(ModelRouteTuning.parseQuotaReset("quota reset at 2026-02-30", at)).toBeUndefined()
    // The later valid reset (2026-03-05) is more than 30 days out from `at`, so the #933
    // ceiling bounds it instead of honouring it as written.
    expect(
      ModelRouteTuning.parseQuotaReset("quota reset at 2026-02-30, back at 2026-03-05T00:00:00Z", at),
    ).toBe(at + 30 * 86_400_000)
    expect(ModelRouteTuning.parseQuotaReset("quota reset at 2024-02-29", at)).toBe(Date.parse("2024-02-29"))
  })
})

describe("ModelRouteTuning notes", () => {
  const at = Date.UTC(2026, 0, 1, 14)

  test("reads the match and text of each note line", () => {
    expect(
      ModelRouteTuning.parseNotes([
        "anthropic/claude-opus-5: promo credits reset at 2026-01-04T00:00:00Z",
        "no separator here",
        ": no match",
        "openai/gpt-6-luna:   ",
      ]),
    ).toEqual([{ match: "anthropic/claude-opus-5", text: "promo credits reset at 2026-01-04T00:00:00Z" }])
    expect(ModelRouteTuning.parseNotes(undefined)).toEqual([])
  })

  test("drops the lines that do not match the note rule, and keeps a later colon in the text", () => {
    expect(ModelRouteTuning.parseNotes([":x:y", "x::y", "x:", "match: text", "a: b\nc"])).toEqual([
      { match: "x", text: ":y" },
      { match: "match", text: "text" },
    ])
  })

  test("a note that states when the quota returns skips the target until then", () => {
    const adjustments = ModelRouteTuning.noteAdjustments(
      [{ match: "claude", text: "promo credits reset at 2026-01-04T00:00:00Z" }],
      at,
      30 * 60_000,
    )
    expect(adjustments).toEqual([
      {
        id: "note:claude",
        match: "claude",
        action: "skip",
        until: Date.parse("2026-01-04T00:00:00Z"),
        note: "promo credits reset at 2026-01-04T00:00:00Z",
      },
    ])
  })

  test("a note that says nothing actionable is left to the agent to read", () => {
    expect(
      ModelRouteTuning.noteAdjustments([{ match: "claude", text: "favored while the promo lasts" }], at, 60_000),
    ).toEqual([])
    expect(ModelRouteTuning.noteAdjustments([{ match: "claude", text: "" }], at, 60_000)).toEqual([])
  })
})
