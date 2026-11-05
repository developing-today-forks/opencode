import { describe, expect, test } from "bun:test"
import { parseMistralBudget } from "../src/quota/providers/mistral.js"
import { parseSubscriptionQuota } from "../src/quota/providers/meta.js"
import { tursoWindows } from "../src/quota/providers/turso.js"
import { parseGroqResetSeconds } from "../src/quota/providers/groq.js"
import { toNumber } from "../src/quota/utils.js"
import { parseCommandCodeCredits } from "../src/quota/providers/command-code.js"
import { parseOpenCodeGoUsage } from "../src/quota/providers/opencode-go.js"

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

  test("over-limit usage publishes windows above 100 percent (code#6227)", () => {
    // The 2026-11-05 live shape: storage and rows-read over their
    // Starter limits vanished from the quota row because the mapper
    // dropped pct > 100 windows, so the over-limit state read as
    // recovered.
    const mapped = tursoWindows(
      {
        organization: {
          usage: {
            rows_read: 821_437_321,
            rows_written: 1_672_071,
            storage_bytes: 7_358_009_000,
            bytes_synced: 0,
            databases: 44,
          },
        },
      },
      {
        plan: "starter",
        current_billing_period_start: "2026-11-01T00:00:00Z",
        current_billing_period_end: "2026-12-01T00:00:00Z",
      },
    )
    expect(mapped?.windows.storage?.usedPercent).toBe(147.16)
    expect(mapped?.windows.storage?.valueLabel).toBe("7.358009 GB / 5 GB")
    expect(mapped?.windows["rows-read"]?.usedPercent).toBe(164.287)
    expect(mapped?.windows.databases?.usedPercent).toBe(44)
    expect(mapped?.windows.sync?.usedPercent).toBe(0)
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

describe("toNumber blank-string handling (#1741)", () => {
  test("empty and whitespace-only strings are absent values, not zero", () => {
    expect(toNumber("")).toBeNull()
    expect(toNumber("   ")).toBeNull()
    expect(toNumber("12")).toBe(12)
    expect(toNumber(" 12 ")).toBe(12)
    expect(toNumber("-3.5")).toBe(-3.5)
    expect(toNumber("abc")).toBeNull()
    expect(toNumber(0)).toBe(0)
    expect(toNumber(undefined)).toBeNull()
  })

  test("an empty monthlyCredits field mints no 100%-used command-code window", () => {
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: "" } })).toEqual({})
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: " " } })).toEqual({})
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: 0 } }).monthly?.usedPercent).toBe(100)
  })

describe("command-code monthly over-included credits (#1744)", () => {
  test("remaining above the included amount publishes a 0%-used monthly window", () => {
    const windows = parseCommandCodeCredits({ credits: { monthlyCredits: 25 } })
    expect(windows.monthly?.usedPercent).toBe(0)
    expect(windows.monthly?.valueLabel).toContain("25")
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: 10 } }).monthly?.usedPercent).toBe(0)
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: 5 } }).monthly?.usedPercent).toBe(50)
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: 5 } }).monthly?.valueLabel).toBe("5 / 10")
  })
})

  test("an empty percent field mints no 0%-used opencode-go window", () => {
    const payload = { usage: { rolling: { percent: "", resetsAt: 1893456000 } } }
    expect(parseOpenCodeGoUsage(payload)).toEqual({})
  })

  test("an empty weighted-used field fails meta parseSubscriptionQuota null gate", () => {
    const payload = {
      subscription_quota: {
        window_weighted_used: "",
        window_weighted_limit: "100",
        weekly_weighted_used: "10",
        weekly_weighted_limit: "100",
        window_resets_at: "1893456000",
        weekly_resets_at: "1893456000",
        window_duration_secs: "18000",
      },
    }
    expect(parseSubscriptionQuota(payload)).toBeNull()
  })
})
