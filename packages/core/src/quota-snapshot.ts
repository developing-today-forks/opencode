export * as QuotaSnapshot from "./quota-snapshot.js"

import { ModelUsage } from "./model-usage.js"
import { ModelRouteLimits } from "./model-route-limits.js"
import type { ModelPlan } from "./model-plan.js"

/**
 * One quota signal for every consumer (design #587, phase 1 in #588): a pure derivation of a snapshot per
 * plan window from the plan store plus recorded usage, reusing `ModelUsage.windowReport` for the
 * percent/remaining arithmetic instead of duplicating it. Snapshots are derived, never stored: the stored
 * truth stays plans + route history, exactly as `windowReport` already treats it. Nothing in the selection
 * path reads snapshots yet.
 *
 * The staleness contract is defined here once: one configured max age (a per-plan override is allowed)
 * decides `stale` for every consumer. A snapshot with neither a percent nor a usable balance, or one that is
 * stale, is *unknown* — never headroom and never a wall; what a consumer does with unknown is its own fallback.
 */

export interface Snapshot {
  readonly planID: string
  readonly window: string
  readonly providerID: string
  /** Percent of the window's limit used, or null when it cannot be derived — never a guessed number. */
  readonly percent: number | null
  readonly remaining: number | null
  /** Epoch ms of the next reset when the window's reset data yields one; null otherwise. */
  readonly resetAt: number | null
  /** When the underlying usage data was current (epoch ms). */
  readonly observedAt: number
  readonly stale: boolean
  /** A credit balance is a point-in-time amount, not a resetting usage window. */
  readonly balance?: boolean
  /** The grant is explicitly expired or its expiry is in the past. */
  readonly expired?: boolean
}

export interface Options {
  /** The clock the derivation is pure in: same inputs plus the same `now` give the same snapshots. */
  readonly now: number
  /** Max age before an observation is stale. One definition for all consumers; default one hour. */
  readonly maxAgeMs?: number
  /** Per-plan max-age overrides, keyed by plan id — the one definition above, overridden per plan. */
  readonly perPlanMaxAgeMs?: Readonly<Record<string, number>>
  /** A credit balance at or below this amount is considered exhausted. Defaults to ten cents. */
  readonly balanceDeadThreshold?: number
}

/** The default staleness max age: one hour, the fleet's placement-read discipline (#587 open question). */
export const DEFAULT_MAX_AGE_MS = 3_600_000
export const DEFAULT_BALANCE_DEAD_THRESHOLD = 0.1

export interface Input {
  readonly plan: ModelPlan.Plan
  readonly window: ModelPlan.QuotaWindow
  /** Usage totals for this window over its last `windowHours`, as `windowReport` consumes them. */
  readonly totals: ModelUsage.Totals
  /** When `totals` were current (epoch ms). */
  readonly observedAt: number
}

/**
 * The next reset a window's reset data yields a concrete time for: an explicit `resetAt` recorded on the
 * window, or a `daily HH:MM UTC` rule (the next occurrence after `now`). Anything else — `rolling`,
 * free-text rules — has no single derivable instant and yields null rather than a guess. An explicit
 * `resetAt` is a recorded fact, not a derivation, so it is returned as recorded even when it is already
 * in the past; consumers judge staleness from `now`, the value is never discarded or rolled forward.
 */
const resetAtOf = (window: ModelPlan.QuotaWindow, now: number): number | null => {
  if (window.resetAt !== undefined) {
    return ModelRouteLimits.parseAbsoluteTime(window.resetAt) ?? null
  }
  const daily = window.resetRule?.match(/^daily (\d{1,2}):(\d{2}) UTC$/)
  if (daily) {
    const hour = Number(daily[1])
    const minute = Number(daily[2])
    // Out-of-range components have no derivable instant: yield null rather than letting
    // setUTCHours roll the overflow into a fabricated reset in the next hour or day.
    if (hour > 23 || minute > 59) return null
    const at = new Date(now)
    at.setUTCHours(hour, minute, 0, 0)
    return at.getTime() <= now ? at.getTime() + 86_400_000 : at.getTime()
  }
  return null
}

export const derive = (input: Input, options: Options): Snapshot => {
  const report = ModelUsage.windowReport(input.plan, input.window, input.totals)
  // Without `windowHours` the totals cannot be attributed to this window (#550), so a percent computed
  // from them would not be a reading of the window: report unknown instead of that number.
  const windowed = input.window.windowHours !== undefined
  // Only a non-windowed credits/usd quota is a point-in-time balance: a windowed one is a
  // resetting usage window whose remaining derives from rolling usage, so treating it as a
  // balance would let elapsed time masquerade as a balance increase (and would hold it
  // without a timed expiry past its stated reset).
  const balance =
    input.plan.coverage === "credits" && input.window.unit === "usd" && input.window.windowHours === undefined
  const expiresAt =
    input.plan.expiresOn === undefined ? undefined : ModelRouteLimits.parseAbsoluteTime(input.plan.expiresOn)
  const expired = input.plan.status === "expired" || (expiresAt !== undefined && expiresAt <= options.now)
  const remaining = balance ? report.remaining : windowed ? report.remaining : null
  const threshold = options.balanceDeadThreshold ?? DEFAULT_BALANCE_DEAD_THRESHOLD
  const deadBalance =
    balance &&
    (expired ||
      (remaining !== null &&
        remaining <= threshold + Number.EPSILON * Math.max(1, Math.abs(remaining), Math.abs(threshold))))
  // Own-property resolution only: a plain lookup reads through the prototype chain, so a plan
  // named e.g. "constructor" would inherit the Object function as its max age instead of falling
  // through to the configured/default max age, and would never go stale (#824).
  const perPlan = options.perPlanMaxAgeMs
  const override = perPlan && Object.hasOwn(perPlan, input.plan.id) ? perPlan[input.plan.id] : undefined
  const maxAge = override ?? options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  return {
    planID: input.plan.id,
    window: input.window.name,
    providerID: input.plan.providerID,
    percent: deadBalance ? 100 : windowed ? report.percent : null,
    remaining,
    resetAt: resetAtOf(input.window, options.now),
    observedAt: input.observedAt,
    stale: options.now - input.observedAt > maxAge,
    ...(balance ? { balance: true, expired } : {}),
  }
}

/**
 * The earliest usage instant that counts against a plan window's grant: the rolling window's
 * start for a windowed quota, and the grant's own start (the plan record's creation) for a
 * non-windowed credit balance — spending before the grant existed is not consumption of it.
 * Anything else is accounted from the beginning of the route history.
 */
export const usageSince = (plan: ModelPlan.Plan, window: ModelPlan.QuotaWindow, now: number): number => {
  if (window.windowHours !== undefined) return now - window.windowHours * 3_600_000
  if (plan.coverage === "credits" && window.unit === "usd")
    return ModelRouteLimits.parseAbsoluteTime(plan.createdAt) ?? 0
  return 0
}

/**
 * The one snapshot of a provider's set that gates a target: a known-full snapshot wins
 * (latest reset first), then a balance snapshot, then the first. An expired credit grant
 * never wins over a live snapshot of the same provider — the plan store retains expired
 * grants as history, and letting one gate would make a funded replacement unable to
 * re-admit the provider. Only when every snapshot is an expired balance does the expired
 * one still gate: there is no live grant to prefer.
 */
export const gatingSnapshot = (
  snapshots: readonly Snapshot[],
  now: number,
  balanceDeadThreshold = DEFAULT_BALANCE_DEAD_THRESHOLD,
): Snapshot | undefined => {
  const live = snapshots.filter((snapshot) => !(snapshot.balance === true && snapshot.expired === true))
  const pool = live.length > 0 ? live : snapshots
  const full = pool
    .filter((snapshot) => isKnownFull(snapshot, now, balanceDeadThreshold))
    .sort((a, b) => (b.resetAt ?? 0) - (a.resetAt ?? 0))[0]
  return full ?? pool.find((snapshot) => snapshot.balance) ?? pool[0]
}

/** One snapshot per quota window of every plan, in plan then window order. */
export const deriveAll = (
  plans: readonly ModelPlan.Plan[],
  totals: (plan: ModelPlan.Plan, window: ModelPlan.QuotaWindow) => ModelUsage.Totals,
  observedAt: number,
  options: Options,
): Snapshot[] =>
  plans.flatMap((plan) =>
    plan.quotas.map((window) => derive({ plan, window, totals: totals(plan, window), observedAt }, options)),
  )

/** Whether a snapshot carries a usable, fresh percent or balance reading. */
export const known = (snapshot: Snapshot): boolean =>
  !snapshot.stale &&
  (snapshot.percent !== null ||
    (snapshot.balance === true && (snapshot.remaining !== null || snapshot.expired === true)))

/**
 * Whether a snapshot is a known-full reading at `now` (#6 gate): a fresh window percent at or over
 * its limit whose reset is still ahead, or a dead/expired credit balance. A null window reset stays
 * full until a fresher snapshot reads below the limit; balance gates instead require a fresh increase.
 * Unknown or stale snapshots are never full: per the contract above they are neither headroom nor a wall.
 */
export const isKnownFull = (
  snapshot: Snapshot,
  now: number,
  balanceDeadThreshold = DEFAULT_BALANCE_DEAD_THRESHOLD,
): boolean =>
  known(snapshot) &&
  (snapshot.balance === true
    ? snapshot.expired === true ||
      (snapshot.remaining !== null &&
        snapshot.remaining <=
          balanceDeadThreshold +
            Number.EPSILON * Math.max(1, Math.abs(snapshot.remaining), Math.abs(balanceDeadThreshold)))
    : snapshot.percent !== null && snapshot.percent >= 100 && (snapshot.resetAt === null || snapshot.resetAt > now))
