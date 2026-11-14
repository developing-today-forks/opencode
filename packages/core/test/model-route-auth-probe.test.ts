import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"

// code#9950: a quota bench probes half-open at its window reset, but an auth bench
// historically just expired — returning a possibly-still-dead door to full candidacy
// at the expiry instant, so a wave of sessions could pile onto it before the first
// failure re-benched it. An expired auth bench now converts to probe-pending: the
// door stays out of ordinary candidacy until exactly one probe attempt settles it.
describe("ModelRoute auth bench probe (code#9950)", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
  const target = ModelRoute.ref({ providerID: "auth-probe-provider", model: "door" })
  const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

  afterEach(() => {
    ModelRoute.resetHealth()
    ModelRoute.resetSelection()
    ModelRoute.setAdjustments([])
  })

  const entriesFor = (now: number) =>
    ModelRoute.availability(now).filter((entry) => entry.providerID === "auth-probe-provider")

  test("an auth bench converts to a half-open probe at expiry; probe success reseats and clears the ladder", () => {
    const now = 1_000_000_000
    // First auth failure benches on the long (quota-length) ladder.
    ModelRoute.failed(target, policy, now, { auth: true })
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 900_000)
    expect(ModelRoute.probeDue(target, undefined, now)).toBe(false)
    // While the bench stands there is no probe: the reset-shaped admission belongs to
    // quota benches, and an auth bench's probe moment is its own expiry.
    expect(ModelRoute.coolingDown(target, now + 899_999)).toBe(true)
    expect(ModelRoute.probeDue(target, undefined, now + 899_999)).toBe(false)

    // At expiry the bench converts instead of lapsing: no cooldown remains, but the
    // door is not an ordinary candidate — a probe is due and availability says so.
    expect(ModelRoute.cooldownUntil(target, now + 900_000)).toBe(0)
    expect(ModelRoute.probeDue(target, undefined, now + 900_000)).toBe(true)
    // The bench lives at traffic (effort) scope now: availability names the
    // effort it holds, "default" for an attempt that served without one.
    expect(entriesFor(now + 900_000)).toEqual([
      {
        providerID: "auth-probe-provider",
        modelID: "door",
        variant: "default",
        class: "auth",
        reason: "auth bench expired; half-open probe pending",
        resume: "probe",
      },
    ])

    // Exactly one probe: the first claim wins and blocks every other candidacy.
    expect(ModelRoute.claimBenchProbe(target, undefined, now + 900_000)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, undefined, now + 900_000)).toBe(false)
    expect(ModelRoute.probeDue(target, undefined, now + 900_000)).toBe(false)
    expect(ModelRoute.probeInFlight(target, undefined, now + 900_000)).toBe(true)
    expect(entriesFor(now + 900_000)[0]?.reason).toBe("auth bench expired; half-open probe in flight")

    // Probe success reseats the door and clears the ladder: the next auth failure
    // benches at the base again instead of escalating.
    ModelRoute.completed(target, policy, sample, now + 900_001)
    expect(ModelRoute.probeDue(target, undefined, now + 900_001)).toBe(false)
    expect(ModelRoute.probeInFlight(target, undefined, now + 900_001)).toBe(false)
    expect(entriesFor(now + 900_001)).toEqual([])
    ModelRoute.failed(target, policy, now + 900_002, { auth: true })
    expect(ModelRoute.cooldownUntil(target, now + 900_002)).toBe(now + 900_002 + 900_000)
  })

  test("a failed auth probe re-benches on the escalated ladder; the door owes another probe at the new expiry (credential scope)", () => {
    const now = 1_100_000_000
    ModelRoute.failed(target, policy, now, { auth: true }, "cred-auth")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-auth", now)).toBe(now + 900_000)

    // The claim is spent straight from the raw expired form — no candidacy read has
    // converted the bench yet — and materializes the probe-pending state.
    expect(ModelRoute.claimBenchProbe(target, "cred-auth", now + 900_000)).toBe(true)
    expect(ModelRoute.probeInFlight(target, "cred-auth", now + 900_000)).toBe(true)
    expect(entriesFor(now + 900_000)).toEqual([
      {
        providerID: "auth-probe-provider",
        modelID: "door",
        credentialID: "cred-auth",
        variant: "default",
        class: "auth",
        reason: "auth bench expired; half-open probe in flight",
        resume: "probe",
      },
    ])

    // The probe fails auth again: second consecutive failure, so the bench doubles.
    ModelRoute.failed(target, policy, now + 900_001, { auth: true }, "cred-auth")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-auth", now + 900_001)).toBe(now + 900_001 + 1_800_000)
    expect(ModelRoute.probeInFlight(target, "cred-auth", now + 900_001)).toBe(false)
    expect(ModelRoute.probeDue(target, "cred-auth", now + 900_001)).toBe(false)
    // At the new expiry the door owes a fresh probe rather than returning outright.
    expect(ModelRoute.probeDue(target, "cred-auth", now + 900_001 + 1_800_000)).toBe(true)
    // The target scope and sibling credentials were never benched or probed.
    expect(ModelRoute.cooldownUntil(target, now + 900_001)).toBe(0)
    expect(ModelRoute.probeDue(target, "cred-other", now + 900_001 + 1_800_000)).toBe(false)
  })

  test("a released auth probe claim leaves the door probe-pending and the probe due again", () => {
    const now = 1_200_000_000
    ModelRoute.failed(target, policy, now, { auth: true })
    expect(ModelRoute.cooldownUntil(target, now + 900_000)).toBe(0)
    expect(ModelRoute.claimBenchProbe(target, undefined, now + 900_000)).toBe(true)
    // The owner resolved the target but never attempted it: the claim is handed back
    // and the probe is due again, exactly as for a quota bench (#1478).
    expect(ModelRoute.releaseBenchProbe(target, undefined, now + 900_000)).toBe(true)
    expect(ModelRoute.probeInFlight(target, undefined, now + 900_000)).toBe(false)
    expect(ModelRoute.probeDue(target, undefined, now + 900_000)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, undefined, now + 900_001)).toBe(true)
  })

  test("an ordinary failure never becomes probe-pending: its bench lapses outright", () => {
    const now = 1_300_000_000
    const ordinary = ModelRoute.ref({ providerID: "auth-probe-provider", model: "ordinary" })
    ModelRoute.failed(ordinary, policy, now)
    expect(ModelRoute.cooldownUntil(ordinary, now)).toBe(now + 60_000)
    expect(ModelRoute.cooldownUntil(ordinary, now + 60_000)).toBe(0)
    expect(ModelRoute.probeDue(ordinary, undefined, now + 60_000)).toBe(false)
    expect(ModelRoute.claimBenchProbe(ordinary, undefined, now + 60_000)).toBe(false)
    expect(entriesFor(now + 60_000)).toEqual([])
  })

  test("a success landing outside a claim (a session already on the door) also reseats a probe-pending bench", () => {
    const now = 1_400_000_000
    ModelRoute.failed(target, policy, now, { auth: true })
    expect(ModelRoute.cooldownUntil(target, now + 900_000)).toBe(0)
    expect(ModelRoute.probeDue(target, undefined, now + 900_000)).toBe(true)
    // No claim was spent; the success itself is the door's answer.
    ModelRoute.completed(target, policy, sample, now + 900_005)
    expect(ModelRoute.probeDue(target, undefined, now + 900_005)).toBe(false)
    expect(entriesFor(now + 900_005)).toEqual([])
  })
})
