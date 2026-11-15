import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"
import { QuotaSnapshot } from "@opencode/core/quota-snapshot"

const target = ModelRoute.ref({ providerID: "root-start-provider", model: "gpt-6-luna" })
const now = 500_000_000
const resetAt = now + 3_600_000

const snap = (overrides: Partial<QuotaSnapshot.Snapshot> = {}): QuotaSnapshot.Snapshot => ({
  planID: "root-start-plan",
  window: "five-hours",
  providerID: "root-start-provider",
  percent: 90,
  remaining: 10,
  resetAt,
  observedAt: now,
  stale: false,
  ...overrides,
})

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.onSettingsConfig(() => undefined)
  ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS)
})

describe("ModelRoute root-start gate (#566 slice 2)", () => {
  test("session kind is the parentID distinction", () => {
    expect(ModelRoute.sessionKind(undefined)).toBe("root")
    expect(ModelRoute.sessionKind(null)).toBe("root")
    expect(ModelRoute.sessionKind("")).toBe("root")
    expect(ModelRoute.sessionKind("ses_parent")).toBe("subsession")
  })

  test("a provider snapshot above the threshold blocks a root start until its reset", () => {
    ModelRoute.observeProviderQuota(target, snap(), now)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toEqual({ until: resetAt })
    expect(ModelRoute.rootStartBlocked(target, undefined, now)).toEqual({ until: resetAt })
  })

  test("below the threshold a root start is admitted; at the threshold it is blocked", () => {
    ModelRoute.observeProviderQuota(target, snap({ percent: 84 }), now)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
    ModelRoute.observeProviderQuota(target, snap({ percent: 85, observedAt: now + 1 }), now + 1)
    expect(ModelRoute.providerRootStartBlocked(target, now + 1)).toEqual({ until: resetAt })
  })

  test("a stale or percent-less snapshot is never a wall", () => {
    ModelRoute.observeProviderQuota(target, snap({ stale: true }), now)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
    ModelRoute.observeProviderQuota(target, snap({ percent: null, remaining: null, observedAt: now + 1 }), now + 1)
    expect(ModelRoute.providerRootStartBlocked(target, now + 1)).toBeUndefined()
  })

  test("a balance snapshot never blocks a root start (the dead-balance gate governs balances)", () => {
    ModelRoute.observeProviderQuota(
      target,
      snap({ balance: true, percent: 100, remaining: 0, window: "credits" }),
      now,
    )
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
  })

  test("a window whose reset has passed no longer blocks", () => {
    ModelRoute.observeProviderQuota(target, snap({ resetAt: now - 1 }), now)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
  })

  test("the credential scope judges from its own snapshot", () => {
    ModelRoute.observeCredentialQuota(target, "cred-root-start", snap(), now)
    expect(ModelRoute.credentialRootStartBlocked("cred-root-start", now)).toEqual({ until: resetAt })
    expect(ModelRoute.rootStartBlocked(target, "cred-root-start", now)).toEqual({ until: resetAt })
    expect(ModelRoute.credentialRootStartBlocked("cred-unseen", now)).toBeUndefined()
  })

  test("disabling the gate restores quota-blind root starts, via constants and via config", () => {
    ModelRoute.observeProviderQuota(target, snap(), now)
    ModelRoute.configureConstants({ quotaGate: { rootStartEnabled: false } })
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
    ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toEqual({ until: resetAt })
    ModelRoute.onSettingsConfig(() => ({ quotaGate: { rootStartEnabled: false } }))
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
  })

  test("a retained snapshot that ages past the max age stops blocking, even with no reset", () => {
    // The stored stale flag is stamped at derivation; a snapshot retained
    // without a fresher observation must still age out at judgement time.
    ModelRoute.observeProviderQuota(target, snap({ resetAt: null }), now)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toEqual({ until: null })
    const aged = now + QuotaSnapshot.DEFAULT_MAX_AGE_MS + 1
    expect(ModelRoute.providerRootStartBlocked(target, aged)).toBeUndefined()
    expect(ModelRoute.rootStartBlocked(target, undefined, aged)).toBeUndefined()
  })

  test("a retained credential snapshot that ages past the max age stops blocking", () => {
    ModelRoute.observeCredentialQuota(target, "cred-aging", snap({ resetAt: null }), now)
    expect(ModelRoute.credentialRootStartBlocked("cred-aging", now)).toEqual({ until: null })
    const aged = now + QuotaSnapshot.DEFAULT_MAX_AGE_MS + 1
    expect(ModelRoute.credentialRootStartBlocked("cred-aging", aged)).toBeUndefined()
  })

  test("a configured threshold replaces the default 85", () => {
    ModelRoute.observeProviderQuota(target, snap({ percent: 75 }), now)
    expect(ModelRoute.providerRootStartBlocked(target, now)).toBeUndefined()
    ModelRoute.onSettingsConfig(() => ({ quotaGate: { rootStartMaxPct: 70 } }))
    expect(ModelRoute.providerRootStartBlocked(target, now)).toEqual({ until: resetAt })
  })
})
