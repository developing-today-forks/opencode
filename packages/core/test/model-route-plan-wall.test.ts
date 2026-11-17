import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"

/**
 * Plan-wall benches (code#10128, Drew 2026-11-16): a provider answer that states a
 * permanent plan/tier refusal — a tier that has ended, a model outside the plan —
 * benches the leaf as a wall. Measured before this class existed: the _commandcode
 * door's tier-ended and not-in-plan 403s classified as plain auth, whose per-effort
 * benches never counted as dead to last-resort dealing, so a route whose only
 * candidate was the walled door dealt it again on every turn (~1,500 attempts in
 * a day at 0% success, re-planting the bench each time). A plan wall benches at
 * pool scope, is dead to last-resort dealing from its first plant, and reopens
 * only through its own half-open probe at expiry — a served probe is the plan
 * having changed. Plain auth refusals and transient failures keep their terms.
 */

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.resetSelection()
  ModelRoute.setAdjustments([])
})

const target = ModelRoute.ref({ providerID: "commandcode-planwall", model: "walled-model" })
const sibling = ModelRoute.ref({ providerID: "commandcode-planwall", model: "other-model" })
const policy = ModelRoute.policy()
const wall = { planWall: true, auth: true }

describe("plan-wall benches (code#10128)", () => {
  test("a plan/tier refusal benches the leaf at pool scope, dead to last-resort dealing from the first plant", () => {
    const now = 1_000_000
    ModelRoute.failed(target, policy, now, wall)
    // Pool scope: the bench covers every effort of the leaf, not just the one that answered.
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 900_000)
    expect(ModelRoute.cooldownUntil(target, now, undefined, "xhigh")).toBe(now + 900_000)
    // The sibling model on the same door is untouched: the wall names this model.
    expect(ModelRoute.cooldownUntil(sibling, now)).toBe(0)
    // Dead immediately — no escalation is owed first: the refusal is permanent
    // on the current plan, so a last-resort attempt dealt into it can only fail.
    expect(ModelRoute.lastResortDead(target, undefined, now)).toBe(true)
    expect(ModelRoute.longTrafficBenched(target, undefined, now)).toBe(true)
    const bench = ModelRoute.activeBenches(now).find((item) => item.providerID === target.providerID)
    expect(bench?.reason).toBe("plan-wall")
    expect(bench?.variant).toBeUndefined()
  })

  test("a plain auth refusal keeps its existing terms: benched per effort, never dead to last resort", () => {
    const now = 2_000_000
    ModelRoute.failed(target, policy, now, { auth: true })
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 900_000)
    expect(ModelRoute.cooldownUntil(target, now, undefined, "xhigh")).toBe(0)
    expect(ModelRoute.lastResortDead(target, undefined, now)).toBe(false)
  })

  test("a transient failure is not walled: short traffic bench, never dead", () => {
    const now = 3_000_000
    ModelRoute.failed(target, policy, now, {})
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + policy.cooldownMs)
    expect(ModelRoute.lastResortDead(target, undefined, now)).toBe(false)
    expect(ModelRoute.activeBenches(now).find((item) => item.providerID === target.providerID)?.reason).toBe(
      "failure",
    )
  })

  test("the wall converts to a single-flight probe at expiry; a served probe reseats the leaf", () => {
    const now = 4_000_000
    const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }
    ModelRoute.failed(target, policy, now, wall)
    const expiry = now + 900_000
    expect(ModelRoute.probeDue(target, undefined, expiry)).toBe(true)
    // Exactly one probe: the first claim wins and blocks every other candidacy.
    expect(ModelRoute.claimBenchProbe(target, undefined, expiry)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, undefined, expiry)).toBe(false)
    expect(ModelRoute.probeInFlight(target, undefined, expiry)).toBe(true)
    // The probe is refused again: second consecutive failure, so the wall
    // re-benches on the doubled ladder, still dead to last-resort dealing.
    ModelRoute.failed(target, policy, expiry + 1, wall)
    expect(ModelRoute.cooldownUntil(target, expiry + 1)).toBe(expiry + 1 + 1_800_000)
    expect(ModelRoute.probeInFlight(target, undefined, expiry + 1)).toBe(false)
    expect(ModelRoute.lastResortDead(target, undefined, expiry + 1)).toBe(true)
    // The plan changes; the next probe serves, and the leaf is a candidate again.
    const expiry2 = expiry + 1 + 1_800_000
    expect(ModelRoute.probeDue(target, undefined, expiry2)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, undefined, expiry2)).toBe(true)
    ModelRoute.completed(target, policy, sample, expiry2)
    expect(ModelRoute.cooldownUntil(target, expiry2)).toBe(0)
    expect(ModelRoute.probeDue(target, undefined, expiry2)).toBe(false)
    expect(ModelRoute.lastResortDead(target, undefined, expiry2)).toBe(false)
  })

  test("a plan wall under a credential benches that credential's pool scope only", () => {
    const now = 5_000_000
    ModelRoute.failed(target, policy, now, wall, "cred-walled")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-walled", now)).toBe(now + 900_000)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-other", now)).toBe(0)
    expect(ModelRoute.cooldownUntil(target, now)).toBe(0)
    expect(ModelRoute.lastResortDead(target, "cred-walled", now)).toBe(true)
    expect(ModelRoute.lastResortDead(target, "cred-other", now)).toBe(false)
  })

  test("a quota refusal keeps its existing behavior: pool scope, quota class, dead to last resort", () => {
    const now = 6_000_000
    ModelRoute.failed(target, policy, now, { quota: true })
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 900_000)
    expect(ModelRoute.activeBenches(now).find((item) => item.providerID === target.providerID)?.reason).toBe("quota")
    expect(ModelRoute.lastResortDead(target, undefined, now)).toBe(true)
  })

  test("availability reports the wall as the quota class, and its expiry as a pending probe", () => {
    const now = 7_000_000
    ModelRoute.failed(target, policy, now, wall)
    const standing = ModelRoute.availability(now).filter((entry) => entry.providerID === target.providerID)
    expect(standing).toHaveLength(1)
    expect(standing[0]?.class).toBe("quota")
    expect(standing[0]?.reason).toBe("plan-wall")
    expect(standing[0]?.resume).toBe("timer")
    const expired = ModelRoute.availability(now + 900_000).filter((entry) => entry.providerID === target.providerID)
    expect(expired).toHaveLength(1)
    expect(expired[0]?.class).toBe("quota")
    expect(expired[0]?.reason).toBe("plan-wall bench expired; half-open probe pending")
    expect(expired[0]?.resume).toBe("probe")
  })
})
