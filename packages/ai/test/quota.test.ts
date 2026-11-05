import { describe, expect, test } from "bun:test"
import { parseMistralBudget } from "../src/quota/providers/mistral.js"
import { parseSubscriptionQuota } from "../src/quota/providers/meta.js"
import { tursoWindows } from "../src/quota/providers/turso.js"
import { parseGroqResetSeconds } from "../src/quota/providers/groq.js"
import { toNumber } from "../src/quota/utils.js"
import { parseCommandCodeCredits } from "../src/quota/providers/command-code.js"
import { parseOpenCodeGoUsage } from "../src/quota/providers/opencode-go.js"
import { provider as codexProvider } from "../src/quota/providers/codex.js"
import { provider as clinePassProvider } from "../src/quota/providers/cline-pass.js"
import { parseBillingBanner } from "../src/quota/providers/meta.js"
import { toClaudeUsage } from "../src/quota/providers/claude.js"
import { normalizeOpenDesignCredential, parseCodingPlanWindows } from "../src/quota/providers/opendesign.js"

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

  test("a payload with no window_resets_at still parses (live 2026-11-05 shape)", () => {
    // Observed live 2026-11-05 after re-login: the rolling window
    // had not started (used "0") and the portal omitted
    // window_resets_at entirely; weekly was over its limit. The
    // parser must map this, not fall through to the key endpoint's
    // empty post-roll state.
    const live = {
      subscription_quota: {
        tier: "Muse Code High Usage",
        as_of: 1793896168,
        window_weighted_used: "0",
        window_weighted_limit: "100000000000",
        window_duration_secs: 18000,
        weekly_weighted_used: "300549363810",
        weekly_weighted_limit: "300000000000",
        weekly_resets_at: 1794182400,
      },
    }
    const parsed = parseSubscriptionQuota(live)
    expect(parsed?.tier).toBe("Muse Code High Usage")
    expect(parsed?.windows["5h"]?.usedPercent).toBe(0)
    expect(parsed?.windows["5h"]?.resetAt).toBeNull()
    expect(parsed?.windows.weekly?.usedPercent).toBe(100)
    expect(parsed?.windows.weekly?.resetAt).toBe(1794182400 * 1000)
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

describe("meta billing banner (#1750)", () => {
  test("numeric and numeric-string minor units both convert to dollars", () => {
    expect(parseBillingBanner({ remaining_minor_units: 12345, currency: "USD" })).toBe(123.45)
    expect(parseBillingBanner({ remaining_minor_units: "12345", currency: "USD" })).toBe(123.45)
    expect(parseBillingBanner({ remaining_minor_units: 0, currency: "USD" })).toBe(0)
  })

  test("absent, blank, malformed, negative, and non-USD banners map to null", () => {
    expect(parseBillingBanner({ currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: "", currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: "abc", currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: -5, currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: 100, currency: "EUR" })).toBeNull()
    expect(parseBillingBanner({})).toBeNull()
    expect(parseBillingBanner(null)).toBeNull()
  })
})

describe("claude usage transform (#1750)", () => {
  const resets = "2026-12-01T00:00:00Z"

  test("limits session/weekly windows win; legacy fills only the gaps", () => {
    const { windows, models } = toClaudeUsage({
      limits: [{ kind: "session", percent: 20, resets_at: resets }],
      five_hour: { utilization: 40, resets_at: resets },
      seven_day: { utilization: 50, resets_at: resets },
    })
    expect(windows["5h"]?.usedPercent).toBe(20)
    expect(windows["7d"]?.usedPercent).toBe(50)
    expect(models).toEqual({})
  })

  test("a scoped-only limits list still surfaces the legacy windows", () => {
    const { windows, models } = toClaudeUsage({
      limits: [
        { kind: "weekly_scoped", percent: 30, resets_at: resets, scope: { model: { display_name: "Claude Sonnet" } } },
      ],
      five_hour: { utilization: 40, resets_at: resets },
      seven_day: { utilization: 50, resets_at: resets },
    })
    expect(windows["5h"]?.usedPercent).toBe(40)
    expect(windows["7d"]?.usedPercent).toBe(50)
    expect(models["Claude Sonnet"]?.windows["7d"]?.usedPercent).toBe(30)
  })

  test("legacy-only and empty payloads keep their shapes", () => {
    const legacy = toClaudeUsage({ five_hour: { utilization: 10, resets_at: resets } })
    expect(legacy.windows["5h"]?.usedPercent).toBe(10)
    expect(legacy.windows["7d"]).toBeUndefined()
    expect(toClaudeUsage({})).toEqual({ windows: {}, models: {} })
    expect(toClaudeUsage(null)).toEqual({ windows: {}, models: {} })
  })
})

describe("opendesign coding-plan windows (#1750)", () => {
  test("maps known durations to percent-used windows, string numbers included", () => {
    const windows = parseCodingPlanWindows({
      windows: [
        { durationSeconds: 18000, limitCredits: 100, remainingCredits: 25 },
        { durationSeconds: "604800", limitCredits: "50", remainingCredits: "50" },
      ],
    })
    expect(windows?.["5h"]?.usedPercent).toBe(75)
    expect(windows?.["5h"]?.valueLabel).toBe("25 / 100 credits")
    expect(windows?.["5h"]?.windowSeconds).toBe(18000)
    expect(windows?.["7d"]?.usedPercent).toBe(0)
  })

  test("a zero-limit entry publishes no window", () => {
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 0, remainingCredits: 0 }] })).toBeNull()
    const windows = parseCodingPlanWindows({
      windows: [
        { durationSeconds: 18000, limitCredits: 0, remainingCredits: 0 },
        { durationSeconds: 604800, limitCredits: 10, remainingCredits: 5 },
      ],
    })
    expect(windows?.["5h"]).toBeUndefined()
    expect(windows?.["7d"]?.usedPercent).toBe(50)
  })

  test("duplicate durations keep the first entry; unknown durations and bad shapes map to null", () => {
    const windows = parseCodingPlanWindows({
      windows: [
        { durationSeconds: 18000, limitCredits: 100, remainingCredits: 25 },
        { durationSeconds: 18000, limitCredits: 100, remainingCredits: 0 },
      ],
    })
    expect(windows?.["5h"]?.usedPercent).toBe(75)
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 3600, limitCredits: 10, remainingCredits: 5 }] })).toBeNull()
    expect(parseCodingPlanWindows({})).toBeNull()
    expect(parseCodingPlanWindows({ windows: "nope" })).toBeNull()
    expect(parseCodingPlanWindows(null)).toBeNull()
  })
})

describe("opendesign credential normalization (#1750)", () => {
  test("a bare token is prefixed with the session-cookie name; a full cookie passes through", () => {
    expect(normalizeOpenDesignCredential({ cookie: "abc123", workspaceId: "ws1" })).toEqual({
      cookie: "better-auth.session_token=abc123",
      workspaceId: "ws1",
    })
    expect(normalizeOpenDesignCredential({ cookie: "better-auth.session_token=xyz", workspaceId: "ws1" })).toEqual({
      cookie: "better-auth.session_token=xyz",
      workspaceId: "ws1",
    })
  })

  test("missing, empty, or newline-carrying credentials map to null", () => {
    expect(normalizeOpenDesignCredential({ cookie: "abc123" })).toBeNull()
    expect(normalizeOpenDesignCredential({ workspaceId: "ws1" })).toBeNull()
    expect(normalizeOpenDesignCredential({ cookie: "", workspaceId: "ws1" })).toBeNull()
    expect(normalizeOpenDesignCredential({ cookie: "a\nb", workspaceId: "ws1" })).toBeNull()
    expect(normalizeOpenDesignCredential(null)).toBeNull()
  })
})

describe("codex quota window mapping (#1762)", () => {
  // Drive the real provider against a mocked wham/usage response.
  const fetchWith = (payload: unknown) =>
    codexProvider.fetchQuota({
      credentials: [
        {
          id: "row-1",
          integrationID: "openai",
          active: true,
          value: { type: "oauth", access: "tok-fixture", refresh: "fixture", expires: 4_102_444_800_000 },
        },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: {},
    })

  const reset = 1893456000

  test("distinct durations keep the plain 5h/weekly keys", async () => {
    const result = await fetchWith({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: reset },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows["5h"]?.usedPercent).toBe(10)
    expect(result.usage?.windows["5h"]?.resetAt).toBe(reset * 1000)
    expect(result.usage?.windows.weekly?.usedPercent).toBe(80)
  })

  test("missing durations collide on tokens and both windows survive qualified", async () => {
    const result = await fetchWith({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: reset },
        secondary_window: { used_percent: 80, reset_at: reset },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.tokens).toBeUndefined()
    expect(result.usage?.windows["tokens-primary"]?.usedPercent).toBe(10)
    expect(result.usage?.windows["tokens-secondary"]?.usedPercent).toBe(80)
  })

  test("equal durations qualify both keys instead of overwriting", async () => {
    const result = await fetchWith({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: 18000, reset_at: reset },
      },
    })
    expect(result.usage?.windows["5h"]).toBeUndefined()
    expect(result.usage?.windows["5h-primary"]?.usedPercent).toBe(10)
    expect(result.usage?.windows["5h-secondary"]?.usedPercent).toBe(80)
  })

  test("an empty window object mints no phantom window", async () => {
    const result = await fetchWith({
      rate_limit: {
        primary_window: {},
        secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: reset },
      },
    })
    expect(result.ok).toBe(true)
    expect(Object.keys(result.usage?.windows ?? {})).toEqual(["weekly"])
  })

  test("a window with duration/reset but no used_percent is dropped", async () => {
    const result = await fetchWith({
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: reset },
      },
    })
    expect(result.usage?.windows["5h"]).toBeUndefined()
    expect(result.usage?.windows.weekly?.usedPercent).toBe(80)
  })

  test("no usable data at all is the sibling no-data contract, not ok:true", async () => {
    const empty = await fetchWith({ rate_limit: {} })
    expect(empty.ok).toBe(false)
    expect(empty.configured).toBe(true)
    expect(empty.error).toBe("No quota data in response")
    expect(empty.usage).toBeNull()

    const percentless = await fetchWith({
      rate_limit: { primary_window: { limit_window_seconds: 18000, reset_at: reset } },
    })
    expect(percentless.ok).toBe(false)
    expect(percentless.error).toBe("No quota data in response")
  })

  test("credits data alone still counts as usable data", async () => {
    const result = await fetchWith({ rate_limit: {}, credits: { balance: 12.5, unlimited: false } })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("12.5")
  })
})

describe("cline-pass quota mapping (#1769)", () => {
  // Drive the real provider against a stubbed usage-limits response.
  const fetchWith = (payload: unknown) =>
    clinePassProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "cline-pass", active: true, value: { type: "key", key: "fixture-key" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: {},
    })

  test("duplicate five_hour entries publish the first, not the last", async () => {
    const result = await fetchWith({
      data: {
        limits: [
          { type: "five_hour", percentUsed: 10, resetsAt: 1893456000 },
          { type: "five_hour", percentUsed: 90, resetsAt: 1893456000 },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows["5h"]?.usedPercent).toBe(10)
    expect(result.usage?.windows["5h"]?.windowSeconds).toBe(18000)
  })

  test("duplicate weekly entries publish the first, string percents included", async () => {
    const result = await fetchWith({
      data: {
        limits: [
          { type: "weekly", percentUsed: "42" },
          { type: "weekly", percentUsed: 7 },
        ],
      },
    })
    expect(result.usage?.windows.weekly?.usedPercent).toBe(42)
  })

  test("distinct types publish all their windows", async () => {
    const result = await fetchWith({
      data: {
        limits: [
          { type: "five_hour", percentUsed: 10 },
          { type: "weekly", percentUsed: 20 },
          { type: "monthly", percentUsed: 30 },
        ],
      },
    })
    expect(result.usage?.windows["5h"]?.usedPercent).toBe(10)
    expect(result.usage?.windows.weekly?.usedPercent).toBe(20)
    expect(result.usage?.windows.monthly?.usedPercent).toBe(30)
  })

  test("no usable limits is the no-data contract", async () => {
    const empty = await fetchWith({ data: { limits: [] } })
    expect(empty.ok).toBe(false)
    expect(empty.error).toBe("No quota data in response")
    const unknown = await fetchWith({ data: { limits: [{ type: "daily", percentUsed: 5 }] } })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toBe("No quota data in response")
  })
})
