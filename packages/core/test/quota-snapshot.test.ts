import { describe, expect, test } from "bun:test"
import { ModelPlan } from "@opencode/core/model-plan"
import { ModelUsage } from "@opencode/core/model-usage"
import { QuotaSnapshot } from "@opencode/core/quota-snapshot"

const totals = (overrides: Partial<ModelUsage.Totals> = {}): ModelUsage.Totals => ({
  requests: 0,
  failures: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  cacheSavedUsd: 0,
  ...overrides,
})

const plan = {
  id: "anthropic-max",
  providerID: "anthropic",
  label: "Personal",
  coverage: "subscription",
  quotas: [],
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} as ModelPlan.Plan

const window = {
  name: "5-hour",
  unit: "messages",
  limit: 200,
  windowHours: 5,
  resetRule: "rolling",
} as ModelPlan.QuotaWindow

const now = Date.parse("2026-10-27T12:00:00.000Z")

describe("QuotaSnapshot", () => {
  test("a normal window derives percent and remaining from windowReport", () => {
    // Hand-computed: 50 of a 200-message limit is 25%, leaving 150.
    const snapshot = QuotaSnapshot.derive({ plan, window, totals: totals({ requests: 50 }), observedAt: now }, { now })
    expect(snapshot).toEqual({
      planID: "anthropic-max",
      window: "5-hour",
      providerID: "anthropic",
      percent: 25,
      remaining: 150,
      resetAt: null,
      observedAt: now,
      stale: false,
    })
    expect(QuotaSnapshot.known(snapshot)).toBe(true)
  })

  test("a window with no limit yields percent null, never a guess", () => {
    const { limit: _limit, ...rest } = window
    const snapshot = QuotaSnapshot.derive(
      { plan, window: rest as ModelPlan.QuotaWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    expect(snapshot.percent).toBeNull()
    expect(snapshot.remaining).toBeNull()
    expect(QuotaSnapshot.known(snapshot)).toBe(false)
  })

  test("a window with no windowHours yields percent null even with a limit", () => {
    const { windowHours: _windowHours, ...rest } = window
    const snapshot = QuotaSnapshot.derive(
      { plan, window: rest as ModelPlan.QuotaWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    expect(snapshot.percent).toBeNull()
    expect(snapshot.remaining).toBeNull()
  })

  test("a credits USD balance is known-full at ten cents and keeps its amount without a window", () => {
    const creditPlan = { ...plan, coverage: "credits" } as ModelPlan.Plan
    const balanceWindow = { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow
    const snapshot = QuotaSnapshot.derive(
      { plan: creditPlan, window: balanceWindow, totals: totals({ costUsd: 1.9 }), observedAt: now },
      { now },
    )

    expect(snapshot).toMatchObject({ balance: true, expired: false, percent: 100 })
    expect(snapshot.remaining).toBeCloseTo(0.1)
    expect(QuotaSnapshot.isKnownFull(snapshot, now)).toBe(true)
  })

  test("the balance-dead threshold is configurable", () => {
    const snapshot = QuotaSnapshot.derive(
      {
        plan: { ...plan, coverage: "credits" } as ModelPlan.Plan,
        window: { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow,
        totals: totals({ costUsd: 1.8 }),
        observedAt: now,
      },
      { now, balanceDeadThreshold: 0.25 },
    )

    expect(snapshot.remaining).toBeCloseTo(0.2)
    expect(QuotaSnapshot.isKnownFull(snapshot, now, 0.25)).toBe(true)
  })

  test("an expired credit grant is known-full even with a positive balance", () => {
    const creditPlan = {
      ...plan,
      coverage: "credits",
      expiresOn: "2026-10-27T11:59:00.000Z",
    } as ModelPlan.Plan
    const balanceWindow = { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow
    const snapshot = QuotaSnapshot.derive(
      { plan: creditPlan, window: balanceWindow, totals: totals(), observedAt: now },
      { now },
    )

    expect(snapshot).toMatchObject({ balance: true, expired: true, percent: 100, remaining: 2 })
    expect(QuotaSnapshot.isKnownFull(snapshot, now)).toBe(true)
  })

  test("an observation older than the configured max age is stale; a fresh one is not", () => {
    const input = { plan, window, totals: totals({ requests: 50 }) }
    const fresh = QuotaSnapshot.derive({ ...input, observedAt: now - 30 * 60_000 }, { now, maxAgeMs: 3_600_000 })
    const stale = QuotaSnapshot.derive({ ...input, observedAt: now - 61 * 60_000 }, { now, maxAgeMs: 3_600_000 })
    expect(fresh.stale).toBe(false)
    expect(stale.stale).toBe(true)
    expect(QuotaSnapshot.known(stale)).toBe(false)
    // The default max age is the same one hour, and a per-plan override replaces it for that plan.
    expect(QuotaSnapshot.derive({ ...input, observedAt: now - 61 * 60_000 }, { now }).stale).toBe(true)
    expect(
      QuotaSnapshot.derive(
        { ...input, observedAt: now - 61 * 60_000 },
        { now, perPlanMaxAgeMs: { "anthropic-max": 7_200_000 } },
      ).stale,
    ).toBe(false)
  })

  test("a plan named like an Object.prototype member still goes stale when the override record has no own entry for it (#824)", () => {
    const observedAt = now - 61 * 60_000
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const input = { plan: { ...plan, id } as ModelPlan.Plan, window, totals: totals({ requests: 50 }), observedAt }
      // An empty record and a JSON-parsed record naming other plans both lack an own entry for the plan.
      expect(QuotaSnapshot.derive(input, { now, perPlanMaxAgeMs: {} }).stale).toBe(true)
      expect(QuotaSnapshot.derive(input, { now, perPlanMaxAgeMs: JSON.parse('{"other-plan": 7200000}') }).stale).toBe(
        true,
      )
      expect(QuotaSnapshot.known(QuotaSnapshot.derive(input, { now, perPlanMaxAgeMs: {} }))).toBe(false)
    }
  })

  test("an explicit own entry for a prototype-named plan is still honoured as its override (#824)", () => {
    const observedAt = now - 61 * 60_000
    const ctor = { plan: { ...plan, id: "constructor" } as ModelPlan.Plan, window, totals: totals(), observedAt }
    expect(QuotaSnapshot.derive(ctor, { now, perPlanMaxAgeMs: { constructor: 7_200_000 } }).stale).toBe(false)
    // An own "__proto__" key exists only via JSON.parse; an object literal would set the prototype.
    const record = JSON.parse('{"__proto__": 7200000}') as Record<string, number>
    expect(Object.hasOwn(record, "__proto__")).toBe(true)
    const proto = { plan: { ...plan, id: "__proto__" } as ModelPlan.Plan, window, totals: totals(), observedAt }
    expect(QuotaSnapshot.derive(proto, { now, perPlanMaxAgeMs: record }).stale).toBe(false)
  })

  test("resetAt comes from an explicit resetAt or a daily rule, and is null for a rolling rule", () => {
    const explicit = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetAt: "2026-10-27T17:00:00.000Z" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(explicit.resetAt).toBe(Date.parse("2026-10-27T17:00:00.000Z"))

    const daily = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetRule: "daily 00:00 UTC" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(daily.resetAt).toBe(Date.parse("2026-10-28T00:00:00.000Z"))

    const rolling = QuotaSnapshot.derive({ plan, window, totals: totals(), observedAt: now }, { now })
    expect(rolling.resetAt).toBeNull()
  })

  test("calendar-invalid explicit resetAt values yield null instead of a rolled-over reset", () => {
    for (const resetAt of ["2026-02-30T00:00:00.000Z", "2026-02-29T00:00:00.000Z", "2026-04-31T12:00:00.000Z"]) {
      const snapshot = QuotaSnapshot.derive(
        { plan, window: { ...window, resetAt } as ModelPlan.QuotaWindow, totals: totals(), observedAt: now },
        { now },
      )
      expect(snapshot.resetAt).toBeNull()
    }

    const leapDay = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetAt: "2024-02-29T00:00:00.000Z" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(leapDay.resetAt).toBe(Date.parse("2024-02-29T00:00:00.000Z"))
  })

  test("a daily rule with out-of-range components yields null instead of a rolled-over reset", () => {
    for (const resetRule of ["daily 25:99 UTC", "daily 12:60 UTC", "daily 24:30 UTC"]) {
      const snapshot = QuotaSnapshot.derive(
        { plan, window: { ...window, resetRule } as ModelPlan.QuotaWindow, totals: totals(), observedAt: now },
        { now },
      )
      expect(snapshot.resetAt).toBeNull()
    }
  })

  test("well-formed daily rules keep their next-occurrence behaviour, including single-digit hours", () => {
    const later = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetRule: "daily 23:59 UTC" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(later.resetAt).toBe(Date.parse("2026-10-27T23:59:00.000Z"))

    const single = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetRule: "daily 9:05 UTC" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(single.resetAt).toBe(Date.parse("2026-10-28T09:05:00.000Z"))
  })

  test("an explicit resetAt in the past is returned as recorded (a stated fact, not a derivation)", () => {
    const past = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetAt: "2026-10-20T00:00:00.000Z" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(past.resetAt).toBe(Date.parse("2026-10-20T00:00:00.000Z"))
  })

  test("deriveAll yields one snapshot per window of every plan", () => {
    const plans = [
      { ...plan, quotas: [window, { ...window, name: "weekly" }] },
      { ...plan, id: "openai-plus", providerID: "openai", quotas: [window] },
    ] as ModelPlan.Plan[]
    const snapshots = QuotaSnapshot.deriveAll(plans, () => totals({ requests: 50 }), now, { now })
    expect(snapshots.map((snapshot) => `${snapshot.planID}/${snapshot.window}`)).toEqual([
      "anthropic-max/5-hour",
      "anthropic-max/weekly",
      "openai-plus/5-hour",
    ])
    expect(snapshots.every((snapshot) => snapshot.percent === 25)).toBe(true)
  })

  test("gate derivation ignores ended plans: an expired plan's full smaller window does not gate (#1340)", () => {
    // The composition refreshQuotaGate uses: only gate-feeding plans reach deriveAll.
    // The expired/cancelled plans carry a tiny window that usage has completely filled;
    // the active plan's larger window for the same provider is nearly empty.
    const small = { ...window, limit: 10 }
    const plans = [
      { ...plan, id: "anthropic-current", quotas: [{ ...window, limit: 1000 }] },
      { ...plan, id: "anthropic-expired", status: "expired", quotas: [small] },
      { ...plan, id: "anthropic-cancelled", status: "cancelled", quotas: [small] },
    ] as ModelPlan.Plan[]
    const usage = (candidate: ModelPlan.Plan) => totals({ requests: 10 })
    const snapshots = QuotaSnapshot.deriveAll(plans.filter(ModelPlan.feedsGate), usage, now, { now })
    expect(snapshots.map((snapshot) => snapshot.planID)).toEqual(["anthropic-current"])
    const gating = QuotaSnapshot.gatingSnapshot(snapshots, now)
    expect(gating?.planID).toBe("anthropic-current")
    expect(gating && QuotaSnapshot.isKnownFull(gating, now)).toBe(false)
    // Without the filter the ended plans would derive known-full snapshots of their own.
    const unfiltered = QuotaSnapshot.deriveAll(plans, usage, now, { now })
    expect(
      unfiltered
        .filter((snapshot) => snapshot.planID !== "anthropic-current")
        .every((snapshot) => QuotaSnapshot.isKnownFull(snapshot, now)),
    ).toBe(true)
  })

  test("a plan whose status is unknown still feeds the gate (#1340)", () => {
    // `unknown` was never verified as ended, so it keeps gating until it is marked ended.
    const plans = [{ ...plan, id: "anthropic-unverified", status: "unknown", quotas: [window] }] as ModelPlan.Plan[]
    expect(plans.filter(ModelPlan.feedsGate).map((candidate) => candidate.id)).toEqual(["anthropic-unverified"])
    const snapshots = QuotaSnapshot.deriveAll(plans.filter(ModelPlan.feedsGate), () => totals({ requests: 200 }), now, {
      now,
    })
    const gating = QuotaSnapshot.gatingSnapshot(snapshots, now)
    expect(gating?.planID).toBe("anthropic-unverified")
    expect(gating && QuotaSnapshot.isKnownFull(gating, now)).toBe(true)
  })

  describe("isKnownFull (#6 gate)", () => {
    const snap = (overrides: Partial<QuotaSnapshot.Snapshot> = {}): QuotaSnapshot.Snapshot => ({
      planID: "anthropic-max",
      window: "5-hour",
      providerID: "anthropic",
      percent: 100,
      remaining: 0,
      resetAt: now + 3_600_000,
      observedAt: now,
      stale: false,
      ...overrides,
    })

    test("a fresh 100% reading is full until its reset", () => {
      expect(QuotaSnapshot.isKnownFull(snap(), now)).toBe(true)
      expect(QuotaSnapshot.isKnownFull(snap(), now + 3_599_999)).toBe(true)
    })

    test("the reset passing re-admits on its own", () => {
      expect(QuotaSnapshot.isKnownFull(snap(), now + 3_600_000)).toBe(false)
      expect(QuotaSnapshot.isKnownFull(snap(), now + 7_200_000)).toBe(false)
    })

    test("below the limit is not full", () => {
      expect(QuotaSnapshot.isKnownFull(snap({ percent: 99.9, remaining: 1 }), now)).toBe(false)
    })

    test("unknown and stale readings are never full", () => {
      expect(QuotaSnapshot.isKnownFull(snap({ percent: null, remaining: null }), now)).toBe(false)
      expect(QuotaSnapshot.isKnownFull(snap({ stale: true }), now)).toBe(false)
    })

    test("a full reading with no derivable reset stays full until a fresher read", () => {
      expect(QuotaSnapshot.isKnownFull(snap({ resetAt: null }), now)).toBe(true)
      expect(QuotaSnapshot.isKnownFull(snap({ resetAt: null }), now + 86_400_000)).toBe(true)
    })
  })
})

describe("QuotaSnapshot balance classification and gating selection (#1014 fix pass)", () => {
  const creditPlan = { ...plan, coverage: "credits" } as ModelPlan.Plan

  test("a windowed credits USD quota is a resetting window, not a balance", () => {
    const windowed = { name: "credits", unit: "usd", limit: 2, windowHours: 5 } as ModelPlan.QuotaWindow
    const snapshot = QuotaSnapshot.derive(
      { plan: creditPlan, window: windowed, totals: totals({ costUsd: 1 }), observedAt: now },
      { now },
    )
    expect(snapshot.balance).toBeUndefined()
    expect(snapshot.percent).toBe(50)
    expect(snapshot.remaining).toBe(1)
    expect(QuotaSnapshot.isKnownFull(snapshot, now)).toBe(false)

    const full = QuotaSnapshot.derive(
      { plan: creditPlan, window: windowed, totals: totals({ costUsd: 2 }), observedAt: now },
      { now },
    )
    expect(full.balance).toBeUndefined()
    expect(full.percent).toBe(100)
  })

  test("usageSince scopes a non-windowed credit balance to its grant start", () => {
    const balanceWindow = { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow
    // The fixture plan was created 2026-10-01: pre-grant spending is not the grant's.
    expect(QuotaSnapshot.usageSince(creditPlan, balanceWindow, now)).toBe(Date.parse(plan.createdAt))
    const windowed = { ...window, windowHours: 5 } as ModelPlan.QuotaWindow
    expect(QuotaSnapshot.usageSince(plan, windowed, now)).toBe(now - 5 * 3_600_000)
    const plain = { name: "monthly", unit: "requests", limit: 100 } as ModelPlan.QuotaWindow
    expect(QuotaSnapshot.usageSince(plan, plain, now)).toBe(0)
  })

  test("gatingSnapshot never lets an expired grant win over a live balance", () => {
    const expired = QuotaSnapshot.derive(
      {
        plan: { ...creditPlan, id: "old-grant", expiresOn: "2026-10-20T00:00:00.000Z" } as ModelPlan.Plan,
        window: { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    const live = QuotaSnapshot.derive(
      {
        plan: { ...creditPlan, id: "new-grant" } as ModelPlan.Plan,
        window: { name: "credits", unit: "usd", limit: 5 } as ModelPlan.QuotaWindow,
        totals: totals({ costUsd: 1 }),
        observedAt: now,
      },
      { now },
    )
    expect(expired.expired).toBe(true)
    expect(QuotaSnapshot.isKnownFull(expired, now)).toBe(true)
    expect(QuotaSnapshot.gatingSnapshot([expired, live], now)?.planID).toBe("new-grant")
    // With no live grant, the expired one still gates.
    expect(QuotaSnapshot.gatingSnapshot([expired], now)?.planID).toBe("old-grant")
  })

  test("gatingSnapshot does not let an expired plan's own window supersede its expired balance", () => {
    // One plan carrying both a non-windowed USD balance and a windowed request
    // quota: when the plan's grant expires, derive marks only the balance
    // snapshot expired. The request snapshot is part of the same dead grant,
    // not a live replacement, so the expired balance must still gate —
    // otherwise the provider stays eligible on an expired grant.
    const expiredPlan = {
      ...creditPlan,
      id: "expired-plan",
      expiresOn: "2026-10-20T00:00:00.000Z",
    } as ModelPlan.Plan
    const balance = QuotaSnapshot.derive(
      {
        plan: expiredPlan,
        window: { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    const requests = QuotaSnapshot.derive(
      {
        plan: expiredPlan,
        window: { name: "requests", unit: "requests", limit: 100, windowHours: 5 } as ModelPlan.QuotaWindow,
        totals: totals({ requests: 10 }),
        observedAt: now,
      },
      { now },
    )
    expect(balance.expired).toBe(true)
    expect(requests.balance).toBeUndefined()
    expect(QuotaSnapshot.isKnownFull(requests, now)).toBe(false)

    const gating = QuotaSnapshot.gatingSnapshot([balance, requests], now)
    expect(gating?.planID).toBe("expired-plan")
    expect(gating?.balance).toBe(true)
    expect(gating && QuotaSnapshot.isKnownFull(gating, now)).toBe(true)

    // A live balance from a different plan is a replacement grant: it wins,
    // and the expired plan's snapshots (balance and window alike) stop gating.
    const live = QuotaSnapshot.derive(
      {
        plan: { ...creditPlan, id: "new-grant" } as ModelPlan.Plan,
        window: { name: "credits", unit: "usd", limit: 5 } as ModelPlan.QuotaWindow,
        totals: totals({ costUsd: 1 }),
        observedAt: now,
      },
      { now },
    )
    expect(QuotaSnapshot.gatingSnapshot([balance, requests, live], now)?.planID).toBe("new-grant")
  })

  test("gatingSnapshot prefers a dead balance over a resetting full window", () => {
    // The same plan's balance is exhausted and its request window is full
    // with a reset ahead. Latest-reset ordering would gate on the window,
    // whose timed gate re-admits the credential at reset while the balance
    // is still exhausted; the dead balance must win, because its gate
    // releases only on a fresh balance increase.
    const mixedPlan = { ...creditPlan, id: "mixed-plan" } as ModelPlan.Plan
    const balance = QuotaSnapshot.derive(
      {
        plan: mixedPlan,
        window: { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow,
        totals: totals({ costUsd: 2 }),
        observedAt: now,
      },
      { now },
    )
    const requests = QuotaSnapshot.derive(
      {
        plan: mixedPlan,
        window: {
          name: "requests",
          unit: "requests",
          limit: 100,
          windowHours: 5,
          resetAt: "2026-10-28T00:00:00.000Z",
        } as ModelPlan.QuotaWindow,
        totals: totals({ requests: 100 }),
        observedAt: now,
      },
      { now },
    )
    expect(balance.remaining).toBe(0)
    expect(QuotaSnapshot.isKnownFull(balance, now)).toBe(true)
    expect(QuotaSnapshot.isKnownFull(requests, now)).toBe(true)
    expect(requests.resetAt).toBe(Date.parse("2026-10-28T00:00:00.000Z"))

    const gating = QuotaSnapshot.gatingSnapshot([requests, balance], now)
    expect(gating?.planID).toBe("mixed-plan")
    expect(gating?.balance).toBe(true)
  })
})

describe("QuotaSnapshot usageSince fixed-reset periods (#1342)", () => {
  const dailyWindow = {
    name: "daily",
    unit: "requests",
    limit: 100,
    windowHours: 24,
    resetRule: "daily 00:00 UTC",
  } as ModelPlan.QuotaWindow

  test("a daily window reads usage from the current period's start, not a rolling 24h lookback", () => {
    const justAfterReset = Date.parse("2026-10-27T00:05:00.000Z")
    const since = QuotaSnapshot.usageSince(plan, dailyWindow, justAfterReset)
    expect(since).toBe(Date.parse("2026-10-27T00:00:00.000Z"))
    // The worked example from #1342: 100 requests at 23:55 the previous day
    // fall before the period start and cannot re-gate the new period; usage
    // at 00:01 is inside it.
    expect(Date.parse("2026-10-26T23:55:00.000Z")).toBeLessThan(since)
    expect(Date.parse("2026-10-27T00:01:00.000Z")).toBeGreaterThanOrEqual(since)
  })

  test("mid-period, a daily window's period start is the most recent reset", () => {
    const midPeriod = Date.parse("2026-10-27T12:00:00.000Z")
    expect(QuotaSnapshot.usageSince(plan, dailyWindow, midPeriod)).toBe(Date.parse("2026-10-27T00:00:00.000Z"))
  })

  test("an explicit future resetAt starts the period one window-length before it", () => {
    const explicit = {
      ...dailyWindow,
      resetRule: undefined,
      resetAt: "2026-10-28T00:00:00.000Z",
    } as ModelPlan.QuotaWindow
    const justAfterReset = Date.parse("2026-10-27T00:05:00.000Z")
    expect(QuotaSnapshot.usageSince(plan, explicit, justAfterReset)).toBe(Date.parse("2026-10-27T00:00:00.000Z"))
  })

  test("a rolling window keeps the rolling lookback", () => {
    const rolling = { ...dailyWindow, resetRule: "rolling" } as ModelPlan.QuotaWindow
    const justAfterReset = Date.parse("2026-10-27T00:05:00.000Z")
    expect(QuotaSnapshot.usageSince(plan, rolling, justAfterReset)).toBe(justAfterReset - 24 * 3_600_000)
  })

  test("a rolling window with a recorded resetAt keeps the rolling lookback (PR #1352 Codex)", () => {
    // plan-tracking records resetAt (the next known reset) on rolling windows too;
    // it is a recorded fact, not a period boundary. At 12:00 with a five-hour
    // window and a recorded reset at 13:00, the rolling start is 07:00 — usage
    // from 07:00 to 08:00 still belongs to the window and must count.
    const recorded = {
      name: "5-hour",
      unit: "requests",
      limit: 100,
      windowHours: 5,
      resetRule: "rolling",
      resetAt: "2026-10-27T13:00:00.000Z",
    } as ModelPlan.QuotaWindow
    const noon = Date.parse("2026-10-27T12:00:00.000Z")
    expect(QuotaSnapshot.usageSince(plan, recorded, noon)).toBe(noon - 5 * 3_600_000)
  })
})

describe("QuotaSnapshot gating fallback evidence (#1341)", () => {
  const unknownWindow = { name: "monthly", unit: "requests" } as ModelPlan.QuotaWindow

  test("the fallback returns a known later window instead of an unknown first snapshot", () => {
    const unknown = QuotaSnapshot.derive(
      { plan, window: unknownWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    expect(QuotaSnapshot.known(unknown)).toBe(false)
    const known = QuotaSnapshot.derive({ plan, window, totals: totals({ requests: 50 }), observedAt: now }, { now })
    expect(QuotaSnapshot.known(known)).toBe(true)
    const gating = QuotaSnapshot.gatingSnapshot([unknown, known], now)
    expect(gating?.window).toBe("5-hour")
    expect(gating && QuotaSnapshot.known(gating)).toBe(true)
    expect(gating && QuotaSnapshot.isKnownFull(gating, now)).toBe(false)
  })

  test("a gate armed by a later window can clear: the cleared known reading is selected over an unknown first snapshot", () => {
    const unknown = QuotaSnapshot.derive(
      { plan, window: unknownWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    const full = QuotaSnapshot.derive({ plan, window, totals: totals({ requests: 200 }), observedAt: now }, { now })
    expect(QuotaSnapshot.gatingSnapshot([unknown, full], now)?.window).toBe("5-hour")
    expect(QuotaSnapshot.isKnownFull(full, now)).toBe(true)

    const later = now + 60_000
    const cleared = QuotaSnapshot.derive(
      { plan, window, totals: totals({ requests: 50 }), observedAt: later },
      { now: later },
    )
    const gating = QuotaSnapshot.gatingSnapshot([unknown, cleared], later)
    expect(gating?.window).toBe("5-hour")
    expect(gating && QuotaSnapshot.isKnownFull(gating, later)).toBe(false)
  })

  test("an all-unknown set selects no known evidence and never reads as full", () => {
    const first = QuotaSnapshot.derive(
      { plan, window: unknownWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    const second = QuotaSnapshot.derive(
      {
        plan,
        window: { name: "yearly", unit: "requests" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    const gating = QuotaSnapshot.gatingSnapshot([first, second], now)
    expect(gating?.window).toBe("monthly")
    expect(gating && QuotaSnapshot.known(gating)).toBe(false)
    expect(gating && QuotaSnapshot.isKnownFull(gating, now)).toBe(false)
  })

  test("a known balance snapshot still outranks a known windowed snapshot in the fallback", () => {
    const creditPlan = { ...plan, coverage: "credits" } as ModelPlan.Plan
    const balance = QuotaSnapshot.derive(
      {
        plan: creditPlan,
        window: { name: "credits", unit: "usd", limit: 2 } as ModelPlan.QuotaWindow,
        totals: totals({ costUsd: 0.5 }),
        observedAt: now,
      },
      { now },
    )
    expect(balance.balance).toBe(true)
    expect(QuotaSnapshot.known(balance)).toBe(true)
    const windowed = QuotaSnapshot.derive(
      { plan, window, totals: totals({ requests: 50 }), observedAt: now + 60_000 },
      { now: now + 60_000 },
    )
    const gating = QuotaSnapshot.gatingSnapshot([windowed, balance], now + 60_000)
    expect(gating?.window).toBe("credits")
  })
})
