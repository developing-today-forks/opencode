import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import type { QuotaSnapshot } from "@opencode/core/quota-snapshot"

const target = ModelRoute.ref({ providerID: "opencode-go", model: "gpt-6-luna" })
const policy = ModelRoute.policy({ cooldownMs: 1_000, quotaCooldownMs: 15_000 })
const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

const snap = (overrides: Partial<QuotaSnapshot.Snapshot> = {}): QuotaSnapshot.Snapshot => ({
  planID: "opencode-go-lab",
  window: "monthly",
  providerID: "opencode-go",
  percent: 100,
  remaining: 0,
  resetAt: 100_000,
  observedAt: 10_000,
  stale: false,
  ...overrides,
})

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRouteLog.setSink(undefined)
})

describe("ModelRoute credential health (#6)", () => {
  test("a failure benches only the credential that served the attempt", () => {
    ModelRoute.failed(target, policy, 10_000, { quota: true }, "cred-lab")

    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 10_000)).toBe(25_000)
    expect(ModelRoute.credentialCoolingDown(target, "cred-lab", 24_999)).toBe(true)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-personal", 10_000)).toBe(0)
    // The target itself is not benched: the other credential behind the provider stays routable.
    expect(ModelRoute.cooldownUntil(target, 10_000)).toBe(0)
    expect(ModelRoute.coolingDown(target, 10_000)).toBe(false)
  })

  test("credential benches escalate per consecutive failure and reset on success", () => {
    ModelRoute.failed(target, policy, 0, undefined, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 0)).toBe(1_000)
    ModelRoute.failed(target, policy, 2_000, undefined, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 2_000)).toBe(4_000)

    // A success after the bench expired clears it and resets the escalation count, exactly
    // like recover() on a target: an active bench is never lifted early.
    ModelRoute.completed(target, policy, fast, 4_000, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 4_000)).toBe(0)
    ModelRoute.failed(target, policy, 5_000, undefined, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 5_000)).toBe(6_000)
  })

  test("quota demotion counts per credential", () => {
    for (const at of [0, 1_000, 2_000]) ModelRoute.failed(target, policy, at, { quota: true }, "cred-lab")

    expect(ModelRoute.demoted(target, 2_000, "cred-lab")).toBe(true)
    expect(ModelRoute.demoted(target, 2_000, "cred-personal")).toBe(false)
    expect(ModelRoute.demoted(target, 2_000)).toBe(false)
  })
})

describe("ModelRoute credential threading (#870)", () => {
  test("credential failure history feeds escalation, not the target's", () => {
    ModelRoute.failed(target, policy, 10_000, undefined, "cred-lab")
    ModelRoute.failed(target, policy, 11_000, undefined, "cred-lab")

    // The serving credential has given up twice: it is no longer steady and the route escalates.
    expect(ModelRoute.giveUps(target, "cred-lab")).toBe(2)
    expect(ModelRoute.steady(target, "cred-lab")).toBe(false)
    expect(ModelRoute.escalates(target, "cred-lab")).toBe(true)
    // The target itself recorded nothing (#6 isolation), and the other credential is unaffected.
    expect(ModelRoute.giveUps(target)).toBe(0)
    expect(ModelRoute.steady(target)).toBe(true)
    expect(ModelRoute.steady(target, "cred-personal")).toBe(true)
    expect(ModelRoute.escalates(target, "cred-personal")).toBe(false)
  })

  test("credential-qualified quota demotion applies in ranking and stickiness", () => {
    const now = Date.now()
    for (const at of [now, now + 1_000, now + 2_000])
      ModelRoute.failed(target, policy, at, { quota: true }, "cred-lab")
    // Successes restore steadiness without erasing the quota history, isolating demotion.
    for (const at of [now + 3_000, now + 4_000, now + 5_000, now + 6_000, now + 7_000])
      ModelRoute.completed(target, policy, fast, at, "cred-lab")
    const at = now + 8_000

    expect(ModelRoute.demoted(target, at, "cred-lab")).toBe(true)
    expect(ModelRoute.weightOf(target, 2, at, { credentialID: "cred-lab" })).toBeCloseTo(0.02)
    expect(ModelRoute.weightOf(target, 2, at, { credentialID: "cred-personal" })).toBe(2)
    expect(ModelRoute.weightOf(target, 2, at)).toBe(2)

    ModelRoute.served("threading", "s1", target)
    expect(ModelRoute.keepsThrough("threading", "s1", target, at, "cred-lab")).toBe(false)
    expect(ModelRoute.keepsThrough("threading", "s1", target, at, "cred-personal")).toBe(true)
    expect(ModelRoute.keepsThrough("threading", "s1", target, at)).toBe(true)
  })

  test("credential demotion steers nextTarget selection to the healthy credential's target", () => {
    const now = Date.now()
    const a = ModelRoute.ref({ providerID: "thread-a", model: "m" })
    const b = ModelRoute.ref({ providerID: "thread-b", model: "m" })
    for (const at of [now, now + 1_000, now + 2_000]) ModelRoute.failed(a, policy, at, { quota: true }, "cred-lab")
    const definition = {
      id: "threading-route",
      targets: [a, b],
      targetVariants: [{}, {}],
      health: policy,
      nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    } as unknown as ModelRoute.Definition
    const ready = new Set([0, 1])
    const credentialOf = (index: number) => (index === 0 ? "cred-lab" : "cred-personal")

    // Equal weights, ordered mode: ranking puts the demoted credential's target last.
    expect(ModelRoute.nextTarget(definition, ready, new Set(), undefined, false, undefined, undefined, Math.random, credentialOf)).toBe(1)
    // The same targets rank normally when the serving credential is the healthy one.
    expect(
      ModelRoute.nextTarget(definition, ready, new Set(), undefined, false, undefined, undefined, Math.random, () => "cred-personal"),
    ).toBe(0)
  })

  test("rate-limit holds are per credential and clear per credential", () => {
    const spent = { at: 10_000, remaining: { requests: "0" }, reset: { requests: "45s" } }
    ModelRoute.observeRateLimit(target, spent, 10_000, "cred-lab")

    expect(ModelRoute.limitedUntil(target, 10_000, "cred-lab")).toBe(55_000)
    expect(ModelRoute.limitedUntil(target, 10_000, "cred-personal")).toBe(0)
    expect(ModelRoute.limitedUntil(target, 10_000)).toBe(0)
    expect(ModelRoute.rateLimitOf(target, "cred-lab")?.remaining).toEqual({ requests: "0" })
    expect(ModelRoute.rateLimitOf(target, "cred-personal")).toBeUndefined()

    // The per-target aggregate read (route_stats) still sees the credential's hold.
    expect(ModelRoute.limitedUntilAny(target, 10_000)).toBe(55_000)
    expect(ModelRoute.rateLimitOfAny(target)?.remaining).toEqual({ requests: "0" })

    // A success on the other credential clears only its own (absent) hold.
    ModelRoute.clearRateLimit(target, "cred-personal")
    expect(ModelRoute.limitedUntil(target, 10_000, "cred-lab")).toBe(55_000)
    ModelRoute.clearRateLimit(target, "cred-lab")
    expect(ModelRoute.limitedUntil(target, 10_000, "cred-lab")).toBe(0)
    expect(ModelRoute.limitedUntilAny(target, 10_000)).toBe(0)
  })
})

describe("ModelRoute credential quota gate (#6)", () => {
  test("a known-full credential is blocked until its reset, then re-admitted with a health record", () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))

    ModelRoute.observeCredentialQuota(target, "cred-lab", snap(), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 100_000 })
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 99_999)).toEqual({ until: 100_000 })
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 100_000)).toBeUndefined()
    expect(ModelRoute.credentialQuotaBlocked("cred-personal", 10_000)).toBeUndefined()

    const kinds = events.flatMap((event) => (event.kind === "health" ? [event.row.kind] : []))
    expect(kinds).toContain("quota-gated")
    expect(kinds).toContain("quota-readmitted")
  })

  test("a fresher good read re-admits before the reset", () => {
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap(), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })

    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 20_000 }),
      20_000,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toBeUndefined()
  })

  test("an older good read does not re-admit a credential gated by a newer full read", () => {
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ observedAt: 20_000 }), 20_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })

    // The below-limit reading was taken before the known-full one; delivered late, it is
    // still fresh (not stale) but must not rewind the gate.
    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 10_000 }),
      20_000,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })

    // A genuinely newer good read still re-admits.
    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 30_000 }),
      30_000,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 30_000)).toBeUndefined()
  })

  test("unknown and stale readings never block, and never clear a known gate", () => {
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ percent: null, remaining: null }), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toBeUndefined()
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ stale: true }), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toBeUndefined()

    ModelRoute.observeCredentialQuota(target, "cred-lab", snap(), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 100_000 })
    // Losing the signal is not a good read: the gate holds until the reset or a fresh snapshot.
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ stale: true, observedAt: 20_000 }), 20_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })
  })
})

describe("ModelRoute quota-failure gate (#984)", () => {
  test("a credentialed exhaustion gates only that credential until the stated reset", () => {
    ModelRoute.observeQuotaFailure(target, "cred-lab", 100_000, 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 100_000 })
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 99_999)).toEqual({ until: 100_000 })
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 100_000)).toBeUndefined()
    expect(ModelRoute.credentialQuotaBlocked("cred-personal", 10_000)).toBeUndefined()
  })

  test("no stated reset holds for the bounded fallback, and an absurd one is capped", () => {
    ModelRoute.observeQuotaFailure(target, "cred-lab", undefined, 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 10_000 + 30 * 60_000 })

    ModelRoute.resetHealth()
    ModelRoute.observeQuotaFailure(target, "cred-lab", 10_000 + 90 * 86_400_000, 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 10_000 + 30 * 86_400_000 })
  })

  test("a credential-less exhaustion skips the provider until the reset, then lapses", () => {
    const plain = ModelRoute.ref({ providerID: "cline-pass", model: "claude-sonnet-5" })
    ModelRoute.observeQuotaFailure(plain, undefined, 100_000, 10_000)
    const active = ModelRoute.activeAdjustments(10_000)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id: "quota:cline-pass", match: "cline-pass/", action: "skip", until: 100_000 })
    expect(ModelRoute.activeAdjustments(100_000)).toHaveLength(0)
  })
})

describe("ModelRoute proactive provider quota gate (#984)", () => {
  const plain = ModelRoute.ref({ providerID: "cline-pass", model: "claude-sonnet-5" })

  test("known-full arms the skip and skipped() honours it", () => {
    ModelRoute.resetHealth()
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))

    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 10_000, resetAt: 100_000 }), 10_000)
    expect(ModelRoute.skipped(plain, 10_000)).toBe(true)
    expect(ModelRoute.skipped(plain, 99_999)).toBe(true)
    expect(ModelRoute.skipped(plain, 100_000)).toBe(false)

    const kinds = events.flatMap((event) => (event.kind === "health" ? [event.row.kind] : []))
    expect(kinds).toContain("quota-gated")
  })

  test("a passed reset re-admits and a fresher good read clears the skip", () => {
    ModelRoute.resetHealth()
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))

    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 10_000, resetAt: 100_000 }), 10_000)
    expect(ModelRoute.skipped(plain, 20_000)).toBe(true)

    // Fresher below-100% snapshot re-admits immediately
    ModelRoute.observeProviderQuota(
      plain,
      snap({ percent: 40, remaining: 60, observedAt: 20_000, resetAt: 100_000 }),
      20_000,
    )
    expect(ModelRoute.skipped(plain, 20_000)).toBe(false)
    const kinds = events.flatMap((event) => (event.kind === "health" ? [event.row.kind] : []))
    expect(kinds).toContain("quota-readmitted")

    // Out-of-order older reading does not rewind
    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 30_000, resetAt: 100_000 }), 30_000)
    expect(ModelRoute.skipped(plain, 30_000)).toBe(true)
    ModelRoute.observeProviderQuota(
      plain,
      snap({ percent: 40, remaining: 60, observedAt: 25_000, resetAt: 100_000 }),
      30_000,
    )
    expect(ModelRoute.skipped(plain, 30_000)).toBe(true)
  })

  test("an unknown or stale snapshot never arms, and never clears a known gate", () => {
    ModelRoute.resetHealth()
    ModelRoute.observeProviderQuota(plain, snap({ percent: null, remaining: null, observedAt: 10_000 }), 10_000)
    expect(ModelRoute.skipped(plain, 10_000)).toBe(false)

    ModelRoute.observeProviderQuota(plain, snap({ stale: true, observedAt: 10_000 }), 10_000)
    expect(ModelRoute.skipped(plain, 10_000)).toBe(false)

    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 10_000, resetAt: 100_000 }), 10_000)
    expect(ModelRoute.skipped(plain, 10_000)).toBe(true)

    // Stale snapshot never clears the gate
    ModelRoute.observeProviderQuota(plain, snap({ stale: true, observedAt: 20_000 }), 20_000)
    expect(ModelRoute.skipped(plain, 20_000)).toBe(true)
  })

  test("reset capping matches observeQuotaFailure: fallback for null reset and capped at 30 days", () => {
    ModelRoute.resetHealth()
    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 10_000, resetAt: null }), 10_000)
    const activeFallback = ModelRoute.activeAdjustments(10_000)
    expect(activeFallback[0]?.until).toBe(10_000 + 30 * 60_000)

    ModelRoute.resetHealth()
    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 10_000, resetAt: 10_000 + 90 * 86_400_000 }), 10_000)
    const activeCapped = ModelRoute.activeAdjustments(10_000)
    expect(activeCapped[0]?.until).toBe(10_000 + 30 * 86_400_000)
  })
})

describe("ModelRoute health credential column (#1055)", () => {
  const healthRows = (events: ModelRouteLog.Event[]) =>
    events.flatMap((event) => (event.kind === "health" ? [event.row] : []))

  test("credential-scoped rows carry the credential column", () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))

    ModelRoute.failed(target, policy, 10_000, { quota: true }, "cred-lab")
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ observedAt: 10_000, resetAt: 100_000 }), 10_000)
    const spent = { at: 10_000, remaining: { requests: "0" }, reset: { requests: "45s" } }
    ModelRoute.observeRateLimit(target, spent, 10_000, "cred-lab")
    ModelRoute.clearRateLimit(target, "cred-lab", 10_000)

    const rows = healthRows(events)
    // bench cooldown-start, quota-gated, rate-limit-window, rate-limit release.
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.credential_id).toBe("cred-lab")
    expect(rows.map((row) => row.kind).sort()).toEqual(
      ["cooldown-start", "quota-gated", "rate-limit-window", "rate-limit-window"].sort(),
    )
  })

  test("credential gate expiry and re-admission carry the credential column", () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))

    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ observedAt: 10_000, resetAt: 100_000 }), 10_000)
    // A fresher good read re-admits before the reset.
    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 20_000 }),
      20_000,
    )

    const rows = healthRows(events)
    expect(rows.map((row) => row.kind)).toEqual(["quota-gated", "quota-readmitted"])
    for (const row of rows) expect(row.credential_id).toBe("cred-lab")
  })

  test("target-scoped and provider-quota rows leave the credential column empty", () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))
    const plain = ModelRoute.ref({ providerID: "no-cred-pass", model: "claude-sonnet-5" })

    ModelRoute.failed(target, policy, 10_000, { quota: true })
    ModelRoute.observeProviderQuota(plain, snap({ observedAt: 10_000, resetAt: 100_000 }), 10_000)
    // Passing the reset re-admits the provider.
    ModelRoute.observeProviderQuota(
      plain,
      snap({ percent: 40, remaining: 60, observedAt: 20_000, resetAt: 100_000 }),
      20_000,
    )

    const rows = healthRows(events)
    expect(rows.map((row) => row.kind)).toEqual(["cooldown-start", "quota-gated", "quota-readmitted"])
    for (const row of rows) expect(row.credential_id).toBeUndefined()
    // The provider-quota rows name the provider in the reason: a distinct dimension that
    // must never be read back as a credential.
    expect(rows[1]?.reason).toContain("provider:no-cred-pass")
  })
})
