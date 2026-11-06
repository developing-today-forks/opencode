import { describe, expect, test } from "bun:test"
import { parseMistralBudget } from "../src/quota/providers/mistral.js"
import { parseSubscriptionQuota } from "../src/quota/providers/meta.js"
import { tursoWindows } from "../src/quota/providers/turso.js"
import { parseGroqResetSeconds, provider as groqProvider } from "../src/quota/providers/groq.js"
import { toNumber } from "../src/quota/utils.js"
import { parseCommandCodeCredits } from "../src/quota/providers/command-code.js"
import { parseOpenCodeGoUsage } from "../src/quota/providers/opencode-go.js"
import { provider as codexProvider } from "../src/quota/providers/codex.js"
import { provider as clinePassProvider } from "../src/quota/providers/cline-pass.js"
import { provider as openrouterProvider } from "../src/quota/providers/openrouter.js"
import { provider as deepseekProvider } from "../src/quota/providers/deepseek.js"
import { provider as mistralProvider } from "../src/quota/providers/mistral.js"
import { parseBillingBanner } from "../src/quota/providers/meta.js"
import { toClaudeUsage } from "../src/quota/providers/claude.js"
import { normalizeOpenDesignCredential, parseCodingPlanWindows } from "../src/quota/providers/opendesign.js"
import { readFileSync } from "node:fs"

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

  test("clamps over-100 usage consistently for percent and amount", () => {
    const { api } = parseMistralBudget({ usage_percentage: 150, initial_budget: 100 })
    expect(api?.usedPercent).toBe(100)
    expect(api?.usedAmount).toBe(100)
  })

  test("clamps negative usage consistently for percent and amount", () => {
    const { api } = parseMistralBudget({ usage_percentage: -20, initial_budget: 50 })
    expect(api?.usedPercent).toBe(0)
    expect(api?.usedAmount).toBe(0)
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

  test("rejects partially-consumed or malformed durations (#1793)", () => {
    expect(parseGroqResetSeconds("1h30")).toBeNull()
    expect(parseGroqResetSeconds("2m59.56")).toBeNull()
    expect(parseGroqResetSeconds("59s trailing")).toBeNull()
    expect(parseGroqResetSeconds("-30s")).toBeNull()
    expect(parseGroqResetSeconds("1m1m")).toBeNull()
  })
})

describe("groq quota header parsing (#1793)", () => {
  const fetchWith = (headers: Record<string, string>) =>
    groqProvider.fetchQuota({
      credentials: [{ id: "row-1", integrationID: "groq", active: true, value: { type: "key", key: "gsk-fixture" } }],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () => new Response("{}", { status: 200, headers }),
      env: {},
    })

  test("negative remaining mints no window", async () => {
    const result = await fetchWith({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "-5" })
    expect(result.ok).toBe(false)
    expect(result.usage?.windows.requests_daily).toBeUndefined()
  })

  test("hex limit and exponent remaining mint no window", async () => {
    const hex = await fetchWith({ "x-ratelimit-limit-requests": "0x64", "x-ratelimit-remaining-requests": "50" })
    expect(hex.ok).toBe(false)
    expect(hex.usage?.windows.requests_daily).toBeUndefined()
    const exp = await fetchWith({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "1e1" })
    expect(exp.ok).toBe(false)
    expect(exp.usage?.windows.requests_daily).toBeUndefined()
  })

  test("a malformed reset header yields a window with resetAt null", async () => {
    const result = await fetchWith({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "40",
      "x-ratelimit-reset-requests": "1h30",
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.requests_daily?.usedPercent).toBe(60)
    expect(result.usage?.windows.requests_daily?.resetAt).toBeNull()
  })

  test("plain counts and a well-formed reset still publish a window", async () => {
    const result = await fetchWith({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "40",
      "x-ratelimit-reset-requests": "2m59.56s",
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.requests_daily?.usedPercent).toBe(60)
    expect(result.usage?.windows.requests_daily?.resetAt).not.toBeNull()
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

describe("command-code credit balances are not quota windows (#1746)", () => {
  test("purchased-only and free-only payloads yield no windows", () => {
    expect(parseCommandCodeCredits({ credits: { purchasedCredits: 40 } })).toEqual({})
    expect(parseCommandCodeCredits({ credits: { freeCredits: 15 } })).toEqual({})
  })

  test("balances alongside a monthly window publish only the monthly window", () => {
    const windows = parseCommandCodeCredits({ credits: { monthlyCredits: 5, purchasedCredits: 40, freeCredits: 15 } })
    expect(Object.keys(windows)).toEqual(["monthly"])
    expect(windows.monthly?.usedPercent).toBe(50)
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

describe("codex isConfigured active credentials (#1811)", () => {
  const oauth = { type: "oauth", access: "tok-fixture", refresh: "fixture", expires: 4_102_444_800_000 } as const
  const ctxWith = (credentials: unknown[], instances = new Map()) => ({
    credentials,
    disabledProviders: new Set<string>(),
    instances,
    providerConfig: {},
    env: {},
  })

  test("an inactive direct credential does not count as configured", async () => {
    const ctx = ctxWith([{ id: "row-1", integrationID: "openai", active: false, value: oauth }])
    expect(await codexProvider.isConfigured(ctx as never)).toBe(false)
    const result = await codexProvider.fetchQuota({ ...ctx, fetchImpl: async () => new Response("{}") } as never)
    expect(result.configured).toBe(false)
  })

  test("an inactive instance credential does not count as configured", async () => {
    const ctx = ctxWith(
      [{ id: "row-2", integrationID: "openai.main", active: false, value: oauth }],
      new Map([["openai.main", { base: "openai" }]]),
    )
    expect(await codexProvider.isConfigured(ctx as never)).toBe(false)
    const result = await codexProvider.fetchQuota({ ...ctx, fetchImpl: async () => new Response("{}") } as never)
    expect(result.configured).toBe(false)
  })

  test("active direct and active instance credentials still count as configured", async () => {
    const direct = ctxWith([{ id: "row-3", integrationID: "openai", active: true, value: oauth }])
    expect(await codexProvider.isConfigured(direct as never)).toBe(true)
    const instance = ctxWith(
      [{ id: "row-4", integrationID: "openai.main", active: true, value: oauth }],
      new Map([["openai.main", { base: "openai" }]]),
    )
    expect(await codexProvider.isConfigured(instance as never)).toBe(true)
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

describe("openrouter quota mapping (#1799)", () => {
  // Drive the real provider against a mocked /key response.
  const fetchWith = (payload: unknown) =>
    openrouterProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "openrouter", active: true, value: { type: "key", key: "fixture-key" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: {},
    })

  test("a zero limit publishes no window \u2014 the no-data contract", async () => {
    const result = await fetchWith({
      data: { limit: 0, limit_remaining: 0, usage_monthly: 0, limit_reset: "monthly" },
    })
    expect(result.ok).toBe(false)
    expect(result.configured).toBe(true)
    expect(result.error).toBe("No quota data in response")
    expect(result.usage).toBeNull()
  })

  test("a zero limit with spend still publishes no window", async () => {
    const result = await fetchWith({
      data: { limit: 0, limit_remaining: -5, usage_monthly: 5, limit_reset: "monthly" },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No quota data in response")
    expect(result.usage).toBeNull()
  })

  test("the unlimited path still publishes its monthly spent window", async () => {
    const result = await fetchWith({ data: { limit: null, limit_remaining: null, usage_monthly: 12.5 } })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.monthly?.usedPercent).toBeNull()
    expect(result.usage?.windows.monthly?.valueLabel).toBe("$12.50 spent")
  })

  test("normal and over-limit controls keep their probed shapes", async () => {
    const over = await fetchWith({
      data: { limit: 100, limit_remaining: -20, usage_monthly: 120, limit_reset: "monthly" },
    })
    expect(over.ok).toBe(true)
    expect(over.usage?.windows.monthly?.usedPercent).toBe(100)
    expect(over.usage?.windows.monthly?.valueLabel).toBe("$120.00 / $100.00")

    const under = await fetchWith({
      data: { limit: 100, limit_remaining: 150, usage_monthly: 0, limit_reset: "monthly" },
    })
    expect(under.usage?.windows.monthly?.usedPercent).toBe(0)
    expect(under.usage?.windows.monthly?.valueLabel).toBe("$0.00 / $100.00")
  })
})

describe("quota window contract — shared probe matrix (#1795, design #1794 phase 1)", () => {
  // ORACLE: the window contract stated in src/quota/types.ts ("Parse
  // the window you were sent, or none", rules 1-7). The fixtures are
  // payload shapes; the model is the contract itself, not any one
  // provider's current behaviour. Each test names its rule. Only the
  // already-conforming parsers are asserted here — opendesign
  // parseCodingPlanWindows, cline-pass (via provider.fetchQuota),
  // codex (via provider.fetchQuota), command-code
  // parseCommandCodeCredits, and meta parseBillingBanner /
  // parseSubscriptionQuota's conforming cases. Known-lossy parsers
  // are NOT asserted as conforming: antigravity (#1768), meta's
  // collision sites (#1777), claude duplicates (#1781), mistral field
  // consistency (#1785), and opencode-go + openrouter (#1725) live in
  // the types.ts inventory as known-lossy until their own issues land
  // and flip their rows. If a conforming parser's disposition changes
  // without the contract changing, a case here must fail.

  const reset = 1893456000

  const codexFetchWith = (payload: unknown) =>
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

  const clineFetchWith = (payload: unknown) =>
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

  const openrouterFetchWith = (payload: unknown) =>
    openrouterProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "openrouter", active: true, value: { type: "key", key: "fixture-key" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: {},
    })

  test("rule 7: the registry still holds exactly the 13 inventoried providers, in inventory order", () => {
    // Read the registry source instead of importing index.js: the
    // index pulls every provider's runtime dependencies, which this
    // parser suite deliberately does not need. The variable-to-id
    // mapping is each provider module's exported providerId.
    const indexSource = readFileSync(new URL("../src/quota/index.ts", import.meta.url), "utf8")
    const registryBody = indexSource.match(/export const quotaProviders[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? ""
    const variableToId: Record<string, string> = {
      antigravity: "antigravity",
      claude: "claude",
      clinePass: "cline-pass",
      codex: "codex",
      commandCode: "command-code",
      deepseek: "deepseek",
      groq: "groq",
      meta: "meta",
      mistral: "mistral",
      opencodeGo: "opencode-go",
      opendesign: "opendesign",
      openrouter: "openrouter",
      turso: "turso",
    }
    const ids = registryBody
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((variable) => variableToId[variable])
    expect(ids).toEqual([
      "antigravity",
      "claude",
      "cline-pass",
      "codex",
      "command-code",
      "deepseek",
      "groq",
      "meta",
      "mistral",
      "opencode-go",
      "opendesign",
      "openrouter",
      "turso",
    ])
  })

  test("rule 1 (collision): codex equal durations qualify both keys instead of overwriting", async () => {
    const result = await codexFetchWith({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: 18000, reset_at: reset },
      },
    })
    expect(result.usage?.windows["5h"]).toBeUndefined()
    expect(result.usage?.windows["5h-primary"]?.usedPercent).toBe(10)
    expect(result.usage?.windows["5h-secondary"]?.usedPercent).toBe(80)
  })

  test("rule 2 (duplicates keep-first): opendesign duplicate durations publish the first entry", () => {
    const windows = parseCodingPlanWindows({
      windows: [
        { durationSeconds: 18000, limitCredits: 100, remainingCredits: 25 },
        { durationSeconds: 18000, limitCredits: 100, remainingCredits: 0 },
      ],
    })
    expect(windows?.["5h"]?.usedPercent).toBe(75)
  })

  test("rule 2 (duplicates keep-first): cline-pass duplicate weekly entries publish the first entry", async () => {
    const result = await clineFetchWith({
      data: {
        limits: [
          { type: "weekly", percentUsed: 42 },
          { type: "weekly", percentUsed: 7 },
        ],
      },
    })
    expect(result.usage?.windows.weekly?.usedPercent).toBe(42)
  })

  test("rule 3 (missing is null): meta subscription quota keeps the window and nulls an absent reset", () => {
    const parsed = parseSubscriptionQuota({
      subscription_quota: {
        tier: "Muse Code High Usage",
        window_weighted_used: "0",
        window_weighted_limit: "100000000000",
        window_duration_secs: 18000,
        weekly_weighted_used: "8830000000",
        weekly_weighted_limit: "100000000000",
        weekly_resets_at: 1793980800,
      },
    })
    expect(parsed?.windows["5h"]?.usedPercent).toBe(0)
    expect(parsed?.windows["5h"]?.resetAt).toBeNull()
    expect(parsed?.windows.weekly?.resetAt).toBe(1793980800 * 1000)
  })

  test("rule 3 (missing is null): command-code window without a reset publishes resetAt null, not no window", () => {
    const windows = parseCommandCodeCredits({ windowLimits: { fiveHour: { used: 5, cap: 10 } } })
    expect(windows["5h"]?.usedPercent).toBe(50)
    expect(windows["5h"]?.resetAt).toBeNull()
  })

  test("rule 3 (missing figure is null): meta billing banner with no figure maps to null, never 0", () => {
    expect(parseBillingBanner({ currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: "", currency: "USD" })).toBeNull()
  })

  test("rule 3/4 (missing figure): cline-pass entry with no percent publishes no window for that kind", async () => {
    const result = await clineFetchWith({
      data: {
        limits: [{ type: "five_hour" }, { type: "weekly", percentUsed: 20 }],
      },
    })
    expect(result.usage?.windows["5h"]).toBeUndefined()
    expect(result.usage?.windows.weekly?.usedPercent).toBe(20)
  })

  test("rule 4 (no figure, no window): codex empty window object mints no phantom window", async () => {
    const result = await codexFetchWith({
      rate_limit: {
        primary_window: {},
        secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: reset },
      },
    })
    expect(Object.keys(result.usage?.windows ?? {})).toEqual(["weekly"])
  })

  test("rule 4 (no figure, no window): opendesign zero-limit entry and command-code balance-only payload publish nothing", () => {
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 0, remainingCredits: 0 }] })).toBeNull()
    expect(parseCommandCodeCredits({ credits: { purchasedCredits: 40, freeCredits: 15 } })).toEqual({})
  })

  test("rule 4 (no figure, no window): openrouter zero-limit payload is the no-data contract (#1799)", async () => {
    // Only the zero-limit rule-4 case is asserted for openrouter here;
    // its #1725 resolveResetAt row stays known-lossy in the inventory.
    const result = await openrouterFetchWith({
      data: { limit: 0, limit_remaining: 0, usage_monthly: 0, limit_reset: "monthly" },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No quota data in response")
    expect(result.usage).toBeNull()
  })

  test("rule 4 (no figure, no window): codex window with duration/reset but no used_percent is dropped", async () => {
    const result = await codexFetchWith({
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: reset },
      },
    })
    expect(result.usage?.windows["5h"]).toBeUndefined()
    expect(result.usage?.windows.weekly?.usedPercent).toBe(80)
  })

  test("rule 5 (fields agree, out-of-range): command-code over-included credits publish truthfully at 0% used", () => {
    const windows = parseCommandCodeCredits({ credits: { monthlyCredits: 25 } })
    expect(windows.monthly?.usedPercent).toBe(0)
    expect(windows.monthly?.valueLabel).toContain("25")
  })

  test("rule 5 (fields agree, out-of-range): opendesign over-remaining clamps the percent and keeps the real figures in the label", () => {
    const windows = parseCodingPlanWindows({
      windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: 150 }],
    })
    expect(windows?.["5h"]?.usedPercent).toBe(0)
    expect(windows?.["5h"]?.valueLabel).toBe("150 / 100 credits")
  })

  test("rule 5 (fields agree, out-of-range): meta over-limit weekly clamps to 100 and the window does not vanish", () => {
    const parsed = parseSubscriptionQuota({
      subscription_quota: {
        window_weighted_used: "1000000000",
        window_weighted_limit: "100000000000",
        window_duration_secs: 18000,
        weekly_weighted_used: "300549363810",
        weekly_weighted_limit: "300000000000",
        weekly_resets_at: 1793980800,
      },
    })
    expect(parsed?.windows.weekly?.usedPercent).toBe(100)
  })

  test("rule 5 (out-of-range): cline-pass percent above 100 clamps and the window does not vanish", async () => {
    const result = await clineFetchWith({ data: { limits: [{ type: "five_hour", percentUsed: 150 }] } })
    expect(result.usage?.windows["5h"]?.usedPercent).toBe(100)
  })

  test("rule 5 (out-of-range): codex percent above 100 clamps and the window does not vanish", async () => {
    const result = await codexFetchWith({
      rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 18000, reset_at: reset } },
    })
    expect(result.usage?.windows["5h"]?.usedPercent).toBe(100)
  })

  test("rule 6 (unknown kinds skipped, not renamed): opendesign unknown duration publishes no familiar label", () => {
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 3600, limitCredits: 10, remainingCredits: 5 }] })).toBeNull()
  })

  test("rule 6 (unknown kinds skipped, not renamed): cline-pass unknown limit type publishes no window", async () => {
    const result = await clineFetchWith({ data: { limits: [{ type: "daily", percentUsed: 5 }] } })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No quota data in response")
  })
})

describe("blank credentials are not configured (#1831)", () => {
  const keyCtx = (integrationID: string, key: string, calls: string[]) => ({
    credentials: [{ id: "row-1", integrationID, active: true, value: { type: "key", key } }],
    disabledProviders: new Set<string>(),
    instances: new Map(),
    providerConfig: {},
    env: {},
    fetchImpl: async (_url: unknown, init: { headers?: Record<string, string> }) => {
      calls.push(init?.headers?.Authorization ?? "")
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
    },
  })

  const keyProviders = [
    ["deepseek", deepseekProvider, "deepseek"],
    ["groq", groqProvider, "groq"],
    ["openrouter", openrouterProvider, "openrouter"],
  ] as const

  for (const [name, provider, integrationID] of keyProviders) {
    test(`${name}: a whitespace-only key is not configured and is never sent`, async () => {
      const calls: string[] = []
      const ctx = keyCtx(integrationID, "   ", calls)
      expect(await provider.isConfigured(ctx as never)).toBe(false)
      const result = await provider.fetchQuota(ctx as never)
      expect(result.configured).toBe(false)
      expect(result.error).toBe("Not configured")
      expect(calls).toEqual([])
    })

    test(`${name}: a real key still counts as configured (control)`, async () => {
      const calls: string[] = []
      const ctx = keyCtx(integrationID, "sk-fixture", calls)
      expect(await provider.isConfigured(ctx as never)).toBe(true)
      await provider.fetchQuota(ctx as never)
      expect(calls).toEqual(["Bearer " + "sk-fixture"])
    })
  }

  test("deepseek: a padded real key is sent trimmed, not verbatim", async () => {
    const calls: string[] = []
    const ctx = keyCtx("deepseek", "  sk-fixture  ", calls)
    expect(await deepseekProvider.isConfigured(ctx as never)).toBe(true)
    await deepseekProvider.fetchQuota(ctx as never)
    expect(calls).toEqual(["Bearer " + "sk-fixture"])
  })

  test("mistral: a whitespace-only key is not configured", async () => {
    const blank = keyCtx("mistral", "   ", [])
    expect(await mistralProvider.isConfigured(blank as never)).toBe(false)
    const real = keyCtx("mistral", "sk-fixture", [])
    expect(await mistralProvider.isConfigured(real as never)).toBe(true)
  })

  test("codex: a whitespace-only access token is not configured and is never sent", async () => {
    const calls: string[] = []
    const ctx = {
      credentials: [
        {
          id: "row-1",
          integrationID: "openai",
          active: true,
          value: { type: "oauth", access: "   ", refresh: "fixture", expires: 4_102_444_800_000 },
        },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      env: {},
      fetchImpl: async (_url: unknown, init: { headers?: Record<string, string> }) => {
        calls.push(init?.headers?.Authorization ?? "")
        return new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
      },
    }
    expect(await codexProvider.isConfigured(ctx as never)).toBe(false)
    const result = await codexProvider.fetchQuota(ctx as never)
    expect(result.configured).toBe(false)
    expect(result.error).toBe("Not configured")
    expect(calls).toEqual([])
  })
})
