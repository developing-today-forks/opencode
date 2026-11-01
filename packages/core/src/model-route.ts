export * as ModelRoute from "./model-route.js"

import { Model } from "@opencode/schema/model"
import { CacheFormat } from "@opencode/schema/model-compatibility"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
import { ModelRouteLimits } from "./model-route-limits.js"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"
import { ModelRouteLog } from "./model-route-log.js"
import { ModelRouteOverrides } from "./model-route-overrides.js"
import { ModelRouteSchedule } from "./model-route-schedule.js"
import { QuotaSnapshot } from "./quota-snapshot.js"
import { optional, PositiveInt } from "@opencode/schema/schema"

export const PROVIDER_ID = Provider.ID.make("opencode-route")
export const SETTING = "opencodeRoute"

const Policy = Schema.Struct({
  firstTokenTimeoutMs: Schema.Union([PositiveInt, Schema.Literal(false)]),
  maxResponseTimeMs: PositiveInt.pipe(optional),
  minOutputTokensPerSecond: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
  sampleWindow: PositiveInt,
  slowThreshold: PositiveInt,
  cooldownMs: PositiveInt,
  /** Cooldown after the provider reports an exhausted quota without saying when it resets. */
  quotaCooldownMs: PositiveInt,
})

const TargetVariant = Schema.Struct({
  default: Model.VariantID.pipe(optional),
  map: Schema.Record(Schema.String, Model.VariantID).pipe(optional),
})

/** A leaf's declared prompt-cache format; empty means the target keeps its own compatibility. */
const TargetCacheFormat = Schema.Struct({
  cacheFormat: CacheFormat.pipe(optional),
})

const Mode = Schema.Literals(["ordered", "round-robin", "weighted"])

/** Which targets a scheduled weight change covers. Empty matchers mean "everything in reach". */
const ScheduleMatch = Schema.Struct({
  /** `provider/model` targets, `*` allowed; matches a nested route as `opencode-route/<id>`. */
  targets: Schema.Array(Schema.String).pipe(optional),
  providers: Schema.Array(Schema.String).pipe(optional),
  models: Schema.Array(Schema.String).pipe(optional),
  /** Route ids the rule is limited to, for rules configured across every route. */
  routes: Schema.Array(Schema.String).pipe(optional),
})

export interface ScheduleWindow {
  readonly daysOfWeek?: readonly number[]
  readonly daysOfMonth?: readonly number[]
  readonly start?: string
  readonly end?: string
  readonly timezone?: string
  readonly dates?: readonly string[]
  readonly excludeDates?: readonly string[]
  readonly excludeWindows?: readonly string[]
  readonly excludedWindows?: readonly ScheduleWindow[]
  readonly from?: number
  readonly until?: number
}

const ScheduleWindow: Schema.Codec<ScheduleWindow, ScheduleWindow, never, never> = Schema.Struct({
  daysOfWeek: Schema.Array(Schema.Finite).pipe(optional),
  daysOfMonth: Schema.Array(Schema.Finite).pipe(optional),
  start: Schema.String.pipe(optional),
  end: Schema.String.pipe(optional),
  timezone: Schema.String.pipe(optional),
  dates: Schema.Array(Schema.String).pipe(optional),
  excludeDates: Schema.Array(Schema.String).pipe(optional),
  excludeWindows: Schema.Array(Schema.String).pipe(optional),
  excludedWindows: Schema.Array(Schema.suspend(() => ScheduleWindow)).pipe(optional),
  from: Schema.Finite.pipe(optional),
  until: Schema.Finite.pipe(optional),
})

/** One time-bound weight change. `factor` scales the target's configured weight, `weight` replaces it. */
const WeightRule = Schema.Struct({
  id: Schema.String.pipe(optional),
  match: ScheduleMatch.pipe(optional),
  window: ScheduleWindow.pipe(optional),
  factor: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
  weight: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
  note: Schema.String.pipe(optional),
})

export type WeightRule = typeof WeightRule.Type

/** An eligibility gate on a child position, resolved at config load from a named window in
 * experimental.model_route_windows. The child is a candidate only while the window is active, or
 * only while it is not when `invert` is set. A gate only ever removes a candidate: quota demotion,
 * budgets and health still apply to a gated-in child exactly as before. */
const Gate = Schema.Struct({
  name: Schema.String,
  window: ScheduleWindow,
  invert: Schema.Boolean.pipe(optional),
})

export type Gate = typeof Gate.Type

/** Whether a gate lets its child be a candidate at `now`. No gate is always open. */
export const gateOpen = (gate: Gate | undefined, now = Date.now()): boolean =>
  gate === undefined || ModelRouteSchedule.active(gate.window, now) !== (gate.invert === true)

/** A group of targets with its own selection mode. Children are leaf target indexes or nested
 * groups; `weights` is parallel to `children`. Group 0 is the route itself. */
const Node = Schema.Struct({
  /** Route id at this point in the hierarchy. */
  routeID: Schema.String.pipe(optional),
  selection: Mode,
  weights: Schema.Array(Schema.Finite.check(Schema.isGreaterThan(0))),
  /** Weight changes declared on this route, in force while a target under this node is judged. */
  schedules: Schema.Array(WeightRule).pipe(optional),
  children: Schema.Array(
    Schema.Struct({
      leaf: Schema.Finite.pipe(optional),
      node: Schema.Finite.pipe(optional),
      /** Eligibility gate on this position, from the target's `window` in config. */
      gate: Gate.pipe(optional),
    }),
  ),
})

const Budget = Schema.Struct({
  requestsPerMinute: Schema.Finite.pipe(optional),
  requestsPerDay: Schema.Finite.pipe(optional),
  tokensPerMinute: Schema.Finite.pipe(optional),
  tokensPerDay: Schema.Finite.pipe(optional),
  softLimit: Schema.Finite.pipe(optional),
})

export type Budget = typeof Budget.Type

const Definition = Schema.Struct({
  id: Model.ID,
  targets: Schema.Array(Model.Ref),
  targetVariants: Schema.Array(TargetVariant),
  /** Parallel to `targets`; the resolved prompt-cache format for each leaf, an empty object when unset. */
  targetCacheFormats: Schema.Array(TargetCacheFormat).pipe(optional),
  health: Policy,
  attempts: Schema.Finite.pipe(optional),
  hedgeAfterMs: Schema.Finite.pipe(optional),
  /** Decision level of the route; see ModelRouteAutonomy. Unset keeps every rule on. */
  autonomy: Schema.Literals(["fixed", "rules", "adaptive", "predictive", "agent"]).pipe(optional),
  /** Parallel to `targets`; an empty object means unlimited. */
  budgets: Schema.Array(Budget).pipe(optional),
  /** The route-level context cap from config, when one is set. A request must fit this and the leaf's own ceiling. */
  limit: Schema.Struct({
    context: Schema.Finite.pipe(optional),
  }).pipe(optional),
  /** Parallel to `targets`: each leaf's effective context ceiling in tokens — the smallest per-target ceiling on the path that reached it — or an empty object when no target on the path declares one. The model's own limit still applies on top of what is stored here. */
  targetLimits: Schema.Array(
    Schema.Struct({
      context: Schema.Finite.pipe(optional),
    }),
  ).pipe(optional),
  /** Weight changes in force across every route, from experimental.model_route_schedules. */
  schedules: Schema.Array(WeightRule).pipe(optional),
  nodes: Schema.Array(Node),
})

/** A concrete provider/model a route sends requests to. */
export type Target = Model.Ref
export type Node = typeof Node.Type
export type Policy = typeof Policy.Type
export type Definition = typeof Definition.Type

const DEFAULT_POLICY: Policy = {
  firstTokenTimeoutMs: 10_000,
  sampleWindow: 5,
  slowThreshold: 3,
  cooldownMs: 60_000,
  quotaCooldownMs: 900_000,
}

export const policy = (input?: {
  readonly firstTokenTimeoutMs?: number | false
  readonly maxResponseTimeMs?: number
  readonly minOutputTokensPerSecond?: number
  readonly sampleWindow?: number
  readonly slowThreshold?: number
  readonly cooldownMs?: number
  readonly quotaCooldownMs?: number
}): Policy => {
  const sampleWindow = Math.min(input?.sampleWindow ?? DEFAULT_POLICY.sampleWindow, 50)
  return {
    firstTokenTimeoutMs: input?.firstTokenTimeoutMs ?? DEFAULT_POLICY.firstTokenTimeoutMs,
    // Unset thresholds are omitted, not undefined: the stored definition rejects explicit undefined.
    ...(input?.maxResponseTimeMs !== undefined ? { maxResponseTimeMs: input.maxResponseTimeMs } : {}),
    ...(input?.minOutputTokensPerSecond !== undefined
      ? { minOutputTokensPerSecond: input.minOutputTokensPerSecond }
      : {}),
    sampleWindow,
    slowThreshold: Math.min(input?.slowThreshold ?? DEFAULT_POLICY.slowThreshold, sampleWindow),
    cooldownMs: Math.min(input?.cooldownMs ?? DEFAULT_POLICY.cooldownMs, 3_600_000),
    quotaCooldownMs: Math.min(input?.quotaCooldownMs ?? DEFAULT_POLICY.quotaCooldownMs, 86_400_000),
  }
}

export const definition = (model: Model.Info): Definition | undefined => {
  if (model.providerID !== PROVIDER_ID) return
  const value = model.settings?.[SETTING]
  const result = Schema.decodeUnknownOption(Definition)(value)
  return result._tag === "Some" ? result.value : undefined
}

export const ref = (target: { providerID: string; model: string; variant?: string }): Model.Ref =>
  Model.Ref.make({
    providerID: Provider.ID.make(target.providerID),
    id: Model.ID.make(target.model),
    ...(target.variant ? { variant: Model.VariantID.make(target.variant) } : {}),
  })

const health = new Map<
  string,
  { samples: boolean[]; outcomes: boolean[]; cooldownUntil: number; consecutiveFailures: number }
>()

/** Health of one credential serving one target (#6): two credentials behind one provider are
 * distinct here even though they share the target's entry above, so a failure on one never
 * benches the other. Process-local like `health`; transitions are logged through the same
 * health channel. */
const credentialHealth = new Map<
  string,
  { samples: boolean[]; outcomes: boolean[]; cooldownUntil: number; consecutiveFailures: number }
>()

const credentialKey = (target: Model.Ref, credentialID: string) => `${target.providerID}/${target.id}#${credentialID}`

const credentialEntry = (target: Model.Ref, credentialID: string) => {
  const id = credentialKey(target, credentialID)
  const current = credentialHealth.get(id) ?? { samples: [], outcomes: [], cooldownUntil: 0, consecutiveFailures: 0 }
  credentialHealth.delete(id)
  credentialHealth.set(id, current)
  while (credentialHealth.size > HEALTH_LIMIT) credentialHealth.delete(credentialHealth.keys().next().value!)
  return current
}

/** Until when one credential of a target is benched; 0 when it is not. Reading an expired bench
 * clears it, exactly like `cooldownUntil` for targets. */
export const credentialCooldownUntil = (target: Model.Ref, credentialID: string, now = Date.now()) => {
  const state = credentialHealth.get(credentialKey(target, credentialID))
  if (state) recover(target, state, now, credentialID)
  return state?.cooldownUntil ?? 0
}

export const credentialCoolingDown = (target: Model.Ref, credentialID: string, now = Date.now()) =>
  credentialCooldownUntil(target, credentialID, now) > now
const HEALTH_LIMIT = 2_000
// Recent finished requests per target (true = answered). A target with at most one give-up in this
// window is steady: a single failure there is treated as transient before the route moves on.
const OUTCOME_WINDOW = 5

const key = (target: Model.Ref) => `${target.providerID}/${target.id}`

const pushOutcome = (outcomes: boolean[], answered: boolean) => [...outcomes, answered].slice(-OUTCOME_WINDOW)

const entry = (target: Model.Ref) => {
  const id = key(target)
  const current = health.get(id) ?? { samples: [], outcomes: [], cooldownUntil: 0, consecutiveFailures: 0 }
  health.delete(id)
  health.set(id, current)
  while (health.size > HEALTH_LIMIT) health.delete(health.keys().next().value!)
  return current
}

const logHealth = (
  target: Model.Ref,
  kind:
    | "cooldown-start"
    | "cooldown-end"
    | "network-suspect"
    | "rate-limit-window"
    | "quota-gated"
    | "quota-readmitted",
  reason: string,
  until?: number,
  credentialID?: string,
) =>
  ModelRouteLog.record({
    kind: "health",
    row: {
      time: Date.now(),
      provider_id: target.providerID,
      model_id: target.id,
      kind,
      reason,
      until,
      ...(credentialID ? { credential_id: credentialID } : {}),
    },
  })

const recover = (
  target: Model.Ref,
  state: { samples: boolean[]; cooldownUntil: number },
  now: number,
  credentialID?: string,
) => {
  if (state.cooldownUntil === 0 || state.cooldownUntil > now) return
  state.cooldownUntil = 0
  state.samples = []
  // Credential expirations are tagged so restart replay ends that credential's restored
  // cooldown, never the target's (#870).
  logHealth(target, "cooldown-end", credentialID ? `expired credential:${credentialID}` : "expired", undefined, credentialID)
}

// A provider-wide fault looks different from a model-specific one. When several models of the same
// provider are cooling the provider itself is demoted to last resort; when several unrelated
// providers fail at once the fault is more likely the user's network than any target, so none is
// punished.
const NETWORK_WINDOW_MS = 30_000
const NETWORK_PROVIDERS = 3
const PROVIDER_MODELS = 2
const recentFailures: Array<{ readonly provider: string; readonly target: string; readonly time: number }> = []

/** True when failures hit many unrelated providers within a short window. */
export const networkSuspect = (now = Date.now()) =>
  new Set(
    recentFailures.filter((failure) => now - failure.time <= NETWORK_WINDOW_MS).map((failure) => failure.provider),
  ).size >= NETWORK_PROVIDERS

const providerCooldownUntil = (providerID: string, now: number) => {
  const prefix = `${providerID}/`
  let count = 0
  let until = 0
  for (const [id, state] of health) {
    if (!id.startsWith(prefix) || state.cooldownUntil <= now) continue
    count++
    until = Math.max(until, state.cooldownUntil)
  }
  return count >= PROVIDER_MODELS ? until : 0
}

export const coolingDown = (target: Model.Ref, now = Date.now()) => cooldownUntil(target, now) > now

export const cooldownUntil = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (state) recover(target, state, now)
  return Math.max(state?.cooldownUntil ?? 0, providerCooldownUntil(target.providerID, now))
}

const MAX_COOLDOWN_MS = 86_400_000

/** Why a request failed, as far as the cooldown is concerned: a provider that says when it recovers
 * is believed, an exhausted quota outlasts an ordinary error. */
export interface FailureHint {
  readonly retryAfterMs?: number
  readonly quota?: boolean
  /** A local transport failure with no provider HTTP response. */
  readonly network?: boolean
  /** An authentication refusal (401/403, an org-disabled credential): it cannot heal by itself,
   * so its first bench is the long quota-length one. */
  readonly auth?: boolean
}

/** Benches one health state (a target's, or one credential's of a target) after a failure.
 * A stated retry-after is believed as-is and never multiplied; every other class doubles its
 * bench per consecutive failure (auth and quota start from the long bench), capped at a day.
 * The count survives recover() and resets only on a success, so a permanently failing target
 * backs off instead of being retried at full rate forever. */
const bench = (
  target: Model.Ref,
  state: { samples: boolean[]; outcomes: boolean[]; cooldownUntil: number; consecutiveFailures: number },
  policy: Policy,
  now: number,
  hint?: FailureHint,
  credentialID?: string,
) => {
  state.samples = []
  state.outcomes = pushOutcome(state.outcomes, false)
  state.consecutiveFailures += 1
  const base = hint?.quota || hint?.auth ? policy.quotaCooldownMs : policy.cooldownMs
  const cooldown =
    hint?.retryAfterMs !== undefined && hint.retryAfterMs > 0
      ? Math.min(Math.max(hint.retryAfterMs, 1_000), MAX_COOLDOWN_MS)
      : Math.min(base * 2 ** Math.min(state.consecutiveFailures - 1, 30), MAX_COOLDOWN_MS)
  state.cooldownUntil = now + cooldown
  logHealth(
    target,
    "cooldown-start",
    `${hint?.retryAfterMs ? "retry-after" : hint?.quota ? "quota" : hint?.auth ? "auth" : "failure"}${
      credentialID ? ` credential:${credentialID}` : ""
    }`,
    state.cooldownUntil,
    credentialID,
  )
}

export const failed = (
  target: Model.Ref,
  policy: Policy,
  now = Date.now(),
  hint?: FailureHint,
  credentialID?: string,
) => {
  // Quota, rate-limit and provider HTTP errors are not evidence of an internet outage.
  if (hint?.quota) recordQuota(target, now, credentialID)
  if (hint?.network)
    recentFailures.push({
      provider: target.providerID,
      target: credentialID ? credentialKey(target, credentialID) : key(target),
      time: now,
    })
  while (recentFailures.length > 200 || (recentFailures[0] && now - recentFailures[0].time > NETWORK_WINDOW_MS))
    recentFailures.shift()
  if (hint?.network && networkSuspect(now)) {
    // Undo the cooldowns from the earlier correlated transport errors too: those requests likely
    // shared the same local outage, so treating each provider as independently unhealthy is wrong.
    // The escalation count is undone with the cooldown: a forgiven failure must not double the
    // target's next bench (#1034).
    for (const failure of recentFailures) {
      const prior = health.get(failure.target) ?? credentialHealth.get(failure.target)
      if (prior) {
        if (prior.cooldownUntil > now) {
          prior.cooldownUntil = 0
          prior.samples = []
        }
        prior.consecutiveFailures = 0
      }
    }
    logHealth(target, "network-suspect", "transport failures across unrelated providers; target cooldowns cleared")
    return
  }
  // With a credential dimension the failure belongs to the credential that served the attempt:
  // benching the target as well would bench every other credential behind the provider too (#6).
  if (credentialID) {
    bench(target, credentialEntry(target, credentialID), policy, now, hint, credentialID)
    return
  }
  bench(target, entry(target), policy, now, hint)
}

/** Counts a request that was given up on for being slow, so a target that keeps losing hedges
 * eventually cools down like any other slow one. */
export const slow = (target: Model.Ref, policy: Policy, now = Date.now()) => {
  const state = entry(target)
  recover(target, state, now)
  if (state.cooldownUntil > now) return
  state.samples.push(true)
  if (state.samples.length > policy.sampleWindow) state.samples.shift()
  if (state.samples.filter(Boolean).length >= policy.slowThreshold) {
    state.samples = []
    state.cooldownUntil = now + policy.cooldownMs
    logHealth(target, "cooldown-start", "slow", state.cooldownUntil)
  }
}

/** Tunable behaviour. Users never need to set these; they exist so the thresholds can be changed
 * without a code change. Defaults are what a route does when nothing is configured. */
export interface Settings {
  readonly escalation: {
    /** After this many give-ups in the recent window, a route races its next target at once. */
    readonly enabled: boolean
    readonly afterGiveUps: number
  }
  readonly quota: {
    /** Quota errors within `windowMs` that move a target to the end of the route's order. */
    readonly demoteAfter: number
    readonly windowMs: number
  }
}

const DEFAULT_SETTINGS: Settings = {
  escalation: { enabled: true, afterGiveUps: 2 },
  quota: { demoteAfter: 3, windowMs: 4 * 3_600_000 },
}

let settings: Settings = DEFAULT_SETTINGS

export const configure = (
  next: Partial<{ escalation: Partial<Settings["escalation"]>; quota: Partial<Settings["quota"]> }>,
) => {
  settings = {
    escalation: { ...settings.escalation, ...next.escalation },
    quota: { ...settings.quota, ...next.quota },
  }
}

export const currentSettings = () => settings

/** Give-ups among a target's recent requests. With a credentialID, the serving credential's own
 * history counts (#870): credential failures are recorded only in credentialHealth, so a
 * target-level read would call a repeatedly failing credential steady forever. */
export const giveUps = (target: Model.Ref, credentialID?: string) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  return (state?.outcomes ?? []).filter((answered) => !answered).length
}

/** A target is steady while it has fewer give-ups than the race threshold among its recent requests. */
export const steady = (target: Model.Ref, credentialID?: string) =>
  giveUps(target, credentialID) < settings.escalation.afterGiveUps

/** A route should race its next target immediately when its current target keeps giving up. Whether a
 * route races at all depends on its autonomy level; see ModelRouteAutonomy.races. */
export const escalates = (target: Model.Ref, credentialID?: string) =>
  settings.escalation.enabled && !steady(target, credentialID)

// Quota errors are recorded per target so a provider that keeps saying "out of quota" drops to the end
// of every order, instead of being retried first on each new session.
const quotaEvents = new Map<string, number[]>()

/** True when a target has hit its quota errors often enough recently to be put last. With a
 * credentialID, only that credential's quota errors count: the demotion is per credential (#6). */
export const demoted = (target: Model.Ref, now = Date.now(), credentialID?: string) => {
  const recent = (quotaEvents.get(credentialID ? credentialKey(target, credentialID) : key(target)) ?? []).filter(
    (at) => now - at <= settings.quota.windowMs,
  )
  return recent.length >= settings.quota.demoteAfter
}

const recordQuota = (target: Model.Ref, now: number, credentialID?: string) => {
  const id = credentialID ? credentialKey(target, credentialID) : key(target)
  const recent = (quotaEvents.get(id) ?? []).filter((at) => now - at <= settings.quota.windowMs)
  quotaEvents.set(id, [...recent, now].slice(-50))
}

// The proactive half of #6: the latest quota snapshot observed per credential, and whether it
// currently gates the credential out of routes. Snapshots stay derived at their producers
// (#587); this is only the gate state consumers read. An unknown or stale observation never
// replaces a known one, so a gated credential is re-admitted only by its reset passing or by a
// fresher known snapshot below the limit — never by losing the signal.
const credentialQuota = new Map<string, { snapshot: QuotaSnapshot.Snapshot; target: Model.Ref; gated: boolean }>()

/** Feeds one credential's latest quota snapshot into the gate. */
export const observeCredentialQuota = (
  target: Model.Ref,
  credentialID: string,
  snapshot: QuotaSnapshot.Snapshot,
  now = Date.now(),
) => {
  const previous = credentialQuota.get(credentialID)
  if (previous && !QuotaSnapshot.known(snapshot)) return
  // Out-of-order delivery must not rewind the gate: an observation older than the retained
  // one carries no new information, even when it is still fresh — a below-limit reading
  // taken before the retained known-full reading cannot re-admit the credential (#6).
  if (previous && snapshot.observedAt < previous.snapshot.observedAt) return
  const full = QuotaSnapshot.isKnownFull(snapshot, now)
  credentialQuota.set(credentialID, { snapshot, target, gated: full })
  if (full && !previous?.gated)
    logHealth(
      target,
      "quota-gated",
      `credential:${credentialID} quota-known-full`,
      snapshot.resetAt ?? undefined,
      credentialID,
    )
  if (!full && previous?.gated) logHealth(target, "quota-readmitted", `credential:${credentialID}`, undefined, credentialID)
}

const providerQuota = new Map<string, { snapshot: QuotaSnapshot.Snapshot; target: Model.Ref; gated: boolean }>()

/** Feeds one provider's latest quota snapshot into the gate (for credential-less providers). */
export const observeProviderQuota = (
  target: Model.Ref,
  snapshot: QuotaSnapshot.Snapshot,
  now = Date.now(),
) => {
  const previous = providerQuota.get(target.providerID)
  if (previous && !QuotaSnapshot.known(snapshot)) return
  if (previous && snapshot.observedAt < previous.snapshot.observedAt) return
  const full = QuotaSnapshot.isKnownFull(snapshot, now)
  providerQuota.set(target.providerID, { snapshot, target, gated: full })
  if (full) {
    const until = Math.min(snapshot.resetAt ?? now + QUOTA_GATE_FALLBACK_MS, now + QUOTA_GATE_MAX_MS)
    addAdjustment({
      id: `quota:${target.providerID}`,
      match: `${target.providerID}/`,
      action: "skip",
      until,
      note: "quota exhausted (proactive snapshot); held until the stated reset",
    })
    if (!previous?.gated)
      logHealth(target, "quota-gated", `provider:${target.providerID} quota-known-full`, snapshot.resetAt ?? undefined)
  }
  if (!full && previous?.gated) {
    removeAdjustment(`quota:${target.providerID}`)
    logHealth(target, "quota-readmitted", `provider:${target.providerID}`)
  }
}

let lastQuotaFeedAt = 0

export const resetQuotaFeed = () => {
  lastQuotaFeedAt = 0
}

export const shouldFeedQuota = (now = Date.now(), ttlMs = 60_000) => {
  if (now - lastQuotaFeedAt < ttlMs) return false
  lastQuotaFeedAt = now
  return true
}

/** The longest a single exhaustion reading may hold a gate: a stated reset further out than
 * this is capped rather than believed (mirrors ModelRouteTuning.MAX_QUOTA_RESET_MS). */
const QUOTA_GATE_MAX_MS = 30 * 86_400_000
/** The hold when an exhaustion error states no usable reset: long enough to stop a 429 on
 * every turn, short enough that a recovered pool is retried promptly (mirrors the tuning
 * review's default hold). */
const QUOTA_GATE_FALLBACK_MS = 30 * 60_000

/**
 * The reactive half of #984: one attempt's quota-exhaustion answer gates its pool until the
 * reset the provider stated, or the bounded fallback hold when it stated none, so selection
 * stops spending attempts on a pool that has already answered 100%. A credentialed attempt
 * gates only its credential — sibling credentials behind the same provider keep serving.
 * A credential-less provider is gated by a skip adjustment on the provider itself, which
 * selection honours as last-resort: a route with no other door still tries it rather than
 * idling. Re-admission needs no second producer: the gate re-derives from the stated reset
 * at every check, and a fresher below-limit snapshot replaces the synthesized one.
 */
export const observeQuotaFailure = (
  target: Model.Ref,
  credentialID: string | undefined,
  resetAt: number | undefined,
  now = Date.now(),
) => {
  const until = Math.min(resetAt ?? now + QUOTA_GATE_FALLBACK_MS, now + QUOTA_GATE_MAX_MS)
  if (credentialID) {
    observeCredentialQuota(
      target,
      credentialID,
      {
        planID: `attempt:${target.providerID}`,
        window: "exhaustion",
        providerID: target.providerID,
        percent: 100,
        remaining: 0,
        resetAt: until,
        observedAt: now,
        stale: false,
      },
      now,
    )
    return
  }
  addAdjustment({
    id: `quota:${target.providerID}`,
    match: `${target.providerID}/`,
    action: "skip",
    until,
    note: "quota exhausted (attempt-reported); held until the stated reset",
  })
}

/** The gate on one credential at `now`: `{ until }` (the snapshot's reset, null when it gave
 * none) while a known-full snapshot holds it out of routes, undefined while it is eligible.
 * Passing the reset re-admits and logs it, like a cooldown expiring. */
export const credentialQuotaBlocked = (
  credentialID: string,
  now = Date.now(),
): { readonly until: number | null } | undefined => {
  const state = credentialQuota.get(credentialID)
  if (!state) return undefined
  if (QuotaSnapshot.isKnownFull(state.snapshot, now)) {
    state.gated = true
    return { until: state.snapshot.resetAt }
  }
  if (state.gated) {
    state.gated = false
    logHealth(state.target, "quota-readmitted", `credential:${credentialID}`, undefined, credentialID)
  }
  return undefined
}

export const completed = (
  target: Model.Ref,
  policy: Policy,
  sample: { readonly firstTokenMs: number; readonly responseMs: number; readonly tokensPerSecond: number },
  now = Date.now(),
  credentialID?: string,
) => {
  // A success clears the serving credential's failure count and bench (#6); the target-level
  // accounting below is unchanged, since the target did serve the request.
  if (credentialID) {
    const credentialState = credentialEntry(target, credentialID)
    credentialState.outcomes = pushOutcome(credentialState.outcomes, true)
    credentialState.consecutiveFailures = 0
    recover(target, credentialState, now, credentialID)
  }
  const state = entry(target)
  state.outcomes = pushOutcome(state.outcomes, true)
  state.consecutiveFailures = 0
  recover(target, state, now)
  if (state.cooldownUntil > now) return
  const slow =
    (typeof policy.firstTokenTimeoutMs === "number" && sample.firstTokenMs > policy.firstTokenTimeoutMs) ||
    (policy.maxResponseTimeMs !== undefined && sample.responseMs > policy.maxResponseTimeMs) ||
    (policy.minOutputTokensPerSecond !== undefined && sample.tokensPerSecond < policy.minOutputTokensPerSecond)
  state.samples.push(slow)
  if (state.samples.length > policy.sampleWindow) state.samples.shift()
  if (state.samples.filter(Boolean).length >= policy.slowThreshold) {
    state.samples = []
    state.cooldownUntil = now + policy.cooldownMs
    logHealth(target, "cooldown-start", "slow", state.cooldownUntil)
  }
}

/** Test seam; health is intentionally process-local and never persists prompts or request contents. */
export const resetHealth = () => {
  limits.clear()
  usage.clear()
  adjustments = []
  health.clear()
  credentialHealth.clear()
  credentialQuota.clear()
  providerQuota.clear()
  quotaEvents.clear()
  continuity.clear()
  recentFailures.length = 0
  lastQuotaFeedAt = 0
}

/** Per-route selection state: rotation counters for round-robin, sticky session choices, both
 * process-local like health. */
const selection = new Map<string, { cursor: number; sessions: Map<string, number>; scores: Map<number, number> }>()
const SESSION_LIMIT = 5_000

const selectionEntry = (routeID: string) => {
  let current = selection.get(routeID)
  if (!current) {
    current = { cursor: 0, sessions: new Map(), scores: new Map() }
    selection.set(routeID, current)
  }
  return current
}

/** True when the selection mode picks a target per session rather than always starting at the
 * first healthy one. */
export const sessionScoped = (mode: "ordered" | "round-robin" | "weighted") => mode !== "ordered"

/** The sticky target index chosen for this session, if one was already made. */
export const sessionTarget = (routeID: string, sessionID: string) => {
  const state = selection.get(routeID)
  const index = state?.sessions.get(sessionID)
  return index === undefined ? undefined : index
}

/** Chooses the session's target index. `ordered` always returns the first entry; round-robin
 * rotates by smooth weights; weighted draws by relative ratio. Only the outcome is sticky. */
export const selectSessionTarget = (
  routeID: string,
  sessionID: string,
  mode: "ordered" | "round-robin" | "weighted",
  candidateIndexes: readonly number[],
  weights: readonly number[],
  random: () => number = Math.random,
): number | undefined => {
  if (candidateIndexes.length === 0) return undefined
  const first = candidateIndexes[0]
  if (mode === "ordered") return first
  const state = selectionEntry(routeID)
  const sticky = state.sessions.get(sessionID)
  if (sticky !== undefined && candidateIndexes.includes(sticky)) return sticky
  let chosen: number
  if (mode === "round-robin") {
    // Smooth weighted round robin. Equal weights are ordinary round robin; weights and
    // user-supplied preference factors become stable ratios without random session-to-session
    // variance.
    const total = candidateIndexes.reduce((sum, index) => sum + (weights[index] ?? 1), 0)
    chosen = candidateIndexes[0]
    let greatest = Number.NEGATIVE_INFINITY
    for (const index of candidateIndexes) {
      const score = (state.scores.get(index) ?? 0) + (weights[index] ?? 1)
      state.scores.set(index, score)
      if (score > greatest) {
        greatest = score
        chosen = index
      }
    }
    state.scores.set(chosen, (state.scores.get(chosen) ?? 0) - total)
    state.cursor = (state.cursor + 1) % Number.MAX_SAFE_INTEGER
  } else {
    const total = candidateIndexes.reduce((sum, index) => sum + (weights[index] ?? 1), 0)
    let draw = random() * total
    chosen = candidateIndexes[candidateIndexes.length - 1]
    for (const index of candidateIndexes) {
      draw -= weights[index] ?? 1
      if (draw <= 0) {
        chosen = index
        break
      }
    }
  }
  state.sessions.set(sessionID, chosen)
  while (state.sessions.size > SESSION_LIMIT) {
    const oldest = state.sessions.keys().next().value
    if (oldest === undefined) break
    state.sessions.delete(oldest)
  }
  return chosen
}

// Usage per target in 6-second buckets, enough for per-minute and per-day allowances without
// remembering individual requests.
const BUCKET_MS = 6_000
const DAY_MS = 86_400_000
const usage = new Map<
  string,
  { buckets: Array<{ at: number; requests: number; tokens: number }>; day: { requests: number; tokens: number } }
>()

const usageEntry = (target: Model.Ref) => {
  const id = key(target)
  let current = usage.get(id)
  if (!current) {
    current = { buckets: [], day: { requests: 0, tokens: 0 } }
    usage.set(id, current)
  }
  return current
}

const prune = (state: ReturnType<typeof usageEntry>, now: number) => {
  while (state.buckets.length > 0 && state.buckets[0].at <= now - DAY_MS) {
    const old = state.buckets.shift()!
    state.day.requests -= old.requests
    state.day.tokens -= old.tokens
  }
}

/** Counts one request and its tokens against the target. */
export const recordUsage = (target: Model.Ref, tokens: number, now = Date.now()) => {
  const state = usageEntry(target)
  prune(state, now)
  const at = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const last = state.buckets.at(-1)
  if (last && last.at === at) {
    last.requests += 1
    last.tokens += tokens
  } else if (!last || last.at < at) state.buckets.push({ at, requests: 1, tokens })
  else return // Restored history older than what is already recorded is added in order by the caller.
  state.day.requests += 1
  state.day.tokens += tokens
  while (usage.size > HEALTH_LIMIT) usage.delete(usage.keys().next().value!)
}

/** Counts one request with the tokens it used: input plus output plus reasoning, as the routing history
 * stores them. Without a usage report, `estimatedInput` stands in for the input, as the history row does.
 * Every request OpenCode sends is counted this way, background ones included, so live usage matches what
 * a restart restores. */
export const recordRequest = (
  target: Model.Ref,
  tokens?: { readonly input: number; readonly output: number; readonly reasoning: number },
  estimatedInput = 0,
) => recordUsage(target, tokens ? tokens.input + tokens.output + tokens.reasoning : estimatedInput)

/** Requests and tokens used by the target in the last minute and the last day. */
export const usageOf = (target: Model.Ref, now = Date.now()) => {
  const state = usage.get(key(target))
  if (!state) return { minute: { requests: 0, tokens: 0 }, day: { requests: 0, tokens: 0 } }
  prune(state, now)
  const minute = { requests: 0, tokens: 0 }
  for (let index = state.buckets.length - 1; index >= 0 && state.buckets[index].at > now - 60_000; index--) {
    minute.requests += state.buckets[index].requests
    minute.tokens += state.buckets[index].tokens
  }
  return { minute, day: { ...state.day } }
}

/** True when any allowance in `budget` is used up to its soft limit. */
export const overBudget = (
  target: Model.Ref,
  budget: Budget | undefined,
  now = Date.now(),
  scope: ModelRouteOverrides.Scope = {},
) => {
  if (!budget || userOverride("allow-over-budget", target, now, scope)) return false
  const soft = budget.softLimit ?? 0.9
  const used = usageOf(target, now)
  const over = (value: number, limit: number | undefined) => limit !== undefined && value >= limit * soft
  return (
    over(used.minute.requests, budget.requestsPerMinute) ||
    over(used.day.requests, budget.requestsPerDay) ||
    over(used.minute.tokens, budget.tokensPerMinute) ||
    over(used.day.tokens, budget.tokensPerDay)
  )
}

/** The context ceiling a request must fit to use a leaf: the route's cap and the leaf's own ceiling, whichever is smaller. Undefined when neither is set. */
export const contextCeiling = (definition: Definition, index: number): number | undefined => {
  const routeCap = definition.limit?.context
  const leaf = definition.targetLimits?.[index]?.context
  if (routeCap === undefined) return leaf
  if (leaf === undefined) return routeCap
  return Math.min(routeCap, leaf)
}

/** True when a request carrying `requestTokens` context tokens does not fit the leaf's ceiling, so the leaf is skipped like any other ineligible target. An unknown size never filters, and a leaf with no ceiling always fits. */
export const overLimit = (definition: Definition, index: number, requestTokens: number | undefined): boolean => {
  if (requestTokens === undefined) return false
  const ceiling = contextCeiling(definition, index)
  return ceiling !== undefined && requestTokens > ceiling
}

/** Rebuilds usage from stored history, oldest first, after a restart. */
export const seedUsage = (
  rows: ReadonlyArray<{ time: number; providerID: string; modelID: string; tokens: number }>,
) => {
  for (const row of rows.toSorted((left, right) => left.time - right.time))
    recordUsage(ModelRoute_ref(row.providerID, row.modelID), row.tokens, row.time)
}

const ModelRoute_ref = (providerID: string, modelID: string) => ref({ providerID, model: modelID })

// What each provider last said about its rate-limit windows, and how long that holds the target
// back. Kept apart from cooldowns: this is the provider's own forecast, not a failure.
const limits = new Map<string, { snapshot?: ModelRouteLimits.Snapshot; until: number }>()

/** Records a response's rate-limit snapshot. A spent window holds the target back until it resets.
 * With a credentialID the hold is scoped to that credential (#870): one credential's 429 must not
 * bench the others behind the same target, and a later success on another credential must not
 * clear (or inherit) this one's hold. */
export const observeRateLimit = (
  target: Model.Ref,
  snapshot: ModelRouteLimits.Snapshot | undefined,
  now = Date.now(),
  credentialID?: string,
) => {
  if (!snapshot) return
  const id = credentialID ? credentialKey(target, credentialID) : key(target)
  const until = ModelRouteLimits.holdUntil(snapshot, now)
  const previous = limits.get(id)
  limits.delete(id)
  limits.set(id, { snapshot, until })
  while (limits.size > HEALTH_LIMIT) limits.delete(limits.keys().next().value!)
  if (until > now && (previous?.until ?? 0) < until - 1_000)
    logHealth(
      target,
      "rate-limit-window",
      credentialID ? `provider-reported credential:${credentialID}` : "provider-reported",
      until,
      credentialID,
    )
}

/** Drops a recorded rate-limit hold: a credential (or target) that just succeeded without
 * advertising any limit has replaced the provider's last word with a healthy response (#870).
 * The release is persisted as a rate-limit-window row with no hold left, so restart replay
 * applies it after the original window row instead of resurrecting the cleared hold. */
export const clearRateLimit = (target: Model.Ref, credentialID?: string, now = Date.now()) => {
  const id = credentialID ? credentialKey(target, credentialID) : key(target)
  const existing = limits.get(id)
  limits.delete(id)
  if (existing && existing.until > now)
    logHealth(
      target,
      "rate-limit-window",
      credentialID ? `provider-released credential:${credentialID}` : "provider-released",
      0,
      credentialID,
    )
}

/** Until when the provider's own numbers say to leave the target alone; 0 when they don't.
 * With a credentialID, only that credential's hold counts. */
export const limitedUntil = (target: Model.Ref, now = Date.now(), credentialID?: string) => {
  const state = limits.get(credentialID ? credentialKey(target, credentialID) : key(target))
  return state && state.until > now ? state.until : 0
}

/** The latest rate-limit snapshot seen for the target, if any. */
export const rateLimitOf = (target: Model.Ref, credentialID?: string) =>
  limits.get(credentialID ? credentialKey(target, credentialID) : key(target))?.snapshot

/** The longest rate-limit hold on a target across its target-level and per-credential entries,
 * for diagnostics (route_stats) that report per target rather than per serving credential (#870). */
export const limitedUntilAny = (target: Model.Ref, now = Date.now()) => {
  const prefix = `${key(target)}#`
  let until = 0
  for (const [id, state] of limits) {
    if (id !== key(target) && !id.startsWith(prefix)) continue
    if (state.until > now) until = Math.max(until, state.until)
  }
  return until
}

/** The newest rate-limit snapshot recorded for a target under any key (its own, or one of its
 * credentials'), for the same per-target diagnostics. */
export const rateLimitOfAny = (target: Model.Ref) => {
  const prefix = `${key(target)}#`
  let snapshot: ModelRouteLimits.Snapshot | undefined
  for (const [id, state] of limits) {
    if (id !== key(target) && !id.startsWith(prefix)) continue
    if (state.snapshot) snapshot = state.snapshot
  }
  return snapshot
}

/** Re-applies windows that were still holding targets back when the process last stopped, with the
 * snapshot that produced them, so a cold target still has the provider's last word. */
export const seedLimits = (
  rows: ReadonlyArray<{
    providerID: string
    modelID: string
    until: number
    snapshot?: ModelRouteLimits.Snapshot
    credentialID?: string
  }>,
) => {
  for (const row of rows) {
    const target = ref({ providerID: row.providerID, model: row.modelID })
    limits.set(row.credentialID ? credentialKey(target, row.credentialID) : key(target), {
      until: row.until,
      ...(row.snapshot ? { snapshot: row.snapshot } : {}),
    })
  }
}

/** An expiring operator or agent instruction about which targets to use. `match` is a case-insensitive
 * substring of `provider/model`, so "anthropic" or "claude" covers every target that looks like it.
 * With `schedule` the instruction recurs inside a local-time window instead of living until a date. */
export interface Adjustment {
  readonly id: string
  readonly match: string
  /** `skip` removes matching targets unless nothing else is available; `weight` scales or sets their share. */
  readonly action: "skip" | "weight"
  readonly factor?: number
  /** Sets the target's weight outright instead of scaling it; takes precedence over `factor`. */
  readonly weight?: number
  /** Recurring local-time window the adjustment is confined to. */
  readonly schedule?: ModelRouteSchedule.Window
  /** When the adjustment lapses, epoch milliseconds; unset means only the schedule ends it. */
  readonly until?: number
  readonly note?: string
  /** Set on learned adjustments: the least autonomy a route needs before this one applies to it. Unset
   * means an operator or agent instruction, which applies wherever a route uses rules. */
  readonly requires?: ModelRouteAutonomy.Level
}

let adjustments: readonly Adjustment[] = []

export const setAdjustments = (next: readonly Adjustment[]) => {
  adjustments = next
}

/** Adds an adjustment, replacing one with the same id, and records it so it survives a restart. */
export const addAdjustment = (item: Adjustment, text?: string) => {
  adjustments = [...adjustments.filter((existing) => existing.id !== item.id), item]
  ModelRouteLog.record({
    kind: "note",
    row: {
      time: Date.now(),
      text: text ?? item.note ?? item.id,
      interpreted: { op: "add", adjustment: item },
      expires: item.until,
    },
  })
}

export const removeAdjustment = (id: string) => {
  const existed = adjustments.some((item) => item.id === id)
  adjustments = adjustments.filter((item) => item.id !== id)
  if (existed)
    ModelRouteLog.record({
      kind: "note",
      row: { time: Date.now(), text: `remove ${id}`, interpreted: { op: "remove", id } },
    })
  return existed
}

/** Re-applies cooldowns that were still running when the process last stopped. */
export const seedCooldowns = (
  rows: ReadonlyArray<{ providerID: string; modelID: string; until: number; credentialID?: string }>,
) => {
  for (const row of rows) {
    const target = ref({ providerID: row.providerID, model: row.modelID })
    // A credential-scoped cooldown restores onto that credential only (#870): the healthy
    // credentials behind the same target stay routable after a restart.
    if (row.credentialID) credentialEntry(target, row.credentialID).cooldownUntil = row.until
    else entry(target).cooldownUntil = row.until
  }
}

ModelRouteLog.onRestoreCooldowns(seedCooldowns)
ModelRouteLog.onRestoreLimits(seedLimits)
ModelRouteLog.onRestoreUsage(seedUsage)

ModelRouteLog.onRestore((notes) => {
  const restored = new Map<string, Adjustment>()
  for (const note of notes) {
    if (note.op === "add" && note.adjustment)
      restored.set((note.adjustment as Adjustment).id, note.adjustment as Adjustment)
    if (note.op === "remove" && typeof note.id === "string") restored.delete(note.id)
  }
  adjustments = [...restored.values()]
})

/** Adjustments whose overall lifetime has not lapsed; a recurring `schedule` narrows them further at
 * the moment they are used. */
export const activeAdjustments = (now = Date.now()) =>
  adjustments.filter((item) => item.until === undefined || item.until > now)

const matches = (item: Adjustment, target: Model.Ref) =>
  `${target.providerID}/${target.id}`.toLowerCase().includes(item.match.toLowerCase())

const adjustmentOn = (item: Adjustment, now: number) =>
  item.schedule === undefined || ModelRouteSchedule.active(item.schedule, now)

const userOverrides = (
  action: ModelRouteOverrides.Action,
  target: Model.Ref,
  now: number,
  scope: ModelRouteOverrides.Scope,
) =>
  ModelRouteOverrides.current().filter(
    (item) => item.action === action && ModelRouteOverrides.applies(item, target, now, scope),
  )

const userOverride = (
  action: ModelRouteOverrides.Action,
  target: Model.Ref,
  now: number,
  scope: ModelRouteOverrides.Scope,
) => userOverrides(action, target, now, scope).length > 0

/** A target the user has said to avoid, on this route. Applies at every autonomy level. */
export const userSkipped = (target: Model.Ref, now = Date.now(), scope: ModelRouteOverrides.Scope = {}) =>
  userOverride("avoid", target, now, scope)

/** Learned adjustments apply only to a route whose level reaches their floor; the rest apply everywhere. */
const appliesOn = (item: Adjustment, scope: ModelRouteOverrides.Scope) =>
  item.requires === undefined || ModelRouteAutonomy.reaches(scope.autonomy, item.requires)

/** A target the route's learned adjustments skip. Only routes that let the tuner decide see these. */
export const skipped = (target: Model.Ref, now = Date.now(), scope: ModelRouteOverrides.Scope = {}) =>
  activeAdjustments(now).some(
    (item) => item.action === "skip" && adjustmentOn(item, now) && matches(item, target) && appliesOn(item, scope),
  )

/** Weight multiplier for a target demoted by quota errors. */
const DEMOTED_FACTOR = 0.01

/** How much a user's "prefer" lifts a target when they don't say by how much. */
const PREFERRED_FACTOR = 3

/** The route path a request is being judged on, for `match.routes` schedule filters. `routeID` is the
 * route being resolved; `routes` is that id plus the nested route ids reached on the way in. */
export interface WeightScope extends ModelRouteOverrides.Scope {
  readonly routes?: readonly string[]
  /** Scheduled rules in force where this target is judged: global first, then the route's own. */
  readonly schedules?: readonly WeightRule[]
  /** The credential that would serve this target, when the caller knows it: quota demotion is
   * judged against that credential's events, not the target's (#870). */
  readonly credentialID?: string
}

const ruleMatches = (rule: WeightRule, target: Model.Ref, scope: WeightScope) => {
  const match = rule.match
  if (!match) return true
  const ref = `${target.providerID}/${target.id}`
  if (match.targets?.length && !match.targets.some((pattern) => ModelRouteOverrides.matchesPattern(pattern, ref)))
    return false
  if (match.providers?.length && !match.providers.some((id) => id.toLowerCase() === target.providerID.toLowerCase()))
    return false
  if (match.models?.length && !match.models.some((pattern) => ModelRouteOverrides.matchesPattern(pattern, target.id)))
    return false
  if (match.routes?.length) {
    const path = scope.routes ?? (scope.routeID === undefined ? [] : [scope.routeID])
    if (!match.routes.some((id) => path.includes(id))) return false
  }
  return true
}

const scheduled = (target: Model.Ref, weight: number, now: number, scope: WeightScope) => {
  for (const rule of scope.schedules ?? []) {
    if (rule.window !== undefined && !ModelRouteSchedule.active(rule.window, now)) continue
    if (!ruleMatches(rule, target, scope)) continue
    if (rule.weight !== undefined) weight = rule.weight
    else if (rule.factor !== undefined) weight *= rule.factor
  }
  return weight
}

/** The weight a target carries on a route, given the weight its pool gives it. Scheduled rules
 * apply first (global, then the route's own), the user's own preferences next, then learned
 * adjustments and quota demotion. Learned weights apply only where the tuner may decide, so a
 * `fixed` route keeps its order; explicit schedules and user overrides apply on every route. */
/** The weight a target carries after each layer of the computation, in the order the layers apply:
 * the configured pool weight (`base`), scheduled rules (`scheduled`), the user's preferences
 * (`prefer`), learned adjustments (`adjustment`), and quota demotion (`demotion` — the final
 * effective weight). `gate` carries the eligibility-gate verdict (#566) for a leaf whose position
 * is gated on a named window: "<name>:open" or "<name>:closed"; null when the position has no
 * gate. A closed gate removes the candidate before weights are compared; it never lifts demotion. */
export interface WeightTrace {
  readonly base: number
  readonly scheduled: number
  readonly prefer: number
  readonly adjustment: number
  readonly demotion: number
  readonly gate: string | null
}

/** The traced form of the weight computation: the real computation, recording the weight after
 * each layer so a selection can be explained after the fact (#589). `weightOf` below is this
 * trace's final layer, so traced weights can never drift from the weights selection used. */
export const tracedWeightOf = (
  target: Model.Ref,
  base: number,
  now = Date.now(),
  scope: WeightScope = {},
): WeightTrace => {
  const afterScheduled = scheduled(target, base, now, scope)
  let weight = afterScheduled
  for (const item of userOverrides("prefer", target, now, scope)) {
    if (item.weight !== undefined) weight = item.weight
    else weight *= item.factor ?? PREFERRED_FACTOR
  }
  const afterPrefer = weight
  if (scope.fixed !== true) {
    for (const item of activeAdjustments(now)) {
      if (item.action !== "weight" || !adjustmentOn(item, now) || !matches(item, target) || !appliesOn(item, scope))
        continue
      if (item.weight !== undefined) weight = item.weight
      else weight *= item.factor ?? 1
    }
  }
  return {
    base,
    scheduled: afterScheduled,
    prefer: afterPrefer,
    adjustment: weight,
    demotion: weight * (demoted(target, now, scope.credentialID) ? DEMOTED_FACTOR : 1),
    gate: null,
  }
}

export const weightOf = (target: Model.Ref, base: number, now = Date.now(), scope: WeightScope = {}) =>
  tracedWeightOf(target, base, now, scope).demotion

/** A target's pure weight multiplier, with its configured pool weight taken as 1. */
export const weightFactor = (target: Model.Ref, now = Date.now(), scope: WeightScope = {}) =>
  weightOf(target, 1, now, scope)

/** A session already answered by this target keeps it through a burst rate-limit hold, as long as the
 * target is still working and not demoted. New sessions go elsewhere; current ones stay where their
 * cache is, and only move when the target itself starts failing. */
export const keepsThrough = (
  routeID: string,
  sessionID: string | undefined,
  target: Model.Ref,
  now = Date.now(),
  credentialID?: string,
) =>
  sessionID !== undefined &&
  continuityOf(routeID, sessionID)?.current === key(target) &&
  steady(target, credentialID) &&
  !demoted(target, now, credentialID)

/** The scope overrides and weights are judged against: this route (and nested ids reached on the
 * way in), whether it is `fixed`, and the route-level schedule rules. */
export const scopeOf = (definition: Definition, path: readonly string[] = []): WeightScope => ({
  routeID: definition.id,
  routes: [definition.id, ...path.filter((id) => id !== definition.id)],
  fixed: !ModelRouteAutonomy.usesRules(definition.autonomy),
  autonomy: definition.autonomy,
  ...(definition.schedules?.length ? { schedules: definition.schedules } : {}),
})

/** Chooses one leaf lazily. Only groups on the chosen path draw their sticky/rotation entry; nested
 * siblings aren't consumed until failover reaches them. This makes RR and weights compositional. */
export const nextTarget = (
  definition: Definition,
  ready: ReadonlySet<number>,
  tried: ReadonlySet<number>,
  sessionID: string | undefined,
  draw: boolean,
  variant?: string,
  unavailable?: ReadonlyMap<number, string>,
  random: () => number = Math.random,
  credentialOf?: (index: number) => string | undefined,
): number | undefined => {
  const leaves = (nodeIndex: number): number[] => {
    const node = definition.nodes[nodeIndex]
    if (!node) return []
    return node.children.flatMap((child) =>
      child.leaf !== undefined ? [child.leaf] : child.node !== undefined ? leaves(child.node) : [],
    )
  }
  const now = Date.now()
  /** The leaves under a node that can actually serve at `now`: ready, untried, and open at every
   * gate on the way down — a gate on a leaf inside a nested group counts exactly like a gate on a
   * direct child, so a group whose leaves are all gate-closed is not ready (#723). */
  const openLeaves = (nodeIndex: number): number[] => {
    const node = definition.nodes[nodeIndex]
    if (!node) return []
    return node.children.flatMap((child) =>
      !gateOpen(child.gate, now)
        ? []
        : child.leaf !== undefined
          ? ready.has(child.leaf) && !tried.has(child.leaf)
            ? [child.leaf]
            : []
          : child.node !== undefined
            ? openLeaves(child.node)
            : [],
    )
  }
  const hasReady = (nodeIndex: number): boolean => openLeaves(nodeIndex).length > 0
  /** Whether any gate on the path from this node down to the leaf is closed at `now`. */
  const gateClosedOnPath = (nodeIndex: number, leafIndex: number): boolean => {
    const node = definition.nodes[nodeIndex]
    if (!node) return false
    return node.children.some((child) => {
      const onPath = child.leaf === leafIndex || (child.node !== undefined && leaves(child.node).includes(leafIndex))
      if (!onPath) return false
      if (!gateOpen(child.gate, now)) return true
      return child.node !== undefined && gateClosedOnPath(child.node, leafIndex)
    })
  }
  const scopeAt = (rules: readonly WeightRule[], path: readonly string[]): WeightScope => ({
    routeID: definition.id,
    routes: [definition.id, ...path.filter((id) => id !== definition.id)],
    fixed: !ModelRouteAutonomy.usesRules(definition.autonomy),
    schedules: [...(definition.schedules ?? []), ...rules],
  })
  /** The average weight multiplier of a nested group's leaves, judged with the schedules that reach
   * into that group. The group's own weight stays in `weights`; a parent then scales the two. */
  const factor = (nodeIndex: number, inherited: readonly WeightRule[], path: readonly string[]) => {
    const node = definition.nodes[nodeIndex]
    const nodePath = node?.routeID && !path.includes(node.routeID) ? [...path, node.routeID] : path
    const rules = [...inherited, ...(node?.schedules ?? [])]
    const scope = scopeAt(rules, nodePath)
    const eligible = openLeaves(nodeIndex)
    return eligible.length === 0
      ? 1
      : eligible.reduce(
          (sum, index) =>
            sum + weightOf(definition.targets[index], 1, now, { ...scope, credentialID: credentialOf?.(index) }),
          0,
        ) / eligible.length
  }
  const label = (child: Node["children"][number]) =>
    child.leaf !== undefined
      ? `${definition.targets[child.leaf]?.providerID}/${definition.targets[child.leaf]?.id}`
      : child.node !== undefined
        ? `opencode-route/${definition.nodes[child.node]?.routeID ?? child.node}`
        : "unknown"
  const walk = (
    nodeIndex: number,
    inherited: readonly WeightRule[] = [],
    path: readonly string[] = [],
  ): number | undefined => {
    const node = definition.nodes[nodeIndex]
    if (!node) return undefined
    const nodePath = node.routeID && !path.includes(node.routeID) ? [...path, node.routeID] : path
    const rules = [...inherited, ...(node.schedules ?? [])]
    const scope = scopeAt(rules, nodePath)
    const positions = node.children.flatMap((child, position) => {
      const available =
        gateOpen(child.gate, now) &&
        (child.leaf !== undefined
          ? ready.has(child.leaf) && !tried.has(child.leaf)
          : child.node !== undefined && hasReady(child.node))
      return available ? [position] : []
    })
    if (positions.length === 0) {
      ModelRouteLog.record({
        kind: "decision",
        row: {
          time: Date.now(),
          session_id: sessionID,
          route_id: node.routeID ?? definition.id,
          selection: node.selection,
          variant,
          candidates: [],
          reason: "no-candidates",
        },
      })
      return undefined
    }
    // Every child's effective weight: its configured pool weight scaled or replaced by the schedules
    // in force. Equal weights keep their configured relative order when the list is sorted.
    const traces = node.children.map((child, position) => {
      if (child.leaf === undefined) return undefined
      const trace = tracedWeightOf(definition.targets[child.leaf], node.weights[position] ?? 1, now, {
        ...scope,
        credentialID: credentialOf?.(child.leaf),
      })
      return child.gate
        ? { ...trace, gate: `${child.gate.name}:${gateOpen(child.gate, now) ? "open" : "closed"}` }
        : trace
    })
    const effective = node.children.map((child, position) => {
      const base = node.weights[position] ?? 1
      if (child.leaf !== undefined) return traces[position]?.demotion ?? base
      if (child.node !== undefined) return base * factor(child.node, rules, nodePath)
      return base
    })
    const selectionKey = `${node.routeID ?? definition.id}#${nodeIndex}`
    const priorSticky = sessionID ? sessionTarget(selectionKey, sessionID) : undefined
    // A session stays on the target it is being answered by while that target is ready, so a recovered
    // primary does not pull it back and throw away the cache it has built on the fallback.
    const current = sessionID ? continuityOf(definition.id, sessionID)?.current : undefined
    const currentPosition =
      current === undefined
        ? undefined
        : positions.find((position) => {
            const leaf = node.children[position].leaf
            if (leaf === undefined) return false
            const target = definition.targets[leaf]
            return key(target) === current && !demoted(target, now, credentialOf?.(leaf))
          })
    const rank = (from: readonly number[]) =>
      [...from].toSorted((left, right) => (effective[right] ?? 1) - (effective[left] ?? 1))
    const sorted = rank(positions)
    let ordered = sorted
    let decisionReason = sorted.some((position, index) => position !== positions[index]) ? "adjusted" : "ordered"
    if (node.selection === "ordered" && currentPosition !== undefined) {
      ordered = [currentPosition, ...positions.filter((position) => position !== currentPosition)]
      decisionReason = "sticky"
    } else if (sessionID && sessionScoped(node.selection)) {
      const chosen =
        priorSticky !== undefined && positions.includes(priorSticky)
          ? priorSticky
          : draw
            ? selectSessionTarget(
                selectionKey,
                sessionID,
                node.selection,
                positions,
                node.children.map((_, position) => effective[position] ?? 1),
                random,
              )
            : undefined
      if (chosen !== undefined) ordered = [chosen, ...rank(positions.filter((position) => position !== chosen))]
      decisionReason =
        priorSticky !== undefined && positions.includes(priorSticky) ? "sticky" : draw ? "drawn" : decisionReason
    }
    const chosen = ordered[0]
    const excluded = node.children.flatMap((child, position) => {
      const childLeaves = child.leaf !== undefined ? [child.leaf] : child.node !== undefined ? leaves(child.node) : []
      return childLeaves.flatMap((index) => {
        const gateClosed =
          (child.gate !== undefined && !gateOpen(child.gate, now)) ||
          (child.node !== undefined && gateClosedOnPath(child.node, index))
        const unavailableReason =
          unavailable?.get(index) ??
          (tried.has(index) ? "already-tried" : gateClosed ? "window-gate-closed" : undefined)
        return unavailableReason ? [{ candidate: label(node.children[position]), reason: unavailableReason }] : []
      })
    })
    ModelRouteLog.record({
      kind: "decision",
      row: {
        time: Date.now(),
        session_id: sessionID,
        route_id: node.routeID ?? definition.id,
        selection: node.selection,
        variant,
        candidates: positions.map((position) => label(node.children[position])),
        chosen: chosen === undefined ? undefined : label(node.children[chosen]),
        reason: decisionReason,
        detail: {
          weights: Object.fromEntries(
            positions.map((position) => [label(node.children[position]), effective[position]]),
          ),
          // Per-layer attribution for leaf candidates (#589); group candidates carry no
          // weightOf layers — their weight is their leaves' average, in `weights` above.
          layers: Object.fromEntries(
            positions.flatMap((position) => {
              const trace = traces[position]
              return trace ? [[label(node.children[position]), trace] as const] : []
            }),
          ),
          excluded,
        },
      },
    })
    // Fall back to the remaining positions when the chosen group yields no target: a group can
    // look available at this level yet resolve to nothing below, and that must not strand the
    // ready siblings next to it (#723).
    for (const position of ordered) {
      const selected = node.children[position]
      if (!selected) continue
      if (selected.leaf !== undefined) return selected.leaf
      if (selected.node === undefined) continue
      const found = walk(selected.node, rules, nodePath)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(0)
}

/** Compatibility/test helper. Production resolution calls `nextTarget` lazily so unvisited sibling
 * groups do not consume their own round-robin or weighted draw. */
export const orderTargets = (
  definition: Definition,
  ready: ReadonlySet<number>,
  sessionID: string | undefined,
  draw: boolean,
) => {
  const tried = new Set<number>()
  const result: number[] = []
  while (true) {
    const next = nextTarget(definition, ready, tried, sessionID, draw)
    if (next === undefined) return result
    tried.add(next)
    result.push(next)
  }
}

/** Drops a session's sticky choice, e.g. when its model selection leaves the route. Test seam. */
export const forgetSession = (routeID: string, sessionID: string) => {
  selection.get(routeID)?.sessions.delete(sessionID)
}

export const resetSelection = () => selection.clear()

/** Where a session has been answered on a route. `origin` is the target it moved away from after a
 * failover; `away` counts requests answered since on the target it moved to. */
export interface Continuity {
  readonly current: string
  readonly origin?: string
  readonly away: number
}

/** A session that just failed over may hedge back to its origin for this many requests. */
export const ORIGIN_HEDGE_REQUESTS = 2
const CONTINUITY_LIMIT = 5_000
const continuity = new Map<string, Continuity>()

const continuityKey = (routeID: string, sessionID: string) => `${routeID}\u0000${sessionID}`

export const continuityOf = (routeID: string, sessionID: string) => continuity.get(continuityKey(routeID, sessionID))

const remember = (id: string, next: Continuity) => {
  continuity.delete(id)
  continuity.set(id, next)
  while (continuity.size > CONTINUITY_LIMIT) continuity.delete(continuity.keys().next().value!)
}

/** A request on this route failed over from `from`. The first move keeps `from` as the origin; later
 * moves keep the original origin, so a session drifting between fallbacks still returns home. */
export const moved = (routeID: string, sessionID: string, from: Model.Ref) => {
  const id = continuityKey(routeID, sessionID)
  const prior = continuity.get(id)
  remember(id, { current: key(from), origin: prior?.origin ?? key(from), away: 0 })
}

/** A request on this route was answered by `target`. Answering from the origin ends the move. */
export const served = (routeID: string, sessionID: string, target: Model.Ref) => {
  const id = continuityKey(routeID, sessionID)
  const current = key(target)
  const prior = continuity.get(id)
  if (prior?.origin === undefined || prior.origin === current) return remember(id, { current, away: 0 })
  remember(id, { current, origin: prior.origin, away: Math.min(prior.away + 1, ORIGIN_HEDGE_REQUESTS) })
}

/** The origin a session should hedge back to: only just after it moved, and never once it has
 * settled on the new target. */
export const hedgeHome = (routeID: string, sessionID: string) => {
  const state = continuityOf(routeID, sessionID)
  if (state?.origin === undefined || state.away >= ORIGIN_HEDGE_REQUESTS) return undefined
  return state.origin
}
