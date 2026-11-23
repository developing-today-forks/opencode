import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteGranularity } from "@opencode/core/model-route-granularity"

/**
 * Learned bench granularity (code#10367 design points 3–4).
 *
 * The oracle is the design's own rule, judged over recorded route_attempt
 * fixtures: promotion happens only on perfect concordance — every observed
 * failure window shows all tried efforts (then all tried models) failing
 * together, over the minimum sample of MIN_CONCORDANT_WINDOWS windows — and
 * the first discordant success demotes instantly. The live-wiring tests then
 * pin what a promotion buys: a standing traffic bench widens from the effort
 * that earned it to the model, and a promoted provider's simultaneity bench
 * fires on one cooling model instead of the global threshold.
 *
 * A failure window is one episode: attempts within WINDOW_GAP_MS of each
 * other. Fixtures space windows a gap and a minute apart, so each new
 * window's first row closes the one before it; promotion is therefore
 * asserted only after a closing row lands.
 */

const GAP = ModelRouteGranularity.WINDOW_GAP_MS + 60_000
const T0 = 1_000_000_000_000

type Row = ModelRouteGranularity.AttemptRow

const row = (
  provider_id: string,
  model_id: string,
  variant: string | null,
  outcome: string,
  time_started: number,
): Row => ({ provider_id, model_id, variant, outcome, time_started })

/** One failure window for a model: every named effort fails, a second apart. */
const modelWindow = (provider: string, model: string, efforts: readonly string[], at: number): Row[] =>
  efforts.map((variant, index) => row(provider, model, variant, "failure", at + index * 1_000))

/** One failure window for a provider: every named model fails, a second apart. */
const providerWindow = (provider: string, models: readonly string[], at: number): Row[] =>
  models.map((model, index) => row(provider, model, null, "failure", at + index * 1_000))

const state = (key: string, scope: "model" | "provider") =>
  ModelRouteGranularity.snapshot().find((item) => item.key === key && item.scope === scope)

describe("learned bench granularity (code#10367 points 3-4)", () => {
  afterEach(() => {
    ModelRoute.resetHealth()
    ModelRoute.resetSelection()
    ModelRouteGranularity.reset()
  })

  test("promotes effort→model on perfect concordance over the minimum sample, from route_attempt fixtures", () => {
    const rows: Row[] = []
    for (let window = 0; window < 3; window++)
      rows.push(...modelWindow("learn-door", "luna", ["high", "medium"], T0 + window * GAP))
    // The closing row: window 4's first failure judges window 3.
    rows.push(row("learn-door", "luna", "high", "failure", T0 + 3 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.modelLevel("learn-door", "luna")).toBe("model")
    const learned = state("learn-door/luna", "model")
    expect(learned?.level).toBe("model")
    expect(learned?.concordantWindows).toBe(3)
    expect(learned?.evidence).toBe(7)
    expect(learned?.demotions).toBe(0)
    expect(learned?.promotedAt).toBe(T0 + 2 * GAP + 1_000)
  })

  test("windows that tried only one effort are not concordance evidence", () => {
    const rows: Row[] = []
    for (let window = 0; window < 5; window++)
      rows.push(...modelWindow("solo-door", "luna", ["high"], T0 + window * GAP))
    rows.push(row("solo-door", "luna", "high", "failure", T0 + 5 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.modelLevel("solo-door", "luna")).toBe("effort")
    expect(state("solo-door/luna", "model")?.concordantWindows).toBe(0)
  })

  test("a discordant success resets the count; the claim must be re-earned", () => {
    const rows: Row[] = []
    for (let window = 0; window < 2; window++)
      rows.push(...modelWindow("reset-door", "luna", ["high", "medium"], T0 + window * GAP))
    // Window 3: high fails, medium — which never failed in this window — answers.
    rows.push(row("reset-door", "luna", "high", "failure", T0 + 2 * GAP))
    rows.push(row("reset-door", "luna", "medium", "success", T0 + 2 * GAP + 1_000))
    // Two fresh concordant windows are not enough after the reset.
    for (let window = 3; window < 5; window++)
      rows.push(...modelWindow("reset-door", "luna", ["high", "medium"], T0 + window * GAP))
    rows.push(row("reset-door", "luna", "high", "failure", T0 + 5 * GAP))
    expect(ModelRouteGranularity.modelLevel("reset-door", "luna")).toBe("effort")
    expect(state("reset-door/luna", "model")?.concordantWindows).toBe(2)
    // The third fresh window earns it.
    rows.push(...modelWindow("reset-door", "luna", ["high", "medium"], T0 + 6 * GAP))
    rows.push(row("reset-door", "luna", "high", "failure", T0 + 7 * GAP))
    expect(ModelRouteGranularity.modelLevel("reset-door", "luna")).toBe("model")
  })

  test("demotes on the first discordant success while a coarser claim stands (point 4)", () => {
    const rows: Row[] = []
    for (let window = 0; window < 3; window++)
      rows.push(...modelWindow("demote-door", "luna", ["high", "medium"], T0 + window * GAP))
    // Window 4 opens with high's failure — the model-level claim now stands
    // over it — and medium answers without having failed in this window.
    rows.push(row("demote-door", "luna", "high", "failure", T0 + 3 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.modelLevel("demote-door", "luna")).toBe("model")
    ModelRouteGranularity.observeAttemptRows([row("demote-door", "luna", "medium", "success", T0 + 3 * GAP + 1_000)])
    expect(ModelRouteGranularity.modelLevel("demote-door", "luna")).toBe("effort")
    const learned = state("demote-door/luna", "model")
    expect(learned?.demotions).toBe(1)
    expect(learned?.lastDemotionAt).toBe(T0 + 3 * GAP + 1_000)
    expect(learned?.concordantWindows).toBe(0)
  })

  test("an effort recovering from its own failure is not a counterexample", () => {
    const rows: Row[] = []
    for (let window = 0; window < 3; window++)
      rows.push(...modelWindow("recover-door", "luna", ["high", "medium"], T0 + window * GAP))
    rows.push(row("recover-door", "luna", "high", "failure", T0 + 3 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.modelLevel("recover-door", "luna")).toBe("model")
    // High answers again inside its own episode: the episode is ending, and
    // the model-level claim survives it.
    ModelRouteGranularity.observeAttemptRows([row("recover-door", "luna", "high", "success", T0 + 3 * GAP + 1_000)])
    expect(ModelRouteGranularity.modelLevel("recover-door", "luna")).toBe("model")
    expect(state("recover-door/luna", "model")?.demotions).toBe(0)
  })

  test("promotes model→provider on perfect concordance, from route_attempt fixtures", () => {
    const rows: Row[] = []
    for (let window = 0; window < 3; window++)
      rows.push(...providerWindow("fleet-door", ["luna", "haiku"], T0 + window * GAP))
    rows.push(row("fleet-door", "luna", null, "failure", T0 + 3 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.providerPromoted("fleet-door")).toBe(true)
    const learned = state("fleet-door", "provider")
    expect(learned?.level).toBe("provider")
    expect(learned?.concordantWindows).toBe(3)
    // Each model was only ever tried at its default effort, so neither model
    // key earned a promotion of its own: the two promotions are independent.
    expect(ModelRouteGranularity.modelLevel("fleet-door", "luna")).toBe("effort")
    expect(ModelRouteGranularity.modelLevel("fleet-door", "haiku")).toBe("effort")
  })

  test("demotes the provider on the first model-discordant success", () => {
    const rows: Row[] = []
    for (let window = 0; window < 3; window++)
      rows.push(...providerWindow("fleet-door", ["luna", "haiku"], T0 + window * GAP))
    rows.push(row("fleet-door", "luna", null, "failure", T0 + 3 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.providerPromoted("fleet-door")).toBe(true)
    // Luna fails again; haiku, which did not fail in this window, answers.
    ModelRouteGranularity.observeAttemptRows([
      row("fleet-door", "luna", null, "failure", T0 + 3 * GAP + 60_000),
      row("fleet-door", "haiku", null, "success", T0 + 3 * GAP + 61_000),
    ])
    expect(ModelRouteGranularity.providerPromoted("fleet-door")).toBe(false)
    expect(state("fleet-door", "provider")?.demotions).toBe(1)
  })

  test("only door-evidence outcomes feed the learner; timeouts count as failures", () => {
    const rows: Row[] = []
    for (let window = 0; window < 3; window++) {
      const at = T0 + window * GAP
      rows.push(row("evidence-door", "luna", "high", "failure", at))
      rows.push(row("evidence-door", "luna", "medium", "timeout", at + 1_000))
      rows.push(row("evidence-door", "luna", "medium", "interrupted", at + 2_000))
      rows.push(row("evidence-door", "luna", "high", "hedged-out", at + 3_000))
      rows.push(row("evidence-door", "luna", "high", "resolution-failure", at + 4_000))
    }
    rows.push(row("evidence-door", "luna", "high", "failure", T0 + 3 * GAP))
    ModelRouteGranularity.observeAttemptRows(rows)
    expect(ModelRouteGranularity.modelLevel("evidence-door", "luna")).toBe("model")
    // 3 windows × 2 evidence rows + the closing row; the three non-evidence
    // outcomes per window never landed.
    expect(state("evidence-door/luna", "model")?.evidence).toBe(7)
  })

  test("live wiring: a promoted model's standing traffic bench holds its sibling efforts, until a success demotes it", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
    const target = ModelRoute.ref({ providerID: "wire-door", model: "wire-model" })
    const fail = (at: number, variant: string) =>
      ModelRoute.failed(target, policy, at, {}, undefined, undefined, undefined, variant)
    for (let window = 0; window < 3; window++) {
      fail(T0 + window * GAP, "high")
      fail(T0 + window * GAP + 1_000, "medium")
    }
    fail(T0 + 3 * GAP, "high")
    expect(ModelRouteGranularity.modelLevel("wire-door", "wire-model")).toBe("model")
    // A fresh failure at xhigh alone: at the seed granularity medium would
    // read clear (its own bench expired windows ago); promoted, it reads the
    // xhigh bench in full.
    fail(T0 + 3 * GAP + 2_000, "xhigh")
    const widened = ModelRoute.cooldownUntil(target, T0 + 3 * GAP + 2_000, undefined, "medium")
    expect(widened).toBe(ModelRoute.cooldownUntil(target, T0 + 3 * GAP + 2_000, undefined, "xhigh"))
    expect(widened).toBeGreaterThan(T0 + 3 * GAP + 2_000)
    // Medium answers while the model-level bench stands: the first
    // counterexample demotes the key on the spot, and the next xhigh failure
    // benches xhigh only.
    ModelRoute.completed(
      target,
      policy,
      { firstTokenMs: 10, responseMs: 10, tokensPerSecond: 100 },
      T0 + 3 * GAP + 3_000,
      undefined,
      undefined,
      undefined,
      "medium",
    )
    expect(ModelRouteGranularity.modelLevel("wire-door", "wire-model")).toBe("effort")
    fail(T0 + 3 * GAP + 4_000, "xhigh")
    expect(ModelRoute.cooldownUntil(target, T0 + 3 * GAP + 4_000, undefined, "medium")).toBe(0)
  })

  test("live wiring: a promoted provider's simultaneity bench fires on one cooling model", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
    const alpha = ModelRoute.ref({ providerID: "sim-door", model: "alpha" })
    const beta = ModelRoute.ref({ providerID: "sim-door", model: "beta" })
    for (let window = 0; window < 3; window++) {
      ModelRoute.failed(alpha, policy, T0 + window * GAP, {})
      ModelRoute.failed(beta, policy, T0 + window * GAP + 1_000, {})
    }
    ModelRoute.failed(alpha, policy, T0 + 3 * GAP, {})
    expect(ModelRouteGranularity.providerPromoted("sim-door")).toBe(true)
    // One model cooling is now the provider's own verdict: beta, whose own
    // benches expired windows ago, reads alpha's bench in full. Unpromoted,
    // the simultaneity bench would need a second model cooling.
    const at = T0 + 3 * GAP + 2_000
    ModelRoute.failed(alpha, policy, at, {})
    expect(ModelRoute.cooldownUntil(beta, at)).toBe(ModelRoute.cooldownUntil(alpha, at))
    expect(ModelRoute.cooldownUntil(beta, at)).toBeGreaterThan(at)
  })
})
