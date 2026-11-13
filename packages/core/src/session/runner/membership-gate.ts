export * as SessionMembershipGate from "./membership-gate.js"

import { Duration, Effect } from "effect"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteLog } from "../../model-route-log.js"

/** The membership gate (#2253): before a request starts against a provider that
 * declares membership caps, the start is metered against the one shared account
 * accumulator (ModelRouteMembership, via ModelRoute). When the account is
 * momentarily full, the request waits briefly — never longer than the configured
 * bound — for a slot to free; when no slot frees within the bound, the caller
 * fails over to the next leg silently instead of spending an attempt the
 * provider would refuse with `tier_limit_exceeded`.
 *
 * The gate is shared by the session runner's step attempt and the generation
 * façade so every door draws from the same accumulator. It is deliberately
 * small: admission, the bounded wait, the slot's release, and the ledger rows
 * that make waits and failovers visible. Which model a failover moves to stays
 * the caller's routing decision. */

export interface MembershipRef {
  readonly providerID: string
  readonly canonical?: string
}

export interface GateResult {
  /** True when the caller holds a membership slot it must release. False when
   * the provider declares no caps (nothing was metered, so nothing to release)
   * or when the last-resort path proceeded without a slot. */
  readonly held: boolean
  /** True when admission had to wait for a slot before it was granted. */
  readonly waited: boolean
}

/** Releases a held membership slot. Safe to call for a result that held none. */
export const release = (membership: MembershipRef | undefined, result: GateResult | undefined) => {
  if (membership && result?.held) ModelRoute.membershipRelease(membership.providerID, membership.canonical)
}

const ledger = (input: {
  readonly sessionID?: string
  readonly routeID: string
  readonly membership: MembershipRef
  readonly reason: "membership-wait" | "membership-failover"
  readonly detail: Record<string, unknown>
}) =>
  ModelRouteLog.record({
    kind: "decision",
    row: {
      time: Date.now(),
      ...(input.sessionID ? { session_id: input.sessionID } : {}),
      route_id: input.routeID,
      selection: "membership",
      candidates: [input.membership.providerID],
      reason: input.reason,
      detail: input.detail,
    },
  })

/** Runs the gate for one request start.
 *
 * - No declared caps: passes at once, holding nothing.
 * - Room in the account: admitted at once, holding a slot.
 * - Full, and a slot frees within the bound: waits (polling — a concurrency slot
 *   frees when an in-flight request ends, which no clock can predict), then
 *   admitted holding a slot; the wait is ledgered.
 * - Full past the bound: returns `undefined` — the caller fails over silently.
 *   The refusal is ledgered as a membership failover.
 * - Full and `lastResort` (the caller has no other leg): admitted without a
 *   slot — proceeding over the local count beats failing the request outright;
 *   the provider's own answer remains the backstop.
 *
 * `now`/`sleep` are injectable so tests control time instead of waiting for it. */
export const gate = (input: {
  readonly membership: MembershipRef | undefined
  readonly routeID: string
  readonly sessionID?: string
  readonly location?: string
  readonly lastResort: boolean
  readonly now?: () => number
  readonly sleep?: (ms: number) => Effect.Effect<void>
}): Effect.Effect<GateResult | undefined> =>
  Effect.gen(function* () {
    const membership = input.membership
    if (!membership) return { held: false, waited: false }
    // No caps are declared for this provider (the lookup the caller's Resolved
    // stamp would have used): nothing is metered, so nothing is held — callers
    // must not pair a release with a slot that was never taken.
    if (!ModelRoute.membershipLimits(membership.providerID, membership.canonical, input.location))
      return { held: false, waited: false }
    const now = input.now ?? Date.now
    const sleep = input.sleep ?? ((ms: number) => Effect.sleep(Duration.millis(ms)))
    const waitMs = ModelRoute.currentConstants(input.location).membership.waitMs
    const deadline = now() + waitMs
    let waited = false
    while (true) {
      const admission = ModelRoute.membershipAcquire(membership.providerID, membership.canonical, input.location, now())
      if (admission.granted) {
        if (waited) {
          const standing = ModelRoute.membershipSnapshot(membership.providerID, membership.canonical, now())
          ledger({
            ...(input.sessionID ? { sessionID: input.sessionID } : {}),
            routeID: input.routeID,
            membership,
            reason: "membership-wait",
            detail: { inFlight: standing.inFlight, startsInWindow: standing.startsInWindow },
          })
        }
        return { held: true, waited }
      }
      if (input.lastResort) return { held: false, waited }
      const remaining = deadline - now()
      if (remaining <= 0) {
        const standing = ModelRoute.membershipSnapshot(membership.providerID, membership.canonical, now())
        ledger({
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          routeID: input.routeID,
          membership,
          reason: "membership-failover",
          detail: {
            blockedBy: admission.blockedBy,
            inFlight: standing.inFlight,
            startsInWindow: standing.startsInWindow,
            heldUntil: standing.heldUntil,
          },
        })
        return undefined
      }
      waited = true
      // Poll briefly: the window and hold expiries are exact, but a concurrency
      // slot frees the moment some in-flight request ends, so the check itself
      // is the signal. Bounded by both the wait bound and the known free time.
      const untilFree = admission.waitMs === undefined ? remaining : Math.min(remaining, admission.waitMs)
      yield* sleep(Math.max(1, Math.min(25, untilFree)))
    }
  })
