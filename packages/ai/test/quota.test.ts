import { describe, expect, test } from "bun:test"
import { parseMistralBudget } from "../src/quota/providers/mistral.js"
import { parseSubscriptionQuota } from "../src/quota/providers/meta.js"
import { tursoWindows } from "../src/quota/providers/turso.js"
import { parseGroqResetSeconds } from "../src/quota/providers/groq.js"
import {
  parseConsoleBillingBalance,
  parseConsoleGoUsage,
  parseOpenCodeGoUsage,
} from "../src/quota/providers/opencode-go.js"
import { resolveResetAt } from "../src/quota/providers/openrouter.js"

describe("mistral console budget mapping", () => {
  // The live billing.budget payload shape, captured 2026-11-05 from
  // admin.mistral.ai (percentages and budgets as the console reports
  // them; the dollar figures are the console's own truth: API ~$0.70 of
  // $15 at capture time, Vibe ~$0.06 of $150, reset 2026-12-01).
  const payload = {
    result: {
      data: {
        json: {
          usage_percentage: 4.658978,
          initial_budget: 15,
          currency: "USD",
          reset_at: "2026-12-01T00:00:00Z",
          api_budget: {
            usage_percentage: 4.658978,
            initial_budget: 15,
            currency: "USD",
            reset_at: "2026-12-01T00:00:00Z",
          },
          vibe_budget: {
            usage_percentage: 0.04296070666666667,
            initial_budget: 150,
            currency: "USD",
            reset_at: "2026-12-01T00:00:00Z",
          },
        },
      },
    },
  }

  test("maps both budgets to percent + dollar amounts with the shared reset", () => {
    const { api, vibe } = parseMistralBudget(payload)
    expect(api).not.toBeNull()
    expect(vibe).not.toBeNull()
    // usage_percentage is a percent: used = percent/100 * budget.
    expect(api?.usedPercent).toBeCloseTo(4.658978, 6)
    expect(api?.usedAmount).toBeCloseTo(0.6988467, 6)
    expect(api?.budgetAmount).toBe(15)
    expect(vibe?.usedPercent).toBeCloseTo(0.04296070666666667, 10)
    expect(vibe?.usedAmount).toBeCloseTo(0.06444106, 6)
    expect(vibe?.budgetAmount).toBe(150)
    expect(api?.resetAt).toBe(Date.parse("2026-12-01T00:00:00Z"))
    expect(vibe?.resetAt).toBe(Date.parse("2026-12-01T00:00:00Z"))
  })

  test("a payload without budgets maps to nulls, never zeros", () => {
    const { api, vibe } = parseMistralBudget({ result: { data: { json: {} } } })
    expect(api).toBeNull()
    expect(vibe).toBeNull()
  })
})

describe("meta portal subscription-quota mapping", () => {
  // The 2026-10-27 proven payload shape (code#6079): stringified
  // weighted units; window 1.02%, weekly 8.83%.
  const payload = {
    subscription_quota: {
      tier: "Muse Code High Usage",
      as_of: 1793534400,
      window_weighted_used: "1020000000",
      window_weighted_limit: "100000000000",
      window_duration_secs: 18000,
      window_resets_at: 1793552400,
      weekly_weighted_used: "26490000000",
      weekly_weighted_limit: "300000000000",
      weekly_resets_at: 1793980800,
    },
  }

  test("derives percentages from used/limit and labels the 18000s window 5h", () => {
    const parsed = parseSubscriptionQuota(payload)
    expect(parsed?.tier).toBe("Muse Code High Usage")
    expect(parsed?.windows["5h"]?.usedPercent).toBeCloseTo(1.02, 6)
    expect(parsed?.windows["5h"]?.windowSeconds).toBe(18000)
    expect(parsed?.windows["5h"]?.resetAt).toBe(1793552400 * 1000)
    expect(parsed?.windows.weekly?.usedPercent).toBeCloseTo(8.83, 6)
    expect(parsed?.windows.weekly?.resetAt).toBe(1793980800 * 1000)
  })

  test("a missing subscription_quota object maps to null", () => {
    expect(parseSubscriptionQuota({})).toBeNull()
    expect(parseSubscriptionQuota({ subscription_quota: { window_weighted_used: "1" } })).toBeNull()
  })
})

describe("turso org usage mapping", () => {
  test("maps counts to percent-of-Starter-limit windows with the period end as reset", () => {
    const mapped = tursoWindows(
      {
        organization: {
          usage: {
            rows_read: 250_000_000,
            rows_written: 1_000_000,
            storage_bytes: 2_500_000_000,
            bytes_synced: 0,
            databases: 44,
          },
        },
      },
      {
        plan: "scaler",
        current_billing_period_start: "2026-11-01T00:00:00Z",
        current_billing_period_end: "2026-12-01T00:00:00Z",
      },
    )
    expect(mapped?.planLabel).toBe("scaler")
    expect(mapped?.windows.databases?.usedPercent).toBe(44)
    expect(mapped?.windows.databases?.valueLabel).toBe("44 / 100")
    expect(mapped?.windows.storage?.usedPercent).toBe(50)
    expect(mapped?.windows.storage?.valueLabel).toBe("2.5 GB / 5 GB")
    expect(mapped?.windows["rows-read"]?.usedPercent).toBe(50)
    expect(mapped?.windows.databases?.resetAt).toBe(Date.parse("2026-12-01T00:00:00Z"))
    expect(mapped?.windows.databases?.windowSeconds).toBe(30 * 24 * 60 * 60)
  })

  test("a response without organization.usage maps to null", () => {
    expect(tursoWindows({}, {})).toBeNull()
    expect(tursoWindows(null, null)).toBeNull()
  })
})

describe("groq reset duration parsing", () => {
  test("parses Groq's header durations", () => {
    expect(parseGroqResetSeconds("2m59.56s")).toBeCloseTo(179.56, 2)
    expect(parseGroqResetSeconds("7.66s")).toBeCloseTo(7.66, 2)
    expect(parseGroqResetSeconds("14h12m")).toBe(14 * 3600 + 12 * 60)
    expect(parseGroqResetSeconds(null)).toBeNull()
    expect(parseGroqResetSeconds("soon")).toBeNull()
  })
})

describe("OpenCode Go API-key usage mapping", () => {
  test("maps rolling, weekly, and monthly usage payloads to quota windows", () => {
    const mapped = parseOpenCodeGoUsage({
      usage: {
        rolling: { percent: 37.5, resetsAt: "2026-11-05T12:00:00Z" },
        weekly: { percent: 62, resetsAt: "2026-11-09T00:00:00Z" },
        monthly: { percent: 105, resetsAt: "2026-12-01T00:00:00Z" },
      },
    })

    expect(mapped["5h"]?.usedPercent).toBe(37.5)
    expect(mapped["5h"]?.resetAt).toBe(Date.parse("2026-11-05T12:00:00Z"))
    expect(mapped.weekly?.usedPercent).toBe(62)
    expect(mapped.weekly?.resetAt).toBe(Date.parse("2026-11-09T00:00:00Z"))
    expect(mapped.monthly?.usedPercent).toBe(100)
  })

  test("keeps present windows with nulls when payload fields are missing", () => {
    const mapped = parseOpenCodeGoUsage({
      usage: {
        rolling: { percent: 20 },
        weekly: { resetsAt: "2026-11-09T00:00:00Z" },
      },
    })

    expect(mapped["5h"]?.usedPercent).toBe(20)
    expect(mapped["5h"]?.resetAt).toBeNull()
    expect(mapped.weekly?.usedPercent).toBeNull()
    expect(mapped.weekly?.resetAt).toBe(Date.parse("2026-11-09T00:00:00Z"))
    expect(parseOpenCodeGoUsage({})).toEqual({})
  })
})

describe("OpenCode Console Go usage mapping", () => {
  test("derives quota percentages from Console meter payloads", () => {
    const mapped = parseConsoleGoUsage({
      product: "go-plus",
      access: {
        meters: {
          fiveHour: {
            limitMicroCents: 50_000_000,
            usedMicroCents: 12_500_000,
            resetsAt: "2026-11-05T12:00:00Z",
          },
          week: {
            limitMicroCents: 150_000_000,
            usedMicroCents: 100_000_000,
            resetsAt: "2026-11-09T00:00:00Z",
          },
          month: {
            limitMicroCents: 100_000_000,
            usedMicroCents: 0,
            resetsAt: "2026-12-01T00:00:00Z",
          },
        },
      },
    })

    expect(mapped["5h"]?.usedPercent).toBe(25)
    expect(mapped["5h"]?.resetAt).toBe(Date.parse("2026-11-05T12:00:00Z"))
    expect(mapped.weekly?.usedPercent).toBeCloseTo((100_000_000 / 150_000_000) * 100, 6)
    expect(mapped.monthly?.usedPercent).toBe(0)
  })

  test("returns no windows for missing or incomplete meter payloads", () => {
    expect(parseConsoleGoUsage({})).toEqual({})
    expect(
      parseConsoleGoUsage({
        access: { meters: { fiveHour: { limitMicroCents: 100_000_000, usedMicroCents: 20_000_000 } } },
      }),
    ).toEqual({})
  })
})

describe("OpenCode Console billing balance mapping", () => {
  test("converts available micro-cents to dollars", () => {
    expect(parseConsoleBillingBalance({ availableMicroCents: 123_456_789 })).toBe(1.23456789)
  })

  test("maps missing and negative balances to null", () => {
    expect(parseConsoleBillingBalance({})).toBeNull()
    expect(parseConsoleBillingBalance({ availableMicroCents: -1 })).toBeNull()
    expect(parseConsoleBillingBalance(null)).toBeNull()
  })
})

describe("OpenRouter calendar reset calculation", () => {
  test("daily reset is the next UTC midnight across the year boundary", () => {
    expect(resolveResetAt("daily", Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1))
  })

  test("weekly reset is the next Monday UTC, including across week and year boundaries", () => {
    expect(resolveResetAt("weekly", Date.UTC(2026, 11, 27, 23, 59, 59))).toBe(Date.UTC(2026, 11, 28))
    expect(resolveResetAt("weekly", Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 4))
    expect(resolveResetAt("weekly", Date.UTC(2026, 11, 28))).toBe(Date.UTC(2027, 0, 4))
  })

  test("monthly reset is the first UTC day of the next month and year", () => {
    expect(resolveResetAt("monthly", Date.UTC(2026, 10, 30, 23, 59, 59))).toBe(Date.UTC(2026, 11, 1))
    expect(resolveResetAt("monthly", Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1))
  })

  test("unknown reset periods have no calendar reset", () => {
    expect(resolveResetAt("quarterly", Date.UTC(2026, 11, 31))).toBeNull()
  })
})
