import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelRouteMembership } from "@opencode/core/model-route-membership"
import { ModelRoute } from "@opencode/core/model-route"
import { SessionMembershipGate } from "@opencode/core/session/runner/membership-gate"

const CAPS: ModelRouteMembership.Limits = { concurrent: 10, requestsPerMinute: 100 }
const at = 1_700_000_000_000

// Membership readers are per-process registrations keyed by Location; every test
// that registers one unregisters it again (the gate tests' off functions), and
// the gate tests below always register before reading, so test order cannot
// leak a reader into the no-caps case.
beforeEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS)
})

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS)
})

describe("ModelRouteMembership.limitsOf", () => {
  test("reads a declared membership block from provider settings", () => {
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: 10, requestsPerMinute: 100 } })).toEqual(CAPS)
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: 1, requestsPerMinute: 1 } })).toEqual({
      concurrent: 1,
      requestsPerMinute: 1,
    })
  })

  test("anything but plain positive integers is not a declaration", () => {
    expect(ModelRouteMembership.limitsOf(undefined)).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({})).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: 10 } })).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: 0, requestsPerMinute: 100 } })).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: -1, requestsPerMinute: 100 } })).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: 1.5, requestsPerMinute: 100 } })).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: "10", requestsPerMinute: 100 } })).toBeUndefined()
    expect(ModelRouteMembership.limitsOf({ membership: { concurrent: 10, requestsPerMinute: null } })).toBeUndefined()
  })
})

describe("ModelRouteMembership accumulator", () => {
  test("the concurrency cap is shared across routes and models on one account", () => {
    // Route A and route B, different models, one account: the accumulator is the
    // oracle — ten starts admitted however the traffic is labelled, the eleventh
    // refused while all ten are in flight.
    const state = ModelRouteMembership.empty()
    for (let i = 0; i < 10; i++) {
      expect(ModelRouteMembership.tryAcquire(state, CAPS, at + i)).toEqual({ granted: true })
    }
    expect(state.inFlight).toBe(10)
    expect(ModelRouteMembership.tryAcquire(state, CAPS, at + 100)).toEqual({
      granted: false,
      blockedBy: "concurrency",
    })
    expect(state.inFlight).toBe(10)

    // A release — whichever route's request ended — frees the next start.
    ModelRouteMembership.release(state)
    expect(ModelRouteMembership.tryAcquire(state, CAPS, at + 200)).toEqual({ granted: true })
    expect(ModelRouteMembership.snapshot(state, at + 200).inFlight).toBe(10)
  })

  test("aliases of one account share the accumulator through its canonical key", () => {
    const account = ModelRouteMembership.accountOf("design-code", "opendesign")
    expect(account).toBe("opendesign")
    expect(ModelRouteMembership.accountOf("opendesign")).toBe("opendesign")
    ModelRouteMembership.reset()
    for (let i = 0; i < 10; i++) {
      expect(ModelRouteMembership.acquire(account, CAPS, at)).toEqual({ granted: true })
    }
    // The alias's eleventh concurrent start is refused: the count never split.
    expect(ModelRouteMembership.acquire(account, CAPS, at)).toEqual({ granted: false, blockedBy: "concurrency" })
    expect(ModelRouteMembership.accountSnapshot(account, at).inFlight).toBe(10)
    ModelRouteMembership.releaseAccount(account)
    expect(ModelRouteMembership.acquire(account, CAPS, at)).toEqual({ granted: true })
  })

  test("the per-minute window is shared across models on one account", () => {
    const state = ModelRouteMembership.empty()
    // 100 starts inside one minute, each released at once, spread across two
    // models: the window — not concurrency — is what refuses the 101st.
    for (let i = 0; i < 100; i++) {
      expect(ModelRouteMembership.tryAcquire(state, CAPS, at + i * 100)).toEqual({ granted: true })
      ModelRouteMembership.release(state)
    }
    const denied = ModelRouteMembership.tryAcquire(state, CAPS, at + 10_050)
    // The oldest start ages out exactly a window after it began.
    expect(denied).toEqual({ granted: false, blockedBy: "window", waitMs: at + 60_000 - (at + 10_050) })
    // At that instant the start is admitted again.
    expect(ModelRouteMembership.tryAcquire(state, CAPS, at + 60_000)).toEqual({ granted: true })
  })

  test("a double release never drives the in-flight count negative", () => {
    const state = ModelRouteMembership.empty()
    expect(ModelRouteMembership.tryAcquire(state, CAPS, at)).toEqual({ granted: true })
    ModelRouteMembership.release(state)
    ModelRouteMembership.release(state)
    expect(state.inFlight).toBe(0)
    expect(ModelRouteMembership.tryAcquire(state, CAPS, at)).toEqual({ granted: true })
  })

  test("random acquire/release traffic never exceeds either cap", () => {
    // Seeded sweep: the caps themselves are the oracle — in-flight must stay
    // within [0, concurrent] and admitted starts within the window cap at every
    // instant, whatever the interleaving.
    let seed = 2_253
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const state = ModelRouteMembership.empty()
    let now = at
    for (let step = 0; step < 5_000; step++) {
      now += Math.floor(next() * 500)
      if (next() < 0.6) {
        const before = state.inFlight
        const admission = ModelRouteMembership.tryAcquire(state, CAPS, now)
        if (admission.granted) expect(state.inFlight).toBe(before + 1)
        else expect(state.inFlight).toBe(before)
      } else ModelRouteMembership.release(state)
      expect(state.inFlight).toBeGreaterThanOrEqual(0)
      expect(state.inFlight).toBeLessThanOrEqual(CAPS.concurrent)
      const standing = ModelRouteMembership.snapshot(state, now)
      expect(standing.startsInWindow).toBeLessThanOrEqual(CAPS.requestsPerMinute)
    }
  })
})

describe("ModelRouteMembership tier-limit backstop", () => {
  test("a stated reset is believed and holds the account out", () => {
    ModelRouteMembership.reset()
    const until = ModelRouteMembership.recordTierLimit(
      "opendesign",
      "membership concurrency limit exceeded; try again in 30 seconds",
      at,
    )
    expect(until).toBe(at + 30_000)
    expect(ModelRouteMembership.heldUntil("opendesign", at + 29_999)).toBe(at + 30_000)
    expect(ModelRouteMembership.heldUntil("opendesign", at + 30_000)).toBe(0)
    expect(ModelRouteMembership.acquire("opendesign", CAPS, at + 1_000)).toEqual({
      granted: false,
      blockedBy: "hold",
      waitMs: 29_000,
    })
  })

  test("a stated reset past a day is capped at a day", () => {
    ModelRouteMembership.reset()
    const until = ModelRouteMembership.recordTierLimit("opendesign", "tier limit; reset in 3 days", at)
    expect(until).toBe(at + 86_400_000)
  })

  test("a concurrency answer with no stated reset holds for a minute", () => {
    ModelRouteMembership.reset()
    const until = ModelRouteMembership.recordTierLimit(
      "opendesign",
      "[code=tier_limit_exceeded] membership concurrency limit exceeded: 11/10",
      at,
    )
    expect(until).toBe(at + 60_000)
  })

  test("an rpm answer with no stated reset holds until the oldest start ages out", () => {
    ModelRouteMembership.reset()
    for (let i = 0; i < 3; i++) ModelRouteMembership.acquire("opendesign", CAPS, at + i * 1_000)
    const until = ModelRouteMembership.recordTierLimit(
      "opendesign",
      "[code=tier_limit_exceeded] membership rpm limit exceeded: 101/100",
      at + 5_000,
    )
    expect(until).toBe(at + 60_000)
    expect(ModelRouteMembership.heldUntil("opendesign", at + 5_000)).toBe(at + 60_000)
  })

  test("a later, shorter hold never shortens an existing one", () => {
    ModelRouteMembership.reset()
    ModelRouteMembership.recordTierLimit("opendesign", "try again in 2 minutes", at)
    const until = ModelRouteMembership.recordTierLimit("opendesign", "try again in 10 seconds", at + 1_000)
    expect(until).toBe(at + 120_000)
  })

  test("resetHealth clears membership state with the rest of route health", () => {
    ModelRouteMembership.reset()
    ModelRouteMembership.recordTierLimit("opendesign", "try again in 5 minutes", at)
    expect(ModelRouteMembership.heldUntil("opendesign", at)).toBeGreaterThan(at)
    ModelRoute.resetHealth()
    expect(ModelRouteMembership.heldUntil("opendesign", at)).toBe(0)
  })
})

describe("SessionMembershipGate", () => {
  const register = (limits: ModelRouteMembership.Limits, waitMs?: number) => {
    const off = ModelRoute.onMembershipLimits(() => limits)
    if (waitMs !== undefined) ModelRoute.configureConstants({ membership: { waitMs } })
    return off
  }

  /** A fake clock: sleeping advances it, and a hook can act as time passes. */
  const clock = (start: number, onAdvance?: (now: number) => void) => {
    let now = start
    return {
      now: () => now,
      sleep: (ms: number) =>
        Effect.sync(() => {
          now += ms
          onAdvance?.(now)
        }),
    }
  }

  const run = (input: Parameters<typeof SessionMembershipGate.gate>[0]) =>
    Effect.runPromise(SessionMembershipGate.gate(input))

  test("passes at once when the provider declares no caps", async () => {
    // No reader is registered in this test, so no caps are declared for the
    // provider: nothing is metered and nothing is held.
    const gated = await run({ membership: { providerID: "uncapped" }, routeID: "r", lastResort: false })
    expect(gated).toEqual({ held: false, waited: false })
  })

  test("admits at once while the account has room, holding a releasable slot", async () => {
    const off = register({ concurrent: 2, requestsPerMinute: 100 })
    try {
      const gated = await run({ membership: { providerID: "opendesign" }, routeID: "r", lastResort: false })
      expect(gated).toEqual({ held: true, waited: false })
      expect(ModelRoute.membershipSnapshot("opendesign").inFlight).toBe(1)
      SessionMembershipGate.release({ providerID: "opendesign" }, gated)
      expect(ModelRoute.membershipSnapshot("opendesign").inFlight).toBe(0)
    } finally {
      off()
    }
  })

  test("waits briefly when a slot frees inside the bound", async () => {
    const off = register({ concurrent: 1, requestsPerMinute: 100 }, 5_000)
    try {
      // The only slot is taken; it frees 2s into the gate's wait.
      expect(ModelRoute.membershipAcquire("opendesign", undefined, undefined, at).granted).toBe(true)
      const fake = clock(at, (now) => {
        if (now >= at + 2_000) ModelRoute.membershipRelease("opendesign")
      })
      const gated = await run({
        membership: { providerID: "opendesign" },
        routeID: "r",
        lastResort: false,
        now: fake.now,
        sleep: fake.sleep,
      })
      expect(gated).toEqual({ held: true, waited: true })
      SessionMembershipGate.release({ providerID: "opendesign" }, gated)
    } finally {
      off()
    }
  })

  test("fails over when no slot frees inside the bound", async () => {
    const off = register({ concurrent: 1, requestsPerMinute: 100 }, 5_000)
    try {
      expect(ModelRoute.membershipAcquire("opendesign", undefined, undefined, at).granted).toBe(true)
      const fake = clock(at)
      const gated = await run({
        membership: { providerID: "opendesign" },
        routeID: "r",
        lastResort: false,
        now: fake.now,
        sleep: fake.sleep,
      })
      // Undefined is the gate's failover signal: the caller moves to the next leg
      // without spending an attempt.
      expect(gated).toBeUndefined()
      expect(fake.now()).toBeGreaterThanOrEqual(at + 5_000)
    } finally {
      off()
    }
  })

  test("the last resort proceeds unmetered instead of failing", async () => {
    const off = register({ concurrent: 1, requestsPerMinute: 100 }, 5_000)
    try {
      expect(ModelRoute.membershipAcquire("opendesign", undefined, undefined, at).granted).toBe(true)
      const gated = await run({ membership: { providerID: "opendesign" }, routeID: "r", lastResort: true })
      expect(gated).toEqual({ held: false, waited: false })
    } finally {
      off()
    }
  })

  test("waits out a full minute window when it frees inside the bound", async () => {
    const off = register({ concurrent: 10, requestsPerMinute: 2 }, 70_000)
    try {
      // Two starts at the window's head fill it; the gate's wait ends exactly
      // when the first start ages out.
      ModelRoute.membershipAcquire("opendesign", undefined, undefined, at)
      ModelRoute.membershipRelease("opendesign")
      ModelRoute.membershipAcquire("opendesign", undefined, undefined, at + 500)
      ModelRoute.membershipRelease("opendesign")
      const fake = clock(at + 1_000)
      const gated = await run({
        membership: { providerID: "opendesign" },
        routeID: "r",
        lastResort: false,
        now: fake.now,
        sleep: fake.sleep,
      })
      expect(gated).toEqual({ held: true, waited: true })
      SessionMembershipGate.release({ providerID: "opendesign" }, gated)
    } finally {
      off()
    }
  })

  test("a recorded tier-limit hold fails the gate over to the next leg", async () => {
    const off = register({ concurrent: 10, requestsPerMinute: 100 }, 5_000)
    try {
      ModelRoute.recordTierLimit(
        ModelRoute.ref({ providerID: "opendesign", model: "m" }),
        "membership concurrency limit exceeded; try again in 10 minutes",
        at,
      )
      const fake = clock(at)
      const gated = await run({
        membership: { providerID: "opendesign" },
        routeID: "r",
        lastResort: false,
        now: fake.now,
        sleep: fake.sleep,
      })
      expect(gated).toBeUndefined()
      expect(ModelRoute.membershipHeldUntil("opendesign", undefined, at)).toBe(at + 600_000)
    } finally {
      off()
    }
  })
})
