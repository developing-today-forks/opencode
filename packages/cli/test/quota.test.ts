import { describe, expect, test } from "bun:test"
import { quotaRunSucceeded, renderQuotaResults } from "../src/commands/handlers/quota"
import type { QuotaResult } from "@opencode/ai/quota"

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
