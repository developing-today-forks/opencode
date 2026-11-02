import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteLog } from "@opencode/core/model-route-log"

const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" })

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.resetSelection()
  ModelRoute.setAdjustments([])
})

describe("ModelRoute health", () => {
  test("starts with bounded first-token and rolling-window defaults", () => {
    expect(ModelRoute.policy()).toMatchObject({
      firstTokenTimeoutMs: 10_000,
      sampleWindow: 5,
      slowThreshold: 3,
      cooldownMs: 60_000,
    })
  })

  test("cools down immediately after a provider failure, then recovers", () => {
    const policy = ModelRoute.policy({ cooldownMs: 2_000 })

    ModelRoute.failed(target, policy, 10_000)

    expect(ModelRoute.coolingDown(target, 11_999)).toBe(true)
    expect(ModelRoute.coolingDown(target, 12_000)).toBe(false)
    expect(ModelRoute.cooldownUntil(target, 12_000)).toBe(0)
  })

  test("degrades after three slow completions in the rolling five-request window", () => {
    const policy = ModelRoute.policy({
      firstTokenTimeoutMs: false,
      maxResponseTimeMs: 1_000,
      sampleWindow: 5,
      slowThreshold: 3,
      cooldownMs: 2_000,
    })
    const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }
    const slow = { firstTokenMs: 100, responseMs: 1_001, tokensPerSecond: 30 }

    ModelRoute.completed(target, policy, slow, 1_000)
    ModelRoute.completed(target, policy, fast, 2_000)
    ModelRoute.completed(target, policy, slow, 3_000)
    expect(ModelRoute.coolingDown(target, 3_000)).toBe(false)
    ModelRoute.completed(target, policy, slow, 4_000)

    expect(ModelRoute.coolingDown(target, 4_000)).toBe(true)
    expect(ModelRoute.coolingDown(target, 6_000)).toBe(false)
  })

  test("evicts old slow samples as the rolling window advances", () => {
    const policy = ModelRoute.policy({
      firstTokenTimeoutMs: false,
      maxResponseTimeMs: 1_000,
      sampleWindow: 3,
      slowThreshold: 3,
      cooldownMs: 2_000,
    })
    const slow = { firstTokenMs: 100, responseMs: 2_000, tokensPerSecond: 30 }
    const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

    ModelRoute.completed(target, policy, slow, 1_000)
    ModelRoute.completed(target, policy, slow, 2_000)
    ModelRoute.completed(target, policy, fast, 3_000)
    ModelRoute.completed(target, policy, fast, 4_000)

    expect(ModelRoute.coolingDown(target, 4_000)).toBe(false)
  })
})

describe("ModelRoute session selection", () => {
  test("ordered mode always starts at the first candidate and stays sticky", () => {
    expect(ModelRoute.sessionScoped("ordered")).toBe(false)
    expect(ModelRoute.selectSessionTarget("r", "s1", "ordered", [0, 1, 2], [1, 1, 1])).toBe(0)
    expect(ModelRoute.sessionTarget("r", "s1")).toBeUndefined()
  })

  test("round-robin rotates per session and sticks to the drawn target", () => {
    const indexes = [0, 1, 2]
    const first = ModelRoute.selectSessionTarget("rr", "s1", "round-robin", indexes, [1, 1, 1])
    const second = ModelRoute.selectSessionTarget("rr", "s2", "round-robin", indexes, [1, 1, 1])
    const third = ModelRoute.selectSessionTarget("rr", "s3", "round-robin", indexes, [1, 1, 1])
    expect([first, second, third]).toEqual([0, 1, 2])
    // Sticky while the drawn target is still a candidate.
    expect(ModelRoute.sessionTarget("rr", "s1")).toBe(0)
    expect(ModelRoute.selectSessionTarget("rr", "s1", "round-robin", [0, 2], [1, 1])).toBe(0)
    // If the sticky target left the candidate list (e.g. cooldown), the session re-draws and re-sticks.
    const redrawn = ModelRoute.selectSessionTarget("rr", "s1", "round-robin", [1, 2], [1, 1])
    expect(redrawn === 1 || redrawn === 2).toBe(true)
    expect(ModelRoute.sessionTarget("rr", "s1")).toBe(redrawn)
  })

  test("weighted selection respects ratios and sticks per session", () => {
    const indexes = [0, 1]
    let first = 0
    for (let i = 0; i < 200; i++) {
      const drawn = ModelRoute.selectSessionTarget(`w-${i}`, `s${i}`, "weighted", indexes, [3, 1])
      if (drawn === 0) first++
    }
    // 3:1 ratio over 200 draws; a tolerant band keeps this deterministic enough for CI.
    expect(first).toBeGreaterThan(120)
    expect(first).toBeLessThan(180)
    const sticky = ModelRoute.sessionTarget("w-0", "s0")
    expect(sticky).toBeDefined()
    expect(sticky).toBe(ModelRoute.selectSessionTarget("w-0", "s0", "weighted", indexes, [3, 1]))
  })

  test("forgetSession drops the sticky choice", () => {
    ModelRoute.selectSessionTarget("f", "s1", "round-robin", [0, 1], [1, 1])
    expect(ModelRoute.sessionTarget("f", "s1")).toBeDefined()
    ModelRoute.forgetSession("f", "s1")
    expect(ModelRoute.sessionTarget("f", "s1")).toBeUndefined()
  })
})

describe("ModelRoute.orderTargets", () => {
  const targets = [0, 1, 2, 3].map((index) => ModelRoute.ref({ providerID: "p", model: `m${index}` }))
  // root: weighted 3:1 between group A (leaves 0,1 round-robin) and leaf 2; leaf 3 is a fallback.
  const definition = {
    id: "tree",
    targets,
    targetVariants: [],
    health: ModelRoute.policy(),
    nodes: [
      {
        selection: "weighted" as const,
        weights: [3, 1, 1],
        children: [{ node: 1 }, { leaf: 2 }, { leaf: 3 }],
      },
      { selection: "round-robin" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ],
  } as unknown as ModelRoute.Definition
  const all = new Set([0, 1, 2, 3])

  test("keeps every leaf and splits within the chosen group", () => {
    const first = ModelRoute.orderTargets(definition, all, "s1", true)
    expect([...first].sort()).toEqual([0, 1, 2, 3])
    // Group A's leaves stay adjacent: a group is chosen as one unit.
    const groupA = first.filter((index) => index < 2)
    expect(Math.abs(first.indexOf(groupA[0]) - first.indexOf(groupA[1]))).toBe(1)
  })

  test("is sticky per session at every level and drops cooled groups", () => {
    ModelRoute.resetSelection()
    const first = ModelRoute.nextTarget(definition, all, new Set(), "s2", true, undefined, undefined, () => 0)
    expect(first).toBe(0)
    expect(ModelRoute.nextTarget(definition, all, new Set(), "s2", true, undefined, undefined, () => 0.99)).toBe(0)
    const withoutA = ModelRoute.nextTarget(
      definition,
      new Set([2, 3]),
      new Set(),
      "s2",
      true,
      undefined,
      undefined,
      () => 0,
    )
    expect(withoutA === 2 || withoutA === 3).toBe(true)
  })

  test("round-robin inside a group rotates across sessions", () => {
    const onlyA = new Set([0, 1])
    const heads = ["a", "b", "c", "d"].map((id) => ModelRoute.orderTargets(definition, onlyA, id, true)[0])
    expect(new Set(heads).size).toBe(2)
  })

  test("does not consume a nested round-robin draw until the parent reaches that group", () => {
    ModelRoute.resetSelection()
    const hierarchy = {
      ...definition,
      nodes: [
        {
          routeID: "outer",
          selection: "weighted" as const,
          weights: [99, 1],
          children: [{ node: 1 }, { leaf: 2 }],
        },
        {
          routeID: "luna",
          selection: "round-robin" as const,
          weights: [1, 1],
          children: [{ leaf: 0 }, { leaf: 1 }],
        },
      ],
    } as unknown as ModelRoute.Definition
    const ready = new Set([0, 1, 2])
    // Choose the sibling leaf; the nested route must not spend a turn just because it was inspected.
    expect(ModelRoute.nextTarget(hierarchy, ready, new Set(), "sibling", true, undefined, undefined, () => 0.999)).toBe(
      2,
    )
    expect(ModelRoute.sessionTarget("luna#1", "sibling")).toBeUndefined()
    // Subsequent sessions that actually enter Luna should get its RR sequence in order.
    expect(ModelRoute.nextTarget(hierarchy, ready, new Set(), "luna-a", true, undefined, undefined, () => 0)).toBe(0)
    expect(ModelRoute.nextTarget(hierarchy, ready, new Set(), "luna-b", true, undefined, undefined, () => 0)).toBe(1)
  })
})

describe("ModelRoute correlation and adjustments", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000 })
  const model = (providerID: string, id: string) => ModelRoute.ref({ providerID, model: id })

  test("demotes a provider once several of its models are cooling, but not other providers", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(model("azure", "a"), policy, 1_000)
    expect(ModelRoute.coolingDown(model("azure", "b"), 1_000)).toBe(false)
    ModelRoute.failed(model("azure", "c"), policy, 1_000)
    expect(ModelRoute.coolingDown(model("azure", "b"), 1_000)).toBe(true)
    expect(ModelRoute.coolingDown(model("openai", "b"), 1_000)).toBe(false)
    expect(ModelRoute.coolingDown(model("azure", "b"), 62_000)).toBe(false)
  })

  test("does not punish targets when unrelated providers fail together", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(model("openai", "a"), policy, 1_000, { network: true })
    ModelRoute.failed(model("azure", "a"), policy, 2_000, { network: true })
    expect(ModelRoute.networkSuspect(2_000)).toBe(false)
    ModelRoute.failed(model("anthropic", "a"), policy, 3_000, { network: true })
    expect(ModelRoute.networkSuspect(3_000)).toBe(true)
    expect(ModelRoute.coolingDown(model("anthropic", "a"), 3_000)).toBe(false)
    expect(ModelRoute.coolingDown(model("openai", "a"), 3_000)).toBe(false)
    expect(ModelRoute.coolingDown(model("azure", "a"), 3_000)).toBe(false)
    expect(ModelRoute.networkSuspect(40_000)).toBe(false)
  })

  test("network-suspect undo also forgives the escalation count", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(model("openai", "a"), policy, 1_000, { network: true })
    ModelRoute.failed(model("azure", "a"), policy, 2_000, { network: true })
    ModelRoute.failed(model("anthropic", "a"), policy, 3_000, { network: true })
    expect(ModelRoute.networkSuspect(3_000)).toBe(true)
    expect(ModelRoute.coolingDown(model("openai", "a"), 3_000)).toBe(false)

    // After the outage is forgiven, a later single genuine failure benches at the
    // first-offence (1x) length, not doubled by the undone failure (#1034).
    ModelRoute.failed(model("openai", "a"), policy, 40_000)
    expect(ModelRoute.cooldownUntil(model("openai", "a"), 40_000)).toBe(100_000)
    expect(ModelRoute.coolingDown(model("openai", "a"), 99_999)).toBe(true)
    expect(ModelRoute.coolingDown(model("openai", "a"), 100_000)).toBe(false)
  })

  test("does not classify provider quota failures as a network outage", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(model("openai", "a"), policy, 1_000, { quota: true })
    ModelRoute.failed(model("azure", "a"), policy, 2_000, { quota: true })
    ModelRoute.failed(model("anthropic", "a"), policy, 3_000, { quota: true })
    expect(ModelRoute.networkSuspect(3_000)).toBe(false)
    expect(ModelRoute.coolingDown(model("anthropic", "a"), 3_000)).toBe(true)
  })

  test("skip and weight adjustments expire and reorder ordered groups", () => {
    ModelRoute.resetHealth()
    const targets = [model("openai", "gpt-6-luna"), model("anthropic", "claude-opus-5")]
    const definition = {
      id: "adj",
      targets,
      targetVariants: [],
      health: policy,
      nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    } as unknown as ModelRoute.Definition
    const now = Date.now()
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([0, 1])
    ModelRoute.setAdjustments([{ id: "promo", match: "claude", action: "weight", factor: 5, until: now + 60_000 }])
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([1, 0])
    ModelRoute.setAdjustments([{ id: "promo", match: "claude", action: "weight", factor: 5, until: now - 1 }])
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([0, 1])
    ModelRoute.setAdjustments([{ id: "out", match: "openai/", action: "skip", until: now + 60_000 }])
    expect(ModelRoute.skipped(targets[0])).toBe(true)
    expect(ModelRoute.skipped(targets[1])).toBe(false)
  })
})

describe("ModelRoute failure hints", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
  const t = ModelRoute.ref({ providerID: "openai", model: "hint" })

  test("a stated retry-after sets the cooldown, capped at a day", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { retryAfterMs: 5_000 })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(6_000)
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { retryAfterMs: 10 ** 12 })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 86_400_000)
  })

  test("an exhausted quota outlasts an ordinary failure", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { quota: true })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 900_000)
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000)
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 60_000)
  })

  test("repeated failures double the bench, and the count survives the bench expiring", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000)
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 60_000)
    ModelRoute.failed(t, policy, 61_000)
    expect(ModelRoute.cooldownUntil(t, 61_000)).toBe(61_000 + 120_000)
    ModelRoute.failed(t, policy, 181_000)
    expect(ModelRoute.cooldownUntil(t, 181_000)).toBe(181_000 + 240_000)
    // Expiry (recover) does not forgive the history: the next failure keeps escalating.
    expect(ModelRoute.cooldownUntil(t, 421_000)).toBe(0)
    ModelRoute.failed(t, policy, 421_000)
    expect(ModelRoute.cooldownUntil(t, 421_000)).toBe(421_000 + 480_000)
  })

  test("a success resets the escalation back to the base bench", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000)
    ModelRoute.failed(t, policy, 61_000)
    expect(ModelRoute.cooldownUntil(t, 61_000)).toBe(61_000 + 120_000)
    ModelRoute.completed(t, policy, { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }, 181_000)
    ModelRoute.failed(t, policy, 182_000)
    expect(ModelRoute.cooldownUntil(t, 182_000)).toBe(182_000 + 60_000)
  })

  test("an auth failure takes the long bench first, then escalates from it", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000, { auth: true })
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 900_000)
    ModelRoute.failed(t, policy, 901_000, { auth: true })
    expect(ModelRoute.cooldownUntil(t, 901_000)).toBe(901_000 + 1_800_000)
  })

  test("a stated retry-after is never multiplied, even after repeated failures", () => {
    ModelRoute.resetHealth()
    ModelRoute.failed(t, policy, 1_000)
    ModelRoute.failed(t, policy, 61_000)
    ModelRoute.failed(t, policy, 181_000, { retryAfterMs: 5_000 })
    expect(ModelRoute.cooldownUntil(t, 181_000)).toBe(181_000 + 5_000)
  })

  test("the escalated bench is capped at a day", () => {
    ModelRoute.resetHealth()
    for (let index = 0; index < 30; index++) ModelRoute.failed(t, policy, 1_000)
    expect(ModelRoute.cooldownUntil(t, 1_000)).toBe(1_000 + 86_400_000)
  })
})

describe("ModelRoute quota bench reset", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
  const target = ModelRoute.ref({ providerID: "reset-provider", model: "quota" })
  const day = 86_400_000

  const exhaustLadder = (now: number, credentialID?: string) => {
    for (let index = 0; index < 8; index++)
      ModelRoute.failed(target, policy, now + index, { quota: true }, credentialID)
  }

  test("caps a credential bench at its exhausted window reset, not an unrelated window", () => {
    const now = 100_000_000
    const resetAt = now + 5 * 3_600_000
    ModelRoute.observeRateLimit(
      target,
      {
        at: now,
        limit: { short: "100", long: "1000" },
        remaining: { short: "0", long: "100" },
        reset: { short: "5h", long: "24h" },
      },
      now,
      "cred-a",
    )

    exhaustLadder(now, "cred-a")

    expect(ModelRoute.credentialCooldownUntil(target, "cred-a", now + 7)).toBe(resetAt)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-a", resetAt - 1)).toBe(resetAt)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-a", resetAt)).toBe(0)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-b", now)).toBe(0)
    expect(ModelRoute.cooldownUntil(target, now)).toBe(0)

    ModelRoute.completed(target, policy, { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }, resetAt, "cred-a")
    ModelRoute.failed(target, policy, resetAt + 1, { quota: true }, "cred-a")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-a", resetAt + 1)).toBe(resetAt + 1 + 900_000)
  })

  test("uses a fresh known-full plan reset but never the reactive fallback as an actual reset", () => {
    const now = 200_000_000
    const resetAt = now + 5 * 3_600_000
    ModelRoute.observeCredentialQuota(
      target,
      "cred-plan",
      {
        planID: "plan",
        window: "five-hours",
        providerID: "reset-provider",
        percent: 100,
        remaining: 0,
        resetAt,
        observedAt: now,
        stale: false,
      },
      now,
    )
    ModelRoute.observeQuotaFailure(target, "cred-plan", undefined, now)
    exhaustLadder(now + 1, "cred-plan")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-plan", now + 8)).toBe(resetAt)

    ModelRoute.resetHealth()
    ModelRoute.observeProviderQuota(
      target,
      {
        planID: "plan",
        window: "five-hours",
        providerID: "reset-provider",
        percent: 100,
        remaining: 0,
        resetAt,
        observedAt: now,
        stale: false,
      },
      now,
    )
    exhaustLadder(now)
    expect(ModelRoute.cooldownUntil(target, now + 7)).toBe(resetAt)

    ModelRoute.resetHealth()
    ModelRoute.observeQuotaFailure(target, "cred-fallback", undefined, now)
    exhaustLadder(now, "cred-fallback")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-fallback", now + 7)).toBe(now + 7 + day)
  })

  test("reconciling the gate against live plans clears state derived from an ended plan (#1340)", () => {
    const now = 400_000_000
    const resetAt = now + 5 * 3_600_000
    const ended = {
      planID: "ended-plan",
      window: "five-hours",
      providerID: "reset-provider",
      percent: 100,
      remaining: 0,
      resetAt,
      observedAt: now,
      stale: false,
    }
    ModelRoute.resetHealth()
    ModelRoute.observeCredentialQuota(target, "cred-ended", ended, now)
    expect(ModelRoute.credentialQuotaBlocked("cred-ended", now)).toEqual({ until: resetAt })

    // While the plan still feeds the gate, reconciliation keeps its state.
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["ended-plan"]))
    expect(ModelRoute.credentialQuotaBlocked("cred-ended", now)).toEqual({ until: resetAt })

    // The plan ends: it derives no replacement snapshot, so its retained gate state clears
    // and the next route selection no longer blocks the credential on the stale snapshot.
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]))
    expect(ModelRoute.credentialQuotaBlocked("cred-ended", now)).toBeUndefined()

    // Reactive attempt evidence is not plan capacity: an attempt-derived gate survives
    // reconciliation even when no plan is live.
    ModelRoute.resetHealth()
    ModelRoute.observeQuotaFailure(target, "cred-reactive", resetAt, now)
    expect(ModelRoute.credentialQuotaBlocked("cred-reactive", now)).toEqual({ until: resetAt })
    ModelRoute.reconcileQuotaGate("reset-provider", new Set())
    expect(ModelRoute.credentialQuotaBlocked("cred-reactive", now)).toEqual({ until: resetAt })

    // The provider scope follows the same rule, including its plan-derived skip adjustment.
    ModelRoute.resetHealth()
    ModelRoute.observeProviderQuota(target, ended, now)
    expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(true)
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]))
    expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(false)
  })

  test("reconciling the gate clears a balance baseline only when its grant's plan ended (#1340)", () => {
    const now = 450_000_000
    const balance = {
      planID: "ended-balance-plan",
      window: "credits",
      providerID: "reset-provider",
      percent: 100,
      remaining: 0,
      resetAt: null,
      observedAt: now,
      stale: false,
      balance: true,
    }
    ModelRoute.resetHealth()
    ModelRoute.observeCredentialQuota(target, "cred-balance", balance, now)
    expect(ModelRoute.credentialQuotaBlocked("cred-balance", now)).toEqual({ until: null })
    // The durable baseline record is what re-arms the hold after a restart; while the
    // grant's plan is live, reconciliation leaves both state and record alone.
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["ended-balance-plan"]))
    expect(ModelRoute.credentialQuotaBlocked("cred-balance", now)).toEqual({ until: null })
    // Once the grant's plan has ended, the baseline goes with the in-memory state:
    // otherwise the restored hold would immediately re-block the credential.
    ModelRoute.reconcileQuotaGate("reset-provider", new Set())
    expect(ModelRoute.credentialQuotaBlocked("cred-balance", now)).toBeUndefined()
    expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota-credential:cred-balance")).toBe(false)
  })

  test("a reclassified window replaces a balance hold with its normal timed gate (#1380)", () => {
    const now = 500_000_000
    const resetAt = now + 5 * 3_600_000
    const balance = {
      planID: "credits-plan",
      window: "credits",
      providerID: "reset-provider",
      percent: 100,
      remaining: 0,
      resetAt: null,
      observedAt: now,
      stale: false,
      balance: true,
    }
    // The same plan + window after a windowHours reclassification: derive() no longer
    // reports it as a balance, so the snapshot is a resetting usage window.
    const windowed = {
      planID: "credits-plan",
      window: "credits",
      providerID: "reset-provider",
      percent: 100,
      remaining: 0,
      resetAt,
      observedAt: now + 1,
      stale: false,
    }
    ModelRoute.resetHealth()
    ModelRoute.observeCredentialQuota(target, "cred-reclass", balance, now)
    expect(ModelRoute.credentialQuotaBlocked("cred-reclass", now)).toEqual({ until: null })
    expect(
      ModelRoute.activeAdjustments(now).some((item) => item.id === "quota-credential:cred-reclass"),
    ).toBe(true)

    ModelRoute.observeCredentialQuota(target, "cred-reclass", windowed, now + 1)
    // The stale increase-only hold is gone: the credential is gated only until the
    // window's stated reset, and the durable baseline record is cleared.
    expect(ModelRoute.credentialQuotaBlocked("cred-reclass", now + 1)).toEqual({ until: resetAt })
    expect(
      ModelRoute.activeAdjustments(now + 1).some((item) => item.id === "quota-credential:cred-reclass"),
    ).toBe(false)

    // A non-balance snapshot from a DIFFERENT grant is not evidence about the hold.
    ModelRoute.resetHealth()
    ModelRoute.observeCredentialQuota(target, "cred-other", balance, now)
    ModelRoute.observeCredentialQuota(
      target,
      "cred-other",
      { ...windowed, planID: "other-plan", window: "five-hours" },
      now + 1,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-other", now + 1)).toEqual({ until: null })

    // The provider scope follows the same rule: its balance skip is replaced by the
    // window's timed skip, with no balance baseline left on the record.
    ModelRoute.resetHealth()
    ModelRoute.observeProviderQuota(target, balance, now)
    expect(
      ModelRoute.activeAdjustments(now).find((item) => item.id === "quota:reset-provider")?.balanceBaseline,
    ).toBe(0)
    ModelRoute.observeProviderQuota(target, windowed, now + 1)
    const skip = ModelRoute.activeAdjustments(now + 1).find((item) => item.id === "quota:reset-provider")
    expect(skip?.balanceBaseline).toBeUndefined()
    expect(skip?.until).toBe(resetAt)
  })

  test("reconciling clears restored balance baselines whose grant plan ended (#1380)", () => {
    const now = 550_000_000
    ModelRoute.resetHealth()
    // A baseline record restored after a restart, with no in-memory gate state: it blocks
    // its credential until a fed snapshot releases it -- or until reconciliation clears it.
    ModelRoute.addAdjustment({
      id: "quota-credential:cred-restored",
      match: "credential:cred-restored",
      action: "skip",
      balanceBaseline: 0,
      balanceGrant: "dead-plan\ncredits",
      credentialID: "cred-restored",
      providerID: "reset-provider",
      note: "credential balance exhausted; held until a fresh balance increase (durable baseline record -- not a selection skip)",
    })
    expect(ModelRoute.credentialQuotaBlocked("cred-restored", now)).toEqual({ until: null })
    // While the grant's plan still feeds the gate, the hold is still-applicable and stays.
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["dead-plan"]))
    expect(ModelRoute.credentialQuotaBlocked("cred-restored", now)).toEqual({ until: null })
    // The grant's plan is gone and no balance grant remains: the stale baseline clears.
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]))
    expect(ModelRoute.credentialQuotaBlocked("cred-restored", now)).toBeUndefined()
    expect(
      ModelRoute.activeAdjustments(now).some((item) => item.id === "quota-credential:cred-restored"),
    ).toBe(false)

    // The provider scope's restored balance skip follows the same rule.
    ModelRoute.addAdjustment({
      id: "quota:reset-provider",
      match: "reset-provider/",
      action: "skip",
      balanceBaseline: 0,
      balanceGrant: "dead-plan\ncredits",
      note: "quota exhausted (proactive snapshot); held until the stated reset",
    })
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["dead-plan"]))
    expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(true)
    ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]))
    expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(false)
  })

  test("leaves the ladder unchanged for missing, invalid, elapsed or stale provider resets", () => {
    const now = 300_000_000
    const snapshots = [
      { at: now, remaining: { requests: "0" } },
      { at: now, remaining: { requests: "0" }, reset: { requests: "not-a-reset" } },
      { at: now - 2 * 3_600_000, remaining: { requests: "0" }, reset: { requests: "5h" } },
      { at: now - 2 * 3_600_000, remaining: { requests: "0" }, reset: { requests: "1h" } },
    ]

    for (const snapshot of snapshots) {
      ModelRoute.resetHealth()
      ModelRoute.observeRateLimit(target, snapshot, now, "cred-a")
      exhaustLadder(now, "cred-a")
      expect(ModelRoute.credentialCooldownUntil(target, "cred-a", now + 7)).toBe(now + 7 + day)
    }
  })

  test("does not cap auth or ordinary benches, and retry-after still wins unless the quota window is sooner", () => {
    const now = 400_000_000
    const resetAt = now + 5 * 60_000
    const spent = {
      at: now,
      limit: { requests: "100" },
      remaining: { requests: "0" },
      reset: { requests: "5m" },
    }
    ModelRoute.observeRateLimit(target, spent, now, "cred-auth")
    ModelRoute.failed(target, policy, now, { auth: true }, "cred-auth")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-auth", now)).toBe(now + 900_000)

    ModelRoute.resetHealth()
    ModelRoute.observeRateLimit(target, spent, now, "cred-ordinary")
    ModelRoute.failed(target, policy, now, undefined, "cred-ordinary")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-ordinary", now)).toBe(now + 60_000)

    ModelRoute.resetHealth()
    ModelRoute.observeRateLimit(target, spent, now, "cred-retry")
    ModelRoute.failed(target, policy, now, { quota: true, retryAfterMs: 120_000 }, "cred-retry")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-retry", now)).toBe(now + 120_000)
    ModelRoute.resetHealth()
    ModelRoute.observeRateLimit(target, spent, now, "cred-retry-long")
    ModelRoute.failed(target, policy, now, { quota: true, retryAfterMs: 10 * 60_000 }, "cred-retry-long")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-retry-long", now)).toBe(resetAt)
  })

  test("a quota bench can expire while an independent provider gate remains active", () => {
    const now = 500_000_000
    const resetAt = now + 5 * 60_000
    ModelRoute.observeRateLimit(
      target,
      {
        at: now,
        limit: { requests: "100" },
        remaining: { requests: "0" },
        reset: { requests: "5m" },
      },
      now,
    )
    ModelRoute.observeQuotaFailure(target, undefined, now + day, now)
    exhaustLadder(now)

    expect(ModelRoute.cooldownUntil(target, now + 7)).toBe(resetAt)
    expect(ModelRoute.skipped(target, resetAt + 1)).toBe(true)
  })
})

describe("ModelRoute quota bench probe (#1123)", () => {
  const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
  const target = ModelRoute.ref({ providerID: "probe-provider", model: "quota" })
  const day = 86_400_000
  const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

  const exhaustLadder = (now: number, credentialID?: string) => {
    for (let index = 0; index < 8; index++)
      ModelRoute.failed(target, policy, now + index, { quota: true }, credentialID)
  }

  const knownFull = (resetAt: number, observedAt: number) => ({
    planID: "plan",
    window: "five-hours",
    providerID: "probe-provider",
    percent: 100,
    remaining: 0,
    resetAt,
    observedAt,
    stale: false,
  })

  test("a reset learned after the bench arms exactly one probe at rollover; probe success unbenched and clears the ladder", () => {
    const now = 600_000_000
    const resetAt = now + 5 * 3_600_000
    ModelRoute.resetHealth()
    // The bench is planted before any reset is known: the generic ladder runs to the 24h cap.
    exhaustLadder(now, "cred-probe")
    const benchUntil = now + 7 + day
    expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", now + 7)).toBe(benchUntil)

    // The quota feed then learns the credential's actual window reset, hours before the bench ends.
    ModelRoute.observeCredentialQuota(target, "cred-probe", knownFull(resetAt, now + 10), now + 10)

    // Route stats surface the active bench with its reason, expiry and known reset.
    expect(ModelRoute.activeBenches(now + 11)).toEqual([
      {
        providerID: "probe-provider",
        modelID: "quota",
        credentialID: "cred-probe",
        until: benchUntil,
        reason: "quota",
        consecutiveFailures: 8,
        quotaResetAt: resetAt,
        probeDue: false,
        probeClaimed: false,
      },
    ])

    expect(ModelRoute.probeDue(target, "cred-probe", resetAt - 1)).toBe(false)
    expect(ModelRoute.probeDue(target, "cred-probe", resetAt)).toBe(true)
    // Exactly one probe: the first claim wins, later claims are refused while it is outstanding,
    // and ordinary candidacy stays excluded the whole time.
    expect(ModelRoute.claimBenchProbe(target, "cred-probe", resetAt)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, "cred-probe", resetAt)).toBe(false)
    expect(ModelRoute.probeDue(target, "cred-probe", resetAt)).toBe(false)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt)).toBe(benchUntil)
    expect(ModelRoute.activeBenches(resetAt)[0]?.probeClaimed).toBe(true)

    // Probe success fully unbenched the credential (the bench had ~19h left) and clears the ladder:
    // the next quota failure benches at the base again instead of escalating.
    ModelRoute.completed(target, policy, sample, resetAt + 1, "cred-probe")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 1)).toBe(0)
    expect(ModelRoute.activeBenches(resetAt + 1)).toEqual([])
    ModelRoute.failed(target, policy, resetAt + 2, { quota: true }, "cred-probe")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 2)).toBe(resetAt + 2 + 900_000)
  })

  test("a failed probe re-benches on the escalated ladder, capped at the next known reset", () => {
    const now = 700_000_000
    const resetAt = now + 5 * 3_600_000
    const nextResetAt = resetAt + 5 * 3_600_000
    ModelRoute.resetHealth()
    exhaustLadder(now, "cred-probe-fail")
    ModelRoute.observeCredentialQuota(target, "cred-probe-fail", knownFull(resetAt, now + 10), now + 10)
    // The next window's reset becomes known before the probe runs.
    ModelRoute.observeCredentialQuota(target, "cred-probe-fail", knownFull(nextResetAt, resetAt), resetAt)
    expect(ModelRoute.claimBenchProbe(target, "cred-probe-fail", resetAt)).toBe(true)

    ModelRoute.failed(target, policy, resetAt + 1, { quota: true }, "cred-probe-fail")
    // Ninth consecutive failure: the ladder alone would cap at 24h; the next known reset bounds it.
    expect(ModelRoute.credentialCooldownUntil(target, "cred-probe-fail", resetAt + 1)).toBe(nextResetAt)
    expect(ModelRoute.probeDue(target, "cred-probe-fail", resetAt + 1)).toBe(false)
    // The re-bench ends AT the next reset, so candidacy returns there without needing a probe.
    expect(ModelRoute.credentialCooldownUntil(target, "cred-probe-fail", nextResetAt)).toBe(0)
    // Sibling credentials were never benched or probed.
    expect(ModelRoute.credentialCooldownUntil(target, "cred-other", resetAt + 1)).toBe(0)
    expect(ModelRoute.probeDue(target, "cred-other", nextResetAt)).toBe(false)
  })

  test("a target-level quota bench probes at a provider window reset learned after the bench", () => {
    const now = 800_000_000
    const resetAt = now + 5 * 3_600_000
    ModelRoute.resetHealth()
    exhaustLadder(now)
    expect(ModelRoute.cooldownUntil(target, now + 7)).toBe(now + 7 + day)
    ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10)
    expect(ModelRoute.probeDue(target, undefined, resetAt - 1)).toBe(false)
    expect(ModelRoute.probeDue(target, undefined, resetAt)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, undefined, resetAt)).toBe(true)
    expect(ModelRoute.claimBenchProbe(target, undefined, resetAt)).toBe(false)
    ModelRoute.completed(target, policy, sample, resetAt + 1)
    expect(ModelRoute.cooldownUntil(target, resetAt + 1)).toBe(0)
  })

  test("no probe for auth benches, and the reactive fallback reset never arms one", () => {
    const now = 900_000_000
    const resetAt = now + 5 * 3_600_000
    ModelRoute.resetHealth()
    ModelRoute.failed(target, policy, now, { auth: true }, "cred-auth")
    ModelRoute.observeCredentialQuota(target, "cred-auth", knownFull(resetAt, now + 1), now + 1)
    expect(ModelRoute.probeDue(target, "cred-auth", resetAt)).toBe(false)
    expect(ModelRoute.claimBenchProbe(target, "cred-auth", resetAt)).toBe(false)

    ModelRoute.resetHealth()
    exhaustLadder(now, "cred-fallback")
    ModelRoute.observeQuotaFailure(target, "cred-fallback", undefined, now + 10)
    expect(ModelRoute.activeBenches(now + 11)[0]?.quotaResetAt).toBeUndefined()
    expect(ModelRoute.probeDue(target, "cred-fallback", now + day)).toBe(false)
  })
})

describe("ModelRoute budgets", () => {
  const t = ModelRoute.ref({ providerID: "openai", model: "budgeted" })

  test("passes a target over once it reaches its soft limit, and frees it as the window moves", () => {
    ModelRoute.resetHealth()
    const budget = { requestsPerMinute: 10, softLimit: 0.5 }
    const start = 1_000_000
    for (let index = 0; index < 4; index++) ModelRoute.recordUsage(t, 100, start + index * 1_000)
    expect(ModelRoute.overBudget(t, budget, start + 5_000)).toBe(false)
    ModelRoute.recordUsage(t, 100, start + 5_000)
    expect(ModelRoute.overBudget(t, budget, start + 6_000)).toBe(true)
    expect(ModelRoute.usageOf(t, start + 6_000).minute).toEqual({ requests: 5, tokens: 500 })
    expect(ModelRoute.overBudget(t, budget, start + 70_000)).toBe(false)
    expect(ModelRoute.usageOf(t, start + 70_000).day.requests).toBe(5)
  })

  test("counts daily tokens and expires them after a day", () => {
    ModelRoute.resetHealth()
    const budget = { tokensPerDay: 1_000 }
    ModelRoute.recordUsage(t, 950, 1_000)
    expect(ModelRoute.overBudget(t, budget, 2_000)).toBe(true)
    expect(ModelRoute.overBudget(t, budget, 1_000 + 86_400_000 + 1)).toBe(false)
    expect(ModelRoute.overBudget(t, undefined, 2_000)).toBe(false)
  })

  test("seeds usage from stored history in order", () => {
    ModelRoute.resetHealth()
    ModelRoute.seedUsage([
      { time: 3_000, providerID: "openai", modelID: "budgeted", tokens: 30 },
      { time: 1_000, providerID: "openai", modelID: "budgeted", tokens: 10 },
    ])
    expect(ModelRoute.usageOf(t, 4_000).day).toEqual({ requests: 2, tokens: 40 })
  })
})

describe("ModelRoute.slow", () => {
  test("repeated slow losses cool a target down like any other slow one", () => {
    ModelRoute.resetHealth()
    const policy = ModelRoute.policy({ sampleWindow: 5, slowThreshold: 3, cooldownMs: 60_000 })
    const t = ModelRoute.ref({ providerID: "openai", model: "slowpoke" })
    ModelRoute.slow(t, policy, 1_000)
    ModelRoute.slow(t, policy, 2_000)
    expect(ModelRoute.coolingDown(t, 2_000)).toBe(false)
    ModelRoute.slow(t, policy, 3_000)
    expect(ModelRoute.coolingDown(t, 3_000)).toBe(true)
    expect(ModelRoute.coolingDown(t, 64_000)).toBe(false)
  })
})

describe("ModelRoute provider rate limits", () => {
  const t = ModelRoute.ref({ providerID: "openai", model: "limited" })
  const spent = (reset: string, now: number) => ({
    at: now,
    limit: { requests: "60" },
    remaining: { requests: "0" },
    reset: { requests: reset },
  })

  test("a spent window holds the target back until it resets, without counting as a failure", () => {
    ModelRoute.resetHealth()
    const now = 5_000_000
    ModelRoute.observeRateLimit(t, spent("30s", now), now)
    expect(ModelRoute.limitedUntil(t, now + 1_000)).toBe(now + 30_000)
    expect(ModelRoute.coolingDown(t, now + 1_000)).toBe(false)
    expect(ModelRoute.limitedUntil(t, now + 31_000)).toBe(0)
  })

  test("a healthy report is remembered but holds nothing", () => {
    ModelRoute.resetHealth()
    const now = 5_000_000
    const healthy = { at: now, limit: { requests: "60" }, remaining: { requests: "59" }, reset: { requests: "1s" } }
    ModelRoute.observeRateLimit(t, healthy, now)
    expect(ModelRoute.limitedUntil(t, now)).toBe(0)
    expect(ModelRoute.rateLimitOf(t)).toEqual(healthy)
  })

  test("a later healthy report lifts the hold", () => {
    ModelRoute.resetHealth()
    const now = 5_000_000
    ModelRoute.observeRateLimit(t, spent("1h", now), now)
    expect(ModelRoute.limitedUntil(t, now + 1_000)).toBeGreaterThan(0)
    ModelRoute.observeRateLimit(
      t,
      { at: now + 2_000, limit: { requests: "60" }, remaining: { requests: "60" } },
      now + 2_000,
    )
    expect(ModelRoute.limitedUntil(t, now + 3_000)).toBe(0)
  })

  test("ignores a response that said nothing and is cleared with the rest of the health state", () => {
    ModelRoute.resetHealth()
    ModelRoute.observeRateLimit(t, undefined)
    expect(ModelRoute.rateLimitOf(t)).toBeUndefined()
    ModelRoute.observeRateLimit(t, spent("1h", Date.now()))
    ModelRoute.resetHealth()
    expect(ModelRoute.limitedUntil(t)).toBe(0)
    expect(ModelRoute.rateLimitOf(t)).toBeUndefined()
  })

  test("restored windows hold targets back", () => {
    ModelRoute.resetHealth()
    const now = Date.now()
    ModelRoute.seedLimits([{ providerID: "openai", modelID: "limited", until: now + 60_000 }])
    expect(ModelRoute.limitedUntil(t, now)).toBe(now + 60_000)
  })
})

describe("ModelRoute continuity", () => {
  const primary = ModelRoute.ref({ providerID: "p", model: "a" })
  const fallback = ModelRoute.ref({ providerID: "p", model: "b" })
  const policy = ModelRoute.policy()
  const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }
  const ordered = {
    id: "r",
    targets: [primary, fallback],
    targetVariants: [],
    health: policy,
    nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
  } as unknown as ModelRoute.Definition
  const both = new Set([0, 1])

  test("a target is steady until it has two give-ups in its last five requests", () => {
    expect(ModelRoute.steady(primary)).toBe(true)
    ModelRoute.failed(primary, policy)
    expect(ModelRoute.steady(primary)).toBe(true)
    ModelRoute.failed(primary, policy)
    expect(ModelRoute.steady(primary)).toBe(false)
    for (let index = 0; index < 4; index++) ModelRoute.completed(primary, policy, sample)
    expect(ModelRoute.steady(primary)).toBe(true)
  })

  test("a failover keeps the origin and offers it as the hedge partner for the next two requests", () => {
    ModelRoute.moved("r", "s1", primary)
    expect(ModelRoute.hedgeHome("r", "s1")).toBe("p/a")
    ModelRoute.served("r", "s1", fallback)
    expect(ModelRoute.hedgeHome("r", "s1")).toBe("p/a")
    ModelRoute.served("r", "s1", fallback)
    expect(ModelRoute.hedgeHome("r", "s1")).toBeUndefined()
    expect(ModelRoute.continuityOf("r", "s1")).toMatchObject({ current: "p/b", origin: "p/a", away: 2 })
  })

  test("answering from the origin again ends the move", () => {
    ModelRoute.moved("r", "s2", primary)
    ModelRoute.served("r", "s2", fallback)
    ModelRoute.served("r", "s2", primary)
    expect(ModelRoute.continuityOf("r", "s2")).toEqual({ current: "p/a", away: 0 })
    expect(ModelRoute.hedgeHome("r", "s2")).toBeUndefined()
  })

  test("an ordered route keeps a session on the target answering it while that target is ready", () => {
    expect(ModelRoute.orderTargets(ordered, both, "s3", false)).toEqual([0, 1])
    ModelRoute.moved("r", "s3", primary)
    ModelRoute.served("r", "s3", fallback)
    // The primary has recovered and is first in order, but the session stays on the fallback.
    expect(ModelRoute.orderTargets(ordered, both, "s3", false)).toEqual([1, 0])
    // Other sessions still start at the primary.
    expect(ModelRoute.orderTargets(ordered, both, "other", false)).toEqual([0, 1])
    // If the current target is not ready, the order falls back to the configured one.
    expect(ModelRoute.orderTargets(ordered, new Set([0]), "s3", false)).toEqual([0])
  })

  test("a session's continuity is dropped with the rest of the health state", () => {
    ModelRoute.moved("r", "s4", primary)
    ModelRoute.resetHealth()
    expect(ModelRoute.continuityOf("r", "s4")).toBeUndefined()
  })
})

describe("ModelRoute burst holds, quota demotion and escalation", () => {
  const primary = ModelRoute.ref({ providerID: "anthropic", model: "sonnet" })
  const backup = ModelRoute.ref({ providerID: "openai", model: "fallback" })
  const policy = ModelRoute.policy({ cooldownMs: 1_000 })
  const ordered = {
    id: "burst",
    targets: [primary, backup],
    targetVariants: [],
    health: policy,
    nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
  } as unknown as ModelRoute.Definition
  const both = new Set([0, 1])
  const spent = (now: number) => ({
    at: now,
    limit: { requests: "60" },
    remaining: { requests: "0" },
    reset: { requests: "30s" },
  })

  afterEach(() => {
    ModelRoute.configure({
      escalation: { enabled: true, afterGiveUps: 2 },
      quota: { demoteAfter: 3, windowMs: 4 * 3_600_000 },
    })
  })

  test("a session already on a held target keeps it, while a new session goes elsewhere", () => {
    ModelRoute.resetHealth()
    const now = 9_000_000
    ModelRoute.observeRateLimit(primary, spent(now), now)
    ModelRoute.moved("burst", "old", backup)
    ModelRoute.served("burst", "old", primary)
    expect(ModelRoute.keepsThrough("burst", "old", primary, now + 1_000)).toBe(true)
    expect(ModelRoute.keepsThrough("burst", "new", primary, now + 1_000)).toBe(false)
  })

  test("a session on a held target moves once that target starts failing", () => {
    ModelRoute.resetHealth()
    const now = 9_000_000
    ModelRoute.observeRateLimit(primary, spent(now), now)
    ModelRoute.moved("burst", "s", backup)
    ModelRoute.served("burst", "s", primary)
    ModelRoute.failed(primary, policy, now)
    ModelRoute.failed(primary, policy, now)
    expect(ModelRoute.keepsThrough("burst", "s", primary, now + 1_000)).toBe(false)
  })

  test("three quota errors within the window put a target last in the order", () => {
    ModelRoute.resetHealth()
    const now = Date.now()
    const quota = { quota: true }
    ModelRoute.failed(primary, policy, now, quota)
    ModelRoute.failed(primary, policy, now + 1, quota)
    expect(ModelRoute.demoted(primary, now + 2)).toBe(false)
    ModelRoute.failed(primary, policy, now + 2, quota)
    expect(ModelRoute.demoted(primary, now + 3)).toBe(true)
    expect(ModelRoute.orderTargets(ordered, both, "new", false)).toEqual([1, 0])
    // Old quota errors age out of the window, and the target returns to its place.
    expect(ModelRoute.demoted(primary, now + 4 * 3_600_000 + 10)).toBe(false)
  })

  test("a demoted target is not kept by a session that was already on it", () => {
    ModelRoute.resetHealth()
    const now = Date.now()
    ModelRoute.moved("burst", "q", backup)
    ModelRoute.served("burst", "q", primary)
    for (let index = 0; index < 3; index++) ModelRoute.failed(primary, policy, now + index, { quota: true })
    expect(ModelRoute.orderTargets(ordered, both, "q", false)).toEqual([1, 0])
  })

  test("escalation starts once a target has given up twice recently, and can be switched off", () => {
    ModelRoute.resetHealth()
    expect(ModelRoute.escalates(primary)).toBe(false)
    ModelRoute.failed(primary, policy)
    expect(ModelRoute.escalates(primary)).toBe(false)
    ModelRoute.failed(primary, policy)
    expect(ModelRoute.escalates(primary)).toBe(true)
    ModelRoute.configure({ escalation: { enabled: false } })
    expect(ModelRoute.escalates(primary)).toBe(false)
  })

  test("the escalation threshold is tunable", () => {
    ModelRoute.resetHealth()
    ModelRoute.configure({ escalation: { afterGiveUps: 1 } })
    ModelRoute.failed(primary, policy)
    expect(ModelRoute.escalates(primary)).toBe(true)
  })

  test("currentSettings reports the defaults and what configure has changed", () => {
    expect(ModelRoute.currentSettings()).toEqual({
      escalation: { enabled: true, afterGiveUps: 2 },
      quota: { demoteAfter: 3, windowMs: 4 * 3_600_000 },
    })
    ModelRoute.configure({ quota: { demoteAfter: 5 } })
    expect(ModelRoute.currentSettings().quota).toEqual({ demoteAfter: 5, windowMs: 4 * 3_600_000 })
  })
})

describe("ModelRoute scheduled weights", () => {
  const a = ModelRoute.ref({ providerID: "p", model: "a" })
  const b = ModelRoute.ref({ providerID: "p", model: "b" })
  const c = ModelRoute.ref({ providerID: "p", model: "c" })
  const d = ModelRoute.ref({ providerID: "p", model: "d" })
  const always = { timezone: "UTC" as const }
  const definition = (
    weights: number[],
    schedules: ModelRoute.WeightRule[] = [],
    targets = [a, b, c, d],
    selection: "ordered" | "round-robin" | "weighted" = "ordered",
  ) =>
    ({
      id: "r",
      targets: targets.slice(0, weights.length),
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [
        {
          selection,
          weights,
          ...(schedules.length > 0 ? { schedules } : {}),
          children: weights.map((_, index) => ({ leaf: index })),
        },
      ],
    }) as unknown as ModelRoute.Definition
  const fixed = (route: ModelRoute.Definition) => ({ ...route, autonomy: "fixed" }) as ModelRoute.Definition
  const ready = (count: number) => new Set(Array.from({ length: count }, (_, index) => index))

  test("equal weights keep the configured order; different weights rank first", () => {
    const route = definition([1, 1, 1, 1], [
      { window: always, match: { targets: ["p/a"] }, factor: 1.2 },
      { window: always, match: { targets: ["p/c"] }, factor: 0.8 },
    ])
    // 1.2 first, then the 1s in configured order, then the 0.8s.
    expect(ModelRoute.orderTargets(route, ready(4), undefined, false)).toEqual([0, 1, 3, 2])
  })

  test("a static weight replaces the configured weight, a factor scales it", () => {
    const scaled = definition([2, 1], [{ window: always, match: { targets: ["p/a"] }, factor: 0.8 }], [a, b])
    expect(ModelRoute.orderTargets(scaled, ready(2), undefined, false)).toEqual([0, 1]) // 1.6 vs 1
    const replaced = definition([2, 1], [{ window: always, match: { targets: ["p/a"] }, weight: 0.5 }], [a, b])
    expect(ModelRoute.orderTargets(replaced, ready(2), undefined, false)).toEqual([1, 0]) // 0.5 vs 1
  })

  test("a schedule outside its window leaves the order alone", () => {
    const tomorrow = { daysOfWeek: [(new Date().getUTCDay() + 1) % 7], timezone: "UTC" }
    const route = definition([1, 1], [{ window: tomorrow, match: { targets: ["p/b"] }, factor: 10 }], [a, b])
    expect(ModelRoute.orderTargets(route, ready(2), undefined, false)).toEqual([0, 1])
  })

  test("configured weights order the remaining targets on every selection mode", () => {
    const rr = definition([1, 2], [], [a, b], "round-robin")
    expect(ModelRoute.orderTargets(rr, ready(2), undefined, false)).toEqual([1, 0])
    const weighted = definition([1, 2], [], [a, b], "weighted")
    expect(ModelRoute.orderTargets(weighted, ready(2), undefined, false)).toEqual([1, 0])
  })

  test("a session stays on the target answering it even when a schedule ranks it lower", () => {
    ModelRoute.resetHealth()
    const route = definition([1, 1], [{ window: always, match: { targets: ["p/b"] }, factor: 10 }], [a, b])
    ModelRoute.moved("r", "s1", a)
    ModelRoute.served("r", "s1", b)
    expect(ModelRoute.orderTargets(route, ready(2), "s1", false)).toEqual([1, 0])
    // A fresh session follows the schedule instead.
    expect(ModelRoute.orderTargets(route, ready(2), "fresh", false)).toEqual([1, 0])
  })

  test("a global rule reaches only the routes it names", () => {
    const base = {
      id: "r",
      targets: [a, b],
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    }
    const scoped: ModelRoute.WeightRule = {
      window: always,
      match: { targets: ["p/b"], routes: ["other"] },
      factor: 10,
    }
    expect(
      ModelRoute.orderTargets({ ...base, schedules: [scoped] } as unknown as ModelRoute.Definition, ready(2), undefined, false),
    ).toEqual([0, 1])
    expect(
      ModelRoute.orderTargets(
        { ...base, id: "other", schedules: [scoped] } as unknown as ModelRoute.Definition,
        ready(2),
        undefined,
        false,
      ),
    ).toEqual([1, 0])
  })

  test("a schedule on a nested route applies inside it", () => {
    const nested = {
      id: "outer",
      targets: [a, b, c],
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [
        { routeID: "outer", selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { node: 1 }] },
        {
          routeID: "inner",
          selection: "ordered" as const,
          weights: [1, 1],
          schedules: [{ window: always, match: { targets: ["p/b"] }, factor: 0.5 }],
          children: [{ leaf: 1 }, { leaf: 2 }],
        },
      ],
    } as unknown as ModelRoute.Definition
    // Outer: leaf a (1) before the group (average 0.75); inside the group c (1) before b (0.5).
    expect(ModelRoute.orderTargets(nested, ready(3), undefined, false)).toEqual([0, 2, 1])
  })

  test("a config schedule reorders a fixed route while a learned weight does not", () => {
    const scheduled = fixed(definition([1, 1], [{ window: always, match: { targets: ["p/b"] }, factor: 10 }], [a, b]))
    expect(ModelRoute.orderTargets(scheduled, ready(2), undefined, false)).toEqual([1, 0])
    const learned = fixed(definition([1, 1], [], [a, b]))
    ModelRoute.setAdjustments([{ id: "tuned", match: "p/b", action: "weight", factor: 10, until: Date.now() + 60_000 }])
    expect(ModelRoute.orderTargets(learned, ready(2), undefined, false)).toEqual([0, 1])
  })

  test("a definition with schedules survives the settings round trip", () => {
    const built = definition([2, 1], [{ window: always, match: { targets: ["p/a"] }, factor: 0.8 }], [a, b])
    const info = {
      providerID: ModelRoute.PROVIDER_ID,
      id: "r",
      settings: { [ModelRoute.SETTING]: built },
    } as unknown as Parameters<typeof ModelRoute.definition>[0]
    const decoded = ModelRoute.definition(info)
    expect(decoded?.schedules).toBeUndefined()
    expect(decoded?.nodes[0].schedules).toEqual([
      { window: always, match: { targets: ["p/a"] }, factor: 0.8 },
    ])
    expect(ModelRoute.orderTargets(decoded!, ready(2), undefined, false)).toEqual([0, 1])
  })

  test('a definition with date constraints survives the settings round trip', () => {
    const today = new Date().toISOString().slice(0, 10)
    const window = {
      timezone: 'UTC',
      dates: ['2026-12-25'],
      excludeDates: ['2026-12-24'],
      excludeWindows: ['holidays'],
      excludedWindows: [{ dates: [today], timezone: 'UTC' }],
    }
    const built = definition([1, 1], [{ window, match: { targets: ['p/b'] }, factor: 10 }], [a, b])
    const info = {
      providerID: ModelRoute.PROVIDER_ID,
      id: 'r',
      settings: { [ModelRoute.SETTING]: built },
    } as unknown as Parameters<typeof ModelRoute.definition>[0]
    const decoded = ModelRoute.definition(info)
    expect(decoded?.nodes[0].schedules).toEqual([{ window, match: { targets: ['p/b'] }, factor: 10 }])
    // The resolved holiday exclusion is active today, so the rule stays out of force.
    expect(ModelRoute.orderTargets(decoded!, ready(2), undefined, false)).toEqual([0, 1])
  })
})

describe("ModelRoute window gates", () => {
  const flash = ModelRoute.ref({ providerID: "p", model: "flash" })
  const mimo = ModelRoute.ref({ providerID: "p", model: "mimo" })
  const always = { timezone: "UTC" as const }
  // A window active only tomorrow (UTC), following the scheduled-weights tests above.
  const tomorrow = { daysOfWeek: [(new Date().getUTCDay() + 1) % 7], timezone: "UTC" }
  const ready = new Set([0, 1])

  test("gateOpen is open with no gate, follows the window, and invert flips it", () => {
    // January 5, 2026 is a Monday; 15:00 UTC is inside 09:00-17:00.
    const monday = Date.UTC(2026, 0, 5, 15, 0)
    const peak = { daysOfWeek: [1], start: "09:00", end: "17:00", timezone: "UTC" }
    expect(ModelRoute.gateOpen(undefined, monday)).toBe(true)
    expect(ModelRoute.gateOpen({ name: "peak", window: peak }, monday)).toBe(true)
    expect(ModelRoute.gateOpen({ name: "peak", window: peak, invert: true }, monday)).toBe(false)
    expect(ModelRoute.gateOpen({ name: "peak", window: { daysOfWeek: [2], timezone: "UTC" } }, monday)).toBe(false)
    expect(ModelRoute.gateOpen({ name: "peak", window: { daysOfWeek: [2], timezone: "UTC" }, invert: true }, monday)).toBe(
      true,
    )
  })

  test("an ordered route resolves flash then mimo off-peak and mimo then flash at peak", () => {
    const gated = (peak: ModelRoute.ScheduleWindow) =>
      ({
        id: "r",
        targets: [flash, mimo],
        targetVariants: [],
        health: ModelRoute.policy(),
        nodes: [
          {
            routeID: "r",
            selection: "ordered",
            weights: [1, 1, 1],
            children: [
              { node: 1, gate: { name: "peak", window: peak, invert: true } },
              { node: 2 },
              { node: 3, gate: { name: "peak", window: peak } },
            ],
          },
          { routeID: "flash-plan", selection: "ordered", weights: [1], children: [{ leaf: 0 }] },
          { routeID: "mimo-plan", selection: "ordered", weights: [1], children: [{ leaf: 1 }] },
          { routeID: "flash-peak", selection: "ordered", weights: [1], children: [{ leaf: 0 }] },
        ],
      }) as unknown as ModelRoute.Definition
    // Peak window inactive (tomorrow only): the inverted gate is open, the peak gate is closed.
    expect(ModelRoute.orderTargets(gated(tomorrow), ready, undefined, false)).toEqual([0, 1])
    // Peak window active (always): the inverted gate is closed, the peak gate is open.
    expect(ModelRoute.orderTargets(gated(always), ready, undefined, false)).toEqual([1, 0])
  })

  test("a gate-closed leaf inside an ungated nested group does not strand its ready sibling", () => {
    const nested = (gate: ModelRoute.Gate) =>
      ({
        id: "r",
        targets: [flash, mimo],
        targetVariants: [],
        health: ModelRoute.policy(),
        nodes: [
          {
            selection: "ordered",
            weights: [1, 1],
            children: [{ node: 1 }, { leaf: 1 }],
          },
          { selection: "ordered", weights: [1], children: [{ leaf: 0, gate }] },
        ],
      }) as unknown as ModelRoute.Definition
    const closed = nested({ name: "peak", window: tomorrow })
    expect(ModelRoute.nextTarget(closed, ready, new Set(), undefined, false)).toBe(1)
    expect(ModelRoute.orderTargets(closed, ready, undefined, false)).toEqual([1])
    // The same shape with the inner gate open resolves the inner leaf first.
    expect(ModelRoute.orderTargets(nested({ name: "peak", window: always }), ready, undefined, false)).toEqual([0, 1])
    // An inverted gate on an always-active window is closed at every depth too.
    expect(
      ModelRoute.orderTargets(nested({ name: "peak", window: always, invert: true }), ready, undefined, false),
    ).toEqual([1])
  })

  test("a fully gate-closed route still returns no target", () => {
    const route = {
      id: "r",
      targets: [flash, mimo],
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [
        {
          selection: "ordered",
          weights: [1, 1],
          children: [{ node: 1 }, { leaf: 1, gate: { name: "peak", window: tomorrow } }],
        },
        {
          selection: "ordered",
          weights: [1],
          children: [{ leaf: 0, gate: { name: "peak", window: tomorrow } }],
        },
      ],
    } as unknown as ModelRoute.Definition
    expect(ModelRoute.nextTarget(route, ready, new Set(), undefined, false)).toBeUndefined()
    expect(ModelRoute.orderTargets(route, ready, undefined, false)).toEqual([])
  })

  test("a closed gate on a leaf removes only that leaf", () => {
    const route = {
      id: "r",
      targets: [flash, mimo],
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [
        {
          selection: "ordered",
          weights: [1, 1],
          children: [{ leaf: 0, gate: { name: "peak", window: tomorrow } }, { leaf: 1 }],
        },
      ],
    } as unknown as ModelRoute.Definition
    expect(ModelRoute.orderTargets(route, ready, undefined, false)).toEqual([1])
  })
})

describe("ModelRoute per-target context limits", () => {
  const limited = (targetLimits: ({ context?: number } | undefined)[], routeCap?: number) =>
    ({
      id: "r",
      targets: targetLimits.map((_, index) => ModelRoute.ref({ providerID: "p", model: `m${index}` })),
      targetVariants: [],
      health: ModelRoute.policy(),
      ...(routeCap !== undefined ? { limit: { context: routeCap } } : {}),
      ...(targetLimits.some((item) => item !== undefined)
        ? { targetLimits: targetLimits.map((item) => item ?? {}) }
        : {}),
      nodes: [
        {
          selection: "ordered" as const,
          weights: targetLimits.map(() => 1),
          children: targetLimits.map((_, index) => ({ leaf: index })),
        },
      ],
    }) as unknown as ModelRoute.Definition

  test("contextCeiling is the smaller of the route cap and the leaf ceiling", () => {
    expect(ModelRoute.contextCeiling(limited([]), 0)).toBeUndefined()
    expect(ModelRoute.contextCeiling(limited([undefined], 100_000), 0)).toBe(100_000)
    expect(ModelRoute.contextCeiling(limited([{ context: 200_000 }]), 0)).toBe(200_000)
    expect(ModelRoute.contextCeiling(limited([{ context: 200_000 }], 100_000), 0)).toBe(100_000)
    expect(ModelRoute.contextCeiling(limited([{ context: 100_000 }], 200_000), 0)).toBe(100_000)
  })

  test("overLimit skips a request that fits neither ceiling, and never filters an unknown size", () => {
    const both = limited([{ context: 200_000 }], 100_000)
    expect(ModelRoute.overLimit(both, 0, undefined)).toBe(false)
    expect(ModelRoute.overLimit(both, 0, 100_000)).toBe(false)
    expect(ModelRoute.overLimit(both, 0, 100_001)).toBe(true)
    // The route cap binds even though the leaf ceiling is larger.
    expect(ModelRoute.overLimit(limited([{ context: 200_000 }], 100_000), 0, 150_000)).toBe(true)
    // The leaf ceiling binds even though the route cap is larger.
    expect(ModelRoute.overLimit(limited([{ context: 200_000 }], 300_000), 0, 250_000)).toBe(true)
    expect(ModelRoute.overLimit(limited([{ context: 200_000 }], 300_000), 0, 150_000)).toBe(false)
    // A leaf with no ceiling always fits, with or without a route cap elsewhere.
    expect(ModelRoute.overLimit(limited([undefined], 100_000), 0, 90_000)).toBe(false)
    expect(ModelRoute.overLimit(limited([undefined]), 0, 10_000_000)).toBe(false)
  })

  test("a definition with limits survives the settings round trip", () => {
    const built = limited([{ context: 100_000 }, {}], 200_000)
    const info = {
      providerID: ModelRoute.PROVIDER_ID,
      id: "r",
      settings: { [ModelRoute.SETTING]: built },
    } as unknown as Parameters<typeof ModelRoute.definition>[0]
    const decoded = ModelRoute.definition(info)
    expect(decoded?.limit).toEqual({ context: 200_000 })
    expect(decoded?.targetLimits).toEqual([{ context: 100_000 }, {}])
  })
})

describe("ModelRoute round-robin tiers (#1122)", () => {
  const policy = ModelRoute.policy()
  const leaf = (model: string) => ModelRoute.ref({ providerID: "tiers-p", model })
  const flat = (id: string, weights: number[], targets: ModelRoute.Target[]) =>
    ({
      id,
      targets,
      targetVariants: [],
      health: policy,
      nodes: [
        { selection: "round-robin" as const, weights, children: targets.map((_, index) => ({ leaf: index })) },
      ],
    }) as unknown as ModelRoute.Definition
  const head = (route: ModelRoute.Definition, ready: ReadonlySet<number>, session: string) =>
    ModelRoute.nextTarget(route, ready, new Set(), session, true)

  test("a single tier rotates evenly across sessions, as plain round-robin always did", () => {
    const route = flat("tier-single", [1, 1, 1], [leaf("a"), leaf("b"), leaf("c")])
    const all = new Set([0, 1, 2])
    const heads = ["s1", "s2", "s3", "s4", "s5", "s6"].map((session) => head(route, all, session))
    expect(heads).toEqual([0, 1, 2, 0, 1, 2])
  })

  test("the lower tier is never drawn while any top-tier member is ready", () => {
    const route = flat("tier-two", [2, 2, 1], [leaf("a"), leaf("b"), leaf("c")])
    const all = new Set([0, 1, 2])
    const heads = ["s1", "s2", "s3", "s4"].map((session) => head(route, all, session))
    expect(heads).toEqual([0, 1, 0, 1])
    // The session-less walk order is the tier order too: both weight-2 leaves before the weight-1.
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([0, 1, 2])
    const walked = ModelRoute.orderTargets(route, all, "sx", true)
    expect([...walked.slice(0, 2)].sort()).toEqual([0, 1])
    expect(walked[2]).toBe(2)
  })

  test("the next tier engages once every member above it has failed or left", () => {
    const route = flat("tier-fall", [2, 2, 1], [leaf("a"), leaf("b"), leaf("c")])
    // Top tier unavailable: the weight-1 leaf serves.
    expect(head(route, new Set([2]), "down")).toBe(2)
    // Top tier tried within this dispatch: the walk falls through instead of retrying it.
    expect(ModelRoute.nextTarget(route, new Set([0, 1, 2]), new Set([0, 1]), "walk", true)).toBe(2)
  })

  test("a session stuck to a lower tier returns to the top tier when it recovers", () => {
    const route = flat("tier-sticky", [2, 1], [leaf("a"), leaf("b")])
    expect(head(route, new Set([1]), "s1")).toBe(1)
    // The top tier is back: the sticky pick in the lower tier no longer binds the session.
    expect(head(route, new Set([0, 1]), "s1")).toBe(0)
    expect(ModelRoute.sessionTarget("tier-sticky#0", "s1")).toBe(0)
  })

  test("rotation persists across dispatches inside the tier, wrapping instead of falling through", () => {
    const route = flat("tier-cycle", [2, 2, 2, 1], [leaf("a"), leaf("b"), leaf("c"), leaf("d")])
    const all = new Set([0, 1, 2, 3])
    const heads = ["s1", "s2", "s3", "s4", "s5", "s6"].map((session) => head(route, all, session))
    expect(heads).toEqual([0, 1, 2, 0, 1, 2])
  })

  test("an unset weight lands in the same tier as weight 1", () => {
    // Only the first target lists a weight; the other two default to 1.
    const route = flat("tier-default", [2], [leaf("a"), leaf("b"), leaf("c")])
    const all = new Set([0, 1, 2])
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([0, 1, 2])
    // The lone weight-2 target is the whole top tier, so every session starts there.
    expect(head(route, all, "s1")).toBe(0)
    expect(head(route, all, "s2")).toBe(0)
    // With it gone, the two default-weight targets rotate evenly between themselves.
    const rest = new Set([1, 2])
    const heads = ["t1", "t2", "t3", "t4"].map((session) => head(route, rest, session))
    expect(heads).toEqual([1, 2, 1, 2])
  })

  test("a quota-demoted leaf sorts below every live tier, whatever its weight, and still serves last", () => {
    const heavy = leaf("heavy")
    const route = flat("tier-demoted", [100, 2, 1], [heavy, leaf("mid"), leaf("low")])
    const now = Date.now()
    for (const at of [now, now + 1_000, now + 2_000]) ModelRoute.failed(heavy, policy, at, { quota: true })
    expect(ModelRoute.demoted(heavy)).toBe(true)
    const all = new Set([0, 1, 2])
    // Weight order among the live tiers (2 before 1); the demoted 100 goes last — the old 0.01
    // factor would have tied it with the weight-1 leaf in configured order, [1, 0, 2].
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([1, 2, 0])
    // Draws stay in the live tiers while any of them can serve...
    expect(head(route, all, "d1")).toBe(1)
    expect(ModelRoute.nextTarget(route, all, new Set([1]), "d2", true)).toBe(2)
    // ...and the demoted leaf is the last resort, not a refusal.
    expect(ModelRoute.nextTarget(route, all, new Set([1, 2]), "d3", true)).toBe(0)
  })

  test("a nested route reference is a tier member with its group weight", () => {
    const targets = [leaf("a"), leaf("b"), leaf("c")]
    const build = (weights: number[]) =>
      ({
        id: "tier-nested",
        targets,
        targetVariants: [],
        health: policy,
        nodes: [
          { selection: "round-robin" as const, weights, children: [{ node: 1 }, { leaf: 2 }] },
          { routeID: "inner", selection: "round-robin" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
        ],
      }) as unknown as ModelRoute.Definition
    const all = new Set([0, 1, 2])

    // Group at weight 2 over the weight-1 leaf: sessions rotate inside the group, leaf 2 waits.
    const grouped = build([2, 1])
    const heads = ["g1", "g2", "g3", "g4"].map((session) => head(grouped, all, session))
    expect(heads).toEqual([0, 1, 0, 1])
    expect(ModelRoute.orderTargets(grouped, all, undefined, false)).toEqual([0, 1, 2])
    expect(head(grouped, new Set([2]), "only")).toBe(2)

    // Leaf at weight 2 over the weight-1 group: the leaf is the top tier now.
    ModelRoute.resetSelection()
    const leafFirst = build([1, 2])
    expect(head(leafFirst, all, "top")).toBe(2)
    expect(ModelRoute.orderTargets(leafFirst, all, undefined, false)).toEqual([2, 0, 1])
  })

  test("a group whose every door is demoted drops below the live tiers as one demoted member", () => {
    const a = leaf("ga")
    const b = leaf("gb")
    const route = {
      id: "tier-group-demoted",
      targets: [a, b, leaf("gc")],
      targetVariants: [],
      health: policy,
      nodes: [
        { selection: "round-robin" as const, weights: [2, 1], children: [{ node: 1 }, { leaf: 2 }] },
        { routeID: "inner", selection: "round-robin" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
      ],
    } as unknown as ModelRoute.Definition
    const now = Date.now()
    for (const target of [a, b])
      for (const at of [now, now + 1_000, now + 2_000]) ModelRoute.failed(target, policy, at, { quota: true })
    const all = new Set([0, 1, 2])
    // The weight-2 group is demoted as a unit: the weight-1 leaf leads, the group serves after.
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([2, 0, 1])
    expect(head(route, all, "gd")).toBe(2)
  })
})

describe("ModelRoute provider route groups", () => {
  const policy = ModelRoute.policy()
  const alt = ModelRoute.ref({ providerID: "route-alt", model: "m" })
  const main = ModelRoute.ref({ providerID: "route-main", model: "m" })
  const build = (selection: "ordered" | "round-robin" | "weighted", weights: number[] = [1, 1]) =>
    ({
      id: "outer-route",
      targets: [alt, main],
      targetVariants: [],
      health: policy,
      nodes: [
        { selection: "ordered" as const, weights: [1], children: [{ node: 1 }] },
        { routeID: "plan", providerRoute: "plan", selection, weights, children: [{ leaf: 0 }, { leaf: 1 }] },
      ],
    }) as unknown as ModelRoute.Definition
  const all = new Set([0, 1])
  const demote = (target: ModelRoute.Target) => {
    const now = Date.now()
    for (const at of [now, now + 1_000, now + 2_000]) ModelRoute.failed(target, policy, at, { quota: true })
    expect(ModelRoute.demoted(target)).toBe(true)
  }

  test("ordered: the first ready member serves, and an unavailable member falls through", () => {
    const route = build("ordered")
    expect(ModelRoute.nextTarget(route, all, new Set(), "s1", true)).toBe(0)
    // The resolver expresses a benched member by leaving it out of the ready set.
    expect(ModelRoute.nextTarget(route, new Set([1]), new Set(), "s2", true)).toBe(1)
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([0, 1])
  })

  test("ordered: a quota-demoted member drops behind the live member and still serves last", () => {
    demote(alt)
    const route = build("ordered")
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([1, 0])
    expect(ModelRoute.nextTarget(route, all, new Set(), "d1", true)).toBe(1)
    expect(ModelRoute.nextTarget(route, all, new Set([1]), "d2", true)).toBe(0)
  })

  test("round-robin: a quota-demoted member sorts below the live tier inside the group", () => {
    demote(alt)
    const route = build("round-robin", [2, 1])
    // Alt outweighs main 2:1, but demotion holds it below the live tier: main serves,
    // and the demoted member remains the last resort rather than a refusal.
    expect(ModelRoute.nextTarget(route, all, new Set(), "r1", true)).toBe(1)
    expect(ModelRoute.nextTarget(route, all, new Set([1]), "r2", true)).toBe(0)
    expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([1, 0])
  })

  test("the decision records show the provider route resolution: the group under its own id, the member it chose", () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))
    try {
      expect(ModelRoute.nextTarget(build("ordered"), all, new Set(), "dec-session", true)).toBe(0)
    } finally {
      ModelRouteLog.setSink(undefined)
    }
    const decisions = events.flatMap((event) => (event.kind === "decision" ? [event.row] : []))
    const inner = decisions.find((row) => row.route_id === "plan")
    expect(inner?.candidates).toEqual(["route-alt/m", "route-main/m"])
    expect(inner?.chosen).toBe("route-alt/m")
    const outer = decisions.find((row) => row.route_id === "outer-route")
    expect(outer?.candidates).toEqual(["plan/m"])
    expect(outer?.chosen).toBe("plan/m")
  })
})

describe("ModelRoute machinery constants (experimental.model_route_settings)", () => {
  const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-sol" })
  const policy = ModelRoute.policy({ cooldownMs: 60_000 })

  afterEach(() => {
    ModelRoute.onSettingsConfig(() => undefined)
    ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS)
    ModelRoute.configure({
      escalation: { enabled: true, afterGiveUps: 2 },
      quota: { demoteAfter: 3, windowMs: 4 * 3_600_000 },
    })
  })

  test("the resolved defaults are exactly the machinery's named constants", () => {
    expect(ModelRoute.currentConstants()).toEqual({
      bench: {
        maxCooldownMs: 86_400_000,
        multiplier: 2,
        retryAfterMinMs: 1_000,
        cooldownCapMs: 3_600_000,
        quotaCooldownCapMs: 86_400_000,
      },
      demotion: { factor: 0.01 },
      quotaGate: {
        maxMs: 30 * 86_400_000,
        fallbackMs: 30 * 60_000,
        feedTtlMs: 60_000,
        balanceDeadThreshold: 0.1,
      },
      escalation: { outcomeWindow: 5 },
      network: { windowMs: 30_000, providers: 3, providerModels: 2 },
      continuity: { hedgeRequests: 2 },
      overrides: { preferredFactor: 3 },
    })
    expect(ModelRoute.currentConstants()).toEqual(ModelRoute.DEFAULT_CONSTANTS)
  })

  test("the bench ladder doubles toward the 24h cap by default, and stops at a configured cap", () => {
    const now = 1_000_000
    ModelRoute.failed(target, policy, now)
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 60_000)
    ModelRoute.failed(target, policy, now)
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 120_000)

    ModelRoute.resetHealth()
    ModelRoute.configureConstants({ bench: { maxCooldownMs: 5_000 } })
    ModelRoute.failed(target, policy, now)
    // A bench that would run a full minute stops at the configured cap.
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 5_000)
  })

  test("the bench multiplier and the caps on the health bases are configurable", () => {
    const quick = ModelRoute.policy({ cooldownMs: 1_000 })
    const now = 2_000_000
    ModelRoute.configureConstants({ bench: { multiplier: 3 } })
    ModelRoute.failed(target, quick, now)
    ModelRoute.failed(target, quick, now)
    ModelRoute.failed(target, quick, now)
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 9_000)

    expect(ModelRoute.policy({ cooldownMs: 999_999_999 }).cooldownMs).toBe(3_600_000)
    expect(ModelRoute.policy({ quotaCooldownMs: 999_999_999 }).quotaCooldownMs).toBe(86_400_000)
    ModelRoute.configureConstants({ bench: { cooldownCapMs: 120_000, quotaCooldownCapMs: 7_200_000 } })
    expect(ModelRoute.policy({ cooldownMs: 999_999_999 }).cooldownMs).toBe(120_000)
    expect(ModelRoute.policy({ quotaCooldownMs: 999_999_999 }).quotaCooldownMs).toBe(7_200_000)
  })

  test("demotion threshold and factor are configurable", () => {
    const now = Date.now()
    ModelRoute.configureConstants({ demotion: { factor: 0.5 } })
    ModelRoute.configure({ quota: { demoteAfter: 2 } })
    ModelRoute.failed(target, policy, now, { quota: true })
    expect(ModelRoute.demoted(target, now + 1)).toBe(false)
    ModelRoute.failed(target, policy, now + 1, { quota: true })
    expect(ModelRoute.demoted(target, now + 2)).toBe(true)
    expect(ModelRoute.weightOf(target, 2, now + 2)).toBe(1)
  })

  test("the quota gate believes a stated reset up to the cap and falls back when none is stated", () => {
    const now = 100_000_000
    ModelRoute.observeQuotaFailure(target, "settings-cred-a", now + 90 * 86_400_000, now)
    expect(ModelRoute.credentialQuotaBlocked("settings-cred-a", now)?.until).toBe(now + 30 * 86_400_000)
    ModelRoute.observeQuotaFailure(target, "settings-cred-b", undefined, now)
    expect(ModelRoute.credentialQuotaBlocked("settings-cred-b", now)?.until).toBe(now + 30 * 60_000)
  })

  test("the quota gate fallback and cap are configurable", () => {
    const now = 100_000_000
    ModelRoute.configureConstants({ quotaGate: { fallbackMs: 10_000, maxMs: 60_000 } })
    ModelRoute.observeQuotaFailure(target, "settings-cred-c", undefined, now)
    expect(ModelRoute.credentialQuotaBlocked("settings-cred-c", now)?.until).toBe(now + 10_000)
    ModelRoute.observeQuotaFailure(target, "settings-cred-d", now + 3_600_000, now)
    expect(ModelRoute.credentialQuotaBlocked("settings-cred-d", now)?.until).toBe(now + 60_000)
  })

  test("the quota feed interval follows the gate constants", () => {
    ModelRoute.resetQuotaFeed()
    expect(ModelRoute.shouldFeedQuota(1_000_000)).toBe(true)
    expect(ModelRoute.shouldFeedQuota(1_030_000)).toBe(false)
    expect(ModelRoute.shouldFeedQuota(1_061_000)).toBe(true)
    ModelRoute.resetQuotaFeed()
    ModelRoute.configureConstants({ quotaGate: { feedTtlMs: 10_000 } })
    expect(ModelRoute.shouldFeedQuota(2_000_000)).toBe(true)
    expect(ModelRoute.shouldFeedQuota(2_005_000)).toBe(false)
    expect(ModelRoute.shouldFeedQuota(2_011_000)).toBe(true)
  })

  test("the escalation outcome window is configurable", () => {
    const ok = { firstTokenMs: 10, responseMs: 20, tokensPerSecond: 50 }
    const other = ModelRoute.ref({ providerID: "openai", model: "gpt-6-terra" })
    // Default window (5): two give-ups still count after two successes.
    ModelRoute.failed(target, policy, 1_000)
    ModelRoute.failed(target, policy, 2_000)
    ModelRoute.completed(target, policy, ok, 3_000)
    ModelRoute.completed(target, policy, ok, 4_000)
    expect(ModelRoute.escalates(target)).toBe(true)
    // Window of 3: the successes push the older give-up out of the window.
    ModelRoute.configureConstants({ escalation: { outcomeWindow: 3 } })
    ModelRoute.failed(other, policy, 1_000)
    ModelRoute.failed(other, policy, 2_000)
    ModelRoute.completed(other, policy, ok, 3_000)
    ModelRoute.completed(other, policy, ok, 4_000)
    expect(ModelRoute.escalates(other)).toBe(false)
  })

  test("settings readers are scoped per Location, in either activation order", () => {
    const offA = ModelRoute.onSettingsConfig(
      () => ({ demotion: { after: 2, factor: 0.5 }, bench: { maxCooldownMs: 5_000 }, escalation: { afterGiveUps: 4 } }),
      "/loc/a",
    )
    const offB = ModelRoute.onSettingsConfig(
      () => ({ demotion: { after: 9, factor: 0.9 }, bench: { maxCooldownMs: 9_000 }, escalation: { afterGiveUps: 7 } }),
      "/loc/b",
    )
    try {
      // B activated last: before #1423 its reader would have governed A too.
      expect(ModelRoute.currentSettings("/loc/a").escalation.afterGiveUps).toBe(4)
      expect(ModelRoute.currentSettings("/loc/b").escalation.afterGiveUps).toBe(7)
      expect(ModelRoute.currentConstants("/loc/a").bench.maxCooldownMs).toBe(5_000)
      expect(ModelRoute.currentConstants("/loc/b").bench.maxCooldownMs).toBe(9_000)
      expect(ModelRoute.currentConstants("/loc/a").demotion.factor).toBe(0.5)
      // An unscoped read with two Locations registered cannot know which it serves:
      // it must fall back to the defaults rather than leak either Location's config.
      expect(ModelRoute.currentSettings().escalation.afterGiveUps).toBe(2)
      expect(ModelRoute.currentConstants()).toEqual(ModelRoute.DEFAULT_CONSTANTS)
    } finally {
      offA()
      offB()
    }
  })

  test("a Location with no settings block gets defaults without disturbing others", () => {
    const offA = ModelRoute.onSettingsConfig(() => ({ escalation: { afterGiveUps: 4 } }), "/loc/a")
    const offB = ModelRoute.onSettingsConfig(() => undefined, "/loc/b")
    try {
      expect(ModelRoute.currentSettings("/loc/b").escalation.afterGiveUps).toBe(2)
      expect(ModelRoute.currentSettings("/loc/a").escalation.afterGiveUps).toBe(4)
    } finally {
      offA()
      offB()
    }
  })

  test("config feeds both layers at once, and behavior follows", () => {
    ModelRoute.onSettingsConfig(() => ({
      demotion: { after: 2, factor: 0.5 },
      bench: { maxCooldownMs: 5_000 },
      escalation: { afterGiveUps: 4 },
    }))
    expect(ModelRoute.currentSettings()).toEqual({
      escalation: { enabled: true, afterGiveUps: 4 },
      quota: { demoteAfter: 2, windowMs: 4 * 3_600_000 },
    })
    expect(ModelRoute.currentConstants().bench.maxCooldownMs).toBe(5_000)
    expect(ModelRoute.currentConstants().demotion.factor).toBe(0.5)

    const now = Date.now()
    ModelRoute.failed(target, policy, now)
    expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 5_000)
    ModelRoute.failed(target, policy, now, { quota: true })
    ModelRoute.failed(target, policy, now + 1, { quota: true })
    expect(ModelRoute.demoted(target, now + 2)).toBe(true)
    expect(ModelRoute.weightOf(target, 2, now + 2)).toBe(1)
  })
})

describe("ModelRoute provider-route groups with no ready members", () => {
  const sibling = ModelRoute.ref({ providerID: "opendesign", model: "gpt-6-luna" })
  const groupNode = {
    routeID: "plan",
    providerRoute: "plan",
    selection: "ordered" as const,
    weights: [] as number[],
    children: [] as never[],
  }
  const capture = () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))
    return {
      stop: () => ModelRouteLog.setSink(undefined),
      decisions: () => events.flatMap((event) => (event.kind === "decision" ? [event.row] : [])),
    }
  }

  test("a leafless provider-route group appears in the parent decision's excluded list with a reason", () => {
    const definition = {
      id: "luna-plan",
      targets: [sibling],
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [{ selection: "round-robin" as const, weights: [2.5, 1], children: [{ node: 1 }, { leaf: 0 }] }, groupNode],
    } as unknown as ModelRoute.Definition
    const cap = capture()
    try {
      expect(ModelRoute.nextTarget(definition, new Set([0]), new Set(), undefined, false)).toBe(0)
    } finally {
      cap.stop()
    }
    const parent = cap.decisions().find((row) => row.route_id === "luna-plan")
    expect(parent?.chosen).toBe("opendesign/gpt-6-luna")
    expect((parent?.detail as { excluded?: unknown } | undefined)?.excluded).toContainEqual({
      candidate: "plan",
      reason: "no-ready-members",
    })
  })

  test("a route whose only seat is a leafless group records the exclusion on its no-candidates decision", () => {
    const definition = {
      id: "terra-plan",
      targets: [],
      targetVariants: [],
      health: ModelRoute.policy(),
      nodes: [{ selection: "round-robin" as const, weights: [1], children: [{ node: 1 }] }, groupNode],
    } as unknown as ModelRoute.Definition
    const cap = capture()
    try {
      expect(ModelRoute.nextTarget(definition, new Set(), new Set(), undefined, false)).toBeUndefined()
    } finally {
      cap.stop()
    }
    const row = cap.decisions().find((item) => item.route_id === "terra-plan")
    expect(row?.reason).toBe("no-candidates")
    expect((row?.detail as { excluded?: unknown } | undefined)?.excluded).toContainEqual({
      candidate: "plan",
      reason: "no-ready-members",
    })
  })
})

describe("ModelRoute pool-shaped quota pull-out (#1014 PR3)", () => {
  const policy = ModelRoute.policy({ cooldownMs: 5_000, quotaCooldownMs: 60_000 })
  const leaves = [0, 1, 2].map((index) => ModelRoute.ref({ providerID: `pool-p${index}`, model: `m${index}` }))
  const outside = ModelRoute.ref({ providerID: "pool-outside", model: "solo" })
  // Root: the pool group (leaves 0-2, one nested route) plus one leaf that belongs to no pool.
  const definition = {
    id: "pool-route",
    targets: [...leaves, outside],
    targetVariants: [],
    health: policy,
    nodes: [
      { selection: "ordered" as const, weights: [1, 1], children: [{ node: 1 }, { leaf: 3 }] },
      { routeID: "pool-plan", selection: "ordered" as const, weights: [1, 1, 1], children: [{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }] },
    ],
  } as unknown as ModelRoute.Definition

  test("two distinct leaves answering quota in turn pull the whole pool; expiry re-admits it", () => {
    ModelRoute.resetHealth()
    const now = Date.now()
    expect(ModelRoute.poolIDOf(definition, 2)).toBe("pool-plan")
    expect(ModelRoute.poolIDOf(definition, 3)).toBeUndefined()
    expect(ModelRoute.poolQuotaExhausted(definition, 2, now)).toBe(false)

    // One leaf's quota answer is leaf-shaped: the pool still serves through its other leaves.
    ModelRoute.failed(leaves[0], policy, now, { quota: true })
    expect(ModelRoute.poolQuotaExhausted(definition, 2, now)).toBe(false)

    // A second distinct leaf answering quota is the pool-shaped signal: the remaining leaf
    // is pulled with its pool instead of being spent next.
    ModelRoute.failed(leaves[1], policy, now, { quota: true })
    expect(ModelRoute.poolQuotaExhausted(definition, 2, now)).toBe(true)
    expect(ModelRoute.poolQuotaExhausted(definition, 0, now)).toBe(true)
    // A leaf outside the pool is never pulled by the pool's exhaustion.
    expect(ModelRoute.poolQuotaExhausted(definition, 3, now)).toBe(false)

    // Restoration is automatic: once the quota benches expire the pool re-enters rotation.
    expect(ModelRoute.poolQuotaExhausted(definition, 2, now + 60_001)).toBe(false)
    ModelRoute.resetHealth()
  })

  test("reactive quota gates on two leaves' providers exhaust the pool until the stated reset", () => {
    ModelRoute.resetHealth()
    const now = Date.now()
    const resetAt = now + 30 * 60_000
    ModelRoute.observeQuotaFailure(leaves[0], undefined, resetAt, now)
    expect(ModelRoute.poolQuotaExhausted(definition, 2, now)).toBe(false)
    ModelRoute.observeQuotaFailure(leaves[1], undefined, resetAt, now)
    expect(ModelRoute.poolQuotaExhausted(definition, 2, now)).toBe(true)
    // The pull-out holds until the reset the providers stated, then lifts by itself.
    expect(ModelRoute.poolQuotaExhausted(definition, 2, resetAt + 1)).toBe(false)
    ModelRoute.resetHealth()
  })
})
