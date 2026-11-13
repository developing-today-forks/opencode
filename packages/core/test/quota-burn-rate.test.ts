import { describe, expect, test } from "bun:test"
import { QuotaBurnRate } from "@opencode/core/quota-burn-rate"

const sample = (overrides: Partial<QuotaBurnRate.Sample> = {}): QuotaBurnRate.Sample => ({
  providerID: "anthropic",
  modelID: "sonnet",
  effort: "medium",
  plan: "anthropic-plus",
  window: "weekly",
  percent: 4,
  ...overrides,
})

const query = (overrides: Partial<QuotaBurnRate.Query> = {}): QuotaBurnRate.Query => ({
  providerID: "anthropic",
  modelID: "sonnet",
  effort: "medium",
  plan: "anthropic-plus",
  window: "weekly",
  ...overrides,
})

describe("QuotaBurnRate.estimate", () => {
  test("a bucket with enough history returns its own mean", () => {
    // Hand-computed: (4 + 5 + 6) / 3 = 5.
    const samples = [sample({ percent: 4 }), sample({ percent: 5 }), sample({ percent: 6 })]
    expect(QuotaBurnRate.estimate(samples, query())).toEqual({
      providerID: "anthropic",
      modelID: "sonnet",
      effort: "medium",
      plan: "anthropic-plus",
      window: "weekly",
      percentPerSession: 5,
      sessions: 3,
      source: "bucket",
    })
  })

  test("a thin effort bucket falls back to the model mean across efforts", () => {
    const samples = [
      sample({ effort: "xhigh", percent: 20 }),
      sample({ effort: "medium", percent: 4 }),
      sample({ effort: "medium", percent: 5 }),
      sample({ effort: "low", percent: 3 }),
    ]
    // xhigh has 1 sample (< 3): model mean is (20 + 4 + 5 + 3) / 4 = 8.
    const estimate = QuotaBurnRate.estimate(samples, query({ effort: "xhigh" }))
    expect(estimate.source).toBe("model")
    expect(estimate.percentPerSession).toBe(8)
    expect(estimate.sessions).toBe(4)
  })

  test("no history for the model falls back to the effort prior", () => {
    const estimate = QuotaBurnRate.estimate([], query({ providerID: "meta", modelID: "muse-wonder", effort: "high" }))
    expect(estimate).toEqual({
      providerID: "meta",
      modelID: "muse-wonder",
      effort: "high",
      plan: "anthropic-plus",
      window: "weekly",
      percentPerSession: QuotaBurnRate.DEFAULT_PRIORS.high,
      sessions: 0,
      source: "prior-effort",
    })
  })

  test("no history and no effort falls back to the default prior", () => {
    const estimate = QuotaBurnRate.estimate([], query({ providerID: "meta", modelID: "muse-wonder", effort: undefined }))
    expect(estimate.percentPerSession).toBe(QuotaBurnRate.DEFAULT_PRIOR)
    expect(estimate.source).toBe("prior-default")
    expect(estimate.effort).toBeNull()
  })

  test.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "a prototype-named effort (%s) with no own prior falls back to the default prior",
    (effort) => {
      const estimate = QuotaBurnRate.estimate([], query({ providerID: "meta", modelID: "muse-wonder", effort }))
      expect(estimate.source).toBe("prior-default")
      expect(estimate.percentPerSession).toBe(QuotaBurnRate.DEFAULT_PRIOR)
      expect(typeof estimate.percentPerSession).toBe("number")
    },
  )

  test("a prototype-named effort still falls back to the default prior when caller priors are present", () => {
    const estimate = QuotaBurnRate.estimate(
      [],
      query({ providerID: "meta", modelID: "muse-wonder", effort: "constructor" }),
      { priors: { low: 2 } },
    )
    expect(estimate.source).toBe("prior-default")
    expect(estimate.percentPerSession).toBe(QuotaBurnRate.DEFAULT_PRIOR)
  })

  test("an own-property prior named 'constructor' is still honoured", () => {
    const priors = Object.fromEntries([["constructor", 7]])
    const estimate = QuotaBurnRate.estimate(
      [],
      query({ providerID: "meta", modelID: "muse-wonder", effort: "constructor" }),
      { priors },
    )
    expect(estimate.source).toBe("prior-effort")
    expect(estimate.percentPerSession).toBe(7)
  })

  test("configured priors override the defaults", () => {
    const estimate = QuotaBurnRate.estimate(
      [],
      query({ providerID: "meta", modelID: "muse-wonder", effort: "high" }),
      { priors: { high: 9 } },
    )
    expect(estimate.percentPerSession).toBe(9)
    expect(estimate.source).toBe("prior-effort")
  })

  test("an effort-less query trusts the model bucket as its own bucket", () => {
    const samples = [sample({ percent: 2 }), sample({ percent: 4 }), sample({ percent: 6, effort: undefined })]
    const estimate = QuotaBurnRate.estimate(samples, query({ effort: undefined }))
    expect(estimate.source).toBe("bucket")
    expect(estimate.percentPerSession).toBe(4)
  })

  test("estimates are deterministic in the sample order", () => {
    const samples = [sample({ percent: 4 }), sample({ percent: 5 }), sample({ percent: 6 }), sample({ percent: 7 })]
    expect(QuotaBurnRate.estimate(samples, query())).toEqual(QuotaBurnRate.estimate([...samples].reverse(), query()))
  })

  test("samples from another window never average into the estimate (#1033)", () => {
    const samples = [
      sample({ percent: 10 }),
      sample({ percent: 11 }),
      sample({ percent: 12 }),
      sample({ percent: 1, window: "monthly" }),
      sample({ percent: 1, window: "monthly" }),
      sample({ percent: 1, window: "monthly" }),
      sample({ percent: 1, window: "monthly" }),
      sample({ percent: 1, window: "monthly" }),
    ]
    const weekly = QuotaBurnRate.estimate(samples, query())
    expect(weekly).toMatchObject({ percentPerSession: 11, sessions: 3, source: "bucket" })
    const monthly = QuotaBurnRate.estimate(samples, query({ window: "monthly" }))
    expect(monthly).toMatchObject({ percentPerSession: 1, sessions: 5, source: "bucket" })
  })

  test("a thin bucket falls back to the window's own model mean, not cross-window history (#1033)", () => {
    const samples = [
      sample({ effort: "xhigh", percent: 20 }),
      sample({ effort: "medium", percent: 30, window: "monthly" }),
      sample({ effort: "medium", percent: 31, window: "monthly" }),
      sample({ effort: "medium", percent: 32, window: "monthly" }),
    ]
    // Averaging across windows would trust a "model" mean of 28.25 here; the weekly bucket has one
    // sample, so the estimate falls back to the xhigh prior instead.
    const estimate = QuotaBurnRate.estimate(samples, query({ effort: "xhigh" }))
    expect(estimate.source).toBe("prior-effort")
    expect(estimate.percentPerSession).toBe(QuotaBurnRate.DEFAULT_PRIORS.xhigh)
    expect(estimate.sessions).toBe(0)
  })
})

describe("QuotaBurnRate.buckets", () => {
  test("groups by provider, model, and effort with measured means, sorted", () => {
    const samples = [
      sample({ providerID: "meta", modelID: "muse-wonder", plan: "meta-plus", effort: undefined, percent: 10 }),
      sample({ percent: 4 }),
      sample({ percent: 6 }),
      sample({ effort: "low", percent: 1 }),
    ]
    expect(QuotaBurnRate.buckets(samples)).toEqual([
      {
        providerID: "anthropic",
        modelID: "sonnet",
        effort: "low",
        plan: "anthropic-plus",
        window: "weekly",
        percentPerSession: 1,
        sessions: 1,
        source: "bucket",
      },
      {
        providerID: "anthropic",
        modelID: "sonnet",
        effort: "medium",
        plan: "anthropic-plus",
        window: "weekly",
        percentPerSession: 5,
        sessions: 2,
        source: "bucket",
      },
      {
        providerID: "meta",
        modelID: "muse-wonder",
        effort: null,
        plan: "meta-plus",
        window: "weekly",
        percentPerSession: 10,
        sessions: 1,
        source: "bucket",
      },
    ])
  })

  test("empty history gives no buckets", () => {
    expect(QuotaBurnRate.buckets([])).toEqual([])
  })

  test("shares from distinct windows of one provider land in separate buckets (#1033)", () => {
    const samples = [
      sample({ providerID: "openai", modelID: "gpt-6-luna", effort: undefined, plan: "openai-plus", window: "5-hour", percent: 10 }),
      sample({ providerID: "openai", modelID: "gpt-6-luna", effort: undefined, plan: "openai-plus", window: "5-hour", percent: 12 }),
      sample({ providerID: "openai", modelID: "gpt-6-luna", effort: undefined, plan: "openai-plus", window: "daily", percent: 1 }),
      sample({ providerID: "openai", modelID: "gpt-6-luna", effort: undefined, plan: "openai-plus", window: "daily", percent: 2 }),
    ]
    expect(QuotaBurnRate.buckets(samples)).toEqual([
      {
        providerID: "openai",
        modelID: "gpt-6-luna",
        effort: null,
        plan: "openai-plus",
        window: "5-hour",
        percentPerSession: 11,
        sessions: 2,
        source: "bucket",
      },
      {
        providerID: "openai",
        modelID: "gpt-6-luna",
        effort: null,
        plan: "openai-plus",
        window: "daily",
        percentPerSession: 1.5,
        sessions: 2,
        source: "bucket",
      },
    ])
  })
})
