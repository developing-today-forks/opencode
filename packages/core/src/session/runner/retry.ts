export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/** Optional bounds a caller may tighten the policy with (the runner passes the
 * resolved route's per-target attempt budget). The policy's own constants are
 * the ceiling: a caller can only ever narrow them. */
export interface Limits {
  /** Retries allowed after the first attempt (a route's `attempts` counts the
   * first attempt too, so the runner passes `attempts - 1`). */
  readonly maxRetries?: number
  /** Cumulative granted delay allowed across the step's retries. */
  readonly maxWaitMs?: number
}

/** Drew's rule (2026-11-14, code#9549): a leg gets a few tries, not forever.
 * A routed step's retries are bounded by the route's own per-target attempt
 * budget (the runner passes it through `Limits`); MAX_RETRIES is the ceiling
 * for steps with no route budget — an unrouted model, and compaction, whose
 * draft restarts share one step's policy by design. MAX_WAIT_MS caps the
 * CUMULATIVE granted delay across a step's retries at the same figure a
 * single stated retry-after is already capped at: a leg may wait out one
 * long stated wait, never a procession of them. When a bound hits, the leg
 * is exhausted and the step's failover walk (or the step's failure, for an
 * unrouted model) owns what happens next — the session never sits retrying
 * an exhausted leg while candidates remain. */
export const MAX_RETRIES = 10
export const MAX_WAIT_MS = Duration.toMillis("15 minutes")

/** Text that states a quota window (or a credit balance) is spent. Mirrors the
 * session step's bench-class text (`quotaText` in step.ts, #1806): the retry
 * policy and the bench must agree on what a wall sounds like, or the identical
 * condition is retried by one and benched by the other. */
const QUOTA_TEXT =
  /individual quota|quota (?:exhausted|reached|exceeded)|insufficient credits|insufficient balance|insufficient funds|out of credits|usage limit (?:exceeded|reached)|reached your (?:usage|quota|plan) limit/i

/** Text that states the account or service itself is disabled — the refusal
 * Google serves for an Antigravity terms suspension ("This service has been
 * disabled in this account for violation of Terms of Service"). */
const ACCOUNT_DISABLED_TEXT =
  /disabled in this account|violation of (?:the )?terms of service|account (?:has been |was )?disabled|organization has disabled/i

/**
 * Failures that end a leg immediately (code#9549): an authentication refusal
 * (the `Authentication` tag, or an HTTP 401/403 riding any other tag), a quota
 * exhaustion (the `QuotaExceeded` tag, or exhaustion stated in the error's own
 * text), or an account/service-disabled refusal. None of these can heal by
 * being asked again — a walled leg is not attempted again, not even as a
 * probe — yet the routed step proposes a retry for exactly these classes (its
 * `routeFailure` test), and until now this policy granted it: sessions sat in
 * the retry loop re-calling dead doors (1,000+ calls into a disabled provider
 * in ~3h, 2026-11-14). The decision is `retry: false` from the first failure;
 * the bench the step plants through `ModelRoute.failed` (persisted in the
 * route health log, restored across restarts) is the shared record the next
 * selections read, and the failover walk moves the turn on in the same turn.
 */
export const neverRetry = (cause: AIError): boolean => {
  const reason = cause.reason as {
    _tag: string
    http?: { status?: number }
    message?: string
    body?: string
  }
  if (reason._tag === "Authentication" || reason._tag === "QuotaExceeded") return true
  if (reason.http?.status === 401 || reason.http?.status === 403) return true
  const text = `${reason.message ?? ""} ${reason.body ?? ""}`
  return QUOTA_TEXT.test(text) || ACCOUNT_DISABLED_TEXT.test(text)
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a session for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

/** A retry decided for a failed attempt on a last-resort seat waits for the
 * seat's recheck instant — the earliest moment an excluded candidate
 * re-admits (#1806) — instead of re-resolving on the short schedule into
 * the same wall. Bounded by the same cap as provider-requested delays:
 * past it, the retry re-resolves and re-evaluates rather than parking the
 * session on a stale instant. */
export const withRecheckFloor = (decision: Decision, recheckAt: number | undefined, now = Date.now()): Decision => {
  if (recheckAt === undefined) return decision
  const wait = recheckAt - now
  if (wait <= decision.delay) return decision
  return { ...decision, delay: Math.max(decision.delay, Math.min(wait, RETRY_AFTER_MAX)) }
}

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

// Exponential from 2s capped at 10s per gap, for MAX_RETRIES retries: 2, 4, 8,
// then 10 × 7 — about 84s of waiting when every attempt fails (before the
// cumulative cap, which also governs stated retry-afters). `min` takes the
// faster schedule, so the cap applies per gap; `max` with `recurs` bounds the
// count.
const schedule = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("10 seconds")]),
  Schedule.recurs(MAX_RETRIES),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    const minimum = retryAfter(input)
    const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

// A timed-out attempt already waited minutes before failing, so the general allowance would let a
// dead provider hold a step for most of an hour. Cap those attempts well below it.
const MAX_TIMEOUT_RETRIES = 3

const isTimeout = (error: AIError) => error.reason._tag === "Transport" && error.reason.code === "Timeout"

export const policy = (sessionID: SessionSchema.ID, limits?: Limits) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    const maxRetries = Math.max(0, Math.min(MAX_RETRIES, limits?.maxRetries ?? MAX_RETRIES))
    const maxWaitMs = Math.max(0, Math.min(MAX_WAIT_MS, limits?.maxWaitMs ?? MAX_WAIT_MS))
    let attempt = 1
    let granted = 0
    let waitedMs = 0
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        // A dead or walled leg ends here, before any schedule state is spent:
        // no retry, no wait, no second call (code#9549).
        if (neverRetry(input.cause)) return { retry: false as const }
        if (granted >= maxRetries) return { retry: false as const }
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        if (isTimeout(input.cause)) timeouts++
        const delay = Math.ceil(Duration.toMillis(duration))
        // The cumulative bound: a stated retry-after is believed only inside
        // the remaining budget — one that exceeds it (a quota reset hours
        // away) exhausts the leg instead of parking the session on the wall.
        if (waitedMs + delay > maxWaitMs) return { retry: false as const }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          decision: input.retry && timeouts <= MAX_TIMEOUT_RETRIES ? { retry: true, delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        if (waitedMs + normalized > maxWaitMs) return { retry: false as const }
        granted++
        waitedMs += normalized
        return { retry: true as const, attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID, limits?: Limits) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, limits)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
