/**
 * MockRouteDriver — drives one routed step against a {@link MockProvider} through the real
 * resolution path, for the failover regression tests in #1806.
 *
 * The driver is a mirror, not a re-implementation, of the two production loops it stands
 * between, and every production-owned decision stays in production code:
 *
 * - Selection: the resolver's per-route loop (`model-resolver.ts`): ready/unavailable are
 *   computed leaf by leaf from `ModelRoute`'s own predicates (cooldowns, credential cooldowns,
 *   credential quota gates, pool quota pull-out, provider rate-limit holds, skips, budgets,
 *   context ceilings), the last-resort set is derived the same way, and the pick itself is
 *   `ModelRoute.nextTarget`. Bench probes are claimed per pick exactly as the resolver
 *   claims them.
 * - Outcome accounting: the runner's recipe (`session/runner/step.ts`): `recordRequest`,
 *   the rate-limit snapshot observation, the quota-failure gate
 *   (`SessionStep.quotaFailureClassification` → `ModelRoute.observeQuotaFailure`), and
 *   `ModelRoute.failed`/`completed` with `SessionStep.failureHint`. A quota-class failure
 *   first walks the same target's remaining credentials (the runner's credential failover)
 *   before the route itself fails over. The attempt timeout reproduces the runner's
 *   first-token timeout error verbatim.
 *
 * What the driver deliberately does NOT reproduce: the resolver's cross-route cascade
 * (route → route chains and their `triedRefs` seeding). Scenarios that live at that altitude
 * are called out in the tests that need them.
 */
import { AIError, TransportError, isRetryable } from "@opencode/ai"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteAutonomy } from "@opencode/core/model-route-autonomy"
import { ModelRouteLimits } from "@opencode/core/model-route-limits"
import { SessionStep } from "@opencode/core/session/runner/step"
import { MockProvider, type MockSuccess } from "./mock-provider"

export interface DriveAttempt {
  readonly index: number
  readonly target: ModelRoute.Target
  readonly credentialID?: string
  readonly outcome: "text" | "tool-call" | "error"
  readonly error?: AIError
}

export interface DriveResult {
  /** "served": an attempt succeeded. "no-candidates": resolution found nothing eligible —
   * the #1806 death. "failed": an attempt failed terminally (not failover-eligible). */
  readonly status: "served" | "no-candidates" | "failed"
  readonly servedIndex?: number
  readonly servedTarget?: ModelRoute.Target
  readonly servedCredentialID?: string
  readonly success?: MockSuccess
  readonly attempts: readonly DriveAttempt[]
}

export interface DriveInput {
  readonly definition: ModelRoute.Definition
  readonly mock: MockProvider
  readonly sessionID?: string
  /** Credentials available per provider, in serving order. The first unattempted one is the
   * active credential; a quota-class failure walks the rest on the same leaf before the
   * route fails over, as the runner does. */
  readonly credentials?: ReadonlyMap<string, readonly string[]>
  /** Attempt deadline; defaults to the route policy's `firstTokenTimeoutMs` when numeric. */
  readonly attemptTimeoutMs?: number
  readonly allowCooling?: boolean
  readonly requestTokens?: number
  readonly random?: () => number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const driveStep = async (input: DriveInput): Promise<DriveResult> => {
  const { definition, mock } = input
  const policy = definition.health
  const attempts: DriveAttempt[] = []
  const tried = new Set<number>()
  const attemptedCredentials = new Map<string, Set<string>>()
  const random = input.random ?? (() => 0)
  const timeoutMs =
    input.attemptTimeoutMs ?? (typeof policy.firstTokenTimeoutMs === "number" ? policy.firstTokenTimeoutMs : undefined)

  const credentialsOf = (providerID: string) => input.credentials?.get(providerID) ?? []
  const activeCredential = (providerID: string): string | undefined => {
    const attempted = attemptedCredentials.get(providerID)
    return credentialsOf(providerID).find((id) => !attempted?.has(id))
  }
  const credentialOf = (target: ModelRoute.Target) => activeCredential(target.providerID as string)

  /** The resolver's ready filter, leaf by leaf (model-resolver.ts). */
  const computeEligible = (now: number) => {
    const indexes = definition.targets.flatMap((_, index) => (tried.has(index) ? [] : [index]))
    const unavailable = new Map<number, string>()
    const overLimit = new Set<number>()
    const poolExhausted = new Map<number, boolean>()
    for (const index of indexes)
      poolExhausted.set(
        index,
        ModelRoute.poolQuotaExhausted(definition, index, now, (leaf) =>
          credentialOf(definition.targets[leaf]),
        ),
      )
    const rules = ModelRouteAutonomy.usesRules(definition.autonomy)
    const scope = ModelRoute.scopeOf(definition, [])
    const ready = indexes.filter((index) => {
      const target = definition.targets[index]
      const until = ModelRoute.cooldownUntil(target, now)
      const isSkipped =
        ModelRoute.userSkipped(target, now, scope) || (rules && ModelRoute.skipped(target, now, scope))
      const isOverBudget = rules && ModelRoute.overBudget(target, definition.budgets?.[index], now, scope)
      const isOverLimit = ModelRoute.overLimit(definition, index, input.requestTokens)
      if (isOverLimit) overLimit.add(index)
      const credentialID = credentialOf(target)
      const limited = rules ? ModelRoute.limitedUntil(target, now, credentialID) : 0
      const kept =
        limited > now &&
        ModelRoute.keepsThrough(definition.id, input.sessionID, target, now, credentialID)
      const credentialUntil = credentialID ? ModelRoute.credentialCooldownUntil(target, credentialID, now) : 0
      const quotaBlock = credentialID
        ? ModelRoute.credentialQuotaBlocked(credentialID, now)
        : undefined
      const targetProbe = until > now && ModelRoute.probeDue(target, undefined, now)
      const credentialProbe =
        credentialUntil > now && credentialID !== undefined && ModelRoute.probeDue(target, credentialID, now)
      const isPoolExhausted = poolExhausted.get(index) ?? false
      if (until > now && !targetProbe) unavailable.set(index, `cooldown-until:${until}`)
      else if (credentialUntil > now && !credentialProbe)
        unavailable.set(index, `credential-cooldown-until:${credentialUntil}`)
      else if (quotaBlock) unavailable.set(index, `quota-known-full-until:${quotaBlock.until ?? "unknown"}`)
      else if (isPoolExhausted)
        unavailable.set(index, `pool-quota-exhausted:${ModelRoute.poolIDOf(definition, index) ?? "pool"}`)
      else if (limited > now && !kept) unavailable.set(index, `provider-limit-until:${limited}`)
      else if (isSkipped) unavailable.set(index, "user-skip")
      else if (isOverBudget) unavailable.set(index, "soft-budget")
      else if (isOverLimit) unavailable.set(index, "over-limit")
      return (
        (until <= now || targetProbe) &&
        (credentialUntil <= now || credentialProbe) &&
        quotaBlock === undefined &&
        !isPoolExhausted &&
        (limited <= now || kept) &&
        !isSkipped &&
        !isOverBudget &&
        !isOverLimit
      )
    })
    const usable = indexes.filter((index) => !overLimit.has(index))
    const nonFull = usable.filter((index) => {
      const credentialID = credentialOf(definition.targets[index])
      return credentialID === undefined || ModelRoute.credentialQuotaBlocked(credentialID, now) === undefined
    })
    const nonPool = usable.filter((index) => !poolExhausted.get(index))
    const nonPoolNonFull = nonPool.filter((index) => nonFull.includes(index))
    const lastResort = nonPool.length === 0 ? [] : nonPoolNonFull.length > 0 ? nonPoolNonFull : nonPool
    return { unavailable, eligible: ready.length > 0 ? ready : input.allowCooling ? lastResort : [] }
  }

  const claimProbes = (
    target: ModelRoute.Target,
    credentialID: string | undefined,
    now: number,
  ): ModelRoute.ProbeClaim | undefined => {
    const token = ModelRoute.nextProbeClaimToken()
    const targetClaimed = ModelRoute.claimBenchProbe(target, undefined, now, token)
    const credentialClaimed = credentialID ? ModelRoute.claimBenchProbe(target, credentialID, now, token) : false
    if (!targetClaimed && !credentialClaimed) return undefined
    return { claimedAt: now, token, ...(credentialClaimed && credentialID ? { credentialID } : {}) }
  }

  const attemptOnce = async (
    target: ModelRoute.Target,
    credentialID: string | undefined,
  ): Promise<MockSuccess> => {
    const pending = mock.attempt(target, credentialID)
    if (timeoutMs === undefined) return pending
    const guarded = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    const raced = await Promise.race([guarded, sleep(timeoutMs).then(() => ({ timedOut: true as const }))])
    if ("timedOut" in raced)
      // The runner's first-token timeout, verbatim (session/runner/step.ts).
      throw new AIError({
        reason: new TransportError({
          message: `No response output within ${timeoutMs}ms`,
          transport: "http",
          operation: "request",
          code: "Timeout",
        }),
      })
    if ("error" in raced) throw raced.error
    return raced.value
  }

  while (tried.size < definition.targets.length) {
    const now = Date.now()
    const { unavailable, eligible } = computeEligible(now)
    const index = ModelRoute.nextTarget(
      definition,
      new Set(eligible),
      tried,
      input.sessionID,
      input.sessionID !== undefined,
      undefined,
      unavailable,
      random,
      (leaf) => credentialOf(definition.targets[leaf]),
    )
    if (index === undefined) return { status: "no-candidates", attempts }
    tried.add(index)
    const target = definition.targets[index]

    // One leaf: walk its credentials on quota-class failures before the route moves on.
    for (;;) {
      const credentialID = activeCredential(target.providerID as string)
      const claim = claimProbes(target, credentialID, Date.now())
      ModelRoute.recordRequest(target, undefined)
      let success: MockSuccess | undefined
      let failure: AIError | undefined
      try {
        success = await attemptOnce(target, credentialID)
      } catch (error) {
        if (!(error instanceof AIError)) throw error
        failure = error
      }

      if (success) {
        // A success with no advertised limit state clears the credential's hold (#870).
        ModelRoute.clearRateLimit(target, credentialID)
        ModelRoute.completed(
          target,
          policy,
          { firstTokenMs: 25, responseMs: 90, tokensPerSecond: 60 },
          Date.now(),
          credentialID,
          undefined,
          claim,
        )
        if (input.sessionID) ModelRoute.served(definition.id, input.sessionID, target)
        attempts.push({
          index,
          target,
          ...(credentialID === undefined ? {} : { credentialID }),
          outcome: success.type,
        })
        return {
          status: "served",
          servedIndex: index,
          servedTarget: target,
          ...(credentialID === undefined ? {} : { servedCredentialID: credentialID }),
          success,
          attempts,
        }
      }

      const error = failure!
      attempts.push({
        index,
        target,
        ...(credentialID === undefined ? {} : { credentialID }),
        outcome: "error",
        error,
      })
      // The runner's outcome accounting (session/runner/step.ts), in its order.
      const failedAt = Date.now()
      const hint = SessionStep.failureHint(error)
      ModelRoute.observeRateLimit(
        target,
        ModelRouteLimits.snapshot((error.reason as { rateLimit?: ModelRouteLimits.Details }).rateLimit, failedAt),
        failedAt,
        credentialID,
      )
      const quotaClassification = SessionStep.quotaFailureClassification(error)
      if (quotaClassification)
        ModelRoute.observeQuotaFailure(
          target,
          credentialID,
          hint.retryAfterMs === undefined ? undefined : failedAt + hint.retryAfterMs,
          failedAt,
          quotaClassification,
        )
      const policyFailure = error.reason._tag === "ContentPolicy"
      if (policyFailure) {
        // A policy refusal never benches the target, but an outstanding probe claim must be
        // handed back or the bench's recovery stalls (#1084).
        if (claim) {
          ModelRoute.releaseBenchProbe(target, undefined, claim.claimedAt, claim.token)
          if (claim.credentialID) ModelRoute.releaseBenchProbe(target, claim.credentialID, claim.claimedAt, claim.token)
        }
      } else {
        ModelRoute.failed(target, policy, failedAt, hint, credentialID, undefined, claim)
      }

      // Credential failover (#6): a quota-class failure on one credential re-issues the same
      // target on the next eligible credential before the route itself moves on.
      if (credentialID !== undefined && SessionStep.isQuotaFailure(error)) {
        const attempted = attemptedCredentials.get(target.providerID as string) ?? new Set<string>()
        attempted.add(credentialID)
        attemptedCredentials.set(target.providerID as string, attempted)
        if (activeCredential(target.providerID as string) !== undefined) continue
      }

      const routeFailure =
        isRetryable(error) || error.reason._tag === "Authentication" || error.reason._tag === "QuotaExceeded"
      if (policyFailure || routeFailure) {
        if (input.sessionID) ModelRoute.moved(definition.id, input.sessionID, target)
        break
      }
      return { status: "failed", attempts }
    }
  }
  return { status: "no-candidates", attempts }
}
