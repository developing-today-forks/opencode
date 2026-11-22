import { describe, expect, test } from "bun:test"
import {
  AIError,
  AuthenticationError,
  HttpContext,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
} from "@opencode/ai/effect"
import { ModelRetry } from "@opencode/core/model-retry"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Clock, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const dnsFailure = new AIError({
  reason: new TransportError({
    message: "getaddrinfo ENOTFOUND opencode.ai",
    transport: "http",
    operation: "request",
    code: "ENOTFOUND",
    url: "https://opencode.ai/zen/v1/responses",
  }),
})
const refused = new AIError({
  reason: new TransportError({
    message: "Unable to connect",
    transport: "http",
    operation: "request",
    code: "ECONNREFUSED",
  }),
})

const input = (cause: AIError, proposed?: boolean) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: proposed ?? SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
// `propose: true` models the routed step, whose routeFailure test proposes a
// retry for auth and quota failures too — the policy itself must refuse those.
const decisions = (cause: AIError, count: number, limits?: SessionRunnerRetry.Limits, propose?: boolean) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), limits)
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause, propose))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  // Oracle: steps with no route budget keep the long allowance — compaction's
  // draft restarts share one step's policy by design (see the compaction
  // scenarios in session-runner.test.ts). A routed leg never reaches this
  // ceiling: the runner bounds it by the route's attempt budget (next test).
  it.effect("keeps the long allowance when no route budget applies", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 12)).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ])
    }),
  )

  it.effect("honours a tighter route-stated attempt budget", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 3, { maxRetries: 1 })).toEqual([true, false, false])
      expect(yield* decisions(internal, 2, { maxRetries: 0 })).toEqual([false, false])
    }),
  )

  // Oracle: code#9549 — an authentication refusal cannot heal by being asked
  // again; the routed step proposes a retry for it (routeFailure), and the
  // policy must still refuse from the first failure.
  it.effect("never retries an authentication refusal, even when a retry is proposed", () =>
    Effect.gen(function* () {
      const auth = new AIError({
        reason: new AuthenticationError({
          message: "Claude Code is not signed in on this machine",
          http: new HttpContext({ url: "https://example.invalid", status: 403, headers: {} }),
        }),
      })
      expect(yield* decisions(auth, 3, undefined, true)).toEqual([false, false, false])
    }),
  )

  // Oracle: code#9549 — the Antigravity terms suspension arrives as a 403
  // whose text states the service is disabled in the account; zero further
  // attempts may be spent on that leg.
  it.effect("never retries an account-disabled refusal stated in the error text", () =>
    Effect.gen(function* () {
      const disabled = new AIError({
        reason: new UnknownProviderError({
          message:
            "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
        }),
      })
      expect(yield* decisions(disabled, 3, undefined, true)).toEqual([false, false, false])
    }),
  )

  // Oracle: code#9549 / Drew's standing rule — a leg whose quota is exhausted
  // is not attempted again, not even as a probe, whether the exhaustion
  // arrives as a tag or stated in the provider's own words.
  it.effect("never retries a quota exhaustion, tagged or stated", () =>
    Effect.gen(function* () {
      const tagged = new AIError({ reason: new QuotaExceededError({ message: "quota exceeded" }) })
      const stated = new AIError({
        reason: new UnknownProviderError({
          message: "Individual quota reached. Please upgrade your subscription to increase your limits.",
        }),
      })
      expect(yield* decisions(tagged, 3, undefined, true)).toEqual([false, false, false])
      expect(yield* decisions(stated, 3, undefined, true)).toEqual([false, false, false])
    }),
  )

  // Oracle: code#9549 — stated retry-afters count against one cumulative
  // wait budget for the step (fifteen minutes, the figure a single stated
  // wait was already capped at): two 400s waits fit, a third does not; an
  // hour-long stated wait is clamped to one full budget, so it may be
  // waited out exactly once and never twice in a row.
  it.effect("keeps stated retry-afters inside the cumulative wait budget", () =>
    Effect.gen(function* () {
      const longWait = new AIError({
        reason: new RateLimitError({ message: "rate limited", retryAfterMs: 400_000 }),
      })
      expect(yield* decisions(longWait, 4)).toEqual([true, true, false, false])
      const anHour = new AIError({ reason: new RateLimitError({ message: "rate limited", retryAfterMs: 3_600_000 }) })
      expect(yield* decisions(anHour, 2)).toEqual([true, false])
    }),
  )

  it.effect("keeps retrying an unreachable host for an hour with gaps of at most 30 seconds", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const started = yield* Clock.currentTimeMillis
      const delays: number[] = []
      while (true) {
        const decision = yield* policy(input(dnsFailure))
        if (!decision.retry) break
        delays.push(decision.delay)
        yield* TestClock.adjust(Duration.millis(decision.delay))
      }
      const waited = (yield* Clock.currentTimeMillis) - started
      expect(delays.length).toBeGreaterThan(100)
      expect(Math.max(...delays)).toBeLessThanOrEqual(30_000)
      expect(waited).toBeGreaterThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW))
      expect(waited).toBeLessThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW) + 30_000)
    }),
  )

  it.effect("keeps a refused connection on the general allowance", () =>
    Effect.gen(function* () {
      expect(ModelRetry.isUnreachable(refused)).toBe(false)
      expect(yield* decisions(refused, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("doesn't spend the general allowance on an unreachable host", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      for (let i = 0; i < 20; i++) expect((yield* policy(input(dnsFailure))).retry).toBe(true)
      const results: boolean[] = []
      for (let i = 0; i < 11; i++) results.push((yield* policy(input(internal))).retry)
      expect(results).toEqual([...Array(10).fill(true), false])
    }),
  )
})

describe("ModelRetry.retryOneShot", () => {
  it.effect("doesn't replay a call whose response was cut off by the network going down", () =>
    Effect.gen(function* () {
      let calls = 0
      const cutOff = new AIError({
        reason: new TransportError({
          message: "Network is down",
          transport: "http",
          operation: "read",
          code: "ENETDOWN",
        }),
      })
      yield* ModelRetry.retryOneShot(Effect.suspend(() => (calls++, Effect.fail(cutOff)))).pipe(Effect.flip)
      expect(calls).toBe(1)
    }),
  )
})

describe("toSessionError", () => {
  test("names the network when the provider's host can't be reached", () => {
    expect(toSessionError(dnsFailure)).toEqual({
      type: "provider.transport",
      message: "Can't reach opencode.ai. Check the network connection. (getaddrinfo ENOTFOUND opencode.ai)",
    })
    expect(toSessionError(refused)).toEqual({ type: "provider.transport", message: "Unable to connect" })
  })
})
