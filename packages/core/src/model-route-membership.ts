export * as ModelRouteMembership from "./model-route-membership.js"

import { ModelRouteLimits } from "./model-route-limits.js"

/** Membership caps declared on a provider definition (#2253): one account's hard
 * concurrency and per-minute request ceilings, shared by every request that lands on
 * the provider — any route, any model it serves, any session — because it is one
 * membership. The accumulator is keyed by account, not by provider-ID string: a
 * provider whose `canonical`/`instanceOf` names another provider draws from that
 * provider's accumulator, so aliases of one account can never split the count. */
export interface Limits {
  readonly concurrent: number
  readonly requestsPerMinute: number
}

/** The account a provider draws from: its canonical provider when it declares one,
 * else its own id. `instanceOf` doors are separate sign-ins of one provider family
 * and keep their own accounts; only `canonical` folds one provider's identity into
 * another's (the retired design-code / code-design / open-design ids all named this
 * one account the same way). */
export const accountOf = (providerID: string, canonical?: string): string => canonical ?? providerID

/** Caps as a provider declares them in its settings (`membership: { concurrent,
 * requestsPerMinute }`). Accepts only plain positive integers; anything else is not
 * a declaration and yields undefined, exactly as an undeclared provider does. */
export const limitsOf = (settings: unknown): Limits | undefined => {
  if (typeof settings !== "object" || settings === null) return undefined
  const membership = (settings as { membership?: unknown }).membership
  if (typeof membership !== "object" || membership === null) return undefined
  const { concurrent, requestsPerMinute } = membership as { concurrent?: unknown; requestsPerMinute?: unknown }
  if (!Number.isInteger(concurrent) || (concurrent as number) <= 0) return undefined
  if (!Number.isInteger(requestsPerMinute) || (requestsPerMinute as number) <= 0) return undefined
  return { concurrent: concurrent as number, requestsPerMinute: requestsPerMinute as number }
}

/** The rolling window the per-minute cap counts starts in. */
export const WINDOW_MS = 60_000
/** Accounts retained; the LRU bound precedent of the health maps. */
const ACCOUNT_LIMIT = 2_000

export interface State {
  /** Requests currently in flight against the account. Never exceeds the cap. */
  inFlight: number
  /** Start instants (ms since epoch) still inside the rolling window, ascending. */
  starts: number[]
  /** Until when an upstream tier-limit answer holds the whole account out (ms since
   * epoch), when one was recorded. */
  heldUntil: number
}

/** A fresh accumulator: nothing in flight, no starts, no hold. */
export const empty = (): State => ({ inFlight: 0, starts: [], heldUntil: 0 })

/** What one admission attempt against the account concludes. `waitMs` is set only
 * when a slot is certain to free at a known instant (an in-flight request ending
 * frees a slot but not at a known time, so concurrency waits are only offered
 * through the caller-supplied estimate; a window slot frees exactly when the
 * oldest in-window start ages out). */
export type Admission =
  | { readonly granted: true }
  | { readonly granted: false; readonly blockedBy: "hold" | "concurrency" | "window"; readonly waitMs?: number }

const prune = (state: State, now: number) => {
  while (state.starts.length > 0 && state.starts[0] <= now - WINDOW_MS) state.starts.shift()
}

/** Admits one request start when the account has room: under the concurrency cap,
 * under the per-minute cap, and not held out by an upstream tier-limit answer.
 * Granting records the start and the in-flight slot together, so the accumulator
 * can never exceed either cap however admissions interleave. */
export const tryAcquire = (state: State, limits: Limits, now: number): Admission => {
  prune(state, now)
  if (state.heldUntil > now) return { granted: false, blockedBy: "hold", waitMs: state.heldUntil - now }
  if (state.inFlight >= limits.concurrent) return { granted: false, blockedBy: "concurrency" }
  if (state.starts.length >= limits.requestsPerMinute) {
    const freesAt = state.starts[state.starts.length - limits.requestsPerMinute] + WINDOW_MS
    return { granted: false, blockedBy: "window", waitMs: Math.max(0, freesAt - now) }
  }
  state.inFlight += 1
  state.starts.push(now)
  return { granted: true }
}

/** Ends one in-flight request. A double release (or a release with nothing in
 * flight) is ignored rather than driving the count negative. */
export const release = (state: State) => {
  if (state.inFlight > 0) state.inFlight -= 1
}

/** What the account looks like right now, for ledgers and tests. */
export const snapshot = (state: State, now: number) => {
  prune(state, now)
  return {
    inFlight: state.inFlight,
    startsInWindow: state.starts.length,
    heldUntil: state.heldUntil > now ? state.heldUntil : 0,
  }
}

/** When the next start could be admitted, ignoring concurrency (an in-flight end
 * has no known instant): the later of the upstream hold and the window freeing. */
export const nextStartAt = (state: State, limits: Limits, now: number): number => {
  prune(state, now)
  let at = now
  if (state.heldUntil > now) at = Math.max(at, state.heldUntil)
  if (state.starts.length >= limits.requestsPerMinute)
    at = Math.max(at, state.starts[state.starts.length - limits.requestsPerMinute] + WINDOW_MS)
  return at
}

// ---------------------------------------------------------------------------
// The process-wide registry: one accumulator per account, shared by every
// caller in the process (the session runner, the generation façade, background
// calls) exactly as the route health maps are shared.

const accounts = new Map<string, State>()

const entry = (account: string): State => {
  let state = accounts.get(account)
  if (!state) {
    state = empty()
    accounts.set(account, state)
  }
  accounts.delete(account)
  accounts.set(account, state)
  while (accounts.size > ACCOUNT_LIMIT) accounts.delete(accounts.keys().next().value!)
  return state
}

/** Admits one request against the account's declared caps. Providers with no
 * declared caps are always admitted and record nothing — except when an upstream
 * tier-limit hold already stands on the account: the hold is recorded against
 * the account itself (a backstop reading), so it binds the next start even when
 * the caller that consults it has no caps declaration in hand. */
export const acquire = (account: string, limits: Limits | undefined, now = Date.now()): Admission => {
  if (!limits) {
    const state = accounts.get(account)
    if (state && state.heldUntil > now) return { granted: false, blockedBy: "hold", waitMs: state.heldUntil - now }
    return { granted: true }
  }
  return tryAcquire(entry(account), limits, now)
}

/** Ends one in-flight request against the account. */
export const releaseAccount = (account: string) => {
  const state = accounts.get(account)
  if (state) release(state)
}

/** The account's current standing, for ledgers and tests. */
export const accountSnapshot = (account: string, now = Date.now()) => {
  const state = accounts.get(account)
  return state ? snapshot(state, now) : { inFlight: 0, startsInWindow: 0, heldUntil: 0 }
}

/** Records an upstream `tier_limit_exceeded` answer against the account (#2253
 * backstop): the provider is held out of rotation until the reset the error
 * states. The message forms decide the hold, mirroring the limits module's
 * invariants — a stated reset is believed up to a day; a concurrency answer with
 * no stated reset holds for a minute (a slot frees as in-flight work ends); an
 * rpm answer with no stated reset holds until the oldest in-window start ages
 * out, at most a minute. Returns the instant the hold ends. */
export const recordTierLimit = (account: string, message: string | undefined, now = Date.now()): number => {
  const state = entry(account)
  prune(state, now)
  const stated = ModelRouteLimits.retryHintFromMessage(message, now)
  const rpm = /rpm|per[- ]minute|requests per minute/i.test(message ?? "")
  const until =
    stated !== undefined
      ? now + Math.min(stated, 86_400_000)
      : rpm && state.starts.length > 0
        ? state.starts[0] + WINDOW_MS
        : now + 60_000
  state.heldUntil = Math.max(state.heldUntil, until)
  return state.heldUntil
}

/** Until when an upstream tier-limit answer holds the account out; 0 when it doesn't. */
export const heldUntil = (account: string, now = Date.now()): number => {
  const state = accounts.get(account)
  return state && state.heldUntil > now ? state.heldUntil : 0
}

/** Test seam; membership state is process-local like route health. */
export const reset = () => accounts.clear()
