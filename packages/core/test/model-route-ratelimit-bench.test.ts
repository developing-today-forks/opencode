import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"

// Drew, 2026-11-14, amending the #9950 bench design on the day all three OpenCode
// Go doors throttled beam-free for hours while fresh sessions kept being dealt
// into them (~50 attempts/15min/door, zero successes):
//
// - Traffic benches (rate-limit / auth / transport) key on door × model × EFFORT
//   (+ credential where one served), not door × model: the fleet's own evidence
//   is Luna #xhigh racking five figures of auth failures on openai.main while
//   Luna #high on the same door served 99.9% — one effort's failures must not
//   bench its siblings. Quota benches deliberately stay at pool scope (door ×
//   pool-family): quota is drawn per pool, traffic fails per leg. Two signals,
//   two scopes.
// - A bench whose stated retry-after is window-length (at or past the long
//   ladder's base) classifies the leg dead for last-resort purposes, exactly
//   like a quota bench: dealing a fresh session into a door that named a
//   nine-hour wait just burns the attempt and re-plants the bench. Short
//   benches stay last-resort dealable, as before.
// - A long retry-after bench converts to the same single-flight half-open
//   probe at expiry the quota/auth paths already had, so a reset does not
//   re-deal every waiting session at once.
// - Headerless 429s ride the ordinary short ladder for the first failures,
//   then a sustained run (no success between) classifies up to the long
//   ladder — scattered transients never do.
describe("ModelRoute rate-limit benches: effort scope, long-bench classification, probe reseat", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
  const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

  afterEach(() => {
    ModelRoute.resetHealth()
    ModelRoute.resetSelection()
    ModelRoute.setAdjustments([])
  })

  test("an auth failure benches only the effort that errored; the sibling effort keeps dealing (Luna shape)", () => {
    const now = 2_000_000_000
    const luna = ModelRoute.ref({ providerID: "openai-main", model: "luna" })
    ModelRoute.failed(luna, policy, now, { auth: true }, undefined, undefined, undefined, "xhigh")
    expect(ModelRoute.cooldownUntil(luna, now, undefined, "xhigh")).toBe(now + 900_000)
    expect(ModelRoute.cooldownUntil(luna, now, undefined, "high")).toBe(0)
    expect(ModelRoute.coolingDown(luna, now, undefined, "high")).toBe(false)
    // The benched effort owes a probe at its expiry; the sibling owes nothing.
    expect(ModelRoute.probeDue(luna, undefined, now + 900_000, "xhigh")).toBe(true)
    expect(ModelRoute.probeDue(luna, undefined, now + 900_000, "high")).toBe(false)
  })

  test("a rate-limit bench on one model never touches a sibling model on the same door", () => {
    const now = 2_100_000_000
    const beam = ModelRoute.ref({ providerID: "go-door", model: "beam-free" })
    const other = ModelRoute.ref({ providerID: "go-door", model: "iceman-free" })
    ModelRoute.failed(beam, policy, now, { rateLimit: true, retryAfterMs: 32_000_000 })
    expect(ModelRoute.longTrafficBenched(beam, undefined, now)).toBe(true)
    // The same door kept serving other models all through the incident; a
    // single model's throttle is not evidence about them (no scope widening
    // without corroboration).
    expect(ModelRoute.coolingDown(other, now)).toBe(false)
    expect(ModelRoute.lastResortDead(other, undefined, now)).toBe(false)
  })

  test("a window-length stated retry-after classifies the leg dead for last-resort; a short one does not", () => {
    const now = 2_200_000_000
    const long = ModelRoute.ref({ providerID: "go-door", model: "beam-free" })
    const short = ModelRoute.ref({ providerID: "go-door-2", model: "beam-free" })
    // The incident's shape: the provider states a wait to midnight UTC.
    ModelRoute.failed(long, policy, now, { rateLimit: true, retryAfterMs: 32_347_000 })
    expect(ModelRoute.cooldownUntil(long, now)).toBe(now + 32_347_000)
    expect(ModelRoute.longTrafficBenched(long, undefined, now)).toBe(true)
    expect(ModelRoute.lastResortDead(long, undefined, now)).toBe(true)
    // A short stated wait is ordinary cooling: last-resort dealing stays fine.
    ModelRoute.failed(short, policy, now, { rateLimit: true, retryAfterMs: 30_000 })
    expect(ModelRoute.cooldownUntil(short, now)).toBe(now + 30_000)
    expect(ModelRoute.longTrafficBenched(short, undefined, now)).toBe(false)
    expect(ModelRoute.lastResortDead(short, undefined, now)).toBe(false)
  })

  test("a long retry-after bench converts to a single-flight probe at expiry; failure re-benches, success reseats", () => {
    const now = 3_000_000_000
    const go = ModelRoute.ref({ providerID: "go-door", model: "beam-free" })
    ModelRoute.failed(go, policy, now, { rateLimit: true, retryAfterMs: 32_347_000 })
    const expiry = now + 32_347_000
    // No probe while the bench stands, and none a moment early.
    expect(ModelRoute.probeDue(go, undefined, expiry - 1)).toBe(false)
    // At expiry the bench converts instead of lapsing open: exactly one probe.
    expect(ModelRoute.cooldownUntil(go, expiry)).toBe(0)
    expect(ModelRoute.probeDue(go, undefined, expiry)).toBe(true)
    expect(ModelRoute.claimBenchProbe(go, undefined, expiry)).toBe(true)
    expect(ModelRoute.claimBenchProbe(go, undefined, expiry)).toBe(false)
    expect(ModelRoute.probeInFlight(go, undefined, expiry)).toBe(true)
    // The probe meets a fresh window-length 429: the bench re-plants and no
    // probe is due again until the new expiry.
    ModelRoute.failed(go, policy, expiry + 1, { rateLimit: true, retryAfterMs: 32_347_000 })
    expect(ModelRoute.probeInFlight(go, undefined, expiry + 1)).toBe(false)
    expect(ModelRoute.probeDue(go, undefined, expiry + 1)).toBe(false)
    expect(ModelRoute.cooldownUntil(go, expiry + 1)).toBe(expiry + 1 + 32_347_000)
    expect(ModelRoute.lastResortDead(go, undefined, expiry + 1)).toBe(true)
    // The second expiry probes again; a success reseats the door outright.
    const expiry2 = expiry + 1 + 32_347_000
    expect(ModelRoute.probeDue(go, undefined, expiry2)).toBe(true)
    expect(ModelRoute.claimBenchProbe(go, undefined, expiry2)).toBe(true)
    ModelRoute.completed(go, policy, sample, expiry2 + 1)
    expect(ModelRoute.probeDue(go, undefined, expiry2 + 1)).toBe(false)
    expect(ModelRoute.probeInFlight(go, undefined, expiry2 + 1)).toBe(false)
    expect(ModelRoute.cooldownUntil(go, expiry2 + 1)).toBe(0)
    expect(ModelRoute.lastResortDead(go, undefined, expiry2 + 1)).toBe(false)
  })

  test("headerless 429s ride the short ladder twice, then a sustained run classifies up; a probe success resets the run", () => {
    const now = 4_000_000_000
    const door = ModelRoute.ref({ providerID: "go-door-3", model: "beam-free" })
    ModelRoute.failed(door, policy, now, { rateLimit: true })
    expect(ModelRoute.cooldownUntil(door, now)).toBe(now + 60_000)
    expect(ModelRoute.lastResortDead(door, undefined, now)).toBe(false)
    ModelRoute.failed(door, policy, now + 61_000, { rateLimit: true })
    expect(ModelRoute.cooldownUntil(door, now + 61_000)).toBe(now + 61_000 + 120_000)
    expect(ModelRoute.lastResortDead(door, undefined, now + 61_000)).toBe(false)
    // Third consecutive 429 with no success between: the bench leaves the
    // ordinary 120s cap behind for the long ladder off the quota base.
    ModelRoute.failed(door, policy, now + 182_000, { rateLimit: true })
    expect(ModelRoute.cooldownUntil(door, now + 182_000)).toBe(now + 182_000 + 900_000)
    expect(ModelRoute.lastResortDead(door, undefined, now + 182_000)).toBe(true)
    // The long bench probes at expiry like any other; the probe's success ends
    // the run, so the next 429 is back on the short ladder.
    const expiry = now + 182_000 + 900_000
    expect(ModelRoute.probeDue(door, undefined, expiry)).toBe(true)
    expect(ModelRoute.claimBenchProbe(door, undefined, expiry)).toBe(true)
    ModelRoute.completed(door, policy, sample, expiry + 1)
    ModelRoute.failed(door, policy, expiry + 2, { rateLimit: true })
    expect(ModelRoute.cooldownUntil(door, expiry + 2)).toBe(expiry + 2 + 60_000)
    expect(ModelRoute.lastResortDead(door, undefined, expiry + 2)).toBe(false)
  })

  test("scattered headerless 429s with successes between never classify up", () => {
    const now = 4_500_000_000
    const door = ModelRoute.ref({ providerID: "go-door-4", model: "beam-free" })
    let at = now
    for (let round = 0; round < 3; round++) {
      ModelRoute.failed(door, policy, at, { rateLimit: true })
      expect(ModelRoute.cooldownUntil(door, at)).toBe(at + 60_000)
      expect(ModelRoute.lastResortDead(door, undefined, at)).toBe(false)
      at += 61_000
      ModelRoute.completed(door, policy, sample, at)
      at += 1_000
    }
  })

  test("a quota failure benches the pool scope only: no effort bench, no sibling-family touch", () => {
    const now = 5_000_000_000
    const fable = ModelRoute.ref({ providerID: "claude-door", model: "fable" })
    const sonnet = ModelRoute.ref({ providerID: "claude-door", model: "sonnet" })
    ModelRoute.failed(fable, policy, now, { quota: true })
    expect(ModelRoute.cooldownUntil(fable, now)).toBeGreaterThan(now)
    expect(ModelRoute.lastResortDead(fable, undefined, now)).toBe(true)
    // The quota signal planted nothing at traffic (effort) scope: availability
    // shows the pool-scope bench with no variant attached.
    const entries = ModelRoute.availability(now).filter((entry) => entry.providerID === "claude-door")
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.variant === undefined)).toBe(true)
    // The sibling family behind the same door is untouched: split pools are
    // separate pools.
    expect(ModelRoute.cooldownUntil(sonnet, now)).toBe(0)
    expect(ModelRoute.lastResortDead(sonnet, undefined, now)).toBe(false)
  })

  test("seeded cooldown rows restore traffic benches onto their own effort, long span intact", () => {
    const now = 6_000_000_000
    ModelRoute.seedCooldowns(
      [
        {
          providerID: "go-door",
          modelID: "beam-free",
          until: now + 32_000_000,
          reason: "retry-after variant:high",
          variant: "high",
          plantedAt: now,
        },
        { providerID: "other-door", modelID: "mistral", until: now + 45_000, reason: "failure", plantedAt: now },
      ],
      [],
      now,
    )
    // The traffic row lands on its leg only, still classified long from its span.
    expect(ModelRoute.cooldownUntil(ModelRoute.ref({ providerID: "go-door", model: "beam-free" }), now, undefined, "high")).toBe(
      now + 32_000_000,
    )
    expect(
      ModelRoute.cooldownUntil(ModelRoute.ref({ providerID: "go-door", model: "beam-free" }), now, undefined, "low"),
    ).toBe(0)
    expect(
      ModelRoute.longTrafficBenched(ModelRoute.ref({ providerID: "go-door", model: "beam-free" }), undefined, now, undefined, "high"),
    ).toBe(true)
    // …and it will probe at expiry after the restart, not lapse open.
    expect(
      ModelRoute.probeDue(ModelRoute.ref({ providerID: "go-door", model: "beam-free" }), undefined, now + 32_000_000, "high"),
    ).toBe(true)
    // The legacy pool-scope row restores as before.
    expect(ModelRoute.cooldownUntil(ModelRoute.ref({ providerID: "other-door", model: "mistral" }), now)).toBe(now + 45_000)
  })
})
