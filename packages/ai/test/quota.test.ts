import { describe, expect, test } from "bun:test"
import { parseMistralBudget } from "../src/quota/providers/mistral.js"
import { parseSubscriptionQuota } from "../src/quota/providers/meta.js"
import { tursoWindows } from "../src/quota/providers/turso.js"
import { parseGroqResetSeconds, provider as groqProvider } from "../src/quota/providers/groq.js"
import { formatResetAfter, normalizeTimestamp, QUOTA_RESPONSE_MAX_BYTES, readQuotaJson, toNumber, toTimestamp, toUsageWindow } from "../src/quota/utils.js"
import { parseCommandCodeCredits } from "../src/quota/providers/command-code.js"
import { parseConsoleBillingBalance, parseConsoleGoUsage, parseOpenCodeGoUsage, fetchOpenCodeGoUsage } from "../src/quota/providers/opencode-go.js"
import { parseBucket, transformModels, transformSummary } from "../src/quota/providers/antigravity.js"
import { provider as codexProvider } from "../src/quota/providers/codex.js"
import { provider as clinePassProvider } from "../src/quota/providers/cline-pass.js"
import { provider as deepseekProvider } from "../src/quota/providers/deepseek.js"
import { provider as openrouterProvider, resolveResetAt } from "../src/quota/providers/openrouter.js"
import { provider as mistralProvider } from "../src/quota/providers/mistral.js"
import { parseBillingBanner } from "../src/quota/providers/meta.js"
import { provider as metaProvider, teamIdOf } from "../src/quota/providers/meta.js"
import { provider as claudeProvider, toClaudeUsage } from "../src/quota/providers/claude.js"
import { normalizeOpenDesignCredential, parseCodingPlanWindows } from "../src/quota/providers/opendesign.js"
import { fetchAllQuota, listConfiguredQuotaProviders, listConfiguredQuotaProvidersDetailed, quotaProbeFailureResult } from "../src/quota/index.js"
import { readFileSync } from "node:fs"

describe("bounded quota JSON reader", () => {
  test("parses a streamed response body", async () => {
    await expect(readQuotaJson(new Response('{"ok":true}'))).resolves.toEqual({ ok: true })
  })

  test("caps UTF-8 bytes before decoding rather than checking string length afterward", async () => {
    const value = `"${"\u00e9".repeat(Math.floor(QUOTA_RESPONSE_MAX_BYTES / 2) + 1)}"`
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(value))
        },
        cancel() {
          cancelled = true
        },
      }),
    )

    await expect(readQuotaJson(response)).rejects.toThrow(`Quota response exceeded ${QUOTA_RESPONSE_MAX_BYTES} bytes`)
    expect(cancelled).toBe(true)
  })
})

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
    expect(api?.currency).toBe("USD")
    expect(vibe?.currency).toBe("USD")
  })

  test("the payload currency survives parsing; an absent currency defaults to USD", () => {
    const eur = parseMistralBudget({ usage_percentage: 10, initial_budget: 200, currency: "EUR" })
    expect(eur.api?.currency).toBe("EUR")
    const absent = parseMistralBudget({ usage_percentage: 10, initial_budget: 200 })
    expect(absent.api?.currency).toBe("USD")
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

describe("mistral budget label currency (#1805)", () => {
  // Drive the real provider down its console-cookie path against a
  // mocked billing.budget response, so the published window labels
  // are the ones pool rotation actually reads.
  const fetchWith = (budget: Record<string, unknown>) =>
    mistralProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "mistral", active: true, value: { type: "key", key: "sk-fixture" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      env: { MISTRAL_ADMIN_COOKIE: "fixture-cookie" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ result: { data: { json: { api_budget: budget, vibe_budget: budget } } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    } as never)

  test("a non-USD budget denominates both windows in the payload currency", async () => {
    const result = await fetchWith({ usage_percentage: 10, initial_budget: 200, currency: "EUR" })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.api?.valueLabel).toBe("EUR 20.00 / EUR 200.00")
    expect(result.usage?.windows.vibe?.valueLabel).toBe("EUR 20.00 / EUR 200.00")
  })

  test("a USD budget keeps the $ label byte-for-byte (control)", async () => {
    const result = await fetchWith({ usage_percentage: 10, initial_budget: 200, currency: "USD" })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.api?.valueLabel).toBe("$20.00 / $200.00")
    expect(result.usage?.windows.vibe?.valueLabel).toBe("$20.00 / $200.00")
  })

  test("an absent currency defaults to the $ label", async () => {
    const result = await fetchWith({ usage_percentage: 10, initial_budget: 200 })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.api?.valueLabel).toBe("$20.00 / $200.00")
  })
})

describe("meta key-endpoint subs_usage windows (#1907)", () => {
  // Drive the real provider down its key-endpoint cross-check path:
  // the portal read fails closed (unreachable CDP base), so the key
  // endpoint answer is the result. Contract rule 4 (types.ts) /
  // codex #1762 disposition: a window object with no usable
  // used_percent publishes no window.
  const fetchWith = (subsUsage: Record<string, unknown> | undefined, active?: boolean) =>
    metaProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "meta", active: true, value: { type: "key", key: "tok-fixture" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      env: {},
      homeDir: "/nonexistent-home",
      cdpBase: "http://127.0.0.1:9",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ...(active === undefined ? {} : { is_subs_active: active }),
            subs_tier_name: "fixture-tier",
            ...(subsUsage === undefined ? {} : { subs_usage: subsUsage }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    } as never)

  test("an empty rolling window object publishes no phantom window beside a real weekly window", async () => {
    const result = await fetchWith({ window: {}, weekly: { used_percent: 25, resets_at: 1893456000 } }, true)
    expect(result.ok).toBe(true)
    expect(Object.keys(result.usage?.windows ?? {})).toEqual(["weekly"])
    expect(result.usage?.windows.weekly?.usedPercent).toBe(25)
  })

  test("an empty weekly window object publishes no phantom window beside a real rolling window", async () => {
    const result = await fetchWith({ window: { used_percent: 10, resets_at: 1893456000 }, weekly: {} }, true)
    expect(result.ok).toBe(true)
    expect(Object.keys(result.usage?.windows ?? {})).toEqual(["rolling"])
    expect(result.usage?.windows.rolling?.usedPercent).toBe(10)
  })

  test("two figure-less windows with no active subscription reach the no-data disposition, not an all-null success", async () => {
    const result = await fetchWith({ window: {}, weekly: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no quota data")
  })

  test("two figure-less windows on an active subscription keep the post-roll empty state", async () => {
    const result = await fetchWith({ window: {}, weekly: {} }, true)
    expect(result.ok).toBe(true)
    expect(Object.keys(result.usage?.windows ?? {}).toSorted()).toEqual(["rolling", "weekly"])
    expect(result.usage?.windows.rolling?.usedPercent).toBeNull()
    expect(result.usage?.windows.weekly?.usedPercent).toBeNull()
  })

  test("windows carrying figures publish as before (control)", async () => {
    const result = await fetchWith(
      { window: { used_percent: 10, resets_at: 1893456000 }, weekly: { used_percent: 25, resets_at: 1893456000 } },
      true,
    )
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.rolling?.usedPercent).toBe(10)
    expect(result.usage?.windows.weekly?.usedPercent).toBe(25)
  })

  test("a weekly-length rolling window survives beside the weekly window (#1777)", async () => {
    // 10080 minutes = 604800s, a weekly-length rolling window: its
    // derived label would be "weekly" and used to overwrite the fixed
    // weekly entry. It now publishes under its semantic role key.
    const result = await fetchWith(
      {
        window: { used_percent: 10, window_duration_mins: 10080, resets_at: 1893456000 },
        weekly: { used_percent: 90, resets_at: 1893456000 },
      },
      true,
    )
    expect(result.ok).toBe(true)
    expect(Object.keys(result.usage?.windows ?? {}).toSorted()).toEqual(["rolling", "weekly"])
    expect(result.usage?.windows.rolling?.usedPercent).toBe(10)
    expect(result.usage?.windows.rolling?.windowSeconds).toBe(604800)
    expect(result.usage?.windows.weekly?.usedPercent).toBe(90)
  })
})

describe("meta portal team selection (#1931)", () => {
  const ctxWithEnv = (env: Record<string, string>) =>
    ({
      credentials: [],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      env,
    }) as never

  test("a page URL carrying a non-default team_id wins over env and default", () => {
    expect(teamIdOf(ctxWithEnv({ META_TEAM_ID: "env-team" }), "https://dev.meta.ai/portal?team_id=page-team")).toBe(
      "page-team",
    )
  })

  test("env wins when the page URL names no team", () => {
    expect(teamIdOf(ctxWithEnv({ META_TEAM_ID: "env-team" }), "https://dev.meta.ai/portal")).toBe("env-team")
    expect(teamIdOf(ctxWithEnv({ META_TEAM_ID: "env-team" }), "")).toBe("env-team")
  })

  test("the default team stands when neither page nor env names one", () => {
    expect(teamIdOf(ctxWithEnv({}), "https://dev.meta.ai/portal")).toBe("1073226932208501")
    expect(teamIdOf(ctxWithEnv({}), "not a url")).toBe("1073226932208501")
  })
})

describe("meta rolling window key never collides with weekly (#1777)", () => {
  // The #1794 window contract rule 1: identity is semantic — a derived
  // label never erases a window. Filing probe (2026-11-05): a
  // weekly-length rolling window (604800s) with the weekly entry
  // present published only the weekly window at 90%; the rolling
  // window vanished.
  const quota = (patch: Record<string, unknown>) => ({
    subscription_quota: {
      tier: "Muse Code High Usage",
      window_weighted_used: "10",
      window_weighted_limit: "100",
      weekly_weighted_used: "90",
      weekly_weighted_limit: "100",
      window_duration_secs: 604800,
      window_resets_at: 1893456000,
      weekly_resets_at: 1893456000,
      ...patch,
    },
  })

  test("a weekly-length rolling window survives beside the weekly window (filing probe)", () => {
    const parsed = parseSubscriptionQuota(quota({}))
    expect(Object.keys(parsed?.windows ?? {}).toSorted()).toEqual(["rolling", "weekly"])
    expect(parsed?.windows.rolling?.usedPercent).toBe(10)
    expect(parsed?.windows.rolling?.windowSeconds).toBe(604800)
    expect(parsed?.windows.weekly?.usedPercent).toBe(90)
  })

  test("controls: 18000s and 86400s rolling windows keep their derived labels", () => {
    const fiveHour = parseSubscriptionQuota(quota({ window_duration_secs: 18000 }))
    expect(Object.keys(fiveHour?.windows ?? {}).toSorted()).toEqual(["5h", "weekly"])
    expect(fiveHour?.windows["5h"]?.usedPercent).toBe(10)
    const daily = parseSubscriptionQuota(quota({ window_duration_secs: 86400 }))
    expect(Object.keys(daily?.windows ?? {}).toSorted()).toEqual(["1d", "weekly"])
    expect(daily?.windows["1d"]?.usedPercent).toBe(10)
  })

  test("a weekly-length rolling window with no weekly entry still publishes once", () => {
    const parsed = parseSubscriptionQuota(quota({ weekly_weighted_limit: 0 }))
    expect(Object.keys(parsed?.windows ?? {})).toEqual(["rolling"])
    expect(parsed?.windows.rolling?.usedPercent).toBe(10)
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

  test("rejects non-decimal weighted usage and preserves decimal percentages (#2102)", () => {
    const invalid = ["0x64", "0b1100100", "0o144", "1e2"].map((window_weighted_used) =>
      parseSubscriptionQuota({
        subscription_quota: {
          ...payload.subscription_quota,
          window_weighted_used,
          window_weighted_limit: "100",
        },
      }),
    )
    expect(invalid).toEqual([null, null, null, null])

    const decimal = parseSubscriptionQuota({
      subscription_quota: {
        ...payload.subscription_quota,
        window_weighted_used: "42",
        window_weighted_limit: "100",
      },
    })
    expect(decimal?.windows["5h"]?.usedPercent).toBe(42)
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

  test("a non-positive portal reset publishes an honest null resetAt, not a 1969 date (#1855)", () => {
    // The resets used to be multiplied raw (seconds * 1000) with no
    // positivity check, bypassing the shared toTimestamp guard
    // (#1845): "-5000" published resetAt -5000000 with a 1969-12-31
    // formatted date and resetAfterSeconds 0, and "0" published the
    // epoch. A non-positive reset nulls the field (rule 3), exactly
    // like an absent one; the figures of the window still publish.
    const withReset = (patch: Record<string, unknown>) =>
      parseSubscriptionQuota({ subscription_quota: { ...payload.subscription_quota, ...patch } })

    const negativeWindow = withReset({ window_resets_at: -5000 })
    expect(negativeWindow?.windows["5h"]?.usedPercent).toBeCloseTo(1.02, 6)
    expect(negativeWindow?.windows["5h"]?.resetAt).toBeNull()
    expect(negativeWindow?.windows["5h"]?.resetAfterSeconds).toBeNull()
    expect(negativeWindow?.windows.weekly?.resetAt).toBe(1793980800 * 1000)

    const zeroWindow = withReset({ window_resets_at: "0" })
    expect(zeroWindow?.windows["5h"]?.resetAt).toBeNull()

    const negativeWeekly = withReset({ weekly_resets_at: -86400 })
    expect(negativeWeekly?.windows.weekly?.usedPercent).toBeCloseTo(8.83, 6)
    expect(negativeWeekly?.windows.weekly?.resetAt).toBeNull()
    expect(negativeWeekly?.windows["5h"]?.resetAt).toBe(1793552400 * 1000)

    const zeroWeekly = withReset({ weekly_resets_at: 0 })
    expect(zeroWeekly?.windows.weekly?.resetAt).toBeNull()
  })

  test("a zero or negative limit drops only that window; null only when neither survives (#1849)", () => {
    const withQuota = (patch: Record<string, unknown>) =>
      parseSubscriptionQuota({ subscription_quota: { ...payload.subscription_quota, ...patch } })

    const control = withQuota({})
    expect(Object.keys(control?.windows ?? {}).sort()).toEqual(["5h", "weekly"])
    expect(control?.windows["5h"]?.usedPercent).toBeCloseTo(1.02, 6)
    expect(control?.windows.weekly?.usedPercent).toBeCloseTo(8.83, 6)

    const zeroWindow = withQuota({ window_weighted_limit: "0" })
    expect(Object.keys(zeroWindow?.windows ?? {})).toEqual(["weekly"])
    expect(zeroWindow?.windows.weekly?.usedPercent).toBeCloseTo(8.83, 6)
    expect(zeroWindow?.tier).toBe("Muse Code High Usage")

    const zeroWeekly = withQuota({ weekly_weighted_limit: 0 })
    expect(Object.keys(zeroWeekly?.windows ?? {})).toEqual(["5h"])
    expect(zeroWeekly?.windows["5h"]?.usedPercent).toBeCloseTo(1.02, 6)

    const negativeWindow = withQuota({ window_weighted_limit: "-100" })
    expect(Object.keys(negativeWindow?.windows ?? {})).toEqual(["weekly"])

    const negativeWeekly = withQuota({ weekly_weighted_limit: "-100" })
    expect(Object.keys(negativeWeekly?.windows ?? {})).toEqual(["5h"])

    expect(withQuota({ window_weighted_limit: "0", weekly_weighted_limit: "-1" })).toBeNull()
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
        plan: "starter",
        current_billing_period_start: "2026-11-01T00:00:00Z",
        current_billing_period_end: "2026-12-01T00:00:00Z",
      },
    )
    expect(mapped?.planLabel).toBe("starter")
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

  test("dynamic limits: a /plans doc matched by plan name supplies the denominators (code#5468)", () => {
    // The 2026-11-08 live shape: org on Scaler since 2026-11-04, but
    // Starter denominators made rows-read read ~235%. /plans is the
    // source of truth; matching is by plan name, case-insensitively.
    const plans = {
      plans: [
        { name: "starter", quotas: { rowsRead: 500_000_000, rowsWritten: 10_000_000, databases: 100, storage: 5_000_000_000, bytesSynced: 3_000_000_000 } },
        { name: "Scaler", quotas: { rowsRead: 100_000_000_000, rowsWritten: 100_000_000, databases: 1_000_000_000, storage: 24_000_000_000, bytesSynced: 24_000_000_000 } },
      ],
    }
    const usage = {
      organization: {
        usage: {
          rows_read: 1_180_000_000,
          rows_written: 4_000_000,
          storage_bytes: 10_800_000_000,
          bytes_synced: 1_200_000_000,
          databases: 40,
        },
      },
    }
    const sub = { plan: "scaler", current_billing_period_start: "2026-11-01T00:00:00Z", current_billing_period_end: "2026-12-01T00:00:00Z" }
    const mapped = tursoWindows(usage, sub, plans)
    expect(mapped?.planLabel).toBe("scaler")
    expect(mapped?.windows["rows-read"]?.usedPercent).toBe(1.18)
    expect(mapped?.windows["rows-read"]?.valueLabel).toBe("1,180,000,000 / 100,000,000,000")
    expect(mapped?.windows.storage?.usedPercent).toBe(45)
    expect(mapped?.windows.storage?.valueLabel).toBe("10.8 GB / 24 GB")
    expect(mapped?.windows["rows-written"]?.usedPercent).toBe(4)
    expect(mapped?.windows.sync?.usedPercent).toBe(5)
    expect(mapped?.windows.sync?.valueLabel).toBe("1.2 GB / 24 GB")
    expect(mapped?.windows.databases?.valueLabel).toBe("40 / 1000000000")
  })

  test("plans doc absent: the static per-plan fallback applies, so Scaler never regresses to Starter", () => {
    const usage = { organization: { usage: { rows_read: 1_180_000_000, storage_bytes: 10_800_000_000 } } }
    const mapped = tursoWindows(usage, { plan: "scaler" })
    expect(mapped?.windows["rows-read"]?.usedPercent).toBe(1.18)
    expect(mapped?.windows.storage?.usedPercent).toBe(45)
    expect(mapped?.windows.storage?.valueLabel).toBe("10.8 GB / 24 GB")
    // Plans doc present but not matching the plan name: same fallback.
    const unmatched = tursoWindows(usage, { plan: "scaler" }, { plans: [{ name: "starter", quotas: { rowsRead: 500_000_000 } }] })
    expect(unmatched?.windows["rows-read"]?.usedPercent).toBe(1.18)
  })

  test("starter plan and unknown plans keep the old Starter numbers unchanged", () => {
    const usage = { organization: { usage: { rows_read: 250_000_000, storage_bytes: 2_500_000_000, databases: 44 } } }
    const starter = tursoWindows(usage, { plan: "starter" })
    expect(starter?.windows["rows-read"]?.usedPercent).toBe(50)
    expect(starter?.windows["rows-read"]?.valueLabel).toBe("250,000,000 / 500,000,000")
    expect(starter?.windows.storage?.valueLabel).toBe("2.5 GB / 5 GB")
    expect(starter?.windows.databases?.valueLabel).toBe("44 / 100")
    const unknown = tursoWindows(usage, { plan: "enterprise-unknown" })
    expect(unknown?.windows["rows-read"]?.usedPercent).toBe(50)
    expect(unknown?.windows.storage?.valueLabel).toBe("2.5 GB / 5 GB")
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

  test("remaining above the limit is clamped whole-window (#1897)", async () => {
    const requests = await fetchWith({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "150",
    })
    expect(requests.ok).toBe(true)
    expect(requests.usage?.windows.requests_daily?.usedPercent).toBe(0)
    expect(requests.usage?.windows.requests_daily?.remainingPercent).toBe(100)
    expect(requests.usage?.windows.requests_daily?.valueLabel).toBe("100 / 100 requests remaining")
    const tokens = await fetchWith({
      "x-ratelimit-limit-tokens": "10000",
      "x-ratelimit-remaining-tokens": "12000",
    })
    expect(tokens.ok).toBe(true)
    expect(tokens.usage?.windows.tokens_minute?.usedPercent).toBe(0)
    expect(tokens.usage?.windows.tokens_minute?.remainingPercent).toBe(100)
    expect(tokens.usage?.windows.tokens_minute?.valueLabel).toBe("10000 / 10000 tokens remaining")
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

describe("toTimestamp non-positive handling (#1845)", () => {
  test("non-positive numeric spellings convert to null, never 1969/1970 dates", () => {
    expect(toTimestamp(-5000)).toBeNull()
    expect(toTimestamp(-5_000_000_000_000)).toBeNull()
    expect(toTimestamp(0)).toBeNull()
  })

  test("strings parsing to <= 0 ms convert to null, including the epoch spelling", () => {
    expect(toTimestamp("1970-01-01T00:00:00.000Z")).toBeNull()
    expect(toTimestamp("1969-12-31T23:59:59.000Z")).toBeNull()
  })

  test("valid positive timestamps convert exactly as before (controls)", () => {
    expect(toTimestamp(1893456000)).toBe(1893456000000)
    expect(toTimestamp(1893456000000)).toBe(1893456000000)
    expect(toTimestamp("2030-01-01T00:00:00.000Z")).toBe(Date.parse("2030-01-01T00:00:00.000Z"))
    expect(toTimestamp(undefined)).toBeNull()
    expect(toTimestamp("not-a-date")).toBeNull()
  })

  test("opencode-go: a non-positive reset keeps the window with resetAt null (#1725 rule 3)", () => {
    // #1725 adopted contract rule 3: a present window is kept with the
    // missing field null, matching the deepseek/codex siblings, so a
    // bogus non-positive reset publishes the window with resetAt null
    // rather than dropping it (and never a 1969 reset).
    const negative = parseOpenCodeGoUsage({ usage: { rolling: { percent: 50, resetsAt: -5000 } } })
    expect(negative["5h"]?.usedPercent).toBe(50)
    expect(negative["5h"]?.resetAt).toBeNull()
    const epoch = parseOpenCodeGoUsage({ usage: { rolling: { percent: 50, resetsAt: "1970-01-01T00:00:00.000Z" } } })
    expect(epoch["5h"]?.usedPercent).toBe(50)
    expect(epoch["5h"]?.resetAt).toBeNull()
    const control = parseOpenCodeGoUsage({ usage: { rolling: { percent: 50, resetsAt: 1893456000 } } })
    expect(control["5h"]?.resetAt).toBe(1893456000000)
  })

  test("turso: non-positive period bounds derive neither a reset nor a windowSeconds", () => {
    const mapped = tursoWindows(
      { organization: { usage: { rows_read: 250_000_000, rows_written: 1_000_000, storage_bytes: 2_500_000_000, bytes_synced: 0, databases: 44 } } },
      { plan: "scaler", current_period_start: -10000, current_period_end: -5000 },
    )
    const window = Object.values(mapped?.windows ?? {})[0]
    expect(window).toBeDefined()
    expect(window?.resetAt).toBeNull()
    expect(window?.windowSeconds).toBeNull()
  })
})

describe("resetAfterFormatted derives from resetAfterSeconds (#2103)", () => {
  test("formatResetAfter renders compact human durations", () => {
    expect(formatResetAfter(3600)).toBe("1h")
    expect(formatResetAfter(5400)).toBe("1h 30m")
    expect(formatResetAfter(90061)).toBe("1d 1h 1m 1s")
    expect(formatResetAfter(45)).toBe("45s")
    expect(formatResetAfter(0)).toBe("0s")
    expect(formatResetAfter(null)).toBeNull()
    expect(formatResetAfter(undefined)).toBeNull()
  })

  test("a future reset formats the relative wait, not the absolute time", () => {
    const window = toUsageWindow({ usedPercent: 50, resetAt: Date.now() + 3_600_000 })
    expect(window.resetAfterSeconds).toBeGreaterThan(3500)
    expect(window.resetAfterSeconds).toBeLessThanOrEqual(3600)
    expect(window.resetAfterFormatted).toMatch(/^(1h|59m \d+s)$/)
    expect(window.resetAtFormatted).not.toBeNull()
    expect(window.resetAfterFormatted).not.toBe(window.resetAtFormatted)
  })

  test("a past reset pins resetAfterSeconds 0 and resetAfterFormatted 0s", () => {
    const window = toUsageWindow({ usedPercent: 50, resetAt: Date.now() - 60_000 })
    expect(window.resetAfterSeconds).toBe(0)
    expect(window.resetAfterFormatted).toBe("0s")
    expect(window.resetAtFormatted).not.toBeNull()
  })

  test("a null reset keeps every formatted reset field null", () => {
    const window = toUsageWindow({ usedPercent: 50, resetAt: null })
    expect(window.resetAfterSeconds).toBeNull()
    expect(window.resetAtFormatted).toBeNull()
    expect(window.resetAfterFormatted).toBeNull()
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


  test("an empty percent field mints no 0%-used opencode-go window", () => {
    // Rule 4: an entry with no usable percent publishes no window (a
    // percent-bearing entry would keep its window with a null reset —
    // rule 3, the #1725 conformance change pinned below).
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

describe("toNumber plain-decimal strings (#2102)", () => {
  test("accepts signed decimal figures and rejects non-decimal Number spellings", () => {
    expect(toNumber("42")).toBe(42)
    expect(toNumber("4.5")).toBe(4.5)
    expect(toNumber("-5")).toBe(-5)
    expect(toNumber(" 42 ")).toBe(42)

    // A leading plus is intentionally non-canonical and rejected, along
    // with Number's hex, binary, octal, and exponent spellings.
    const invalid = ["+42", "0x64", "0b1100100", "0o144", "1e2", "1e3"]
    invalid.forEach((text) => expect(toNumber(text)).toBeNull())
  })
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

describe("command-code windowLimits clamp-both disposition (#1821)", () => {
  const fiveHour = (limit: Record<string, unknown>) =>
    parseCommandCodeCredits({ windowLimits: { fiveHour: limit } })["5h"]

  test("negative used publishes the window at 0% with the clamped label, no negative figure anywhere", () => {
    const window = fiveHour({ used: -5, cap: 10, resetAt: 1793980800 })
    expect(window?.usedPercent).toBe(0)
    expect(window?.valueLabel).toBe("0 / 10")
    expect(window?.resetAt).toBe(1793980800 * 1000)
  })

  test("over-cap used publishes the window at 100% with the clamped label", () => {
    const window = fiveHour({ used: 15, cap: 10, resetAt: 1793980800 })
    expect(window?.usedPercent).toBe(100)
    expect(window?.valueLabel).toBe("10 / 10")
  })

  test("in-range used publishes percent and label unchanged", () => {
    const window = fiveHour({ used: 5, cap: 10, resetAt: 1793980800000 })
    expect(window?.usedPercent).toBe(50)
    expect(window?.valueLabel).toBe("5 / 10")
    // A millisecond-spelling reset passes through unconverted.
    expect(window?.resetAt).toBe(1793980800000)
  })

  test("non-positive resetAt publishes resetAt null with every derived reset field null", () => {
    for (const resetAt of [0, -5000, -5000000]) {
      const window = fiveHour({ used: 5, cap: 10, resetAt })
      expect(window?.usedPercent).toBe(50)
      expect(window?.resetAt).toBeNull()
      expect(window?.resetAfterSeconds).toBeNull()
      expect(window?.resetAtFormatted).toBeNull()
      expect(window?.resetAfterFormatted).toBeNull()
    }
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

  test("a scoped model named __proto__ survives as an own entry, prototype untouched (#2110)", () => {
    // Payload built via JSON.parse so the name arrives as wire data does.
    const payload = JSON.parse(
      JSON.stringify({
        limits: [
          { kind: "weekly_scoped", percent: 42, resets_at: resets, scope: { model: { display_name: "__proto__" } } },
          { kind: "weekly_scoped", percent: 11, resets_at: resets, scope: { model: { display_name: "constructor" } } },
        ],
      }),
    )
    const { models } = toClaudeUsage(payload)
    expect(Object.keys(models)).toEqual(["__proto__", "constructor"])
    expect(models["__proto__"]?.windows["7d"]?.usedPercent).toBe(42)
    expect(models["constructor"]?.windows["7d"]?.usedPercent).toBe(11)
    expect(Object.getPrototypeOf(models)).toBe(Object.prototype)
    expect((models as Record<string, unknown>)["windows"]).toBeUndefined()
  })

  test("legacy-only and empty payloads keep their shapes", () => {
    const legacy = toClaudeUsage({ five_hour: { utilization: 10, resets_at: resets } })
    expect(legacy.windows["5h"]?.usedPercent).toBe(10)
    expect(legacy.windows["7d"]).toBeUndefined()
    expect(toClaudeUsage({})).toEqual({ windows: {}, models: {} })
    expect(toClaudeUsage(null)).toEqual({ windows: {}, models: {} })
  })

  test("rejects non-decimal session percentages and preserves decimal controls (#2102)", () => {
    const windows = ["0x50", "1e2"].map(
      (percent) => toClaudeUsage({ limits: [{ kind: "session", percent, resets_at: resets }] }).windows,
    )
    expect(windows.map((item) => item["5h"])).toEqual([undefined, undefined])

    const decimal = toClaudeUsage({ limits: [{ kind: "session", percent: "4.5", resets_at: resets }] })
    expect(decimal.windows["5h"]?.usedPercent).toBe(4.5)
  })
})

describe("turso disabled listing (#1923)", () => {
  const ctxWith = (disabledProviders: Set<string>) => ({
    credentials: [],
    disabledProviders,
    instances: new Map(),
    providerConfig: {},
  })

  test("the built-in turso fetcher honours disabled_providers like every other provider", async () => {
    await expect(listConfiguredQuotaProviders(ctxWith(new Set()))).resolves.toContain("turso")
    await expect(listConfiguredQuotaProviders(ctxWith(new Set(["turso"])))).resolves.not.toContain("turso")
  })

  test("includeDisabled brings the disabled turso row back", async () => {
    await expect(
      listConfiguredQuotaProviders(ctxWith(new Set(["turso"])), { includeDisabled: true }),
    ).resolves.toContain("turso")
  })
})

describe("claude spend exponent range (#1920)", () => {
  const spendWith = (exponent: unknown) =>
    toClaudeUsage({
      spend: {
        enabled: true,
        percent: 50,
        used: { amount_minor: 500, exponent, currency: "USD" },
        limit: { amount_minor: 1000, exponent },
      },
    })

  test("an over-range exponent reads the money object as absent; the percent still publishes", () => {
    const { windows } = spendWith(999)
    expect(windows["extra_usage"]?.usedPercent).toBe(50)
    expect(windows["extra_usage"]?.valueLabel).toBeUndefined()
  })

  test("a negative exponent reads the money object as absent", () => {
    const { windows } = spendWith(-2)
    expect(windows["extra_usage"]?.usedPercent).toBe(50)
    expect(windows["extra_usage"]?.valueLabel).toBeUndefined()
  })

  test("in-range exponents and the absent-exponent default are unchanged (controls)", () => {
    expect(spendWith(2).windows["extra_usage"]?.valueLabel).toBe("$5.00 / $10.00")
    expect(spendWith(0).windows["extra_usage"]?.valueLabel).toBe("$500.00 / $1000.00")
    expect(spendWith(3).windows["extra_usage"]?.valueLabel).toBe("$0.50 / $1.00")
    const absent = toClaudeUsage({
      spend: {
        enabled: true,
        percent: 50,
        used: { amount_minor: 500, currency: "USD" },
        limit: { amount_minor: 1000 },
      },
    })
    expect(absent.windows["extra_usage"]?.valueLabel).toBe("$5.00 / $10.00")
  })
})

describe("claude spend negative amounts (#1919)", () => {
  test("a negative used amount reads as absent; the percent still publishes", () => {
    const { windows } = toClaudeUsage({
      spend: {
        enabled: true,
        percent: 50,
        used: { amount_minor: -500, exponent: 2, currency: "USD" },
        limit: { amount_minor: 1000, exponent: 2, currency: "USD" },
      },
    })
    expect(windows["extra_usage"]?.usedPercent).toBe(50)
    expect(windows["extra_usage"]?.valueLabel).toBeUndefined()
  })

  test("a negative limit reads as absent; the used amount still labels", () => {
    const { windows } = toClaudeUsage({
      spend: {
        enabled: true,
        percent: 50,
        used: { amount_minor: 500, exponent: 2, currency: "USD" },
        limit: { amount_minor: -1000, exponent: 2, currency: "USD" },
      },
    })
    expect(windows["extra_usage"]?.valueLabel).toBe("$5.00")
  })

  test("a negative-only spend payload publishes no extra_usage window", () => {
    const { windows } = toClaudeUsage({
      spend: { enabled: true, used: { amount_minor: -500, exponent: 2, currency: "USD" } },
    })
    expect(windows["extra_usage"]).toBeUndefined()
  })

  test("positive, zero, and percent-only controls are unchanged", () => {
    const positive = toClaudeUsage({
      spend: {
        enabled: true,
        used: { amount_minor: 500, exponent: 2, currency: "USD" },
        limit: { amount_minor: 1000, exponent: 2, currency: "USD" },
      },
    })
    expect(positive.windows["extra_usage"]?.valueLabel).toBe("$5.00 / $10.00")
    const zero = toClaudeUsage({
      spend: {
        enabled: true,
        used: { amount_minor: 0, exponent: 2, currency: "USD" },
        limit: { amount_minor: 1000, exponent: 2, currency: "USD" },
      },
    })
    expect(zero.windows["extra_usage"]?.valueLabel).toBe("$0.00 / $10.00")
    const percentOnly = toClaudeUsage({ spend: { enabled: true, percent: 50 } })
    expect(percentOnly.windows["extra_usage"]?.usedPercent).toBe(50)
  })

  test("a negative-only spend payload reaches the no-data contract through fetchQuota", async () => {
    const result = await claudeProvider.fetchQuota({
      credentials: [],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            spend: { enabled: true, used: { amount_minor: -500, exponent: 2, currency: "USD" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" },
      homeDir: "/nonexistent-quota-test-home",
    } as never)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No quota data in response")
  })
})

describe("claude quota no-data contract (#1915)", () => {
  // Drive the real provider against a stubbed usage response, with the
  // env credential as the only source (homeDir names no credentials file).
  const fetchWith = (payload: unknown) =>
    claudeProvider.fetchQuota({
      credentials: [],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" },
      homeDir: "/nonexistent-quota-test-home",
    } as never)

  test("a 200 payload with no usable quota data is the no-data contract, not ok:true with empty windows", async () => {
    for (const payload of [{}, { limits: [] }, { limits: [{ kind: "session", resets_at: "2026-12-01T00:00:00Z" }] }]) {
      const result = await fetchWith(payload)
      expect(result.ok).toBe(false)
      expect(result.configured).toBe(true)
      expect(result.error).toBe("No quota data in response")
      expect(result.usage).toBeNull()
    }
  })

  test("a real figure still publishes its window (control)", async () => {
    const result = await fetchWith({ five_hour: { utilization: 10, resets_at: "2026-12-01T00:00:00Z" } })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows["5h"]?.usedPercent).toBe(10)
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

  test("non-positive durations publish as unknown duration, never negative labels (#1848)", async () => {
    const negative = await fetchWith({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: -3600, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: reset },
      },
    })
    expect(negative.ok).toBe(true)
    expect(negative.usage?.windows["-1h"]).toBeUndefined()
    expect(negative.usage?.windows.tokens?.usedPercent).toBe(10)
    expect(negative.usage?.windows.tokens?.windowSeconds).toBeNull()
    expect(negative.usage?.windows.tokens?.resetAt).toBe(reset * 1000)
    expect(negative.usage?.windows.weekly?.usedPercent).toBe(80)

    const zero = await fetchWith({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 0, reset_at: reset } },
    })
    expect(zero.usage?.windows.tokens?.windowSeconds).toBeNull()

    const bothNegative = await fetchWith({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: -3600, reset_at: reset },
        secondary_window: { used_percent: 80, limit_window_seconds: -3600, reset_at: reset },
      },
    })
    expect(bothNegative.usage?.windows["tokens-primary"]?.usedPercent).toBe(10)
    expect(bothNegative.usage?.windows["tokens-secondary"]?.usedPercent).toBe(80)
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

  test("a negative credits balance is read as absent, never published (#1924)", async () => {
    // Negative-only: no credits_balance window, and the payload reaches
    // the #1762 no-data contract instead of ok:true with a "-5" label.
    const negativeOnly = await fetchWith({ rate_limit: {}, credits: { balance: -5, unlimited: false } })
    expect(negativeOnly.ok).toBe(false)
    expect(negativeOnly.error).toBe("No quota data in response")
    expect(negativeOnly.usage).toBeNull()

    // Negative beside a real window: the window publishes, the negative
    // balance does not.
    const beside = await fetchWith({
      rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: reset } },
      credits: { balance: -5, unlimited: false },
    })
    expect(beside.ok).toBe(true)
    expect(beside.usage?.windows["5h"]?.usedPercent).toBe(25)
    expect(beside.usage?.windows.credits_balance).toBeUndefined()

    // Controls: zero and positive balances publish unchanged, and the
    // unlimited label path is untouched by the sign guard.
    const zero = await fetchWith({ rate_limit: {}, credits: { balance: 0, unlimited: false } })
    expect(zero.ok).toBe(true)
    expect(zero.usage?.windows.credits_balance?.valueLabel).toBe("0")
    const positive = await fetchWith({ rate_limit: {}, credits: { balance: 42, unlimited: false } })
    expect(positive.usage?.windows.credits_balance?.valueLabel).toBe("42")
    const unlimited = await fetchWith({ rate_limit: {}, credits: { balance: -5, unlimited: true } })
    expect(unlimited.usage?.windows.credits_balance?.valueLabel).toBe("Unlimited")
  })

  test("spend-control window: percent and label derive from one clamped used figure (#1882)", async () => {
    const control = await fetchWith({
      rate_limit: {},
      spend_control: { individual_limit: { used: 40, limit: 100, used_percent: 40 } },
    })
    expect(control.ok).toBe(true)
    expect(control.usage?.windows.credits?.usedPercent).toBe(40)
    expect(control.usage?.windows.credits?.valueLabel).toBe("40 / 100 used")

    const negative = await fetchWith({
      rate_limit: {},
      spend_control: { individual_limit: { used: -5, limit: 100, used_percent: -5 } },
    })
    expect(negative.usage?.windows.credits?.usedPercent).toBe(0)
    expect(negative.usage?.windows.credits?.valueLabel).toBe("0 / 100 used")

    // Over-limit disposition (#1882, #1821 rule 5): clamped label at
    // 100% — never "150 / 100 used" beside a clamped percent.
    const overLimit = await fetchWith({
      rate_limit: {},
      spend_control: { individual_limit: { used: 150, limit: 100, used_percent: 150 } },
    })
    expect(overLimit.usage?.windows.credits?.usedPercent).toBe(100)
    expect(overLimit.usage?.windows.credits?.valueLabel).toBe("100 / 100 used")

    // Label-only payload (no used_percent): the percent is derived
    // from the same clamped figures, so the label is never the only
    // — and never a contradictory — figure published.
    const labelOnly = await fetchWith({
      rate_limit: {},
      spend_control: { individual_limit: { used: 150, limit: 100 } },
    })
    expect(labelOnly.usage?.windows.credits?.usedPercent).toBe(100)
    expect(labelOnly.usage?.windows.credits?.valueLabel).toBe("100 / 100 used")
  })

  test("spend-control window: a non-positive limit never renders as a denominator (#1882)", async () => {
    const zeroLimit = await fetchWith({
      rate_limit: {},
      spend_control: { individual_limit: { used: 5, limit: 0, used_percent: 25 } },
    })
    expect(zeroLimit.ok).toBe(true)
    expect(zeroLimit.usage?.windows.credits?.usedPercent).toBe(25)
    expect(zeroLimit.usage?.windows.credits?.valueLabel).toBeUndefined()

    const zeroLimitNoPercent = await fetchWith({
      rate_limit: {},
      spend_control: { individual_limit: { used: 5, limit: 0 } },
    })
    expect(zeroLimitNoPercent.ok).toBe(false)
    expect(zeroLimitNoPercent.error).toBe("No quota data in response")
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

describe("deepseek quota mapping (#1800)", () => {
  const fetchWith = (payload: unknown) =>
    deepseekProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "deepseek", active: true, value: { type: "key", key: "fixture-key" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: {},
    })

  test("uses a positive balance in another currency when USD and CNY are absent", async () => {
    const result = await fetchWith({ balance_infos: [{ currency: "EUR", total_balance: "100" }] })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("EUR 100.00")
  })

  test("a positive third-currency balance wins over zero USD", async () => {
    const result = await fetchWith({
      balance_infos: [
        { currency: "USD", total_balance: 0 },
        { currency: "GBP", total_balance: "80" },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("GBP 80.00")
  })

  test("a positive third-currency balance wins over negative USD", async () => {
    const result = await fetchWith({
      balance_infos: [
        { currency: "USD", total_balance: -5 },
        { currency: "GBP", total_balance: "80" },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("GBP 80.00")
  })

  test("positive USD stays ahead of positive CNY", async () => {
    const result = await fetchWith({
      balance_infos: [
        { currency: "CNY", total_balance: "50" },
        { currency: "USD", total_balance: "25" },
      ],
    })
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("$25.00")

    const cnyOnly = await fetchWith({ balance_infos: [{ currency: "CNY", total_balance: "50" }] })
    expect(cnyOnly.usage?.windows.credits_balance?.valueLabel).toBe("¥50.00")
  })

  test("keeps the non-positive USD fallback when no positive balance exists", async () => {
    const result = await fetchWith({ balance_infos: [{ currency: "USD", total_balance: 0 }] })
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("$0.00")
  })

  test("keeps the zero fallback for a third currency when no USD or CNY row exists (#2129)", async () => {
    const result = await fetchWith({ balance_infos: [{ currency: "EUR", total_balance: 0 }] })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("EUR 0.00")

    const stringZero = await fetchWith({ balance_infos: [{ currency: "GBP", total_balance: "0" }] })
    expect(stringZero.ok).toBe(true)
    expect(stringZero.usage?.windows.credits_balance?.valueLabel).toBe("GBP 0.00")
  })

  test("a zero third-currency balance wins over a negative USD balance (#2129)", async () => {
    const result = await fetchWith({
      balance_infos: [
        { currency: "USD", total_balance: -5 },
        { currency: "EUR", total_balance: 0 },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.credits_balance?.valueLabel).toBe("EUR 0.00")
  })

  test("zero USD and zero CNY stay ahead of a zero third-currency balance (#2129)", async () => {
    const usd = await fetchWith({
      balance_infos: [
        { currency: "EUR", total_balance: 0 },
        { currency: "USD", total_balance: 0 },
      ],
    })
    expect(usd.usage?.windows.credits_balance?.valueLabel).toBe("$0.00")

    const cny = await fetchWith({
      balance_infos: [
        { currency: "EUR", total_balance: 0 },
        { currency: "CNY", total_balance: 0 },
      ],
    })
    expect(cny.usage?.windows.credits_balance?.valueLabel).toBe("¥0.00")
  })

  test("does not publish a negative-only USD balance", async () => {
    const result = await fetchWith({ balance_infos: [{ currency: "USD", total_balance: "-5" }] })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No quota data in response")
    expect(result.usage).toBeNull()
  })

  test("does not publish a negative-only CNY balance", async () => {
    const result = await fetchWith({ balance_infos: [{ currency: "CNY", total_balance: -7 }] })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No quota data in response")
    expect(result.usage).toBeNull()
  })

  test("missing or empty balance_infos returns the no-data error", async () => {
    for (const payload of [{}, { balance_infos: [] }]) {
      const result = await fetchWith(payload)
      expect(result.ok).toBe(false)
      expect(result.error).toBe("No quota data in response")
      expect(result.usage).toBeNull()
    }
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

  test("a negative spend on the unlimited path is read as absent — the no-data contract (#1913)", async () => {
    const result = await fetchWith({ data: { limit: null, limit_remaining: null, usage_monthly: -5 } })
    expect(result.ok).toBe(false)
    expect(result.configured).toBe(true)
    expect(result.error).toBe("No quota data in response")
    expect(result.usage).toBeNull()
  })

  test("a zero spend on the unlimited path still publishes (control, #1913)", async () => {
    const result = await fetchWith({ data: { limit: null, limit_remaining: null, usage_monthly: 0 } })
    expect(result.ok).toBe(true)
    expect(result.usage?.windows.monthly?.valueLabel).toBe("$0.00 spent")
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
  // provider's current behaviour. Each test names its rule. The matrix
  // asserts specific conforming paths, not whole providers: opendesign's
  // keep-first/zero-limit/unknown-duration cases, cline-pass, codex
  // rate-limit windows, command-code, and meta's conforming cases.
  // The paths this matrix once marked known-lossy — codex
  // credits_balance (#1924) and deepseek balance (#1928) — have
  // landed and are pinned by their dedicated describes and by the
  // figure-contract matrix below.
  // opencode-go and openrouter reset math left the known-lossy set when
  // #1725 landed: opencode-go conforms to rules 3/4 and resolveResetAt
  // is pinned by its dedicated describe. meta left it when #1777 landed:
  // a weekly-length rolling window no longer overwrites the weekly entry.
  // Antigravity's #1768, #1912, and #1917 cases are fixed and pinned by
  // dedicated describes; mistral #1785 is likewise pinned by its
  // dedicated describe. If a
  // conforming parser's disposition changes
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
      antigravity: "_antigravity",
      claude: "_claude",
      clinePass: "cline-pass",
      codex: "codex",
      commandCode: "_commandcode",
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
      "_antigravity",
      "_claude",
      "cline-pass",
      "codex",
      "_commandcode",
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
    // its resolveResetAt arithmetic is pinned by the OpenRouter
    // calendar reset calculation describe (#1725).
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

  test("rule 5 (fields agree, out-of-range): opendesign clamps remaining once for percent and label (#1879)", () => {
    const over = parseCodingPlanWindows({
      windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: 150 }],
    })
    expect(over?.["5h"]?.usedPercent).toBe(0)
    expect(over?.["5h"]?.valueLabel).toBe("100 / 100 credits")
    const under = parseCodingPlanWindows({
      windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: -50 }],
    })
    expect(under?.["5h"]?.usedPercent).toBe(100)
    expect(under?.["5h"]?.valueLabel).toBe("0 / 100 credits")
    const inRange = parseCodingPlanWindows({
      windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: 25 }],
    })
    expect(inRange?.["5h"]?.usedPercent).toBe(75)
    expect(inRange?.["5h"]?.valueLabel).toBe("25 / 100 credits")
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

describe("quota figure contract — shared figure probe matrix (#1943, design #1942 phase 1)", () => {
  // ORACLE: the figure contract stated in src/quota/types.ts ("A
  // figure that cannot exist is not a figure", rules 1-6). The
  // fixtures are payload shapes; the model is the contract itself,
  // not any one provider's current behaviour. Each test names its
  // rule. The matrix asserts the already-conforming figure paths:
  // meta parseBillingBanner, opencode-go toMicroCents (through its
  // exported console paths) and its balance path, command-code's
  // clamp-both windows, turso's numNonNegative path, and the paths
  // the design's phases 2-3 landed against this contract — claude
  // spend (negative #1919, exponent #1920), codex credits (#1924),
  // deepseek balance (#1928), groq's pair clamp (#1897), opendesign's
  // pair clamp (#1879) and antigravity's float precision (#1941).
  // If a conforming parser's figure disposition changes without the
  // contract changing, a case here must fail.

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

  const deepseekFetchWith = (payload: unknown) =>
    deepseekProvider.fetchQuota({
      credentials: [
        { id: "row-1", integrationID: "deepseek", active: true, value: { type: "key", key: "fixture-key" } },
      ],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
      env: {},
    })

  test("rule 1 (negative figure reads as absent): meta, opencode-go, turso, codex and deepseek negative figures publish nothing", async () => {
    expect(parseBillingBanner({ remaining_minor_units: -5, currency: "USD" })).toBeNull()
    expect(parseConsoleBillingBalance({ availableMicroCents: -1 })).toBeNull()
    expect(parseConsoleGoUsage({ access: { meters: { fiveHour: { limitMicroCents: 100, usedMicroCents: -1, resetsAt: "2027-01-01T00:00:00Z" } } } })).toEqual({})
    expect(tursoWindows({ usage: { databases: -1 } }, {})?.windows.databases).toBeUndefined()
    const codex = await codexFetchWith({ credits: { balance: -5, unlimited: false } })
    expect(codex.usage?.windows.credits_balance).toBeUndefined()
    const deepseek = await deepseekFetchWith({ balance_infos: [{ currency: "USD", total_balance: -5 }] })
    expect(deepseek.ok).toBe(false)
    expect(deepseek.usage).toBeNull()
  })

  test("rule 1 (zero is a real figure): zero publishes unchanged on the same paths", async () => {
    expect(parseBillingBanner({ remaining_minor_units: 0, currency: "USD" })).toBe(0)
    expect(parseConsoleBillingBalance({ availableMicroCents: 0 })).toBe(0)
    expect(tursoWindows({ usage: { databases: 0 } }, {})?.windows.databases?.usedPercent).toBe(0)
    expect(tursoWindows({ usage: { databases: 0 } }, {})?.windows.databases?.valueLabel).toBe("0 / 100")
    const codex = await codexFetchWith({ credits: { balance: 0, unlimited: false } })
    expect(codex.usage?.windows.credits_balance?.valueLabel).toBe("0")
    const deepseek = await deepseekFetchWith({ balance_infos: [{ currency: "USD", total_balance: 0 }] })
    expect(deepseek.ok).toBe(true)
    expect(deepseek.usage?.windows.credits_balance?.valueLabel).toBe("$0.00")
  })

  test("rule 2 (a pair is judged as a pair): command-code, opendesign and codex spend clamp percent and label from one figure", async () => {
    const ccOver = parseCommandCodeCredits({ windowLimits: { fiveHour: { used: 15, cap: 10 } } })
    expect(ccOver["5h"]?.usedPercent).toBe(100)
    expect(ccOver["5h"]?.valueLabel).toBe("10 / 10")
    const ccUnder = parseCommandCodeCredits({ windowLimits: { fiveHour: { used: -5, cap: 10 } } })
    expect(ccUnder["5h"]?.usedPercent).toBe(0)
    expect(ccUnder["5h"]?.valueLabel).toBe("0 / 10")
    const odOver = parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: 150 }] })
    expect(odOver?.["5h"]?.usedPercent).toBe(0)
    expect(odOver?.["5h"]?.valueLabel).toBe("100 / 100 credits")
    const odUnder = parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: -50 }] })
    expect(odUnder?.["5h"]?.usedPercent).toBe(100)
    expect(odUnder?.["5h"]?.valueLabel).toBe("0 / 100 credits")
    const codex = await codexFetchWith({ spend_control: { individual_limit: { used: 15, limit: 10 } } })
    expect(codex.usage?.windows.credits?.usedPercent).toBe(100)
    expect(codex.usage?.windows.credits?.valueLabel).toBe("10 / 10 used")
  })

  test("rule 2 (named exception): turso over-limit counts publish truthfully, percent and label together", () => {
    const mapped = tursoWindows({ usage: { databases: 150 } }, {})
    expect(mapped?.windows.databases?.usedPercent).toBe(150)
    expect(mapped?.windows.databases?.valueLabel).toBe("150 / 100")
  })

  test("rule 3 (scaling inputs are figures too): an out-of-range claude exponent reads the amount as absent, the percent still publishes", () => {
    for (const exponent of [999, -2, 2.5]) {
      const { windows } = toClaudeUsage({
        spend: {
          enabled: true,
          percent: 50,
          used: { amount_minor: 500, exponent, currency: "USD" },
          limit: { amount_minor: 1000, exponent },
        },
      })
      expect(windows["extra_usage"]?.usedPercent).toBe(50)
      expect(windows["extra_usage"]?.valueLabel).toBeUndefined()
    }
    // In-range control: the same payload at exponent 2 labels unchanged.
    const control = toClaudeUsage({
      spend: {
        enabled: true,
        percent: 50,
        used: { amount_minor: 500, exponent: 2, currency: "USD" },
        limit: { amount_minor: 1000, exponent: 2 },
      },
    })
    expect(control.windows["extra_usage"]?.valueLabel).toBe("$5.00 / $10.00")
  })

  test("rule 4 (precision is part of the figure): antigravity and turso publish sub-percent precision, unrounded", () => {
    const bucket = parseBucket({ window: "5h", remainingFraction: 0.999, resetTime: "2026-12-01T00:00:00Z" } as never)
    expect(bucket?.window.usedPercent).toBeCloseTo(0.1, 10)
    expect(bucket?.window.remainingPercent).toBeCloseTo(99.9, 10)
    // turso's stated precision is 3 decimal places (pct3): a
    // sub-percent count publishes at that precision, not rounded
    // to an integer or to zero.
    const mapped = tursoWindows({ usage: { storage_bytes: 1234567 } }, {})
    expect(mapped?.windows.storage?.usedPercent).toBe(0.025)
  })

  test("rule 5 (only figure impossible is no result): a negative-only figure empties the result into the no-data contract", async () => {
    const deepseek = await deepseekFetchWith({ balance_infos: [{ currency: "CNY", total_balance: -7 }] })
    expect(deepseek.ok).toBe(false)
    expect(deepseek.error).toBe("No quota data in response")
    const codex = await codexFetchWith({ credits: { balance: -5, unlimited: false } })
    expect(codex.ok).toBe(false)
    expect(codex.usage).toBeNull()
    expect(parseCommandCodeCredits({ credits: { monthlyCredits: -5 } })).toEqual({})
  })

  test("rule 6 (every figure path pinned): the conforming money paths scale minor units exactly", () => {
    expect(parseBillingBanner({ remaining_minor_units: 12345, currency: "USD" })).toBe(123.45)
    expect(parseConsoleBillingBalance({ availableMicroCents: 100_000_000 })).toBe(1)
    expect(parseConsoleBillingBalance({ availableMicroCents: 250_000_000 })).toBe(2.5)
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

describe("antigravity quota bucket labelling (#1768)", () => {
  // Payloads mirror the triage probe for #1768 (task 10760).
  const summaryWith = (buckets: unknown[]) => ({ groups: [{ displayName: "Gemini", buckets }] })

  test("per-label happy path: FIVE_HOUR and WEEKLY publish under their own labels", () => {
    const groups = transformSummary(
      summaryWith([
        { window: "FIVE_HOUR", remainingFraction: 0.5, resetTime: "2026-11-06T00:00:00Z" },
        { window: "WEEKLY", remainingFraction: 0.25, resetTime: "2026-11-12T00:00:00Z" },
      ]) as never,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].windows["5h"]?.usedPercent).toBe(50)
    expect(groups[0].windows.weekly?.usedPercent).toBe(75)
    expect(groups[0].bucket5h?.remainingFraction).toBe(0.5)
    expect(groups[0].bucketWeekly?.remainingFraction).toBe(0.25)
  })

  test("DAILY window spelling and daily bucketId publish the daily window (#2111)", () => {
    const groups = transformSummary(
      summaryWith([{ window: "DAILY", remainingFraction: 0.4, resetTime: "2026-11-07T00:00:00Z" }]) as never,
    )
    expect(groups[0].windows.daily?.usedPercent).toBe(60)
    const byBucketId = parseBucket({ bucketId: "daily", remainingFraction: 0.4 } as never)
    expect(byBucketId?.label).toBe("daily")
    expect(byBucketId?.seconds).toBe(86400)
  })

  test("an unrecognized window string is skipped, never published as a fabricated 5h window", () => {
    const groups = transformSummary(
      summaryWith([
        { window: "FIVE_HOUR", remainingFraction: 0.5, resetTime: "2026-11-06T00:00:00Z" },
        { window: "MONTHLY", remainingFraction: 0.9, resetTime: "2026-12-01T00:00:00Z" },
      ]) as never,
    )
    expect(Object.keys(groups[0].windows)).toEqual(["5h"])
    expect(groups[0].windows["5h"]?.usedPercent).toBe(50)
    expect(groups[0].bucket5h?.remainingFraction).toBe(0.5)
    expect(parseBucket({ window: "MONTHLY", remainingFraction: 0.9 } as never)).toBeNull()
  })

  test("same-label collisions keep the first entry for windows, bucket5h, and bucketWeekly", () => {
    const groups = transformSummary(
      summaryWith([
        { window: "WEEKLY", remainingFraction: 0.25, resetTime: "2026-11-12T00:00:00Z" },
        { window: "7D", remainingFraction: 0.75, resetTime: "2026-11-13T00:00:00Z" },
      ]) as never,
    )
    expect(groups[0].windows.weekly?.usedPercent).toBe(75)
    expect(groups[0].bucketWeekly?.remainingFraction).toBe(0.25)
  })

  test("a missing remainingFraction publishes no bucket, not an all-null-percent window (#1917)", () => {
    expect(parseBucket({ window: "WEEKLY", resetTime: "2026-11-12T00:00:00Z" } as never)).toBeNull()
  })

  test("a figure-less weekly bucket never reaches a matched model (#1917)", () => {
    const groups = transformSummary(
      summaryWith([
        { window: "FIVE_HOUR", remainingFraction: 0.5, resetTime: "2026-11-06T00:00:00Z" },
        { window: "WEEKLY", resetTime: "2026-11-12T00:00:00Z" },
      ]) as never,
    )
    const models = transformModels({ models: { "gemini-fixture": {} } } as never, groups)
    // The figure-less weekly bucket is dropped at parse time, so it can
    // neither publish a window nor constrain the ordering.
    expect(Object.keys(models["gemini-fixture"].windows)).toEqual(["5h"])
  })

  test("a known near-exhausted weekly fraction still puts weekly first (control)", () => {
    const groups = transformSummary(
      summaryWith([
        { window: "FIVE_HOUR", remainingFraction: 0.5, resetTime: "2026-11-06T00:00:00Z" },
        { window: "WEEKLY", remainingFraction: 0.0005, resetTime: "2026-11-12T00:00:00Z" },
      ]) as never,
    )
    const models = transformModels({ models: { "gemini-fixture": {} } } as never, groups)
    expect(Object.keys(models["gemini-fixture"].windows)).toEqual(["weekly", "5h"])
  })
})

describe("antigravity quota summary figure check (#1917)", () => {
  // No figure, no window (window contract rule 4): a recognized bucket
  // with no usable remainingFraction publishes no window on the summary
  // path. Disposition: parseBucket returns null, matching its
  // unrecognized-kind case (codex #1762 / meta #1907 precedent).
  const summaryWith = (buckets: unknown[]) => ({ groups: [{ displayName: "Gemini", buckets }] })

  test("a reset-only bucket parses to null", () => {
    expect(parseBucket({ window: "5h", resetTime: "2026-12-01T00:00:00Z" } as never)).toBeNull()
  })

  test("a summary group built only from figure-less buckets carries no windows", () => {
    const groups = transformSummary(
      summaryWith([{ window: "5h", resetTime: "2026-12-01T00:00:00Z" }]) as never,
    )
    expect(groups[0].windows).toEqual({})
    expect(groups[0].bucket5h).toBeNull()
  })

  test("a matched model inherits no window from a figure-less group", () => {
    const groups = transformSummary(
      summaryWith([{ window: "5h", resetTime: "2026-12-01T00:00:00Z" }]) as never,
    )
    const models = transformModels({ models: { "gemini-x": {} } } as never, groups)
    expect(models["gemini-x"]?.windows ?? {}).toEqual({})
  })

  test("a present remainingFraction still publishes its window (control)", () => {
    const parsed = parseBucket(
      { window: "5h", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" } as never,
    )
    expect(parsed?.window.usedPercent).toBe(50)
    expect(parsed?.window.remainingPercent).toBe(50)
  })
})

describe("antigravity quota transformModels fallback figure check (#1912)", () => {
  // No figure, no window (window contract rule 4): the per-model
  // fallback branch must not publish a window when quotaInfo carries
  // no usable remainingFraction. Disposition: the model entry is
  // omitted (codex #1762 / meta #1907 drop-the-window precedent).
  test("a model with no quotaInfo publishes no entry", () => {
    expect(transformModels({ models: { "gemini-x": {} } } as never, [])).toEqual({})
  })

  test("a model with an empty quotaInfo publishes no entry", () => {
    expect(transformModels({ models: { "gemini-x": { quotaInfo: {} } } } as never, [])).toEqual({})
  })

  test("a reset-only quotaInfo publishes no entry — no label is derived from a reset alone", () => {
    expect(
      transformModels(
        { models: { "gemini-x": { quotaInfo: { resetTime: "2027-01-01T00:00:00Z" } } } } as never,
        [],
      ),
    ).toEqual({})
  })

  test("a present remainingFraction still publishes its window (control)", () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const models = transformModels(
      { models: { "gemini-x": { quotaInfo: { remainingFraction: 0.5, resetTime } } } } as never,
      [],
    )
    expect(models["gemini-x"]?.windows["5h"]?.usedPercent).toBe(50)
    expect(models["gemini-x"]?.windows["5h"]?.remainingPercent).toBe(50)
  })

  test("figure-less models are omitted while figured models remain", () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const models = transformModels(
      {
        models: {
          "gemini-x": {},
          "gemini-y": { quotaInfo: { remainingFraction: 0.25, resetTime } },
        },
      } as never,
      [],
    )
    expect(Object.keys(models)).toEqual(["gemini-y"])
    expect(models["gemini-y"]?.windows["5h"]?.usedPercent).toBe(75)
  })
})

describe("antigravity quota __proto__ model names (#2110)", () => {
  const summaryWith = (buckets: unknown[]) => ({ groups: [{ displayName: "Gemini", buckets }] })

  test("transformModels fallback branch keeps a model named __proto__ as an own entry", () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const payload = JSON.parse(
      '{"models":{"__proto__":{"quotaInfo":{"remainingFraction":0.5,"resetTime":"' +
        resetTime +
        '"}},"gemini-3":{"quotaInfo":{"remainingFraction":0.25,"resetTime":"' +
        resetTime +
        '"}}}}',
    )
    const models = transformModels(payload as never, [])
    expect(Object.keys(models)).toEqual(["__proto__", "gemini-3"])
    expect(models["__proto__"]?.windows["5h"]?.usedPercent).toBe(50)
    expect(models["gemini-3"]?.windows["5h"]?.usedPercent).toBe(75)
    expect(Object.getPrototypeOf(models)).toBe(Object.prototype)
    expect((models as Record<string, unknown>)["windows"]).toBeUndefined()
  })

  test("transformModels matched-group branch keeps a model named __proto__ as an own entry", () => {
    const groups = transformSummary(
      summaryWith([{ window: "FIVE_HOUR", remainingFraction: 0.5, resetTime: "2026-11-06T00:00:00Z" }]) as never,
    )
    const payload = JSON.parse('{"models":{"__proto__":{},"gemini-3":{}}}')
    const models = transformModels(payload as never, groups)
    expect(Object.keys(models)).toEqual(["__proto__", "gemini-3"])
    expect(models["__proto__"]?.windows["5h"]?.usedPercent).toBe(50)
    expect(Object.getPrototypeOf(models)).toBe(Object.prototype)
    expect((models as Record<string, unknown>)["windows"]).toBeUndefined()
  })
})

describe("antigravity quota float percents (#1941)", () => {
  // Both conversion sites publish the float percent derived from
  // remainingFraction: integer quantization read 99.9% used as
  // 100% / 0% remaining and 0.1% used as 0% / 100% remaining.
  test("parseBucket publishes sub-percent precision", () => {
    const cases: Array<[number, number]> = [
      [0.999, 0.1],
      [0.001, 99.9],
      [0.504, 49.6],
    ]
    for (const [fraction, used] of cases) {
      const parsed = parseBucket(
        { window: "5h", remainingFraction: fraction, resetTime: "2026-12-01T00:00:00Z" } as never,
      )
      expect(parsed?.window.usedPercent).toBeCloseTo(used, 10)
      expect(parsed?.window.remainingPercent).toBeCloseTo(100 - used, 10)
      // The raw fraction retention (weekly-constrained ordering) is unchanged.
      expect(parsed?.remainingFraction).toBe(fraction)
    }
    // Round-fraction control stays exact.
    const control = parseBucket(
      { window: "5h", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" } as never,
    )
    expect(control?.window.usedPercent).toBe(50)
    expect(control?.window.remainingPercent).toBe(50)
  })

  test("transformModels fallback publishes sub-percent precision", () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const cases: Array<[number, number]> = [
      [0.999, 0.1],
      [0.001, 99.9],
      [0.504, 49.6],
    ]
    for (const [fraction, used] of cases) {
      const models = transformModels(
        { models: { "gemini-x": { quotaInfo: { remainingFraction: fraction, resetTime } } } } as never,
        [],
      )
      expect(models["gemini-x"]?.windows["5h"]?.usedPercent).toBeCloseTo(used, 10)
      expect(models["gemini-x"]?.windows["5h"]?.remainingPercent).toBeCloseTo(100 - used, 10)
    }
  })
})

describe("normalizeTimestamp non-positive handling (#1857)", () => {
  test("non-positive spellings convert to null, never 1969/1970 credential expiries", () => {
    expect(normalizeTimestamp(-5000)).toBeNull()
    expect(normalizeTimestamp(-1893456000000)).toBeNull()
    expect(normalizeTimestamp(0)).toBeNull()
  })

  test("valid positive timestamps convert exactly as before (controls)", () => {
    expect(normalizeTimestamp(1893456000)).toBe(1893456000000)
    expect(normalizeTimestamp(1893456000000)).toBe(1893456000000)
    expect(normalizeTimestamp(undefined)).toBeNull()
  })
})

describe("readQuotaJson byte cap (#1877)", () => {
  // The cap is denominated in bytes (QUOTA_RESPONSE_MAX_BYTES, the error
  // message), so enforcement must measure UTF-8 bytes — text.length
  // counts UTF-16 code units and under-counts multi-byte bodies ~3x.
  test("rejects an ASCII body just over the byte cap", async () => {
    const body = JSON.stringify("a".repeat(QUOTA_RESPONSE_MAX_BYTES))
    await expect(readQuotaJson(new Response(body))).rejects.toThrow("Quota response exceeded")
  })

  test("rejects a multi-byte body whose character count is under the cap but whose byte count is over it", async () => {
    // 400,002 characters, 1,200,002 UTF-8 bytes: under the cap in code
    // units, over it in bytes.
    const body = JSON.stringify("\u20AC".repeat(400_000))
    expect(body.length).toBeLessThan(QUOTA_RESPONSE_MAX_BYTES)
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(QUOTA_RESPONSE_MAX_BYTES)
    await expect(readQuotaJson(new Response(body))).rejects.toThrow("Quota response exceeded")
  })

  test("accepts a multi-byte body under the cap in bytes", async () => {
    const body = JSON.stringify({ note: "\u20AC".repeat(1_000) })
    const parsed = await readQuotaJson(new Response(body))
    expect(parsed).toEqual({ note: "\u20AC".repeat(1_000) })
  })
})

describe("toUsageWindow remainingPercent derivation (#1904)", () => {
  test("a negative usedPercent derives at most 100% remaining, never above it", () => {
    expect(toUsageWindow({ usedPercent: -20 }).remainingPercent).toBe(100)
    expect(toUsageWindow({ usedPercent: -5 }).remainingPercent).toBe(100)
  })

  test("usedPercent itself is published unchanged (provider disposition preserved)", () => {
    expect(toUsageWindow({ usedPercent: -20 }).usedPercent).toBe(-20)
    // Turso publish-truthfully over-100 case (code#6227): the used
    // figure stands and the derived remaining floors at 0, as before.
    expect(toUsageWindow({ usedPercent: 150 }).usedPercent).toBe(150)
    expect(toUsageWindow({ usedPercent: 150 }).remainingPercent).toBe(0)
  })

  test("in-range derivations are exactly as before (controls)", () => {
    expect(toUsageWindow({ usedPercent: 0 }).remainingPercent).toBe(100)
    expect(toUsageWindow({ usedPercent: 50 }).remainingPercent).toBe(50)
    expect(toUsageWindow({ usedPercent: 100 }).remainingPercent).toBe(0)
    expect(toUsageWindow({ usedPercent: null }).remainingPercent).toBeNull()
  })
})

describe("listing probe failure is a result, never absence (#1729)", () => {
  // A credential row whose value cannot even be decoded: every
  // projectAuth-based isConfigured probe throws when it touches it.
  // Oracle: the listing contract from task 10000 - a probe failure
  // produces an error row; the provider never silently vanishes, and
  // the listing resolution then agrees with a named ask.
  const throwingCtx = () => {
    const row: Record<string, unknown> = { id: "throwing-1", integrationID: "deepseek", active: true }
    Object.defineProperty(row, "value", {
      enumerable: true,
      get() {
        throw new Error("credential store decode boom")
      },
    })
    return {
      credentials: [row],
      disabledProviders: new Set<string>(),
      instances: new Map(),
      providerConfig: {},
    } as never
  }

  test("configuredProviderProbeFailureProducesErrorRow", async () => {
    const listing = await listConfiguredQuotaProvidersDetailed(throwingCtx())
    const failure = listing.probeFailures.find((entry) => entry.providerId === "deepseek")
    expect(failure).toBeDefined()
    expect(failure?.error).toContain("credential store decode boom")
    expect(listing.providerIds).not.toContain("deepseek")
    const row = quotaProbeFailureResult(failure!)
    expect(row.ok).toBe(false)
    expect(row.configured).toBe(true)
    expect(row.providerId).toBe("deepseek")
    expect(row.error).toContain("probe failed")
    expect(row.error).toContain("credential store decode boom")
  })

  test("fullListingEmitsEveryConfiguredProviderAndCredential", async () => {
    const groups = await fetchAllQuota(throwingCtx())
    const deepseek = groups.find((group) => group.providerId === "deepseek")
    expect(deepseek).toBeDefined()
    expect(deepseek?.results).toHaveLength(1)
    expect(deepseek?.results[0]?.ok).toBe(false)
    expect(deepseek?.results[0]?.error).toContain("probe failed")
    // No provider group is duplicated: exactly one deepseek group.
    expect(groups.filter((group) => group.providerId === "deepseek")).toHaveLength(1)
  })

  test("named-vs-listing parity: a provider resolvable by name appears in the listing as an error row", async () => {
    const { resolveQuotaProviderName } = await import("../src/quota/index.js")
    const ctx = throwingCtx()
    // The named ask resolves deepseek (catalogue resolution never probes).
    expect(resolveQuotaProviderName(ctx, "deepseek")).toBe("deepseek")
    const groups = await fetchAllQuota(ctx)
    expect(groups.some((group) => group.providerId === "deepseek")).toBe(true)
  })
})

describe("claude duplicate limits keep-first (#1781)", () => {
  // Oracle: window contract rule 2 (duplicates keep the first), the
  // #1750/#1769 convention. Payload shapes mirror the issue's probe:
  // repeated limits entries carrying real figures.
  const resetA = 1798761600 // 2026-12-01T00:00:00Z in epoch seconds
  const resetB = 1798848000 // 2026-12-02T00:00:00Z

  test("duplicate session entries publish the first", () => {
    const usage = toClaudeUsage({
      limits: [
        { kind: "session", percent: 20, resets_at: resetA },
        { kind: "session", percent: 80, resets_at: resetB },
      ],
    })
    expect(usage.windows["5h"]?.usedPercent).toBe(20)
    expect(usage.windows["5h"]?.resetAt).toBe(resetA * 1000)
  })

  test("duplicate weekly_all entries publish the first", () => {
    const usage = toClaudeUsage({
      limits: [
        { kind: "weekly_all", percent: 30, resets_at: resetA },
        { kind: "weekly_all", percent: 70, resets_at: resetB },
      ],
    })
    expect(usage.windows["7d"]?.usedPercent).toBe(30)
    expect(usage.windows["7d"]?.resetAt).toBe(resetA * 1000)
  })

  test("duplicate weekly_scoped entries for one model publish the first", () => {
    const usage = toClaudeUsage({
      limits: [
        { kind: "weekly_scoped", percent: 30, resets_at: resetA, scope: { model: { display_name: "Claude Sonnet" } } },
        { kind: "weekly_scoped", percent: 60, resets_at: resetB, scope: { model: { display_name: "Claude Sonnet" } } },
      ],
    })
    expect(usage.models["Claude Sonnet"]?.windows["7d"]?.usedPercent).toBe(30)
    expect(usage.models["Claude Sonnet"]?.windows["7d"]?.resetAt).toBe(resetA * 1000)
  })

  test("two different models' scoped entries both survive", () => {
    const usage = toClaudeUsage({
      limits: [
        { kind: "weekly_scoped", percent: 30, resets_at: resetA, scope: { model: { display_name: "Claude Sonnet" } } },
        { kind: "weekly_scoped", percent: 60, resets_at: resetB, scope: { model: { display_name: "Claude Opus" } } },
      ],
    })
    expect(usage.models["Claude Sonnet"]?.windows["7d"]?.usedPercent).toBe(30)
    expect(usage.models["Claude Opus"]?.windows["7d"]?.usedPercent).toBe(60)
  })

  test("null-percent duplicate control: the first entry survives, and a figure-less first entry does not claim the window", () => {
    const usage = toClaudeUsage({
      limits: [
        { kind: "session", percent: 20, resets_at: resetA },
        { kind: "session", percent: null, resets_at: resetB },
      ],
    })
    expect(usage.windows["5h"]?.usedPercent).toBe(20)
    const claimed = toClaudeUsage({
      limits: [
        { kind: "session", percent: null, resets_at: resetA },
        { kind: "session", percent: 80, resets_at: resetB },
      ],
    })
    expect(claimed.windows["5h"]?.usedPercent).toBe(80)
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

  test("keeps a percent-bearing window with resetAt null, and drops a percent-less entry", () => {
    const mapped = parseOpenCodeGoUsage({
      usage: {
        rolling: { percent: 20 },
        weekly: { resetsAt: "2026-11-09T00:00:00Z" },
      },
    })

    // Rule 3 (#1725): a percent-bearing window keeps its window and
    // nulls the absent reset instead of dropping it.
    expect(mapped["5h"]?.usedPercent).toBe(20)
    expect(mapped["5h"]?.resetAt).toBeNull()
    // Rule 4: an entry with no usable percent publishes no window.
    expect(mapped.weekly).toBeUndefined()
    expect(parseOpenCodeGoUsage({})).toEqual({})
  })

  test("an all-dropped usage payload throws the unparseable-usage error", async () => {
    const payload = { usage: { rolling: {}, weekly: {} } }
    const ctx = {
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    }
    await expect(fetchOpenCodeGoUsage(ctx as never, "sk-fixture")).rejects.toThrow(
      "OpenCode Go usage data could not be parsed",
    )
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
