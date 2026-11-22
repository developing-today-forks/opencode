import { afterEach, describe, expect, test } from "bun:test"
import { AIError } from "@opencode/ai"
import { ModelRoute } from "@opencode/core/model-route"
import { SessionStep } from "@opencode/core/session/runner/step"
import { MockProvider, MockScenarios } from "./fixture/mock-provider"
import { driveStep } from "./fixture/mock-route-driver"

/**
 * Five-door measurement for code#12228 (build item 1 + the done-when tests).
 *
 * The five doors of #12228 each failed in a different wire shape. This suite
 * drives each shape through the production-shaped path (the MockRouteDriver
 * mirrors the resolver's selection loop and the runner's failure accounting)
 * with one answering door beside it, and measures the behaviour the issue's
 * done-when names:
 *
 * - the session completes on the next door, spending exactly one attempt on
 *   the walled door (failover within one retry, no in-lane retry storm);
 * - a NEW session is never routed to the walled door before its reset (zero
 *   further attempts), and for the 403 door the member is dead to last-resort
 *   dealing until a probe is due at the bench's expiry;
 * - the bench the failure plants runs until the stated reset (the measured
 *   `benchMs`), with the half-open probe due at the reset, not before.
 *
 * The measured values are collected and printed as a table by the last test;
 * they are the slice's recorded baseline (also quoted on code#12228). The
 * live doors' states are data in the quota record, not code — they are read
 * and recorded on the issue, not asserted here.
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

const poolOfTwo = (id: string, a: ModelRoute.Target, b: ModelRoute.Target) =>
  definition(id, [a, b], [{ selection: "round-robin", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }])

const failure = async (mock: MockProvider, target: ModelRoute.Target): Promise<AIError> => {
  const error = await mock.attempt(target).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AIError)
  return error as AIError
}

interface DoorMeasurement {
  readonly door: string
  readonly issue: string
  readonly shape: string
  /** Attempts spent on the walled door by the session that met the wall. */
  readonly failoverAttempts: number
  /** Provider that completed that session. */
  readonly servedBy: string
  /** Attempts a fresh session spent on the walled door (done-when: zero). */
  readonly newSessionAttempts: number
  /** Bench planted by the failure, ms from the failure to the bench's end. */
  readonly benchMs: number
  /** Whether a half-open probe is the re-admission mechanism at the bench's
   * end (auth / long retry-after benches). Quota benches instead re-admit
   * at their stated reset with no probe. */
  readonly probeDueAtReset: boolean
  /** For the 403 door: dead to last-resort dealing while benched. */
  readonly lastResortDead?: boolean
}

const measurements: DoorMeasurement[] = []

/**
 * The two-session protocol every door is measured with: one session meets
 * the wall and must complete on the answering door; a second, fresh session
 * must not be routed to the walled door at all.
 */
const measureDoor = async (input: {
  readonly routeID: string
  readonly door: ModelRoute.Target
  readonly answering: ModelRoute.Target
  readonly mock: MockProvider
}) => {
  const route = poolOfTwo(input.routeID, input.door, input.answering)
  const first = await driveStep({ definition: route, mock: input.mock, sessionID: `${input.routeID}-first` })
  const benchMs = ModelRoute.cooldownUntil(input.door, Date.now()) - Date.now()
  const second = await driveStep({ definition: route, mock: input.mock, sessionID: `${input.routeID}-second` })
  return { first, second, benchMs }
}

describe("five-door measurement (#12228)", () => {
  // Door _claude (#9549): OAuth renewal answers 429; the Anthropic wire shape
  // states the reset only as a timestamp header. Done-when's canonical case:
  // the reset is an hour away.
  test("_claude: a 429 stating a reset an hour away fails over and benches until the reset", async () => {
    const door = ref("_claude", "claude-sonnet-4-5")
    const answering = ref("answering", "m")
    const mock = new MockProvider()
    const resetAt = Date.now() + 3_600_000
    mock.set(door, MockScenarios.rateLimitResetTimestamp(new Date(resetAt).toISOString()))
    mock.set(answering, MockScenarios.succeed("from-answering"))

    const { first, second, benchMs } = await measureDoor({ routeID: "five-door-claude", door, answering, mock })

    expect(first.status).toBe("served")
    expect(first.servedTarget).toBe(answering)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(answering)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    // The bench runs to the stated reset, and the probe is due there — not before.
    expect(Math.abs(benchMs - 3_600_000)).toBeLessThan(10_000)
    expect(ModelRoute.probeDue(door, undefined, resetAt - 60_000)).toBe(false)
    expect(ModelRoute.probeDue(door, undefined, resetAt + 1_000)).toBe(true)

    measurements.push({
      door: "_claude",
      issue: "#9549",
      shape: "429, reset as timestamp header",
      failoverAttempts: 1,
      servedBy: "answering",
      newSessionAttempts: 0,
      benchMs,
      probeDueAtReset: true,
    })
  })

  // Door _antigravity (#9856): 403, the account disabled for Terms of Service
  // (the verbatim refusal the retry suite carries). Done-when: the same
  // failover, with the door marked dead until a probe succeeds.
  test("_antigravity: a 403 account-disabled refusal fails over and the door is dead until its probe", async () => {
    const door = ref("_antigravity", "claude-sonnet-4-5")
    const answering = ref("answering", "m")
    const mock = new MockProvider()
    mock.set(door, {
      kind: "http",
      status: 403,
      body: JSON.stringify({
        error: {
          message:
            "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
        },
      }),
    })
    mock.set(answering, MockScenarios.succeed("from-answering"))

    const hint = SessionStep.failureHint(await failure(mock, door))
    expect(hint.auth).toBe(true)
    // The probe attempt above is the measurement's own doing; the sessions
    // below are measured against a fresh attempt log.
    const sessionMock = new MockProvider()
    sessionMock.set(door, {
      kind: "http",
      status: 403,
      body: JSON.stringify({
        error: {
          message:
            "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
        },
      }),
    })
    sessionMock.set(answering, MockScenarios.succeed("from-answering"))

    const { first, second, benchMs } = await measureDoor({
      routeID: "five-door-antigravity",
      door,
      answering,
      mock: sessionMock,
    })

    expect(first.status).toBe("served")
    expect(first.servedTarget).toBe(answering)
    expect(sessionMock.attempts(MockProvider.key(door))).toBe(1)
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(answering)
    expect(sessionMock.attempts(MockProvider.key(door))).toBe(1)
    // Dead, not merely cooling: last-resort dealing must not seat it either.
    // At the bench's expiry the bench converts to a due probe (#9950) instead
    // of silently re-admitting the door: exactly one probe may be claimed,
    // and a served probe is what reseats the door — "dead until a probe
    // succeeds", measured end to end.
    const now = Date.now()
    expect(ModelRoute.lastResortDead(door, undefined, now)).toBe(true)
    const expiry = ModelRoute.cooldownUntil(door, now)
    expect(ModelRoute.probeDue(door, undefined, expiry + 1_000)).toBe(true)
    expect(ModelRoute.claimBenchProbe(door, undefined, expiry + 1_000)).toBe(true)
    expect(ModelRoute.claimBenchProbe(door, undefined, expiry + 1_000)).toBe(false)
    expect(ModelRoute.probeInFlight(door, undefined, expiry + 1_000)).toBe(true)
    ModelRoute.completed(
      door,
      ModelRoute.policy(),
      { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 },
      expiry + 1_000,
    )
    expect(ModelRoute.cooldownUntil(door, expiry + 1_000)).toBe(0)
    expect(ModelRoute.lastResortDead(door, undefined, expiry + 1_000)).toBe(false)

    measurements.push({
      door: "_antigravity",
      issue: "#9856",
      shape: "403, account disabled (ToS)",
      failoverAttempts: 1,
      servedBy: "answering",
      newSessionAttempts: 0,
      benchMs,
      probeDueAtReset: true,
      lastResortDead: true,
    })
  })

  // Door _muse (#9859): 429, the weekly window at 100%; the reset is stated
  // in the message text (the reset-in-text shape), ~7h out at measurement.
  test("_muse: a 429 quota wall with the reset in its text fails over and benches until the reset", async () => {
    const door = ref("_muse", "muse-model")
    const answering = ref("answering", "m")
    const mock = new MockProvider()
    mock.set(door, MockScenarios.antigravityQuotaWall("7h0m0s"))
    mock.set(answering, MockScenarios.succeed("from-answering"))

    const { first, second, benchMs } = await measureDoor({ routeID: "five-door-muse", door, answering, mock })

    expect(first.status).toBe("served")
    expect(first.servedTarget).toBe(answering)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(answering)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    expect(Math.abs(benchMs - 7 * 3_600_000)).toBeLessThan(120_000)
    // A quota bench carries its own reset, so it gets no half-open probe
    // (probes are for auth / plan-wall / long retry-after benches, whose
    // recovery is unknown): it excludes until the reset and re-admits at it.
    const now = Date.now()
    expect(ModelRoute.coolingDown(door, now + 3_600_000)).toBe(true)
    expect(ModelRoute.probeDue(door, undefined, now + 7 * 3_600_000 + 120_000)).toBe(false)
    expect(ModelRoute.coolingDown(door, now + 7 * 3_600_000 + 120_000)).toBe(false)

    measurements.push({
      door: "_muse",
      issue: "#9859",
      shape: "429 quota wall, reset in message text",
      failoverAttempts: 1,
      servedBy: "answering",
      newSessionAttempts: 0,
      benchMs,
      probeDueAtReset: false,
    })
  })

  // Door cline-pass (#9961): 429, the monthly limit reached, stated as an
  // explicit quota code. No reset is stated, so the bench is the quota
  // ladder's — measured, and the door is skipped for its whole length.
  test("cline-pass: a quota-coded 429 fails over and the door is skipped for the quota bench", async () => {
    const door = ref("cline-pass", "cline-model")
    const answering = ref("answering", "m")
    const mock = new MockProvider()
    mock.set(door, MockScenarios.quotaExceeded())
    mock.set(answering, MockScenarios.succeed("from-answering"))

    const { first, second, benchMs } = await measureDoor({ routeID: "five-door-cline", door, answering, mock })

    expect(first.status).toBe("served")
    expect(first.servedTarget).toBe(answering)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(answering)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    // The quota ladder's first bench is fifteen minutes; nothing shorter may
    // re-deal a door that stated a spent quota.
    expect(benchMs).toBeGreaterThanOrEqual(900_000 - 5_000)

    measurements.push({
      door: "cline-pass",
      issue: "#9961",
      shape: "429, explicit quota code, no reset stated",
      failoverAttempts: 1,
      servedBy: "answering",
      newSessionAttempts: 0,
      benchMs,
      probeDueAtReset: false,
    })
  })

  // Door opencode-go (#10085): bare 429s from spent sub-accounts; sessions
  // froze at retry attempt 2. Two shapes are measured: the reset-header
  // shape (the bench now runs to the stated reset on the first failure) and
  // the reset-less shape (the short first bench is the measured, bounded
  // exposure — the sustained-failure ladder is what classifies it up).
  test("opencode-go: a bare 429 fails over within one attempt; its bench follows what it stated", async () => {
    // The reset-less shape first, on a second member of the same door,
    // before any reset has been stated for the provider: no reset is
    // attributable, so the first bench stays the short one — the measured,
    // bounded exposure the sustained-failure ladder then classifies up.
    const bare = ref("opencode-go", "go-model-bare")
    const bareMock = new MockProvider()
    bareMock.set(bare, {
      kind: "http",
      status: 429,
      body: JSON.stringify({ error: { message: "Rate limit reached; slow down" } }),
    })
    const bareNow = Date.now()
    const bareHint = SessionStep.failureHint(await failure(bareMock, bare))
    expect(bareHint.retryAfterMs).toBeUndefined()
    ModelRoute.failed(bare, ModelRoute.policy(), bareNow, bareHint)
    expect(ModelRoute.cooldownUntil(bare, bareNow) - bareNow).toBe(60_000)

    const door = ref("opencode-go", "go-model")
    const answering = ref("answering", "m")
    const mock = new MockProvider()
    mock.set(door, MockScenarios.rateLimitReset("2h0m0s"))
    mock.set(answering, MockScenarios.succeed("from-answering"))

    const { first, second, benchMs } = await measureDoor({ routeID: "five-door-go", door, answering, mock })

    expect(first.status).toBe("served")
    expect(first.servedTarget).toBe(answering)
    // The freeze was a session stuck retrying this door; the measurement is
    // that exactly one attempt is spent on it before the session completes.
    expect(first.attempts.filter((attempt) => attempt.target === door)).toHaveLength(1)
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    expect(second.status).toBe("served")
    expect(mock.attempts(MockProvider.key(door))).toBe(1)
    expect(Math.abs(benchMs - 2 * 3_600_000)).toBeLessThan(10_000)

    // Once the provider's reset has been stated (by the reset-header 429
    // above), it binds the whole provider window: the sibling member's next
    // reset-less 429 now benches to that same reset instead of 60s — the
    // stated reset is provider data, not per-answer data.
    const later = Date.now()
    ModelRoute.failed(bare, ModelRoute.policy(), later, SessionStep.failureHint(await failure(bareMock, bare)))
    expect(Math.abs(ModelRoute.cooldownUntil(bare, later) - (later + 2 * 3_600_000))).toBeLessThan(10_000)

    measurements.push({
      door: "opencode-go",
      issue: "#10085",
      shape: "429, reset in headers (reset-less member: 60s first bench, then the provider's stated reset binds it)",
      failoverAttempts: 1,
      servedBy: "answering",
      newSessionAttempts: 0,
      benchMs,
      probeDueAtReset: true,
    })
  })

  // The recorded baseline: every door met the done-when pair (failover in
  // one attempt; no new session routed to the wall), and the table is the
  // measurement this slice exists to record.
  test("the measured baseline: all five doors fail over in one attempt and hold their benches", () => {
    expect(measurements).toHaveLength(5)
    for (const entry of measurements) {
      expect(entry.failoverAttempts).toBe(1)
      expect(entry.newSessionAttempts).toBe(0)
      expect(entry.benchMs).toBeGreaterThan(0)
    }
    const rows = measurements.map(
      (entry) =>
        `| ${entry.door} | ${entry.issue} | ${entry.shape} | ${entry.failoverAttempts} | ${entry.servedBy} | ${entry.newSessionAttempts} | ${(entry.benchMs / 60_000).toFixed(1)} min | ${entry.probeDueAtReset ? "probe at bench end" : "—"} |`,
    )
    console.log(
      [
        "| door | issue | failure shape | attempts on walled door | served by | new-session attempts on door | bench | probe |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    )
  })
})
