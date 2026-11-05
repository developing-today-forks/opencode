import { describe, expect, test } from "bun:test"
import { toClaudeUsage } from "../src/quota/providers/claude.js"
import { parseBillingBanner } from "../src/quota/providers/meta.js"
import { normalizeOpenDesignCredential, parseCodingPlanWindows } from "../src/quota/providers/opendesign.js"

describe("Claude quota payload mapping", () => {
  test("maps current limits and scoped model windows, including numeric strings", () => {
    const parsed = toClaudeUsage({
      limits: [
        { kind: "session", percent: "25", resets_at: "2026-12-01T00:00:00Z" },
        { kind: "weekly_all", percent: 42, resets_at: "2026-12-08T00:00:00Z" },
        {
          kind: "weekly_scoped",
          percent: "15",
          resets_at: "2026-12-08T00:00:00Z",
          scope: { model: { display_name: "Claude Sonnet" } },
        },
      ],
    })

    expect(parsed.windows["5h"]?.usedPercent).toBe(25)
    expect(parsed.windows["5h"]?.windowSeconds).toBe(5 * 60 * 60)
    expect(parsed.windows["7d"]?.usedPercent).toBe(42)
    expect(parsed.models["Claude Sonnet"]?.windows["7d"]?.usedPercent).toBe(15)
  })

  test("fills windows missing from scoped limits from legacy payload fields", () => {
    const parsed = toClaudeUsage({
      limits: [
        {
          kind: "weekly_scoped",
          percent: "15",
          scope: { model: { display_name: "Claude Sonnet" } },
        },
      ],
      five_hour: { utilization: "24", resets_at: "2026-12-01T00:00:00Z" },
      seven_day: { utilization: 38, resets_at: "2026-12-08T00:00:00Z" },
    })

    expect(parsed.windows["5h"]?.usedPercent).toBe(24)
    expect(parsed.windows["7d"]?.usedPercent).toBe(38)
    expect(parsed.models["Claude Sonnet"]?.windows["7d"]?.usedPercent).toBe(15)
  })

  test("preserves explicit limits and uses legacy data only for missing windows", () => {
    const parsed = toClaudeUsage({
      limits: [{ kind: "session", percent: 20 }],
      five_hour: { utilization: 90 },
      seven_day: { utilization: "35" },
    })

    expect(parsed.windows["5h"]?.usedPercent).toBe(20)
    expect(parsed.windows["7d"]?.usedPercent).toBe(35)
  })

  test("missing and malformed quota fields produce empty maps", () => {
    expect(toClaudeUsage(null)).toEqual({ windows: {}, models: {} })
    expect(
      toClaudeUsage({
        limits: [null, {}, { kind: "session", percent: " ", resets_at: "not-a-date" }],
        five_hour: { utilization: "" },
      }),
    ).toEqual({ windows: {}, models: {} })
  })
})

describe("Meta billing banner mapping", () => {
  test("converts numeric and numeric-string USD minor units", () => {
    expect(parseBillingBanner({ remaining_minor_units: 12345, currency: "USD" })).toBe(123.45)
    expect(parseBillingBanner({ remaining_minor_units: "12345", currency: "USD" })).toBe(123.45)
  })

  test("rejects missing, malformed, negative, or non-USD values", () => {
    expect(parseBillingBanner(null)).toBeNull()
    expect(parseBillingBanner({ currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: "abc", currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: -1, currency: "USD" })).toBeNull()
    expect(parseBillingBanner({ remaining_minor_units: "12345", currency: "EUR" })).toBeNull()
  })
})

describe("Open Design quota payload mapping", () => {
  test("normalizes bare session tokens and preserves full cookie strings", () => {
    expect(normalizeOpenDesignCredential({ cookie: " session-token ", workspaceId: " workspace-1 " })).toEqual({
      cookie: "better-auth.session_token=session-token",
      workspaceId: "workspace-1",
    })
    expect(
      normalizeOpenDesignCredential({ cookie: "better-auth.session_token=full-cookie", workspaceId: "workspace-1" }),
    ).toEqual({ cookie: "better-auth.session_token=full-cookie", workspaceId: "workspace-1" })
  })

  test("rejects missing or malformed credential fields", () => {
    expect(normalizeOpenDesignCredential(null)).toBeNull()
    expect(normalizeOpenDesignCredential({ cookie: "token" })).toBeNull()
    expect(normalizeOpenDesignCredential({ cookie: "", workspaceId: "workspace-1" })).toBeNull()
    expect(normalizeOpenDesignCredential({ cookie: "token\nextra", workspaceId: "workspace-1" })).toBeNull()
    expect(normalizeOpenDesignCredential({ cookie: 123, workspaceId: "workspace-1" })).toBeNull()
  })

  test("maps recognized durations and numeric-string credits", () => {
    const windows = parseCodingPlanWindows({
      windows: [
        { durationSeconds: "18000", limitCredits: "10", remainingCredits: "4", resetsAt: "2026-12-01T00:00:00Z" },
        { durationSeconds: 604800, limitCredits: 100, remainingCredits: 25 },
      ],
    })

    expect(windows?.["5h"]?.usedPercent).toBe(60)
    expect(windows?.["5h"]?.valueLabel).toBe("4 / 10 credits")
    expect(windows?.["5h"]?.windowSeconds).toBe(18000)
    expect(windows?.["5h"]?.resetAt).toBe(Date.parse("2026-12-01T00:00:00Z"))
    expect(windows?.["7d"]?.usedPercent).toBe(75)
  })

  test("omits zero-limit windows and keeps the last entry for duplicate durations", () => {
    expect(
      parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 0, remainingCredits: 0 }] }),
    ).toBeNull()

    const windows = parseCodingPlanWindows({
      windows: [
        { durationSeconds: 18000, limitCredits: 10, remainingCredits: 5 },
        { durationSeconds: 18000, limitCredits: 10, remainingCredits: 2 },
      ],
    })
    expect(windows?.["5h"]?.usedPercent).toBe(80)
    expect(windows?.["5h"]?.valueLabel).toBe("2 / 10 credits")
  })

  test("missing or malformed windows produce null", () => {
    expect(parseCodingPlanWindows(null)).toBeNull()
    expect(parseCodingPlanWindows({})).toBeNull()
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: "bad", remainingCredits: 5 }] })).toBeNull()
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 3600, limitCredits: 10, remainingCredits: 5 }] })).toBeNull()
  })
})
