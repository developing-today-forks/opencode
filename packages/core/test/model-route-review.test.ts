import { describe, expect, test } from "bun:test"
import { ModelRouteReview } from "@opencode/core/model-route-review"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"

const attempt = (
  routeID: string,
  target: string,
  overrides: Partial<ModelRouteReview.Attempt> = {},
): ModelRouteReview.Attempt => {
  const [providerID = "", modelID = ""] = target.split("/")
  return {
    routeID,
    providerID,
    modelID,
    sessionID: "s1",
    outcome: "success",
    errorTag: null,
    firstTokenMs: 800,
    tokensPerSecond: 70,
    tokensInput: 3000,
    ...overrides,
  }
}

const decision = (
  routeID: string,
  reason: string,
  candidates: string[],
  chosen: string,
  weights: Record<string, number> = {},
  excluded: { candidate: string; reason: string }[] = [],
  extra: {
    selection?: string
    tiers?: Record<string, { weight: number; demoted: boolean }>
  } = {},
): ModelRouteReview.Decision => ({
  routeID,
  sessionID: "s1",
  ...(extra.selection === undefined ? {} : { selection: extra.selection }),
  candidates,
  chosen,
  reason,
  detail: { weights, excluded, ...(extra.tiers === undefined ? {} : { tiers: extra.tiers }) },
})

const tier = (weight: number, demoted = false) => ({ weight, demoted })

const pool = (
  selection: ModelRouteReview.Configured["selection"],
  targets: string[],
  weights: Record<string, number> = {},
): ModelRouteReview.Configured => ({ selection, targets, weights, limits: {} })

describe("ModelRouteReview.summarize", () => {
  test("member speed median counts completed attempts only, as its doc states", () => {
    const [summary] = ModelRouteReview.summarize({
      attempts: [
        attempt("cheap", "a/x", { outcome: "success", tokensPerSecond: 10 }),
        attempt("cheap", "a/x", { outcome: "failure", tokensPerSecond: 1000 }),
        attempt("cheap", "a/x", { outcome: "timeout", tokensPerSecond: 2000 }),
        attempt("cheap", "a/x", { outcome: "interrupted", tokensPerSecond: 3000 }),
      ],
      decisions: [],
      configured: new Map([["cheap", pool("weighted", ["a/x"])]]),
    })
    // The failed, timed-out and interrupted attempts did produce output, so the writers record a
    // speed for them — but the median is documented as completed attempts only: the lone success.
    expect(summary?.members[0]?.tokensPerSecond).toBe(10)
    expect(summary?.members[0]?.attempts).toBe(4)
  })

  test("member speed is null when no attempt completed", () => {
    const [summary] = ModelRouteReview.summarize({
      attempts: [attempt("cheap", "a/x", { outcome: "failure", tokensPerSecond: 1000 })],
      decisions: [],
      configured: new Map([["cheap", pool("weighted", ["a/x"])]]),
    })
    expect(summary?.members[0]?.tokensPerSecond).toBeNull()
  })

  test("judges a weighted pool by its new-session draws, not by sticky turns", () => {
    const weights = { "a/x": 2, "b/y": 1 }
    const decisions = [
      ...Array.from({ length: 20 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "a/x", weights)),
      ...Array.from({ length: 10 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "b/y", weights)),
      // Later turns of sessions already placed: sticky, so they say nothing about the weights.
      ...Array.from({ length: 60 }, () => decision("cheap", "sticky", ["a/x", "b/y"], "b/y", weights)),
    ]
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("weighted", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]).toMatchObject({
      configuredWeight: 2,
      offered: 90,
      chosen: 20,
      draws: 30,
      drawsWon: 20,
      expectedShare: 0.667,
      takeRate: 0.667,
    })
    expect(members["b/y"]).toMatchObject({
      configuredWeight: 1,
      offered: 90,
      chosen: 70,
      draws: 30,
      drawsWon: 10,
      expectedShare: 0.333,
      takeRate: 0.333,
    })
  })

  test("lists configured members that had no traffic, with the weight they were given", () => {
    const configured = new Map([["cheap", pool("ordered", ["a/x", "b/y", "c/z"], { "c/z": 3 })]])
    const [summary] = ModelRouteReview.summarize({
      attempts: [attempt("cheap", "a/x")],
      decisions: [decision("cheap", "ordered", ["a/x", "b/y"], "a/x")],
      configured,
    })
    expect(summary?.members.map((member) => member.target)).toEqual(["a/x", "b/y", "c/z"])
    expect(summary?.members[2]).toMatchObject({
      target: "c/z",
      configuredWeight: 3,
      attempts: 0,
      offered: 0,
      chosen: 0,
      failureRate: null,
      takeRate: null,
      expectedShare: null,
    })
  })

  test("counts why a member was left out, without the timestamp in the reason", () => {
    const decisions = [
      decision("cheap", "ordered", ["b/y"], "b/y", {}, [{ candidate: "a/x", reason: "cooldown-until:1767225600000" }]),
      decision("cheap", "ordered", ["b/y"], "b/y", {}, [
        { candidate: "a/x", reason: "soft-budget" },
        { candidate: "a/x", reason: "cooldown-until:1767225600000" },
      ]),
      decision("cheap", "ordered", ["b/y"], "b/y", {}, [{ candidate: "a/x", reason: "over-limit" }]),
    ]
    const [summary] = ModelRouteReview.summarize({ attempts: [], decisions, configured: new Map() })
    const member = summary?.members.find((item) => item.target === "a/x")
    expect(member?.excluded).toEqual({ cooldown: 2, "soft-budget": 1, "over-limit": 1 })
    expect(member).toMatchObject({ offered: 0, attempts: 0 })
  })

  test("configured carries the per-target ceilings declared on targets", () => {
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions: [],
      configured: new Map([
        [
          "small",
          ModelRouteReview.configured({
            selection: "ordered",
            targets: [
              {
                model: { providerID: "anthropic", model: "opus" },
                limit: { context: 100_000 },
              },
              "openai/gpt-6-luna",
            ],
          } as unknown as ConfigModelRoutes.Route),
        ],
      ]),
    })
    expect(summary?.configured).toMatchObject({
      targets: ["anthropic/opus", "openai/gpt-6-luna"],
      limits: { "anthropic/opus": 100_000 },
    })
    expect(summary?.members).toMatchObject([
      { target: "anthropic/opus", configuredLimit: 100_000 },
      { target: "openai/gpt-6-luna", configuredLimit: null },
    ])
  })

  test("reports failures, first output, speed and request size for each member", () => {
    const attempts = [
      attempt("cheap", "a/x", { firstTokenMs: 500, tokensPerSecond: 90 }),
      attempt("cheap", "a/x", { firstTokenMs: 600, tokensPerSecond: 80 }),
      attempt("cheap", "a/x", { firstTokenMs: 700, tokensPerSecond: 70 }),
      attempt("cheap", "a/x", { firstTokenMs: 800, tokensPerSecond: 60 }),
      attempt("cheap", "a/x", {
        outcome: "failure",
        errorTag: "ContextLengthExceeded",
        firstTokenMs: null,
        tokensPerSecond: null,
        tokensInput: 120_000,
      }),
    ]
    const [summary] = ModelRouteReview.summarize({ attempts, decisions: [], configured: new Map() })
    expect(summary?.members[0]).toMatchObject({
      attempts: 5,
      failures: 1,
      failureRate: 0.2,
      firstTokenMs: 600,
      tokensPerSecond: 70,
      inputTokens: 3000,
      errorTags: { ContextLengthExceeded: 1 },
    })
    expect(summary).toMatchObject({ attempts: 5, sessions: 1, inputTokens: { p50: 3000, p90: 120_000 } })
  })

  test("lists configured pools first, then pools seen only in history, busiest first", () => {
    const summaries = ModelRouteReview.summarize({
      attempts: [attempt("other", "a/x"), attempt("other", "a/x"), attempt("third", "b/y")],
      decisions: [],
      configured: new Map([["cheap", pool("ordered", ["a/x"])]]),
    })
    expect(summaries.map((summary) => summary.id)).toEqual(["cheap", "other", "third"])
    expect(summaries[1]?.configured).toBeNull()
  })

  test("surfaces the per-layer weight attribution of the most recent decision (#589)", () => {
    const layers = { base: 2, scheduled: 2, prefer: 6, adjustment: 6, demotion: 6, gate: null }
    const recorded: ModelRouteReview.Decision = {
      routeID: "cheap",
      sessionID: "s1",
      candidates: ["a/x", "b/y"],
      chosen: "a/x",
      reason: "adjusted",
      detail: { weights: { "a/x": 6, "b/y": 1 }, layers: { "a/x": layers }, excluded: [] },
    }
    const [summary] = ModelRouteReview.summarize({ attempts: [], decisions: [recorded], configured: new Map() })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]?.weightLayers).toEqual(layers)
    expect(members["b/y"]?.weightLayers).toBeNull()
    expect(ModelRouteReview.layersOf(recorded.detail)).toEqual({ "a/x": layers })
    expect(ModelRouteReview.layersOf(null)).toEqual({})
    expect(ModelRouteReview.layersOf({ layers: { "a/x": { base: "heavy" } } })).toEqual({})
  })

  test("weightLayers comes from the newest decision that carries layers, not the oldest (#628)", () => {
    const newest = { base: 99, scheduled: 99, prefer: 99, adjustment: 99, demotion: 99, gate: null }
    const oldest = { base: 1, scheduled: 1, prefer: 1, adjustment: 1, demotion: 1, gate: null }
    const decision = (layers: unknown): ModelRouteReview.Decision => ({
      routeID: "cheap",
      sessionID: "s1",
      candidates: ["a/x"],
      chosen: "a/x",
      reason: "adjusted",
      detail: { weights: { "a/x": 1 }, ...(layers === undefined ? {} : { layers: { "a/x": layers } }), excluded: [] },
    })
    const layersOfSummary = (decisions: ModelRouteReview.Decision[]) =>
      ModelRouteReview.summarize({ attempts: [], decisions, configured: new Map() })[0]?.members[0]?.weightLayers
    // Production order is newest-first: the oldest decision must not overwrite the newest.
    expect(layersOfSummary([decision(newest), decision(oldest)])).toEqual(newest)
    // A newest decision without layers falls through to the next one that carries them.
    expect(layersOfSummary([decision(undefined), decision(newest), decision(oldest)])).toEqual(newest)
  })

  test("round-robin: equal weights are one tier and split the expectation evenly", () => {
    const weights = { "a/x": 2, "b/y": 2 }
    const tiers = { "a/x": tier(2), "b/y": tier(2) }
    const decisions = [
      ...Array.from({ length: 15 }, () =>
        decision("cheap", "drawn", ["a/x", "b/y"], "a/x", weights, [], { selection: "round-robin", tiers }),
      ),
      ...Array.from({ length: 15 }, () =>
        decision("cheap", "drawn", ["a/x", "b/y"], "b/y", weights, [], { selection: "round-robin", tiers }),
      ),
    ]
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("round-robin", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]).toMatchObject({ expectedShare: 0.5, takeRate: 0.5 })
    expect(members["b/y"]).toMatchObject({ expectedShare: 0.5, takeRate: 0.5 })
  })

  test("round-robin: under full availability only the top tier expects anything (3/1 is 100/0, not 75/25)", () => {
    const weights = { "a/x": 3, "b/y": 1 }
    const tiers = { "a/x": tier(3), "b/y": tier(1) }
    const decisions = Array.from({ length: 30 }, () =>
      decision("cheap", "drawn", ["a/x", "b/y"], "a/x", weights, [], { selection: "round-robin", tiers }),
    )
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("round-robin", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    // The old proportional reading promised 0.75 / 0.25 here; tiered selection promises the
    // lone top-tier member everything and the lower tier nothing while the top tier is present.
    expect(members["a/x"]?.expectedShare).toBe(1)
    expect(members["b/y"]?.expectedShare).toBe(0)
    expect(members["a/x"]?.expectedShare).not.toBe(0.75)
    expect(members["b/y"]?.expectedShare).not.toBe(0.25)
  })

  test("round-robin: a multi-member top tier splits evenly and the tier below expects 0", () => {
    const weights = { "a/x": 3, "b/y": 3, "c/z": 1 }
    const tiers = { "a/x": tier(3), "b/y": tier(3), "c/z": tier(1) }
    const decisions = Array.from({ length: 30 }, (_, index) =>
      decision("cheap", "drawn", ["a/x", "b/y", "c/z"], index % 2 === 0 ? "a/x" : "b/y", weights, [], {
        selection: "round-robin",
        tiers,
      }),
    )
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("round-robin", ["a/x", "b/y", "c/z"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]?.expectedShare).toBe(0.5)
    expect(members["b/y"]?.expectedShare).toBe(0.5)
    expect(members["c/z"]?.expectedShare).toBe(0)
  })

  test("round-robin: expectation falls through to the highest tier present when the top tier is absent", () => {
    const weights = { "a/x": 3, "b/y": 2, "c/z": 1 }
    const tiers = { "a/x": tier(3), "b/y": tier(2), "c/z": tier(1) }
    const full = Array.from({ length: 10 }, () =>
      decision("cheap", "drawn", ["a/x", "b/y", "c/z"], "a/x", weights, [], { selection: "round-robin", tiers }),
    )
    // The top tier is not among these draws' candidates, so the weight-2 tier is the top tier here.
    const fallen = Array.from({ length: 10 }, () =>
      decision("cheap", "drawn", ["b/y", "c/z"], "b/y", weights, [], { selection: "round-robin", tiers }),
    )
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions: [...full, ...fallen],
      configured: new Map([["cheap", pool("round-robin", ["a/x", "b/y", "c/z"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]).toMatchObject({ draws: 10, expectedShare: 1 })
    // b/y expects 0 in the 10 full draws and 1 in the 10 fallthrough draws: 0.5 on average.
    expect(members["b/y"]).toMatchObject({ draws: 20, expectedShare: 0.5 })
    expect(members["c/z"]).toMatchObject({ draws: 20, expectedShare: 0 })
  })

  test("round-robin: a demoted heavyweight expects nothing while any live tier is present", () => {
    const weights = { "a/x": 100, "b/y": 1 }
    // The selector records the demoted 100's effective weight as 1 (100 x 0.01), but its tier
    // record holds it below the live weight-1 tier, so expectation follows the tier, not the ratio.
    const tiers = { "a/x": tier(100, true), "b/y": tier(1) }
    const decisions = Array.from({ length: 10 }, () =>
      decision("cheap", "drawn", ["a/x", "b/y"], "b/y", { "a/x": 1, "b/y": 1 }, [], {
        selection: "round-robin",
        tiers,
      }),
    )
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("round-robin", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]?.expectedShare).toBe(0)
    expect(members["b/y"]?.expectedShare).toBe(1)
  })

  test("round-robin: tiers are derived from the recorded weights when a decision carries no tier record", () => {
    // Decisions recorded before #1122 kept weights but no tiers; distinct weights are the tiers.
    const weights = { "a/x": 3, "b/y": 1 }
    const decisions = Array.from({ length: 10 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "a/x", weights))
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("round-robin", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]?.expectedShare).toBe(1)
    expect(members["b/y"]?.expectedShare).toBe(0)
  })

  test("round-robin: the recorded selection mode tiers a pool that is no longer in the configuration", () => {
    const weights = { "a/x": 3, "b/y": 1 }
    const tiers = { "a/x": tier(3), "b/y": tier(1) }
    const decisions = Array.from({ length: 10 }, () =>
      decision("gone", "drawn", ["a/x", "b/y"], "a/x", weights, [], { selection: "round-robin", tiers }),
    )
    const [summary] = ModelRouteReview.summarize({ attempts: [], decisions, configured: new Map() })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]?.expectedShare).toBe(1)
    expect(members["b/y"]?.expectedShare).toBe(0)
    expect(ModelRouteReview.tiersOf(decisions[0]?.detail ?? null)).toEqual(tiers)
    expect(ModelRouteReview.tiersOf(null)).toEqual({})
    expect(ModelRouteReview.tiersOf({ tiers: { "a/x": { weight: "heavy" } } })).toEqual({})
  })

  test("weighted pools keep the proportional expectation the selector draws by", () => {
    const weights = { "a/x": 3, "b/y": 1 }
    const decisions = [
      ...Array.from({ length: 30 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "a/x", weights)),
      ...Array.from({ length: 10 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "b/y", weights)),
    ]
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("weighted", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    // Weighted mode is untouched by #1122/#1124: 3/1 really does promise 75/25 there.
    expect(members["a/x"]).toMatchObject({ expectedShare: 0.75, takeRate: 0.75 })
    expect(members["b/y"]).toMatchObject({ expectedShare: 0.25, takeRate: 0.25 })
  })
})
