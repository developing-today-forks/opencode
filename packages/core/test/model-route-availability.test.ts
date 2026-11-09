import { afterEach, describe, expect, test } from "bun:test"
import { AIError } from "@opencode/ai"
import { ModelRoute } from "@opencode/core/model-route"
import { QuotaSnapshot } from "@opencode/core/quota-snapshot"
import { SessionStep } from "@opencode/core/session/runner/step"
import { MockProvider, MockScenarios } from "./fixture/mock-provider"
import { driveStep } from "./fixture/mock-route-driver"

/**
 * Provider availability (#1828): one classification + stop/resume state machine under the
 * router. Drew's spec (2026-11-06): providers stop trying when quota is burned until it
 * shows an increase; rate limits stop until retry-after; unknown errors block for
 * increasing times; a failure to route at all (our DNS, a dead local service) is NOT the
 * same as a provider error and must not degrade the provider's standing; and one surface
 * shows what is available vs stopped, why, and what resumes it. Plan seats are never
 * removed for any of this — availability is routing-layer state, and a stopped provider
 * must cost a session ~nothing (the seamlessness scenarios at the bottom).
 */

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.resetSelection()
  ModelRoute.setAdjustments([])
})

const ref = (providerID: string, model: string) => ModelRoute.ref({ providerID, model })

const definition = (
  id: string,
  targets: readonly ModelRoute.Target[],
  nodes: unknown,
  health?: ModelRoute.Policy,
): ModelRoute.Definition =>
  ({
    id,
    targets,
    targetVariants: [],
    health: health ?? ModelRoute.policy(),
    nodes,
  }) as unknown as ModelRoute.Definition

const failure = async (mock: MockProvider, target: ModelRoute.Target): Promise<AIError> => {
  const error = await mock.attempt(target).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AIError)
  return error as AIError
}

const snapshot = (over: Partial<QuotaSnapshot.Snapshot>): QuotaSnapshot.Snapshot =>
  ({
    planID: "plan",
    window: "monthly",
    providerID: "prov",
    percent: 40,
    remaining: 50,
    resetAt: Date.now() + 3_600_000,
    observedAt: Date.now(),
    stale: false,
    ...over,
  }) as QuotaSnapshot.Snapshot

const availabilityOf = (providerID: string, now: number) =>
  ModelRoute.availability(now).filter((entry) => entry.providerID === providerID)

describe("availability classification (#1828)", () => {
  test("quota parity: Antigravity's text wall and Mistral's tagged quota stop as the same class", async () => {
    const mock = new MockProvider()
    const ag = ref("antigravity-direct", "claude-sonnet-5-5")
    const mistral = ref("mistral", "mistral-small-latest")
    mock.set(ag, MockScenarios.antigravityQuotaWall())
    mock.set(mistral, MockScenarios.quotaExceeded())
    const now = Date.now()
    ModelRoute.failed(ag, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, ag)))
    ModelRoute.failed(mistral, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, mistral)))
    // The wire shapes differ (RateLimit vs QuotaExceeded); the availability class must not.
    expect(availabilityOf("antigravity-direct", now).map((entry) => entry.class)).toEqual(["quota"])
    expect(availabilityOf("mistral", now).map((entry) => entry.class)).toEqual(["quota"])
    expect(availabilityOf("antigravity-direct", now)[0]?.resume).toBe("reset")
  })

  test("a quota bench is bounded by the reset stated only in the error text", async () => {
    const mock = new MockProvider()
    const ag = ref("antigravity-direct", "claude-sonnet-5-5")
    mock.set(ag, MockScenarios.antigravityQuotaWall())
    const now = Date.now()
    ModelRoute.failed(ag, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, ag)))
    const bench = ModelRoute.activeBenches(now).find((item) => item.providerID === "antigravity-direct")
    expect(bench).toBeDefined()
    const expectedReset = now + (81 * 3600 + 35 * 60 + 49) * 1000
    expect(Math.abs((bench!.quotaResetAt ?? 0) - expectedReset)).toBeLessThan(60_000)
  })

  test("a 429 with retry-after stops as rate-limit until the stated wait, never multiplied", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.rateLimit(120))
    const now = Date.now()
    ModelRoute.failed(target, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, target)))
    const entries = availabilityOf("prov", now)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.class).toBe("rate-limit")
    expect(entries[0]?.resume).toBe("retry-after")
    expect(Math.abs((entries[0]?.until ?? 0) - (now + 120_000))).toBeLessThan(2_000)
    expect(Math.abs(ModelRoute.cooldownUntil(target, now) - (now + 120_000))).toBeLessThan(2_000)
  })

  test("unknown errors block for increasing times; a success resets the ladder", () => {
    const target = ref("prov", "m")
    const policy = ModelRoute.policy()
    const now = Date.now()
    ModelRoute.failed(target, policy, now, {})
    expect(ModelRoute.cooldownUntil(target, now) - now).toBe(60_000)
    ModelRoute.failed(target, policy, now, {})
    expect(ModelRoute.cooldownUntil(target, now) - now).toBe(120_000)
    ModelRoute.failed(target, policy, now, {})
    // The third failure would double to 240s; the failure cap holds an ordinary
    // (unknown) failure's grace at 120s instead (#2212).
    expect(ModelRoute.cooldownUntil(target, now) - now).toBe(120_000)
    expect(availabilityOf("prov", now)[0]?.class).toBe("unknown")
    ModelRoute.completed(target, policy, { firstTokenMs: 25, responseMs: 90, tokensPerSecond: 60 }, now)
    ModelRoute.failed(target, policy, now, {})
    expect(ModelRoute.cooldownUntil(target, now) - now).toBe(60_000)
  })

  test("a balance hold surfaces as increase-only, with no timer", () => {
    const target = ref("prov", "m")
    const now = Date.now()
    ModelRoute.observeProviderQuota(
      target,
      snapshot({ providerID: "prov", percent: null, remaining: 0, resetAt: null, balance: true, observedAt: now }),
      now,
    )
    const entries = availabilityOf("prov", now)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.class).toBe("balance")
    expect(entries[0]?.resume).toBe("increase")
    expect(entries[0]?.until).toBeUndefined()
  })
})

describe("quota resume on measured increase (#1828)", () => {
  test("a fresh not-full provider reading releases a quota bench before its reset", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.quotaExceeded())
    const now = Date.now()
    ModelRoute.failed(target, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, target)))
    expect(ModelRoute.coolingDown(target, now)).toBe(true)
    ModelRoute.observeProviderQuota(target, snapshot({ providerID: "prov", percent: 40, observedAt: now }), now)
    expect(ModelRoute.coolingDown(target, now)).toBe(false)
    expect(availabilityOf("prov", now)).toEqual([])
  })

  test("the same release works at credential scope", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.quotaExceeded())
    const now = Date.now()
    ModelRoute.failed(target, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, target)), "cred-1")
    expect(ModelRoute.credentialCoolingDown(target, "cred-1", now)).toBe(true)
    ModelRoute.observeCredentialQuota(target, "cred-1", snapshot({ providerID: "prov", percent: 40, observedAt: now }), now)
    expect(ModelRoute.credentialCoolingDown(target, "cred-1", now)).toBe(false)
  })

  test("a stale reading releases nothing — a failed quota read never frees a scope", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.quotaExceeded())
    const now = Date.now()
    ModelRoute.failed(target, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, target)))
    ModelRoute.observeProviderQuota(
      target,
      snapshot({ providerID: "prov", percent: 40, stale: true, observedAt: now }),
      now,
    )
    expect(ModelRoute.coolingDown(target, now)).toBe(true)
  })
})

describe("infra holds (#1828)", () => {
  test("a DNS failure is an infra hold, not a bench, and leaves error standing untouched", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.dnsFailure())
    const now = Date.now()
    const hint = SessionStep.failureHint(await failure(mock, target))
    expect(hint.infra).toBe(true)
    ModelRoute.failed(target, ModelRoute.policy(), now, hint)
    // Held out of candidacy, on the short infra cadence…
    expect(ModelRoute.coolingDown(target, now)).toBe(true)
    expect(ModelRoute.cooldownUntil(target, now) - now).toBe(30_000)
    // …but it is not a bench: no escalation state, no quota evidence, class infra.
    expect(ModelRoute.activeBenches(now).filter((bench) => bench.providerID === "prov")).toEqual([])
    const entries = availabilityOf("prov", now)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.class).toBe("infra")
    expect(entries[0]?.resume).toBe("path")
    // The hold lapses on its cadence, and the ladder resumes where it left off if the
    // path breaks again — while an unknown error afterwards still starts at the base
    // bench, proving the infra failure never touched the error ladder.
    expect(ModelRoute.cooldownUntil(target, now + 31_000)).toBeLessThanOrEqual(now + 31_000)
    ModelRoute.failed(target, ModelRoute.policy(), now + 31_000, hint)
    expect(ModelRoute.cooldownUntil(target, now + 31_000) - (now + 31_000)).toBe(60_000)
    ModelRoute.failed(target, ModelRoute.policy(), now + 31_000, {})
    expect(ModelRoute.cooldownUntil(target, now + 31_000) - (now + 31_000)).toBe(60_000)
  })

  test("a success on the target clears its infra hold", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.connectionRefused())
    const now = Date.now()
    ModelRoute.failed(target, ModelRoute.policy(), now, SessionStep.failureHint(await failure(mock, target)))
    expect(ModelRoute.coolingDown(target, now)).toBe(true)
    ModelRoute.completed(target, ModelRoute.policy(), { firstTokenMs: 25, responseMs: 90, tokensPerSecond: 60 }, now)
    expect(ModelRoute.coolingDown(target, now)).toBe(false)
    expect(availabilityOf("prov", now)).toEqual([])
  })
})

describe("seamlessness (the commandcode property, #1828)", () => {
  test("a permanently erroring member costs a session nothing after its first bench", async () => {
    const bad = ref("bad-prov", "bad-model")
    const good = ref("good-prov", "good-model")
    const route = definition("seamless-route", [bad, good], [
      { selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ])
    const mock = new MockProvider()
    mock.set(bad, MockScenarios.serverError())
    mock.set(good, MockScenarios.succeed("from-good"))
    for (let step = 0; step < 5; step++) {
      const result = await driveStep({ definition: route, mock, sessionID: `seamless-${step}` })
      expect(result.status).toBe("served")
      expect(result.servedTarget).toBe(good)
    }
    // One attempt ever reached the bad member: its first failure benched it, and every
    // later step skipped it silently and served on the sibling.
    expect(mock.attempts(MockProvider.key(bad))).toBe(1)
    expect(mock.attempts(MockProvider.key(good))).toBe(5)
  })

  test("a quota-walled member is not re-attempted while stopped and serves again after release", async () => {
    const walled = ref("wall-prov", "wall-model")
    const good = ref("good-prov", "good-model")
    const route = definition("wall-route", [walled, good], [
      { selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ])
    const mock = new MockProvider()
    mock.set(walled, MockScenarios.quotaExceeded())
    mock.set(good, MockScenarios.succeed("from-good"))
    const first = await driveStep({ definition: route, mock, sessionID: "wall-1" })
    expect(first.status).toBe("served")
    expect(mock.attempts(MockProvider.key(walled))).toBe(1)
    const second = await driveStep({ definition: route, mock, sessionID: "wall-2" })
    expect(second.status).toBe("served")
    expect(mock.attempts(MockProvider.key(walled))).toBe(1)
    // The quota feed shows an increase: the member is a candidate again, and once it
    // serves, it serves.
    ModelRoute.observeProviderQuota(
      walled,
      snapshot({ providerID: "wall-prov", percent: 40, observedAt: Date.now() }),
      Date.now(),
    )
    mock.set(walled, MockScenarios.succeed("wall-recovered"))
    const third = await driveStep({ definition: route, mock, sessionID: "wall-3" })
    expect(third.status).toBe("served")
    expect(third.servedTarget).toBe(walled)
  })
})
