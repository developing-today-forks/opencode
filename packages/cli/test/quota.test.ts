import { describe, expect, test } from "bun:test"
import { collectNamedQuotaGroups, quotaRunSucceeded, renderQuotaResults } from "../src/commands/handlers/quota"
import type { QuotaContext, QuotaResult } from "@opencode/ai/quota"

const window = (usedPercent: number | null, valueLabel?: string) => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  ...(valueLabel ? { valueLabel } : {}),
})

const okResult: QuotaResult = {
  providerId: "mistral",
  providerName: "Mistral AI",
  ok: true,
  configured: true,
  fetchedAt: 0,
  usage: {
    windows: {
      api: window(4.66, "$0.70 / $15"),
      vibe: window(0.04, "$0.06 / $150"),
    },
  },
}

const errorResult: QuotaResult = {
  providerId: "meta",
  providerName: "Meta Model API",
  ok: false,
  configured: true,
  fetchedAt: 0,
  usage: null,
  error: "Subscription quota exhausted",
}

describe("quota exit-code behavior", () => {
  test("succeeds when every requested provider produced a successful result", () => {
    expect(quotaRunSucceeded([{ results: [okResult] }])).toBe(true)
    expect(quotaRunSucceeded([{ results: [errorResult, okResult] }])).toBe(true)
  })

  test("fails when a requested provider produced no successful result", () => {
    expect(quotaRunSucceeded([{ results: [okResult] }, { results: [errorResult] }])).toBe(false)
    expect(quotaRunSucceeded([{ results: [] }])).toBe(false)
  })
})

describe("quota human rendering", () => {
  test("renders one block per credential with windows and dollar labels", () => {
    const rendered = renderQuotaResults([okResult])
    expect(rendered).toContain("Mistral AI (mistral)")
    expect(rendered).toContain("api: 4.66% used ($0.70 / $15)")
    expect(rendered).toContain("vibe: 0.04% used ($0.06 / $150)")
  })

  test("renders an error block without inventing windows", () => {
    const rendered = renderQuotaResults([errorResult])
    expect(rendered).toContain("Meta Model API (meta): Subscription quota exhausted")
    expect(rendered).not.toContain("% used")
  })
})

describe("quota named-provider collection (#1734)", () => {
  const ctx: QuotaContext = {
    credentials: [],
    disabledProviders: new Set<string>(),
    instances: new Map(),
    providerConfig: {},
  }

  const fetchStub = (calls: string[]) => async (_ctx: QuotaContext, providerId: string): Promise<QuotaResult[]> => {
    calls.push(providerId)
    return [providerId === "mistral" ? okResult : errorResult]
  }

  test("a mixed invocation keeps every resolvable group and reports the unknown name", async () => {
    const calls: string[] = []
    const { groups, unknown } = await collectNamedQuotaGroups(ctx, ["mistral", "bogus", "meta"], fetchStub(calls))
    // The unknown name is reported, not fatal: names after it are still fetched.
    expect(unknown).toEqual(["bogus"])
    expect(calls).toEqual(["mistral", "meta"])
    expect(groups.map((group) => group.providerId)).toEqual(["mistral", "meta"])
    // The resolvable rows are what the handler renders on stdout.
    const rendered = renderQuotaResults(groups.flatMap((group) => group.results))
    expect(rendered).toContain("Mistral AI (mistral)")
    expect(rendered).toContain("Meta Model API (meta): Subscription quota exhausted")
  })

  test("an only-unknown invocation collects every unknown name and no groups", async () => {
    const calls: string[] = []
    const { groups, unknown } = await collectNamedQuotaGroups(ctx, ["bogus", "also-bogus"], fetchStub(calls))
    expect(unknown).toEqual(["bogus", "also-bogus"])
    expect(groups).toEqual([])
    expect(calls).toEqual([])
  })

  test("all-valid names are fetched once each, in request order, however they are spelled", async () => {
    const calls: string[] = []
    const { groups, unknown } = await collectNamedQuotaGroups(ctx, ["meta", "mistral", "Mistral AI"], fetchStub(calls))
    expect(unknown).toEqual([])
    expect(calls).toEqual(["meta", "mistral"])
    expect(groups.map((group) => group.providerId)).toEqual(["meta", "mistral"])
  })
})
