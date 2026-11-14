export * as ModelRoute from "./model-route.js"

import { Model } from "@opencode/schema/model"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { CacheFormat } from "@opencode/schema/model-compatibility"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
import { ModelRouteLimits } from "./model-route-limits.js"
import { ownValue } from "./util/record.js"
import { ModelRouteMembership } from "./model-route-membership.js"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"
import { ModelRouteLog } from "./model-route-log.js"
import { ModelRouteOverrides } from "./model-route-overrides.js"
import { ModelRouteSchedule } from "./model-route-schedule.js"
import { QuotaSnapshot } from "./quota-snapshot.js"
import { QuotaCurrent } from "./quota-current.js"
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
  /** Route-level variant → the variant this target runs it at, or `false` when the target sits that level
   * out and is never used at it. */
  map: Schema.Record(Schema.String, Schema.Union([Model.VariantID, Schema.Literal(false)])).pipe(optional),
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
 * experimental.routes.windows. The child is a candidate only while the window is active, or
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
  /** Route id at this point in the hierarchy. For a provider-route group, the provider route id. */
  routeID: Schema.String.pipe(optional),
  /** Set on a group that resolves a provider route (experimental.routes.providers):
   * the provider route's id. The group's children are the members' concrete leaves for the
   * one model the group serves, and its decision is recorded under this id. */
  providerRoute: Schema.String.pipe(optional),
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
  /** The route's carried system prompt (config `system`, #1413), when one is declared. */
  system: Schema.String.pipe(optional),
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
  /** Weight changes in force across every route, from experimental.routes.schedules. */
  schedules: Schema.Array(WeightRule).pipe(optional),
  nodes: Schema.Array(Node),
})

/** A provider route, validated at config load from experimental.routes.providers: a
 * selection over concrete providers. Expansion turns a `<provider-route>/<model>` target into a
 * group node over the members' concrete leaves for that model, so selection, health and
 * decisions treat it exactly like a nested route whose leaves differ only by provider. */
export interface ProviderRoute {
  readonly providers: readonly string[]
  readonly selection: "ordered" | "round-robin" | "weighted"
  readonly weights: Readonly<Record<string, number>>
  /** Per-member window gates keyed by provider id (#1140): a member is a candidate only
   * while its named window allows it — the provider-granularity counterpart of a
   * model-route target's window gate. */
  readonly windows?: Readonly<Record<string, ConfigModelRoutes.WindowRef>>
  /** The provider route's own weight schedules (#1140), in the model-route Schedule
   * shape: targets are `provider/model` patterns matched against the concrete leaves
   * this route expands to. */
  readonly schedules?: readonly ConfigModelRoutes.Schedule[]
}

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
}, location?: string): Policy => {
  const sampleWindow = Math.min(input?.sampleWindow ?? DEFAULT_POLICY.sampleWindow, 50)
  const ladder = currentConstants(location).bench
  return {
    firstTokenTimeoutMs: input?.firstTokenTimeoutMs ?? DEFAULT_POLICY.firstTokenTimeoutMs,
    // Unset thresholds are omitted, not undefined: the stored definition rejects explicit undefined.
    ...(input?.maxResponseTimeMs !== undefined ? { maxResponseTimeMs: input.maxResponseTimeMs } : {}),
    ...(input?.minOutputTokensPerSecond !== undefined
      ? { minOutputTokensPerSecond: input.minOutputTokensPerSecond }
      : {}),
    sampleWindow,
    slowThreshold: Math.min(input?.slowThreshold ?? DEFAULT_POLICY.slowThreshold, sampleWindow),
    cooldownMs: Math.min(input?.cooldownMs ?? DEFAULT_POLICY.cooldownMs, ladder.cooldownCapMs),
    quotaCooldownMs: Math.min(input?.quotaCooldownMs ?? DEFAULT_POLICY.quotaCooldownMs, ladder.quotaCooldownCapMs),
  }
}

/** The route definition a model carries. Route models under the routes provider carry one, and so
 * do the direct-addressing models a configured provider route registers under its own id (#1720). */
export const definition = (model: Model.Info): Definition | undefined => {
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

/** One target's (or one credential's) failure-health state. `benchReason` / `benchQuotaResetAt`
 * describe the bench in force: why it was planted, and the trustworthy quota window reset it is
 * bounded by when one is known (#1123). `probeClaimedAt` marks the single half-open probe a bench
 * admits at that reset while the bench itself still stands. `probeClaimToken` is the claim's unique
 * identity (#1486): the millisecond alone collides when a claim settles and another is spent
 * within the same millisecond, so every spend stamps a fresh token and every settle/release
 * lands only when its token still names the outstanding claim. */
interface HealthState {
  samples: boolean[]
  outcomes: boolean[]
  cooldownUntil: number
  consecutiveFailures: number
  benchReason?: string
  benchQuotaResetAt?: number
  probeClaimedAt?: number
  probeClaimToken?: number
}

/** Monotonic identity stamped on every probe claim (#1486). Process-local like health. */
let probeClaimSeq = 0

/** Mints the identity one pick spends on the scopes it claims: a single token names every
 * scope of the pick, so a same-millisecond re-claim after a settle can never collide. */
export const nextProbeClaimToken = () => ++probeClaimSeq

const health = new Map<string, HealthState>()

/** Health of one credential serving one target (#6): two credentials behind one provider are
 * distinct here even though they share the target's entry above, so a failure on one never
 * benches the other. Process-local like `health`; transitions are logged through the same
 * health channel. */
const credentialHealth = new Map<string, HealthState>()

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

/** Infra holds: stops planted by transport path failures (DNS, refused connections) whose
 * request never reached a provider API. Kept apart from `health` on purpose: an infra
 * failure is not evidence about the provider, so it never increments a bench's escalation
 * count, plants no quota evidence, and gates no pool — it only holds the target out of
 * candidacy on a short fixed cadence while the path is broken (Drew 2026-11-06: an error
 * "because it can't route like our dns" must not be treated the same as a provider error).
 * The hold itself is the probe schedule: after it lapses the next pick tests the path, and
 * the first success on the target clears the hold (see `completed`). Planted at target
 * scope — a path failure does not care which credential would have served. */
interface InfraHold {
  until: number
  failures: number
}
const infraHolds = new Map<string, InfraHold>()
const INFRA_LADDER_MS = [30_000, 60_000, 120_000, 240_000]
const INFRA_CAP_MS = 300_000

const infraHoldUntil = (id: string, now: number) => {
  const hold = infraHolds.get(id)
  // An expired hold stops holding but keeps its failure count: the cadence ladder is
  // per path, not per hold, so a path that breaks again right after a lapse resumes
  // the ladder instead of restarting it. The entry itself is bounded by the map cap
  // and cleared by a success or a health reset.
  return hold && hold.until > now ? hold.until : 0
}

const plantInfraHold = (target: Model.Ref, now: number) => {
  const id = key(target)
  const failures = (infraHolds.get(id)?.failures ?? 0) + 1
  const until = now + Math.min(INFRA_LADDER_MS[Math.min(failures - 1, INFRA_LADDER_MS.length - 1)]!, INFRA_CAP_MS)
  infraHolds.set(id, { until, failures })
  while (infraHolds.size > HEALTH_LIMIT) infraHolds.delete(infraHolds.keys().next().value!)
  logHealth(target, "infra-hold", `path failure #${failures}; held while the route heals`, until)
}
const HEALTH_LIMIT = 2_000
// Recent finished requests per target (true = answered). A target with at most one give-up in this
// window is steady: a single failure there is treated as transient before the route moves on.
const OUTCOME_WINDOW = 5

const key = (target: Model.Ref) => `${target.providerID}/${target.id}`

// The outcome history retained for a target: the widest window any registered
// Location evaluates with, so one Location's narrower window cannot destructively
// truncate history another Location still judges by (#1423). Recording retains the
// union; each evaluation applies its own Location's window over it (see giveUps).
const retainedOutcomeWindow = () => {
  let window = constants.escalation.outcomeWindow
  for (const read of settingsReaders.values()) {
    const configured = read()?.escalation?.outcomeWindow
    if (configured !== undefined && configured > window) window = configured
  }
  return window
}

const pushOutcome = (outcomes: boolean[], answered: boolean) =>
  [...outcomes, answered].slice(-retainedOutcomeWindow())

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
    | "quota-readmitted"
    | "bench-probe"
    | "bench-probe-release"
    | "infra-hold"
    | "infra-cleared",
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
  state: HealthState,
  now: number,
  credentialID?: string,
) => {
  if (state.cooldownUntil === 0 || state.cooldownUntil > now) return
  state.cooldownUntil = 0
  state.samples = []
  state.benchReason = undefined
  state.benchQuotaResetAt = undefined
  state.probeClaimedAt = undefined
  state.probeClaimToken = undefined
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

/** The network-failure history retained: the widest network window any registered
 * Location evaluates with (the union-retention rule of retainedOutcomeWindow, #1423);
 * networkSuspect() applies the judging Location's own window over what is retained. */
const retainedNetworkWindowMs = () => {
  let window = constants.network.windowMs
  for (const read of settingsReaders.values()) {
    const configured = read()?.network?.windowMs
    if (configured !== undefined && configured > window) window = configured
  }
  return window
}

/** True when failures hit many unrelated providers within a short window. */
export const networkSuspect = (now = Date.now(), location?: string) =>
  new Set(
    recentFailures
      .filter((failure) => now - failure.time <= currentConstants(location).network.windowMs)
      .map((failure) => failure.provider),
  ).size >= currentConstants(location).network.providers

const providerCooldownUntil = (providerID: string, now: number, location?: string) => {
  const prefix = `${providerID}/`
  let count = 0
  let until = 0
  for (const [id, state] of health) {
    if (!id.startsWith(prefix) || state.cooldownUntil <= now) continue
    count++
    until = Math.max(until, state.cooldownUntil)
  }
  return count >= currentConstants(location).network.providerModels ? until : 0
}

export const coolingDown = (target: Model.Ref, now = Date.now(), location?: string) =>
  cooldownUntil(target, now, location) > now

export const cooldownUntil = (target: Model.Ref, now = Date.now(), location?: string) => {
  const state = health.get(key(target))
  if (state) recover(target, state, now)
  return Math.max(
    state?.cooldownUntil ?? 0,
    providerCooldownUntil(target.providerID, now, location),
    infraHoldUntil(key(target), now),
  )
}

const MAX_COOLDOWN_MS = 86_400_000

/** Why a request failed, as far as the cooldown is concerned: a provider that says when it recovers
 * is believed, an exhausted quota outlasts an ordinary error. */
export interface FailureHint {
  readonly retryAfterMs?: number
  readonly quota?: boolean
  /** The quota window reset the provider stated in its error text (absolute ms), for
   * providers that state it nowhere else (Antigravity's "Resets in 81h35m49s"). Bound to
   * the bench like a snapshot-derived reset (#1806 mechanism 4, #1828). */
  readonly quotaResetAtMs?: number
  /** A transport path failure whose OS code proves the request never reached a provider
   * API (DNS failure, refused connection): an infra hold, not a provider-health signal —
   * it plants no bench and feeds no quota accounting (#1828). */
  readonly infra?: boolean
  /** An upstream membership tier-limit answer (`tier_limit_exceeded`, #2253): the
   * provider's account cap was hit by traffic this process did not meter (a race, or
   * another client), so the whole account is held out until the stated reset, on top
   * of the ordinary rate-limit bench this failure also earns. */
  readonly tierLimit?: boolean
  /** A local transport failure with no provider HTTP response. */
  readonly network?: boolean
  /** An authentication refusal (401/403, an org-disabled credential): it cannot heal by itself,
   * so its first bench is the long quota-length one. */
  readonly auth?: boolean
}

/** Benches one health state (a target's, or one credential's of a target) after a failure.
 * A stated retry-after is believed as-is and never multiplied; every other class multiplies its
 * bench by the configured bench multiplier per consecutive failure (auth and quota start from the long bench), capped at maxCooldownMs.
 * An ordinary failure (no quota, no auth, no stated retry-after) is capped at failureCapMs instead: its grace stays short.
 * A quota bench may end sooner at a trustworthy window reset; that reset is remembered on
 * the state, and one learned later arms the bench the same way (armBenchProbe). The count survives recover() and
 * resets only on a success, so a permanently failing target backs off instead of being retried at
 * full rate forever. */
const bench = (
  target: Model.Ref,
  state: HealthState,
  policy: Policy,
  now: number,
  hint?: FailureHint,
  credentialID?: string,
  quotaResetAt?: number,
  location?: string,
) => {
  state.samples = []
  state.outcomes = pushOutcome(state.outcomes, false)
  state.consecutiveFailures += 1
  const base = hint?.quota || hint?.auth ? policy.quotaCooldownMs : policy.cooldownMs
  const ladder = currentConstants(location).bench
  const escalated = base * ladder.multiplier ** (state.consecutiveFailures - 1)
  // Drew's failover spec (2026-11-08, #2212): when a leg errors the route moves to the next
  // candidate, and the leg's grace before it may be tried again is short. An ordinary failure
  // -- a transport timeout, a provider-internal error, an unclassified one -- therefore stops
  // escalating at failureCapMs (never below the route's own base): uncapped, a target with a
  // healthy success rate but a small timeout rate was benched for hours on end, the cascade
  // ran out of eligible candidates, and sessions died on the last error they saw. Quota and
  // auth keep the long ladder: the provider stated the window, or the refusal cannot heal
  // by itself. A stated retry-after is believed as-is, as before.
  const graced = hint?.quota || hint?.auth ? escalated : Math.min(escalated, Math.max(base, ladder.failureCapMs))
  const cooldown =
    hint?.retryAfterMs !== undefined && hint.retryAfterMs > 0
      ? Math.min(Math.max(hint.retryAfterMs, ladder.retryAfterMinMs), ladder.maxCooldownMs)
      : Math.min(graced, ladder.maxCooldownMs)
  const until = now + cooldown
  state.cooldownUntil = quotaResetAt !== undefined && quotaResetAt > now ? Math.min(until, quotaResetAt) : until
  const reason = hint?.quota
    ? hint.retryAfterMs
      ? "quota retry-after"
      : "quota"
    : hint?.retryAfterMs
      ? "retry-after"
      : hint?.auth
        ? "auth"
        : "failure"
  state.benchReason = reason
  state.benchQuotaResetAt = hint?.quota ? quotaResetAt : undefined
  state.probeClaimedAt = undefined
  state.probeClaimToken = undefined
  logHealth(
    target,
    "cooldown-start",
    `${reason}${credentialID ? ` credential:${credentialID}` : ""}`,
    state.cooldownUntil,
    credentialID,
  )
}

/** Arms a benched quota state with a trustworthy window reset learned after the bench was
 * planted — the quota feed and the provider's rate-limit reports arrive independently of the
 * failure that benched the leaf, so the reset a bench should respect is not always known at
 * bench time (#1123). Only quota-class benches arm: an auth or ordinary bench has no window to
 * roll over. The earliest known reset wins; a later window's reset does not postpone the probe
 * the first reset already owes. */
const armBenchProbe = (target: Model.Ref, credentialID: string | undefined, resetAt: number, now: number) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  if (!state || state.cooldownUntil <= now) return
  if (state.benchReason !== "quota" && state.benchReason !== "quota retry-after") return
  if (state.benchQuotaResetAt !== undefined && state.benchQuotaResetAt <= resetAt) return
  state.benchQuotaResetAt = resetAt
}

/** The reset a quota bench is bounded by: the earliest trustworthy one known — a snapshot
 * derivation or the reset the provider stated in the error text itself (#1828). */
const statedQuotaResetAt = (
  target: Model.Ref,
  credentialID: string | undefined,
  now: number,
  location: string | undefined,
  hint: FailureHint | undefined,
): number | undefined => {
  if (!hint?.quota) return undefined
  const derived = quotaResetAt(target, credentialID, now, location)
  const stated = hint.quotaResetAtMs !== undefined && hint.quotaResetAtMs > now ? hint.quotaResetAtMs : undefined
  return derived === undefined ? stated : stated === undefined ? derived : Math.min(derived, stated)
}

/** Releases quota-class benches in one scope on a measured increase: a fresh, known quota
 * reading that is not full is the provider's own word that headroom is back, so a bench
 * planted by an earlier exhaustion stops holding the scope out instead of waiting for its
 * reset (Drew 2026-11-06: providers stop trying when quota is burned "until it shows an
 * increase"). Only quota-class benches release — auth, unknown-error and slow benches keep
 * their timers, and balance holds keep their stricter increase-over-baseline rule. The
 * caller guarantees the reading is known and fresh; a stale or unknown reading never
 * reaches here, so a failed quota read can never free a scope by accident. */
const releaseQuotaBenches = (inScope: (id: string) => boolean, now: number) => {
  const release = (id: string, state: HealthState, credentialID?: string) => {
    if (state.cooldownUntil <= now) return
    if (state.benchReason !== "quota" && state.benchReason !== "quota retry-after") return
    state.cooldownUntil = 0
    state.consecutiveFailures = 0
    state.benchReason = undefined
    state.benchQuotaResetAt = undefined
    state.probeClaimedAt = undefined
    state.probeClaimToken = undefined
    const base = credentialID ? id.slice(0, id.lastIndexOf("#")) : id
    const slash = base.indexOf("/")
    const target = ref({ providerID: base.slice(0, slash), model: base.slice(slash + 1) })
    logHealth(
      target,
      "quota-readmitted",
      `bench released on a measured quota increase${credentialID ? ` credential:${credentialID}` : ""}`,
      undefined,
      credentialID,
    )
  }
  for (const [id, state] of health) if (inScope(id)) release(id, state)
  for (const [id, state] of credentialHealth)
    if (inScope(id)) release(id, state, id.slice(id.lastIndexOf("#") + 1))
}

const probeDueState = (state: HealthState | undefined, now: number) =>
  state !== undefined &&
  state.cooldownUntil > now &&
  state.benchQuotaResetAt !== undefined &&
  state.benchQuotaResetAt <= now &&
  state.probeClaimedAt === undefined

/** Whether the bench on this target (or on this credential of it, when one is named) is holding
 * past a known quota window reset, so a half-open probe is due: the window has rolled over, the
 * bench has not, and no probe is outstanding yet. The independent quota gate still applies on
 * top of this — a probe never bypasses a gate whose own reset is still ahead. */
export const probeDue = (target: Model.Ref, credentialID: string | undefined, now = Date.now()) =>
  probeDueState(credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target)), now)

/** Claims the one half-open probe a due bench admits. Exactly one claim succeeds: while it is
 * outstanding the bench keeps excluding ordinary candidacy, a probe success ends the bench
 * (see completed()), and a probe failure re-benches through failed() on the escalated ladder,
 * bounded by the next known reset when there is one. A claim that never reports an outcome
 * stops mattering when the bench itself expires.
 *
 * `token` names this spend (#1486): pass one token per pick so every scope the pick claims
 * shares the pick's identity. Omitted, a fresh token is minted for the scope. */
export const claimBenchProbe = (
  target: Model.Ref,
  credentialID: string | undefined,
  now = Date.now(),
  token = nextProbeClaimToken(),
) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  if (!state || !probeDueState(state, now)) return false
  state.probeClaimedAt = now
  state.probeClaimToken = token
  logHealth(
    target,
    "bench-probe",
    `probe at quota reset${credentialID ? ` credential:${credentialID}` : ""}`,
    state.benchQuotaResetAt,
    credentialID,
  )
  return true
}

/** Releases a probe claim whose owner resolved the target but never attempted a request on it
 * (#1478): the bench stays in force and the probe is due again for the next real request.
 * The release only lands when `claimedAt` still names the outstanding claim — and, when the
 * owner passes the pick's `token` (#1486), when the token matches too — so a claim that
 * has since settled, or one a different resolution took afterwards (including within the
 * same millisecond), is never cleared by a stale owner. Releasing is not an outcome:
 * no bench ends, no failure is recorded. */
export const releaseBenchProbe = (
  target: Model.Ref,
  credentialID: string | undefined,
  claimedAt: number,
  token?: number,
) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  if (!state || state.probeClaimedAt === undefined || state.probeClaimedAt !== claimedAt) return false
  if (token !== undefined && state.probeClaimToken !== token) return false
  state.probeClaimedAt = undefined
  state.probeClaimToken = undefined
  logHealth(
    target,
    "bench-probe-release",
    `probe claim released without an outcome${credentialID ? ` credential:${credentialID}` : ""}`,
    state.benchQuotaResetAt,
    credentialID,
  )
  return true
}

/** Whether a health state is a quota-class bench still in force whose half-open probe is
 * not due: the provider has answered exhaustion, so the scope is quota-dead until the bench
 * expires or a fresher reading releases it. A probe-due bench does not count: the probe
 * is the bench’s own servable moment, the window it was bounded by has rolled. */
const quotaBenched = (state: HealthState | undefined, now: number) =>
  state !== undefined &&
  state.cooldownUntil > now &&
  (state.benchReason === "quota" || state.benchReason === "quota retry-after") &&
  !probeDueState(state, now)

/** Whether the target itself is quota-dead under its own bench right now (code#8086): a
 * credential-less target’s only exhaustion signal is this bench — it has no credential
 * whose known-full state a last-resort preference could consult - so without this read
 * a quota-benched leaf is indistinguishable from a merely cooling one to selection. */
export const quotaCoolingDown = (target: Model.Ref, now = Date.now()) => {
  const state = health.get(key(target))
  if (state) recover(target, state, now)
  return quotaBenched(state, now)
}

/** Whether one credential of the target is quota-dead under a quota-class bench right now
 * (code#8086), mirroring quotaCoolingDown at credential scope. Callers judge the credential
 * that would actually serve: when a sibling credential can serve, the effective-credential
 * choice has already passed this one over, so a standing bench here names a target whose
 * every credential is held out. */
export const credentialQuotaCoolingDown = (target: Model.Ref, credentialID: string, now = Date.now()) => {
  const state = credentialHealth.get(credentialKey(target, credentialID))
  if (state) recover(target, state, now, credentialID)
  return quotaBenched(state, now)
}

/** The durable record id for one model target's reactive quota skip (#1976): keyed to the
 * answering target, so one model family's exhaustion record names only that family. */
const quotaModelSkipID = (target: Model.Ref) => `quota-model:${target.providerID}:${target.id}`

/** Whether a persisted skip record is a reactive (attempt-reported) timed quota skip — the
 * class `observeQuotaFailure` plants on a credential-less answer. Its provenance field
 * names it; records written before the field existed are recognised by their note. Balance
 * records are excluded: they re-admit only on a fresh increase (#1014). */
const attemptQuotaSkip = (item: Adjustment): boolean =>
  item.action === "skip" &&
  item.balanceBaseline === undefined &&
  (item.quotaSkipOrigin === "attempt" || (item.note?.includes("(attempt-reported)") ?? false))

/** Quota answers per provider from distinct answering targets, keyed by target ref with
 * the stated hold each answer planted (#1976): the corroboration ledger that decides when
 * a model-scoped reactive skip promotes to provider scope. Process-local: after a restart
 * the first answer plants a model-scoped skip and corroboration rebuilds from live
 * answers, which is the conservative direction. */
/** Distinct targets of one provider that must answer quota before a reactive skip is
 * promoted to provider scope (#1976) — a single family's answer stays model-scoped. */
const QUOTA_SKIP_CORROBORATION_SOURCES = 2

const quotaFailureSources = new Map<string, Map<string, number>>()

/** Re-judges this provider's attempt-reported quota skips against a fresher quota
 * reading (#1974): when the reading is known and not full, the provider's own measured
 * state says its window has capacity again, so the reactive skips come off — the
 * model-scoped record and a corroborated provider-wide one alike — instead of holding
 * until the reset date the original error happened to quote. The reading governs, not
 * the error: a window that rolled early re-admits on the reading's word, and a reading
 * that still shows the window full lifts nothing, however stale the skip's own date has
 * grown — a further reading is the only thing that can lift it then. No attempt is ever
 * spent to test the door: re-admission is a judgement over measured quota, never a
 * probe.
 *
 * Guarded like the feed paths that call it: the reading must be known (a stale or
 * percent-less reading is neither headroom nor a wall) and no older than the skip it
 * lifts — a reading taken before the quota answer that planted the skip cannot
 * contradict it. Balance records are not this path's business: they re-admit only on a
 * fresh increase (#1014). Returns the records it removed. */
export const releaseQuotaSkipsForSnapshot = (
  target: Model.Ref,
  snapshot: QuotaSnapshot.Snapshot,
  now = Date.now(),
  location?: string,
): string[] => {
  if (snapshot.providerID !== target.providerID) return []
  if (!QuotaSnapshot.known(snapshot)) return []
  if (QuotaSnapshot.isKnownFull(snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)) return []
  const released: string[] = []
  for (const item of [...adjustments]) {
    if (!attemptQuotaSkip(item)) continue
    if (!(item.id === `quota:${target.providerID}` || item.id === quotaModelSkipID(target))) continue
    // Plant-time floor: the skip re-plants on each fresh quota answer with a strictly
    // later expiry, so a standing skip's expiry is at least QUOTA_GATE_MAX_MS past the
    // answer that planted it (and at most that far past it). A reading older than that
    // floor predates the answer and cannot contradict it.
    if (item.until !== undefined && snapshot.observedAt <= item.until - QUOTA_GATE_MAX_MS) continue
    if (removeAdjustment(item.id)) released.push(item.id)
  }
  if (released.length > 0)
    logHealth(target, "quota-readmitted", `fresher quota reading re-admitted ${released.join(", ")}`)
  return released
}

/** The freshest measured reading of one model's quota windows in the gatherer's
 * snapshot (#1974, #2036): among the provider's entries, the windows the freshest
 * measurement carries for this model (a model entry, or windows literally named
 * for the model), aggregated the way the provider-wide branch below aggregates —
 * the reading's percent is the MAXIMUM over its windows, so one window still at
 * its limit holds the judgement full whatever order the snapshot serializes the
 * windows in, and `complete` reports whether every window in that measurement
 * carried a percent at all: a percent-less window is missing evidence, not
 * headroom, so an incomplete reading can plant a wall (a window it does show
 * full is positive evidence) but can never lift one. The reset carried is the
 * fullest window's own. Undefined when the snapshot carries no measured window
 * for the model — no reading is no evidence, in either direction. */
const modelWindowReading = (
  readings: readonly QuotaCurrent.ProviderReading[],
  providerID: string,
  modelID: string,
): {
  readonly percent: number
  readonly resetAt: number | null
  readonly observedAt: number
  readonly complete: boolean
} | undefined => {
  const candidatesOf = (reading: QuotaCurrent.ProviderReading): QuotaCurrent.Window[] => [
    ...(ownValue(reading.models, modelID) ?? []),
    ...reading.windows.filter((window) => window.name.startsWith(`${modelID}:`)),
  ]
  let freshest: number | undefined
  for (const reading of readings) {
    if (reading.providerID !== providerID) continue
    for (const window of candidatesOf(reading))
      if (freshest === undefined || window.measuredAt > freshest) freshest = window.measuredAt
  }
  if (freshest === undefined) return undefined
  let percent: number | undefined
  let resetAt: number | null = null
  let complete = true
  for (const reading of readings) {
    if (reading.providerID !== providerID) continue
    for (const window of candidatesOf(reading)) {
      if (window.measuredAt !== freshest) continue
      if (window.usedPercent === null) {
        complete = false
        continue
      }
      if (percent === undefined || window.usedPercent >= percent) {
        percent = window.usedPercent
        resetAt = window.resetAt
      }
    }
  }
  if (percent === undefined) return undefined
  return { percent, resetAt, observedAt: freshest, complete }
}

/** Re-judges this provider's attempt-reported quota skips against the fleet gatherer's
 * measured quota snapshot (#1974): when the provider's freshest reading for this model
 * shows its window below full, the skip that model family's exhaustion planted comes
 * off — the source's word replaces the reset date the original error happened to
 * quote, which is how a window that rolled early re-admits instead of waiting out an
 * overstated hold. The provider's provider-wide windows corroborate rather than
 * override: when they too read full, the model reading does not lift anything yet, and
 * when a provider-wide record stands, provider-wide headroom is what lifts it. No
 * attempt is ever spent to test the door: re-admission is a judgement over measured
 * quota, never a probe. A provider the snapshot does not carry keeps its skips — no
 * record is no judgement. Returns the records removed. */
/** How long a gathered reading may hold a planted wall (code#8086): the gatherer
 * rewrites `quota-current.json` every ~15 minutes, so a reading older than twice
 * that cadence is not evidence — a stale file must never idle a healthy leg, and
 * when the gatherer stops reporting, planted walls lapse on their own `until`
 * and selection falls back to attempt + bench, as before. */
const GATHERED_WALL_MAX_AGE_MS = 30 * 60_000

/** The wall the fleet gatherer's snapshot states for one target (code#8086,
 * Drew 2026-11-10: "if it's failing for quota and quota shows 100% it should be
 * skipped until it's not walled"): the target is walled while a fresh gathered
 * reading shows its window full, and eligible again the moment a later reading
 * shows room — no attempt is spent to learn either state, and no probe is ever
 * sent. Two reading shapes carry a wall, at the scope the reading itself names:
 *
 * - the model's own windows (a model entry, or windows named for the model):
 *   the aggregated freshest reading (see `modelWindowReading`) at 100% with its
 *   reset still ahead walls this model until that reset;
 * - the provider's own windows, when the snapshot carries exactly ONE entry
 *   for the provider and no per-model reading for this target at all (the
 *   cline-pass shape: the provider's weekly window IS the wall every model on
 *   it shares). Several entries for one provider are per-account readings —
 *   the codex doors — and no pool verdict is synthesized from them (Drew,
 *   2026-11-07): each account's own gate and benches govern those.
 *
 * A window at 100% whose stated reset has already passed is not a wall: the
 * window has rolled, whatever the percent still says. A full window stating no
 * reset walls for the gate's bounded fallback hold, re-judged at every feed.
 * Returns the instant the wall holds until and the reading that stated it. */
export const gatheredQuotaWall = (
  target: Model.Ref,
  readings: readonly QuotaCurrent.ProviderReading[],
  now = Date.now(),
  location?: string,
): { readonly until: number; readonly observedAt: number } | undefined => {
  const entries = readings.filter((reading) => reading.providerID === target.providerID)
  if (entries.length === 0) return undefined
  const gate = currentConstants(location).quotaGate
  const threshold = gate.balanceDeadThreshold
  const fresh = (observedAt: number) => now - observedAt <= GATHERED_WALL_MAX_AGE_MS
  const wall = (percent: number, resetAt: number | null, observedAt: number) => {
    if (!fresh(observedAt)) return undefined
    const snapshot = {
      planID: "quota-current",
      window: "gathered",
      providerID: target.providerID,
      percent,
      remaining: null,
      resetAt,
      observedAt,
      stale: false,
    }
    if (!QuotaSnapshot.isKnownFull(snapshot, now, threshold)) return undefined
    return { until: Math.min(resetAt ?? now + gate.fallbackMs, now + gate.maxMs), observedAt }
  }
  const own = modelWindowReading(entries, target.providerID, target.id as string)
  if (own) return wall(own.percent, own.resetAt, own.observedAt)
  if (entries.length !== 1) return undefined
  const entry = entries[0]
  let percent: number | undefined
  let resetAt: number | null = null
  for (const window of entry.windows) {
    if (window.usedPercent === null) continue
    if (percent === undefined || window.usedPercent >= percent) {
      percent = window.usedPercent
      resetAt = window.resetAt
    }
  }
  if (percent === undefined) return undefined
  return wall(percent, resetAt, entry.measuredAt)
}

/** Plants — or, on a later reading's word, lifts — the gathered-quota wall for
 * one target (code#8086): while `gatheredQuotaWall` states a wall, a
 * model-scoped skip record (the reactive skip's own record shape, of proactive
 * origin) holds the target out of selection, until the reading's reset; the
 * record is re-planted at every feed while the wall stands, so its `until`
 * tracks the freshest reading. When a fresh, complete reading at the same
 * scope shows room instead, a standing record OF THIS PLANT'S OWN ORIGIN comes
 * off — re-admission is the snapshot's word alone, never an attempt and never
 * a probe. Attempt-reported records are another path's business (#1974): this
 * plant neither lifts nor overwrites one. A stale, missing, or incomplete
 * reading judges nothing: a standing planted record simply lapses at its own
 * `until`. Returns the record id when one was planted or lifted. */
export const plantGatheredQuotaWall = (
  target: Model.Ref,
  readings: readonly QuotaCurrent.ProviderReading[],
  now = Date.now(),
  location?: string,
): string | undefined => {
  const id = quotaModelSkipID(target)
  const wall = gatheredQuotaWall(target, readings, now, location)
  if (wall) {
    // The documented invariant above, on the plant side (#2332): a standing
    // record that is not this plant's own — an attempt-reported skip above
    // all — is left untouched, exactly as the lift path below already
    // leaves it. Overwriting it would flip its origin to "proactive", and
    // a later headroom reading would then lift it on the snapshot's word,
    // defeating the attempt path's own re-admission rules (#1974).
    const standing = adjustments.find((item) => item.id === id)
    if (standing && standing.quotaSkipOrigin !== "proactive") return undefined
    addAdjustment({
      id,
      match: `${target.providerID}/${target.id}`,
      action: "skip",
      until: wall.until,
      quotaSkipOrigin: "proactive",
      note: "quota exhausted (gathered snapshot); held until the gathered window resets",
    })
    return id
  }
  const standing = adjustments.find((item) => item.id === id)
  if (!standing || standing.quotaSkipOrigin !== "proactive") return undefined
  // Lift only on whole evidence at the scope that planted: the model's own
  // aggregated reading, complete and below full — or, for a provider-window
  // wall, the provider's single entry reading below full on every window it
  // prices. Anything less (stale, partial, absent) leaves the record to lapse
  // at its own `until`.
  const entries = readings.filter((reading) => reading.providerID === target.providerID)
  const threshold = currentConstants(location).quotaGate.balanceDeadThreshold
  const headroom = (percent: number, observedAt: number) =>
    now - observedAt <= GATHERED_WALL_MAX_AGE_MS &&
    !QuotaSnapshot.isKnownFull(
      {
        planID: "quota-current",
        window: "gathered",
        providerID: target.providerID,
        percent,
        remaining: null,
        resetAt: null,
        observedAt,
        stale: false,
      },
      now,
      threshold,
    )
  const own = modelWindowReading(entries, target.providerID, target.id as string)
  if (own) {
    if (!own.complete || !headroom(own.percent, own.observedAt)) return undefined
  } else {
    if (entries.length !== 1) return undefined
    const entry = entries[0]
    if (entry.windows.length === 0 || entry.windows.some((window) => window.usedPercent === null)) return undefined
    const percent = Math.max(...entry.windows.map((window) => window.usedPercent ?? 0))
    if (!headroom(percent, entry.measuredAt)) return undefined
  }
  if (removeAdjustment(id)) {
    logHealth(target, "quota-readmitted", "gathered quota reading re-admitted the planted wall")
    return id
  }
  return undefined
}

export const releaseQuotaSkipsForCurrent = (
  target: Model.Ref,
  readings: readonly QuotaCurrent.ProviderReading[],
  now = Date.now(),
  location?: string,
): string[] => {
  const entries = readings.filter((reading) => reading.providerID === target.providerID)
  if (entries.length === 0) return []
  const own = modelWindowReading(entries, target.providerID, target.id as string)
  if (!own) return []
  const threshold = currentConstants(location).quotaGate.balanceDeadThreshold
  const asSnapshot = (reading: { percent: number; resetAt: number | null; observedAt: number }) => ({
    planID: "quota-current",
    window: "gathered",
    providerID: target.providerID,
    percent: reading.percent,
    remaining: null,
    resetAt: reading.resetAt,
    observedAt: reading.observedAt,
    stale: now - reading.observedAt > QuotaSnapshot.DEFAULT_MAX_AGE_MS,
  })
  const ownSnapshot = asSnapshot(own)
  // An incomplete freshest reading — some window of the model's measurement
  // carries no percent — is not whole evidence of headroom (#2036): it lifts
  // nothing, exactly as a stale or full reading lifts nothing.
  if (!own.complete) return []
  if (!QuotaSnapshot.known(ownSnapshot) || QuotaSnapshot.isKnownFull(ownSnapshot, now, threshold)) return []
  const modelSkipID = quotaModelSkipID(target)
  const providerStanding = adjustments.some(
    (item) => item.id === `quota:${target.providerID}` && attemptQuotaSkip(item),
  )
  // While a provider-wide record stands, this model's headroom alone lifts nothing —
  // not even its own record beneath it: the leaf is out at provider scope, so only
  // provider-wide headroom (below) re-admits anything.
  const released = !providerStanding
    ? releaseQuotaSkipsForSnapshot(target, ownSnapshot, now, location).filter((id) => id === modelSkipID)
    : []
  if (!providerStanding) return released
  // A provider-wide record stands: it lifts only on provider-wide headroom — the
  // freshest reading whose every provider window is below full.
  let wide: { percent: number; resetAt: number | null; observedAt: number } | undefined
  for (const entry of entries) {
    if (entry.windows.length === 0 || entry.windows.some((window) => window.usedPercent === null)) continue
    const percent = Math.max(...entry.windows.map((window) => window.usedPercent ?? 0))
    const observedAt = Math.max(...entry.windows.map((window) => window.measuredAt))
    if (!wide || observedAt >= wide.observedAt) wide = { percent, resetAt: null, observedAt }
  }
  if (!wide) return released
  const wideSnapshot = asSnapshot(wide)
  if (!QuotaSnapshot.known(wideSnapshot) || QuotaSnapshot.isKnownFull(wideSnapshot, now, threshold)) return released
  // Provider-wide headroom re-admits the provider's records: the corroborated record,
  // and the model records under it whose own readings corroborate the roll.
  return [...releaseQuotaSkipsForSnapshot(target, wideSnapshot, now, location), ...released]
}

/** One bench in force, as route diagnostics report it (#1123). */
export interface ActiveBench {
  readonly providerID: string
  readonly modelID: string
  readonly credentialID?: string
  readonly until: number
  /** The bench class that planted it: quota, quota retry-after, retry-after, auth, failure, slow. */
  readonly reason: string
  readonly consecutiveFailures: number
  /** The known quota window reset this bench is bounded by, when one is known. */
  readonly quotaResetAt?: number
  readonly probeDue: boolean
  readonly probeClaimed: boolean
}

/** Every bench in force at `now` — target-level and per-credential — soonest expiry first.
 * Reading it changes nothing: expired benches are simply absent, so a target benched with no
 * attempts in the stats window is still visible here. */
export const activeBenches = (now = Date.now()): ActiveBench[] => {
  const benches: ActiveBench[] = []
  const collect = (id: string, state: HealthState, credentialID?: string) => {
    if (state.cooldownUntil <= now) return
    const base = credentialID ? id.slice(0, id.lastIndexOf("#")) : id
    const slash = base.indexOf("/")
    benches.push({
      providerID: base.slice(0, slash),
      modelID: base.slice(slash + 1),
      ...(credentialID ? { credentialID } : {}),
      until: state.cooldownUntil,
      reason: state.benchReason ?? "unknown",
      consecutiveFailures: state.consecutiveFailures,
      ...(state.benchQuotaResetAt !== undefined ? { quotaResetAt: state.benchQuotaResetAt } : {}),
      probeDue: probeDueState(state, now),
      probeClaimed: state.probeClaimedAt !== undefined,
    })
  }
  for (const [id, state] of health) collect(id, state)
  for (const [id, state] of credentialHealth) collect(id, state, id.slice(id.lastIndexOf("#") + 1))
  return benches.toSorted((left, right) => left.until - right.until)
}

/** The availability classes of #1828: why a provider/credential/target is stopped, in the
 * vocabulary of the resume rule that frees it. */
export type AvailabilityClass = "quota" | "balance" | "rate-limit" | "auth" | "unknown" | "infra" | "slow"

/** One stop in force, as the availability surface reports it: what is stopped, which class
 * holds it, until when (absent for increase-only balance holds — no timer frees those),
 * and the resume rule that ends it. */
export interface AvailabilityEntry {
  readonly providerID: string
  readonly modelID?: string
  readonly credentialID?: string
  readonly class: AvailabilityClass
  readonly reason: string
  readonly until?: number
  readonly resume: "reset" | "increase" | "retry-after" | "timer" | "path"
}

/** Every stop in force at `now`, merged from all four mechanisms that can hold a provider
 * back — benches, quota gates and balance holds, provider rate-limit window holds, and
 * infra holds — so one readout answers "which providers are available, and for the rest:
 * why, until when, and what resumes them" (#1828). Absence from the list means available.
 * The effective stop for a leaf is the latest `until` among its entries; a balance entry
 * carries no `until` because only a measured increase frees it. Reading it changes
 * nothing. */
export const availability = (now = Date.now()): AvailabilityEntry[] => {
  const entries = new Map<string, AvailabilityEntry>()
  const put = (entry: AvailabilityEntry) => {
    const id = `${entry.providerID}/${entry.modelID ?? ""}#${entry.credentialID ?? ""}:${entry.class}`
    const prior = entries.get(id)
    if (prior && (prior.until ?? Number.POSITIVE_INFINITY) >= (entry.until ?? Number.POSITIVE_INFINITY)) return
    entries.set(id, entry)
  }
  const benchClass = (reason: string): { class: AvailabilityClass; resume: AvailabilityEntry["resume"] } =>
    reason === "quota" || reason === "quota retry-after"
      ? { class: "quota", resume: "reset" }
      : reason === "retry-after"
        ? { class: "rate-limit", resume: "retry-after" }
        : reason === "auth"
          ? { class: "auth", resume: "timer" }
          : reason === "slow"
            ? { class: "slow", resume: "timer" }
            : { class: "unknown", resume: "timer" }
  for (const bench of activeBenches(now)) {
    const mapped = benchClass(bench.reason)
    put({
      providerID: bench.providerID,
      modelID: bench.modelID,
      ...(bench.credentialID ? { credentialID: bench.credentialID } : {}),
      class: mapped.class,
      reason: bench.reason,
      until: bench.until,
      resume: mapped.resume,
    })
  }
  for (const [id, state] of limits) {
    if (state.until <= now) continue
    const hash = id.lastIndexOf("#")
    const base = hash === -1 ? id : id.slice(0, hash)
    const slash = base.indexOf("/")
    put({
      providerID: base.slice(0, slash),
      modelID: base.slice(slash + 1),
      ...(hash === -1 ? {} : { credentialID: id.slice(hash + 1) }),
      class: "rate-limit",
      reason: "provider rate-limit window",
      until: state.until,
      resume: "retry-after",
    })
  }
  const gate = (state: QuotaGateState, credentialID?: string) => {
    // A balance hold subsumes the gate that carries it: the same stop seen twice is one
    // stop, and its resume rule is the hold's (a measured increase), not the gate's reset.
    if (state.balanceHold)
      put({
        providerID: state.target.providerID,
        modelID: state.target.id as string,
        ...(credentialID ? { credentialID } : {}),
        class: "balance",
        reason: "balance exhausted; held until a measured increase",
        resume: "increase",
      })
    else if (state.gated)
      put({
        providerID: state.target.providerID,
        modelID: state.target.id as string,
        ...(credentialID ? { credentialID } : {}),
        class: "quota",
        reason: "quota known-full",
        ...(state.actualResetAt !== undefined && state.actualResetAt > now ? { until: state.actualResetAt } : {}),
        resume: "reset",
      })
    if (state.timedGateUntil !== undefined && state.timedGateUntil > now)
      put({
        providerID: state.target.providerID,
        modelID: state.target.id as string,
        ...(credentialID ? { credentialID } : {}),
        class: "rate-limit",
        reason: "attempt-reported rate limit",
        until: state.timedGateUntil,
        resume: "retry-after",
      })
  }
  for (const [credentialID, state] of credentialQuota) gate(state, credentialID)
  for (const state of providerQuota.values()) gate(state)
  for (const [id, hold] of infraHolds) {
    if (hold.until <= now) continue
    const slash = id.indexOf("/")
    put({
      providerID: id.slice(0, slash),
      modelID: id.slice(slash + 1),
      class: "infra",
      reason: "transport path failure (DNS / connection refused)",
      until: hold.until,
      resume: "path",
    })
  }
  return [...entries.values()].toSorted(
    (left, right) =>
      left.providerID.localeCompare(right.providerID) ||
      (left.modelID ?? "").localeCompare(right.modelID ?? "") ||
      left.class.localeCompare(right.class),
  )
}

/** Whether a balance is dead under a threshold, with the same floating-point tolerance
 * QuotaSnapshot.isKnownFull applies to live snapshots (#1461): a balance a hair above the
 * threshold from rounding (0.4 - 0.3 = 0.10000000000000003 against the 0.1 default) is
 * still dead, so restored/durable judgements agree with live ones. */
function deadBalance(balance: number, threshold: number): boolean {
  return balance <= threshold + Number.EPSILON * Math.max(1, Math.abs(balance), Math.abs(threshold))
}

/** Whether a persisted provider quota skip blocks a judgement under `location` (#1461):
 * threshold-derived holds are judged under the judging Location's balanceDeadThreshold --
 * from the provider's live gate state when there is one, otherwise from the balance
 * persisted on the record itself (its latest judged balance, falling back to its benched
 * baseline). Attempt-reported and legacy skips keep their unconditional force, as does a
 * threshold record carrying no balance to admit against. */
const quotaSkipBlocks = (item: Adjustment, now: number, location?: string): boolean => {
  if (item.balanceHoldOrigin !== "threshold") return true
  if (item.id.startsWith("quota:") && !item.id.startsWith("quota-credential:")) {
    const provider = providerQuota.get(item.id.slice("quota:".length))
    if (provider?.balanceHold !== undefined) return holdBlocks(provider.balanceHold, provider.snapshot, now, location)
  }
  if (item.balanceHoldExpired === true) return true
  const judged = item.balanceHoldBalance ?? item.balanceBaseline
  if (judged === null || judged === undefined) return true
  return deadBalance(judged, currentConstants(location).quotaGate.balanceDeadThreshold)
}

/** The half-open bench probe claim a routed pick spent (#1478, #1486): the token names the
 * pick's spend across every scope it claimed, so settlement lands only on scopes whose
 * outstanding claim is still this pick's. The credential is the snapshot credential at pick
 * time, which may differ from the credential that served the attempt. */
export interface ProbeClaim {
  readonly claimedAt: number
  readonly token: number
  readonly credentialID?: string
}

/** Whether this pick still owns the outstanding claim on the scope: the scope is claimed
 * and its token is still the pick's. A settled or re-claimed scope no longer matches. */
const probeClaimMatches = (state: HealthState | undefined, claim: ProbeClaim) =>
  state !== undefined && state.probeClaimedAt === claim.claimedAt && state.probeClaimToken === claim.token

/** Re-benches a probe scope the pick claimed when its attempt failed (#1486): the bench the
 * probe was admitted by renews on the escalated ladder, bounded by the next known reset.
 * Scopes the pick did not claim (or that have since settled) are left alone. */
const benchProbeScope = (
  target: Model.Ref,
  policy: Policy,
  now: number,
  hint: FailureHint | undefined,
  credentialID: string | undefined,
  claim: ProbeClaim,
  location?: string,
) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  if (!probeClaimMatches(state, claim) || !state) return
  bench(
    target,
    state,
    policy,
    now,
    hint,
    credentialID,
    statedQuotaResetAt(target, credentialID, now, location, hint),
    location,
  )
}

/** Ends a probe scope's bench when the pick's attempt succeeded (#1486): the probe was
 * admitted to learn whether the scope serves again, and it does. Like the release, this
 * only lands while the scope's outstanding claim is still the pick's. */
const endProbeScope = (target: Model.Ref, now: number, credentialID: string | undefined, claim: ProbeClaim) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  if (!probeClaimMatches(state, claim) || !state) return
  state.outcomes = pushOutcome(state.outcomes, true)
  state.consecutiveFailures = 0
  endBench(target, state, now, credentialID)
}

export const failed = (
  target: Model.Ref,
  policy: Policy,
  now = Date.now(),
  hint?: FailureHint,
  credentialID?: string,
  location?: string,
  probeClaim?: ProbeClaim,
) => {
  // Quota, rate-limit and provider HTTP errors are not evidence of an internet outage.
  if (hint?.quota) recordQuota(target, now, credentialID)
  if (hint?.network)
    recentFailures.push({
      provider: target.providerID,
      target: credentialID ? credentialKey(target, credentialID) : key(target),
      time: now,
    })
  while (
    recentFailures.length > 200 ||
    (recentFailures[0] && now - recentFailures[0].time > retainedNetworkWindowMs())
  )
    recentFailures.shift()
  if (hint?.network && networkSuspect(now, location)) {
    // Undo the cooldowns from the earlier correlated transport errors too: those requests likely
    // shared the same local outage, so treating each provider as independently unhealthy is wrong.
    // The escalation count is undone with the cooldown: a forgiven failure must not double the
    // target's next bench (#1034).
    for (const failure of recentFailures) {
      // Forgiveness covers the outage the judging Location detected: failures older
      // than its network window are retained for other Locations' evaluations, but
      // they are not part of this outage and keep their benches (#1423).
      if (now - failure.time > currentConstants(location).network.windowMs) continue
      const prior = health.get(failure.target) ?? credentialHealth.get(failure.target)
      if (prior) {
        if (prior.cooldownUntil > now) {
          prior.cooldownUntil = 0
          prior.samples = []
          prior.benchReason = undefined
          prior.benchQuotaResetAt = undefined
          prior.probeClaimedAt = undefined
          prior.probeClaimToken = undefined
        }
        prior.consecutiveFailures = 0
      }
    }
    // The forgiveness above clears the states it can name; a probe scope of this pick it
    // cannot (a snapshot credential that did not serve) is handed back instead of being
    // stranded until the bench expires (#1486, review follow-up). Token-guarded: a scope
    // forgiveness already cleared no-ops.
    if (probeClaim) {
      releaseBenchProbe(target, undefined, probeClaim.claimedAt, probeClaim.token)
      if (probeClaim.credentialID)
        releaseBenchProbe(target, probeClaim.credentialID, probeClaim.claimedAt, probeClaim.token)
    }
    logHealth(target, "network-suspect", "transport failures across unrelated providers; target cooldowns cleared")
    return
  }
  // An infra failure never reached a provider API: it plants no bench, feeds no quota
  // accounting, and never escalates the target's error standing. It holds the target out
  // of candidacy on the infra cadence while the path is broken, and hands back any probe
  // claim this pick spent — the scope it claimed was never actually tested.
  if (hint?.infra) {
    plantInfraHold(target, now)
    if (probeClaim) {
      releaseBenchProbe(target, undefined, probeClaim.claimedAt, probeClaim.token)
      if (probeClaim.credentialID)
        releaseBenchProbe(target, probeClaim.credentialID, probeClaim.claimedAt, probeClaim.token)
    }
    return
  }
  // With a credential dimension the failure belongs to the credential that served the attempt:
  // benching the target as well would bench every other credential behind the provider too (#6).
  if (credentialID) {
    bench(
      target,
      credentialEntry(target, credentialID),
      policy,
      now,
      hint,
      credentialID,
      statedQuotaResetAt(target, credentialID, now, location, hint),
      location,
    )
    // The pick may also have claimed the target scope and a different probe credential (#1486):
    // each renews on the same ladder while its outstanding claim is still this pick's.
    // Serving-credential accounting above is unchanged.
    if (probeClaim) {
      benchProbeScope(target, policy, now, hint, undefined, probeClaim, location)
      if (probeClaim.credentialID && probeClaim.credentialID !== credentialID)
        benchProbeScope(target, policy, now, hint, probeClaim.credentialID, probeClaim, location)
    }
    return
  }
  bench(
    target,
    entry(target),
    policy,
    now,
    hint,
    undefined,
    statedQuotaResetAt(target, undefined, now, location, hint),
    location,
  )
  // A credential-scope claim from the same pick settles here too (#1486).
  if (probeClaim?.credentialID) benchProbeScope(target, policy, now, hint, probeClaim.credentialID, probeClaim, location)
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
    state.benchReason = "slow"
    state.benchQuotaResetAt = undefined
    state.probeClaimedAt = undefined
    state.probeClaimToken = undefined
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

/** Sets the process-wide fallback layer of `Settings`. Since #1151 the demotion half of
 * this is only a fallback: a Location's `experimental.model_route_demotion` config,
 * registered per Location through `onDemotionConfig`, overrides it field by field for
 * that Location's traffic, and the compiled defaults apply where neither is set. */
export const configure = (
  next: Partial<{ escalation: Partial<Settings["escalation"]>; quota: Partial<Settings["quota"]> }>,
) => {
  settings = {
    escalation: { ...settings.escalation, ...next.escalation },
    quota: { ...settings.quota, ...next.quota },
  }
}

/** The machinery constants as config supplies them (experimental.routes.settings), in
 * config's own grouping. Every field is optional; an unset field keeps the layer below it.
 * `demotion.after` / `demotion.windowMs` and the `escalation` fields land in `Settings`
 * above; the rest land in `Constants` at the end of this file. */
export interface SettingsConfig {
  readonly bench?: {
    readonly maxCooldownMs?: number
    readonly multiplier?: number
    readonly failureCapMs?: number
    readonly retryAfterMinMs?: number
    readonly cooldownCapMs?: number
    readonly quotaCooldownCapMs?: number
  }
  readonly demotion?: {
    readonly after?: number
    readonly windowMs?: number
    readonly factor?: number
  }
  readonly quotaGate?: {
    readonly maxMs?: number
    readonly fallbackMs?: number
    readonly feedTtlMs?: number
    readonly balanceDeadThreshold?: number
    readonly rootStartMaxPct?: number
  }
  readonly escalation?: {
    readonly enabled?: boolean
    readonly afterGiveUps?: number
    readonly outcomeWindow?: number
  }
  readonly network?: {
    readonly windowMs?: number
    readonly providers?: number
    readonly providerModels?: number
  }
  readonly membership?: {
    readonly waitMs?: number
  }
  readonly continuity?: {
    readonly hedgeRequests?: number
  }
  readonly overrides?: {
    readonly preferredFactor?: number
  }
}

/** Settings readers keyed by Location directory (#1423). The model-routes config plugin
 * runs once per Location graph, so each registration belongs to that graph's Location
 * alone. Before this, a single module-global reader meant the last activated Location's
 * settings (or its absence) governed every Location's routing machinery in the process. */
const settingsReaders = new Map<string, () => SettingsConfig | undefined>()

/** The reader an unscoped call may use: config is only unambiguous when exactly one
 * Location has registered. With several Locations an unscoped read cannot know which
 * one it serves, so it gets no config reader (the configure()/compiled defaults) rather
 * than another Location's settings. Callers that know their Location pass its directory. */
const unscopedSettingsReader = (): (() => SettingsConfig | undefined) | undefined => {
  if (settingsReaders.size !== 1) return undefined
  return settingsReaders.values().next().value
}

const settingsReaderFor = (location?: string) =>
  location === undefined ? unscopedSettingsReader() : settingsReaders.get(location)

/** Registers where one Location's config-derived settings come from (the model-routes
 * config plugin, keyed by that Location's directory, mirroring
 * ModelRouteLog.onCaptureErrorBodies). Read lazily at every use, so a config
 * reload is honored without re-registering. An unkeyed registration is kept under the
 * empty key (test seam and single-Location hosts). Returns the function that removes
 * this registration again, for when the Location's graph closes. */
export const onSettingsConfig = (read: () => SettingsConfig | undefined, location?: string) => {
  const key = location ?? ""
  settingsReaders.set(key, read)
  return () => {
    if (settingsReaders.get(key) === read) settingsReaders.delete(key)
  }
}

/** Membership caps readers keyed by Location directory (#2253), mirroring the
 * settings readers: the provider-config plugin registers, per Location, where the
 * caps each provider declares on its own definition come from. The caps live on the
 * provider definition (`settings.membership`), so a Location's reader answers per
 * provider id — the canonical account included, so an alias and its canonical
 * provider read the same declaration and share one accumulator. */
export type MembershipLimitsReader = (providerID: string) => ModelRouteMembership.Limits | undefined

const membershipReaders = new Map<string, MembershipLimitsReader>()

/** Registers where one Location's declared membership caps come from (the
 * model-routes config plugin, keyed by that Location's directory). Read lazily at
 * every use, so a config reload is honored without re-registering. The empty key
 * is the unscoped registration (test seam and single-Location hosts). Returns the
 * function that removes this registration again. */
export const onMembershipLimits = (read: MembershipLimitsReader, location?: string) => {
  const key = location ?? ""
  membershipReaders.set(key, read)
  return () => {
    if (membershipReaders.get(key) === read) membershipReaders.delete(key)
  }
}

const membershipReaderFor = (location?: string): MembershipLimitsReader | undefined => {
  if (location !== undefined) return membershipReaders.get(location)
  const unscoped = membershipReaders.get("")
  if (unscoped) return unscoped
  if (membershipReaders.size === 1) return membershipReaders.values().next().value
  return undefined
}

/** The membership caps a provider declares, for a Location: read through the
 * canonical provider first, so an alias whose canonical declares the caps is
 * capped even when the alias's own definition omits them. */
export const membershipLimits = (
  providerID: string,
  canonical?: string,
  location?: string,
): ModelRouteMembership.Limits | undefined => {
  const read = membershipReaderFor(location)
  if (!read) return undefined
  if (canonical !== undefined && canonical !== providerID) {
    const declared = read(canonical)
    if (declared) return declared
  }
  return read(providerID)
}

/** The account a provider's requests draw from (#2253): its canonical provider
 * when it declares one, else itself. Aliases of one account share the accumulator
 * because they share this key. */
export const membershipAccount = (providerID: string, canonical?: string): string =>
  ModelRouteMembership.accountOf(providerID, canonical)

/** Admits one request start against the provider's declared membership caps.
 * Providers with no declared caps are always admitted. The gate that waits or
 * fails over lives in the callers (session runner, generation façade); this is
 * the shared accounting they all draw from. */
export const membershipAcquire = (
  providerID: string,
  canonical?: string,
  location?: string,
  now = Date.now(),
): ModelRouteMembership.Admission =>
  ModelRouteMembership.acquire(
    membershipAccount(providerID, canonical),
    membershipLimits(providerID, canonical, location),
    now,
  )

/** Ends one in-flight request against the provider's membership account. */
export const membershipRelease = (providerID: string, canonical?: string) =>
  ModelRouteMembership.releaseAccount(membershipAccount(providerID, canonical))

/** The provider account's current membership standing, for ledgers and tests. */
export const membershipSnapshot = (providerID: string, canonical?: string, now = Date.now()) =>
  ModelRouteMembership.accountSnapshot(membershipAccount(providerID, canonical), now)

/** Until when an upstream tier-limit answer holds the provider's account out of
 * rotation (#2253 backstop); 0 when it doesn't. The resolver's ready filter reads
 * this alongside the per-target rate-limit holds, so a held account's targets are
 * excluded before any attempt is spent. */
export const membershipHeldUntil = (providerID: string, canonical?: string, now = Date.now()): number =>
  ModelRouteMembership.heldUntil(membershipAccount(providerID, canonical), now)

/** Records an upstream `tier_limit_exceeded` answer against the provider's account
 * (#2253 backstop): the account is held out of rotation until the reset the error
 * states, and the hold is ledgered on the answering target so a restart restores
 * it through the ordinary rate-limit-window replay. */
export const recordTierLimit = (
  target: Model.Ref,
  message: string | undefined,
  now = Date.now(),
  canonical?: string,
) => {
  const until = ModelRouteMembership.recordTierLimit(membershipAccount(target.providerID, canonical), message, now)
  if (until > now)
    observeRateLimit(target, ModelRouteLimits.snapshot({ retryAfterMs: until - now }, now), now)
  return until
}

/** The settings in force for a Location: what configure() set, with that Location's
 * config over it. */
const activeSettings = (location?: string): Settings => {
  const config = settingsReaderFor(location)?.()
  if (!config) return settings
  return {
    escalation: {
      enabled: config.escalation?.enabled ?? settings.escalation.enabled,
      afterGiveUps: config.escalation?.afterGiveUps ?? settings.escalation.afterGiveUps,
    },
    quota: {
      demoteAfter: config.demotion?.after ?? settings.quota.demoteAfter,
      windowMs: config.demotion?.windowMs ?? settings.quota.windowMs,
    },
  }
}

export const currentSettings = (location?: string) => activeSettings(location)

/** The quota demotion policy as config supplies it (#1151): `experimental.model_route_demotion
 * { threshold, window_ms }` in the model-routes plugin's shape. Both fields are optional; an
 * unset field keeps the layer below it. */
export interface DemotionConfig {
  readonly threshold?: number
  readonly windowMs?: number
}

/** A demotion policy with every field resolved: the values `demoted` judges by. */
export interface DemotionPolicy {
  readonly threshold: number
  readonly windowMs: number
}

/** The demotion defaults: today's hardcoded values, so an unconfigured Location behaves
 * exactly as the machinery always has. */
export const DEFAULT_DEMOTION_POLICY: DemotionPolicy = {
  threshold: DEFAULT_SETTINGS.quota.demoteAfter,
  windowMs: DEFAULT_SETTINGS.quota.windowMs,
}

/** Demotion policy readers keyed by Location directory (#1151, design §6 of the façades
 * spec). The model-routes config plugin runs once per Location graph, so each registration
 * belongs to that graph's Location alone: a module-global setter (the old shape of
 * `ModelRoute.configure` for this policy) would let whichever Location loaded last rewrite
 * every other Location's demotion behaviour. */
const demotionReaders = new Map<string, () => DemotionConfig | undefined>()

/** Registers where one Location's demotion policy comes from (the model-routes config
 * plugin, keyed by that Location's directory). Read lazily at every use, so a config
 * reload is honored without re-registering. The empty key is the unscoped registration
 * (test seam and single-Location hosts). Returns the function that removes this
 * registration again, for when the Location's graph closes. */
export const onDemotionConfig = (read: () => DemotionConfig | undefined, location = "") => {
  demotionReaders.set(location, read)
  return () => {
    if (demotionReaders.get(location) === read) demotionReaders.delete(location)
  }
}

/** The demotion config in force for a Location. A caller that knows its Location gets
 * exactly that Location's reader. An unscoped read serves the unscoped registration, or
 * the single registered Location when there is only one; with several Locations an
 * unscoped read cannot know which one it serves, so it gets no Location's config rather
 * than another Location's policy. */
const demotionConfig = (location?: string): DemotionConfig | undefined => {
  if (location !== undefined) return demotionReaders.get(location)?.()
  const unscoped = demotionReaders.get("")
  if (unscoped) return unscoped()
  if (demotionReaders.size === 1) return demotionReaders.values().next().value?.()
  return undefined
}

/** The demotion policy in force for a Location: its `model_route_demotion` config over
 * the fallback layer (`configure()` over the compiled defaults), field by field. */
export const demotionPolicy = (location?: string): DemotionPolicy => {
  const config = demotionConfig(location)
  // The fallback layer is the judging Location's own settings (#1484): an unscoped read
  // here would judge a Location that configured demotion only in its routes settings by
  // the compiled defaults whenever a second Location is registered.
  const fallback = activeSettings(location).quota
  return {
    threshold: config?.threshold ?? fallback.demoteAfter,
    windowMs: config?.windowMs ?? fallback.windowMs,
  }
}

/** Give-ups among a target's recent requests. With a credentialID, the serving credential's own
 * history counts (#870): credential failures are recorded only in credentialHealth, so a
 * target-level read would call a repeatedly failing credential steady forever. */
export const giveUps = (target: Model.Ref, credentialID?: string, location?: string) => {
  const state = credentialID ? credentialHealth.get(credentialKey(target, credentialID)) : health.get(key(target))
  const window = currentConstants(location).escalation.outcomeWindow
  return (state?.outcomes ?? []).slice(-window).filter((answered) => !answered).length
}

/** A target is steady while it has fewer give-ups than the race threshold among its recent requests. */
export const steady = (target: Model.Ref, credentialID?: string, location?: string) =>
  giveUps(target, credentialID, location) < activeSettings(location).escalation.afterGiveUps

/** A route should race its next target immediately when its current target keeps giving up. Whether a
 * route races at all depends on its autonomy level; see ModelRouteAutonomy.races. */
export const escalates = (target: Model.Ref, credentialID?: string, location?: string) =>
  activeSettings(location).escalation.enabled && !steady(target, credentialID, location)

// Quota errors are recorded per target so a provider that keeps saying "out of quota" drops to the end
// of every order, instead of being retried first on each new session. This map is only the hot
// cache over the route_attempt ledger's QuotaExceeded rows (#1151): `seedDemotion` rehydrates
// it from the ledger at startup, so a restart does not reset demotion state.
const quotaEvents = new Map<string, number[]>()

/** Ledger ids of the quota attempts `seedDemotion` has already restored in this
 * process: a repeated restore over the same ledger must not count an attempt twice,
 * and identity — not the timestamp — is what names an attempt, since distinct
 * attempts can share a millisecond (#1151, review follow-up). Cleared with the
 * cache it guards in `resetHealth`. */
const restoredDemotionAttempts = new Set<number>()

/** True when a target has hit its quota errors often enough recently to be put last. With a
 * credentialID, only that credential's quota errors count: the demotion is per credential (#6).
 * The threshold and window are the demotion policy for the target's Location (#1151) when
 * the caller names one, resolved per Location in `demotionPolicy`. */
export const demoted = (target: Model.Ref, now = Date.now(), credentialID?: string, location?: string) => {
  const policy = demotionPolicy(location)
  const recent = (quotaEvents.get(credentialID ? credentialKey(target, credentialID) : key(target)) ?? []).filter(
    (at) => now - at <= policy.windowMs,
  )
  return recent.length >= policy.threshold
}

/** Records one quota event in the hot cache. Retention is the full supported
 * horizon (ModelRouteLog.MAX_DEMOTION_WINDOW_MS), exactly as `seedDemotion`
 * replays the ledger — never the window of whichever Locations happen to be
 * registered at record time (#1699): a Location with a wider demotion window
 * can activate later in a long-running process, and pruning against the
 * then-current retention would discard failures its policy still counts,
 * unrecoverably (the durable ledger only re-enters this cache at restart).
 * Judging still applies each Location's own window over the retained cache
 * in `demoted`, so the wider retention never demotes a target a narrower
 * policy would not. */
const recordQuota = (
  target: Model.Ref,
  now: number,
  credentialID?: string,
  retentionMs = ModelRouteLog.MAX_DEMOTION_WINDOW_MS,
) => {
  const id = credentialID ? credentialKey(target, credentialID) : key(target)
  const recent = (quotaEvents.get(id) ?? []).filter((at) => now - at <= retentionMs)
  quotaEvents.set(id, [...recent, now].slice(-50))
}

// The proactive half of #6: the latest quota snapshot observed per credential, and whether it
// currently gates the credential out of routes. Snapshots stay derived at their producers
// (#587); this is only the gate state consumers read. An unknown or stale observation never
// replaces a known one, so a gated credential is re-admitted only by its reset passing or by a
// fresher known snapshot below the limit — never by losing the signal.
/** One balance bench: the balance it was benched at, and the grant that balance belongs
 * to. Amounts are only comparable within one grant -- a funded replacement grant is
 * different money, so it releases the hold by existing rather than by exceeding the dead
 * grant's leftover (#1014). Holds restored from records written before grant identity was
 * tracked carry no grant and adopt the first live snapshot's. */
type BalanceHold = {
  readonly benchedBalance: number | null
  /** The latest balance this hold was judged from (#1461): refreshed by fresher snapshots
   * from any Location while the hold stays armed. Distinct from `benchedBalance`, the
   * increase-only release baseline -- a later, lower balance must not lower the bar a fresh
   * increase has to clear, but it IS the balance a judging Location's threshold applies to,
   * including after a restart restores the hold from its durable record. */
  readonly judgedBalance?: number | null
  readonly grant?: string
  /** Expiry is independent of the dead-balance threshold and must survive restoration. */
  readonly expired?: boolean
  /** How this hold was installed (#1461): "threshold" holds are policy-derived -- a
   * snapshot judged known-full under the OBSERVING Location's balanceDeadThreshold --
   * so at read time they are judged under the JUDGING Location's threshold and do not
   * block a Location whose threshold admits the balance. "attempt" holds are
   * attempt-reported exhaustion (observeQuotaFailure) and keep their unconditional
   * force. Unset (holds persisted before provenance was tracked) is treated as
   * attempt-reported: the conservative, historical behaviour. */
  readonly origin?: "threshold" | "attempt"
}

/** A balance snapshot's backing grant (plan + window): the identity balances compare within. */
const grantIdentity = (snapshot: QuotaSnapshot.Snapshot) => `${snapshot.planID}\n${snapshot.window}`

/** Whether a live balance snapshot releases a hold: a different grant's live balance is a
 * funded replacement and releases outright; the same grant (or a hold with no recorded
 * grant) needs a strict increase over the benched balance. Non-balance, expired, and
 * amount-less snapshots never release a hold. */
const releasesHold = (hold: BalanceHold, snapshot: QuotaSnapshot.Snapshot): boolean => {
  if (snapshot.balance !== true || snapshot.expired === true || snapshot.remaining === null) return false
  if (hold.grant !== undefined && grantIdentity(snapshot) !== hold.grant) return true
  return hold.benchedBalance === null || snapshot.remaining > hold.benchedBalance
}

/** Whether a snapshot shows its own grant was reclassified out of balance: it comes from
 * the hold's exact grant (same plan + window) but is no longer balance-shaped -- e.g. the
 * window gained `windowHours`, so derive() now reports a resetting usage window instead of
 * a point-in-time balance (#1380). The grant the hold benches on no longer exists as a
 * balance grant, so the hold is stale: the snapshot replaces it and gates (or not) as the
 * window's normal timed gate. A non-balance snapshot from any OTHER grant is not evidence
 * about this hold and never clears it. */
const grantReclassified = (hold: BalanceHold, snapshot: QuotaSnapshot.Snapshot): boolean =>
  hold.grant !== undefined && grantIdentity(snapshot) === hold.grant && snapshot.balance !== true

/** Whether a hold blocks a judgement made under `location` (#1461): attempt-reported
 * holds (and legacy holds with no recorded origin) block unconditionally; a
 * threshold-derived hold blocks only when the snapshot it benches on is still
 * known-full under the judging Location's balanceDeadThreshold. */
const holdBlocks = (hold: BalanceHold, snapshot: QuotaSnapshot.Snapshot, now: number, location?: string): boolean => {
  if (hold.origin !== "threshold") return true
  // A hold benched on an expired grant blocks while it stands (#1552): expiration is
  // known-full regardless of the numeric threshold (the restored-hold judgement below
  // agrees), and a same-grant re-read below the benched balance does not release the
  // hold (releasesHold), so it must not re-admit it here either. Only a fresh increase,
  // a funded replacement grant, or a reclassification ends an expired grant's hold.
  if (hold.expired === true) return true
  if (QuotaSnapshot.known(snapshot))
    return QuotaSnapshot.isKnownFull(snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)
  // An unknown snapshot (e.g. the first feed after a restart, a balance window whose
  // limit is gone so its remaining is null) carries no evidence against the hold:
  // judge by the hold's preserved judged/benched balance instead of admitting by
  // default (#1461).
  const judged = hold.judgedBalance ?? hold.benchedBalance
  if (judged === null || judged === undefined) return true
  return deadBalance(judged, currentConstants(location).quotaGate.balanceDeadThreshold)
}

type QuotaGateState = {
  snapshot: QuotaSnapshot.Snapshot
  target: Model.Ref
  gated: boolean
  /** Balance gates need a fresh increase; wall-clock reset/fallback times are not recovery signals. */
  balanceHold?: BalanceHold
  /** A reactive timed gate (an attempt-reported rate limit) retained alongside a
   * threshold balance hold (#1461): it blocks every Location until its reset, even
   * one whose threshold admits the held balance. */
  timedGateUntil?: number
  actualResetAt?: number
  resetObservedAt?: number
}
const credentialQuota = new Map<string, QuotaGateState>()

/** The durable record id for one credential's balance baseline (#1014): like the provider
 * path's `quota:<provider>` adjustment, but keyed to the credential, so a restart re-arms
 * the credential's own hold instead of losing it. Its `match` names the credential -- never
 * a provider/model ref -- so selection never skips on it; the gate itself lives in
 * credentialQuota above and this record is only its persistence. */
const credentialBaselineID = (credentialID: string) => `quota-credential:${credentialID}`

const persistCredentialBalanceHold = (credentialID: string, hold: BalanceHold, providerID: string) =>
  addAdjustment({
    id: credentialBaselineID(credentialID),
    match: `credential:${credentialID}`,
    action: "skip",
    balanceBaseline: hold.benchedBalance,
    ...(hold.judgedBalance !== undefined ? { balanceHoldBalance: hold.judgedBalance } : {}),
    ...(hold.grant !== undefined ? { balanceGrant: hold.grant } : {}),
    ...(hold.origin !== undefined ? { balanceHoldOrigin: hold.origin } : {}),
    ...(hold.expired !== undefined ? { balanceHoldExpired: hold.expired } : {}),
    credentialID,
    providerID,
    note: "credential balance exhausted; held until a fresh balance increase (durable baseline record -- not a selection skip)",
  })

const restoredCredentialHold = (credentialID: string): BalanceHold | undefined => {
  const item = adjustments.find(
    (entry) => entry.id === credentialBaselineID(credentialID) && entry.balanceBaseline !== undefined,
  )
  if (!item) return undefined
  return {
    benchedBalance: item.balanceBaseline ?? null,
    ...(item.balanceHoldBalance !== undefined ? { judgedBalance: item.balanceHoldBalance } : {}),
    ...(item.balanceGrant !== undefined ? { grant: item.balanceGrant } : {}),
    ...(item.balanceHoldOrigin !== undefined ? { origin: item.balanceHoldOrigin } : {}),
    ...(item.balanceHoldExpired !== undefined ? { expired: item.balanceHoldExpired } : {}),
  }
}

/** Feeds one credential's latest quota snapshot into the gate. */
const observeCredentialQuotaState = (
  target: Model.Ref,
  credentialID: string,
  snapshot: QuotaSnapshot.Snapshot,
  now: number,
  resetAtTrusted: boolean,
  location?: string,
) => {
  const previous = credentialQuota.get(credentialID)
  if (previous && !QuotaSnapshot.known(snapshot)) return
  // A balance hold restored from its durable baseline after a restart has no in-memory
  // state: the persisted baseline re-arms the hold, like the provider path (#1014).
  const restored = previous ? undefined : restoredCredentialHold(credentialID)
  let hold = previous?.balanceHold ?? restored
  if (hold && !releasesHold(hold, snapshot)) {
    // A reclassified grant (#1380) releases the stale hold by no longer being a balance
    // grant: fall through and let this snapshot's normal timed gate replace it (the
    // persist step below clears the durable baseline because `hold` is still set).
    if (!grantReclassified(hold, snapshot)) {
      if (!previous) {
        const refreshedHold =
          hold.origin === "threshold" && snapshot.balance === true && snapshot.remaining !== null
            ? {
                ...hold,
                judgedBalance: snapshot.remaining,
                ...(snapshot.expired === true ? { expired: true } : {}),
              }
            : hold
        credentialQuota.set(credentialID, {
          snapshot,
          target,
          gated: true,
          balanceHold: refreshedHold,
          resetObservedAt: snapshot.observedAt,
        })
        if (refreshedHold.judgedBalance !== hold.judgedBalance || refreshedHold.expired !== hold.expired)
          persistCredentialBalanceHold(credentialID, refreshedHold, target.providerID)
      }
      else if (
        snapshot.balance !== true &&
        QuotaSnapshot.isKnownFull(snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)
      ) {
        // A reactive timed gate (an attempt-reported rate limit, fed as a synthesized
        // exhaustion snapshot) is independent of the balance hold (#1461): retain it
        // alongside the hold instead of discarding it in this branch, so a Location
        // that admits the held balance is still gated until the stated reset.
        credentialQuota.set(credentialID, {
          ...previous,
          gated: true,
          ...(snapshot.resetAt !== null && snapshot.resetAt !== undefined
            ? { timedGateUntil: snapshot.resetAt }
            : {}),
        })
      }
      else if (
        hold.origin === "threshold" &&
        snapshot.balance === true &&
        snapshot.observedAt >= previous.snapshot.observedAt
      ) {
        const refreshedHold = {
          ...hold,
          judgedBalance: snapshot.remaining,
          ...(snapshot.expired === true ? { expired: true } : {}),
        }
        // Another Location feeding the same grant's balance corrects the gate too
        // (#1461): its fresher balance snapshot replaces the retained one, so later
        // judgements under any Location use the latest balance (one whose threshold
        // admits the old balance may still judge the new, lower one full), while
        // the hold itself stays armed. Releasing the hold still requires a fresh
        // increase (releasesHold above) or a reclassified grant.
        credentialQuota.set(credentialID, {
          ...previous,
          snapshot,
          target,
          gated: true,
          balanceHold: refreshedHold,
          ...(resetAtTrusted ? { resetObservedAt: snapshot.observedAt } : {}),
        })
        if (refreshedHold.expired !== hold.expired || refreshedHold.judgedBalance !== hold.judgedBalance)
          persistCredentialBalanceHold(credentialID, refreshedHold, target.providerID)
      }
      return
    }
  }
  // Out-of-order delivery must not rewind the gate: an observation older than the retained
  // one carries no new information, even when it is still fresh — a below-limit reading
  // taken before the retained known-full reading cannot re-admit the credential (#6).
  if (previous && snapshot.observedAt < previous.snapshot.observedAt) return
  const full = QuotaSnapshot.isKnownFull(snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)
  const balanceHold =
    snapshot.balance === true && full
      ? {
          benchedBalance: snapshot.remaining,
          judgedBalance: snapshot.remaining,
          grant: grantIdentity(snapshot),
          origin: "threshold" as const,
          ...(snapshot.expired !== undefined ? { expired: snapshot.expired } : {}),
        }
      : undefined
  const actualResetAt = resetAtTrusted
    ? snapshot.resetAt ?? undefined
    : previous?.actualResetAt !== undefined && previous.actualResetAt > now
      ? previous.actualResetAt
      : undefined
  const resetObservedAt = resetAtTrusted ? snapshot.observedAt : previous?.resetObservedAt
  credentialQuota.set(credentialID, {
    snapshot,
    target,
    gated: full,
    ...(balanceHold ? { balanceHold } : {}),
    ...(actualResetAt !== undefined ? { actualResetAt } : {}),
    ...(resetObservedAt !== undefined ? { resetObservedAt } : {}),
  })
  // Keep the durable baseline in step with the in-memory hold (#1014): written when a hold
  // arms, cleared when one releases, so a restart restores exactly the hold that was live.
  if (balanceHold) persistCredentialBalanceHold(credentialID, balanceHold, target.providerID)
  else if (hold) removeAdjustment(credentialBaselineID(credentialID))
  // A reset learned after a quota bench was planted arms that bench's probe (#1123). Only the
  // trusted actual reset counts: the reactive gate's synthesized fallback never reaches this
  // variable (observeQuotaFailure passes resetAtTrusted=false and keeps the previous actual).
  if (full && actualResetAt !== undefined) armBenchProbe(target, credentialID, actualResetAt, now)
  if (full && !previous?.gated)
    logHealth(
      target,
      "quota-gated",
      `credential:${credentialID} quota-known-full`,
      snapshot.resetAt ?? undefined,
      credentialID,
    )
  if (!full && previous?.gated) logHealth(target, "quota-readmitted", `credential:${credentialID}`, undefined, credentialID)
  // A fresh, known, not-full reading is a measured increase for the scope: quota-class
  // benches planted by earlier exhaustion release on it, not only at their reset (#1828).
  if (!full && QuotaSnapshot.known(snapshot) && now - snapshot.observedAt <= QuotaSnapshot.DEFAULT_MAX_AGE_MS)
    releaseQuotaBenches((id) => id.endsWith(`#${credentialID}`), now)
}

export const observeCredentialQuota = (
  target: Model.Ref,
  credentialID: string,
  snapshot: QuotaSnapshot.Snapshot,
  now = Date.now(),
  location?: string,
) => observeCredentialQuotaState(target, credentialID, snapshot, now, true, location)

/** Credentials of one provider currently held by the quota gate (a balance hold or a gated
 * known-full snapshot). The gate feed uses this to keep refreshing held credentials after
 * failover activates a sibling: without a fresh observation a held credential's balance
 * increase can never reach the release check, so the hold would never clear. */
export const heldCredentialIDs = (providerID: string): string[] => {
  const held: string[] = []
  for (const [credentialID, state] of credentialQuota) {
    if (state.target.providerID !== providerID) continue
    if (state.balanceHold !== undefined || state.gated) held.push(credentialID)
  }
  // A credential balance hold restored from its durable baseline after a restart has no
  // in-memory state yet: without discovery here the gate feed only ever observes the
  // active credential, so the restored hold could never reach its release check and the
  // exhausted credential stayed re-selectable (#1014). Records name their provider, so
  // a restored credential is only ever re-fed under its own provider's plans.
  for (const item of adjustments) {
    if (item.credentialID === undefined || item.balanceBaseline === undefined) continue
    if (item.id !== credentialBaselineID(item.credentialID)) continue
    if (item.providerID !== providerID) continue
    if (!held.includes(item.credentialID)) held.push(item.credentialID)
  }
  return held
}

const providerQuota = new Map<string, QuotaGateState>()

/** Feeds one provider's latest quota snapshot into the gate (for credential-less providers). */
export const observeProviderQuota = (
  target: Model.Ref,
  snapshot: QuotaSnapshot.Snapshot,
  now = Date.now(),
  location?: string,
) => {
  const previous = providerQuota.get(target.providerID)
  if (previous && !QuotaSnapshot.known(snapshot)) return
  // A balance skip restored from its adjustment record after a restart has no in-memory
  // state: its persisted baseline re-arms the hold, so the first above-threshold snapshot
  // cannot clear the skip when the balance never actually increased.
  const restoredItem = previous
    ? undefined
    : adjustments.find(
        (item) => item.id === `quota:${target.providerID}` && item.balanceBaseline !== undefined,
      )
  const hold: BalanceHold | undefined =
    previous?.balanceHold ??
    (restoredItem
      ? {
          benchedBalance: restoredItem.balanceBaseline ?? null,
          ...(restoredItem.balanceHoldBalance !== undefined
            ? { judgedBalance: restoredItem.balanceHoldBalance }
            : {}),
          ...(restoredItem.balanceGrant !== undefined ? { grant: restoredItem.balanceGrant } : {}),
          ...(restoredItem.balanceHoldOrigin !== undefined ? { origin: restoredItem.balanceHoldOrigin } : {}),
          ...(restoredItem.balanceHoldExpired !== undefined ? { expired: restoredItem.balanceHoldExpired } : {}),
        }
      : undefined)
  if (hold) {
    if (!releasesHold(hold, snapshot) && !grantReclassified(hold, snapshot)) {
      if (!previous) {
        const refreshedHold =
          hold.origin === "threshold" && snapshot.balance === true && snapshot.remaining !== null
            ? {
                ...hold,
                judgedBalance: snapshot.remaining,
                ...(snapshot.expired === true ? { expired: true } : {}),
              }
            : hold
        providerQuota.set(target.providerID, {
          snapshot,
          target,
          gated: true,
          balanceHold: refreshedHold,
          resetObservedAt: snapshot.observedAt,
        })
        if (refreshedHold.judgedBalance !== hold.judgedBalance || refreshedHold.expired !== hold.expired)
          addAdjustment({
            id: `quota:${target.providerID}`,
            match: `${target.providerID}/`,
            action: "skip",
            balanceBaseline: refreshedHold.benchedBalance,
            ...(refreshedHold.judgedBalance !== undefined
              ? { balanceHoldBalance: refreshedHold.judgedBalance }
              : {}),
            ...(refreshedHold.grant !== undefined ? { balanceGrant: refreshedHold.grant } : {}),
            ...(refreshedHold.origin !== undefined ? { balanceHoldOrigin: refreshedHold.origin } : {}),
            ...(refreshedHold.expired !== undefined ? { balanceHoldExpired: refreshedHold.expired } : {}),
            note: "quota exhausted (proactive snapshot); held until the stated reset",
          })
      }
      else if (
        hold.origin === "threshold" &&
        snapshot.balance === true &&
        snapshot.observedAt >= previous.snapshot.observedAt
      ) {
        const refreshedHold = {
          ...hold,
          judgedBalance: snapshot.remaining,
          ...(snapshot.expired === true ? { expired: true } : {}),
        }
        // Same Location correction as the credential path (#1461): keep the hold,
        // refresh the balance snapshot it will be judged from.
        providerQuota.set(target.providerID, { ...previous, snapshot, target, gated: true, balanceHold: refreshedHold })
        if (refreshedHold.expired !== hold.expired || refreshedHold.judgedBalance !== hold.judgedBalance)
          addAdjustment({
            id: `quota:${target.providerID}`,
            match: `${target.providerID}/`,
            action: "skip",
            balanceBaseline: refreshedHold.benchedBalance,
            ...(refreshedHold.judgedBalance !== undefined
              ? { balanceHoldBalance: refreshedHold.judgedBalance }
              : {}),
            ...(refreshedHold.grant !== undefined ? { balanceGrant: refreshedHold.grant } : {}),
            ...(refreshedHold.origin !== undefined ? { balanceHoldOrigin: refreshedHold.origin } : {}),
            ...(refreshedHold.expired !== undefined ? { balanceHoldExpired: refreshedHold.expired } : {}),
            note: "quota exhausted (proactive snapshot); held until the stated reset",
          })
      }
      return
    }
    // A reclassified grant (#1380) falls through: processing below replaces the balance
    // skip with this snapshot's normal timed gate (or removes it when not full).
  }
  if (previous && snapshot.observedAt < previous.snapshot.observedAt) return
  const full = QuotaSnapshot.isKnownFull(snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)
  const balanceHold =
    snapshot.balance === true && full
      ? {
          benchedBalance: snapshot.remaining,
          judgedBalance: snapshot.remaining,
          grant: grantIdentity(snapshot),
          origin: "threshold" as const,
          ...(snapshot.expired !== undefined ? { expired: snapshot.expired } : {}),
        }
      : undefined
  providerQuota.set(target.providerID, {
    snapshot,
    target,
    gated: full,
    ...(balanceHold ? { balanceHold } : {}),
    ...(snapshot.resetAt !== null ? { actualResetAt: snapshot.resetAt } : {}),
    resetObservedAt: snapshot.observedAt,
  })
  if (full) {
    if (snapshot.resetAt !== null) armBenchProbe(target, undefined, snapshot.resetAt, now)
    const gate = currentConstants(location).quotaGate
    const until =
      snapshot.balance === true ? undefined : Math.min(snapshot.resetAt ?? now + gate.fallbackMs, now + gate.maxMs)
    addAdjustment({
      id: `quota:${target.providerID}`,
      match: `${target.providerID}/`,
      action: "skip",
      ...(until !== undefined ? { until } : {}),
      ...(snapshot.balance === true
        ? {
            balanceBaseline: snapshot.remaining,
            balanceHoldBalance: snapshot.remaining,
            balanceGrant: grantIdentity(snapshot),
            balanceHoldOrigin: "threshold" as const,
            ...(snapshot.expired !== undefined ? { balanceHoldExpired: snapshot.expired } : {}),
          }
        : {}),
      quotaSkipOrigin: "proactive",
      note: "quota exhausted (proactive snapshot); held until the stated reset",
    })
    if (!previous?.gated)
      logHealth(target, "quota-gated", `provider:${target.providerID} quota-known-full`, snapshot.resetAt ?? undefined)
  }
  if (!full) {
    removeAdjustment(`quota:${target.providerID}`)
    // The same fresher not-full reading re-judges this provider's attempt-reported
    // reactive skips (#1974): the snapshot is the provider's measured word, and the
    // documented rule is that a fresher below-limit snapshot replaces the reactive
    // gate — for the model-scoped record shape (#1976) as for the provider one.
    releaseQuotaSkipsForSnapshot(target, snapshot, now, location)
    if (previous?.gated) logHealth(target, "quota-readmitted", `provider:${target.providerID}`)
    // Same measured-increase release as the credential path (#1828): this provider's
    // target-level quota benches end on a fresh known not-full reading.
    if (QuotaSnapshot.known(snapshot) && now - snapshot.observedAt <= QuotaSnapshot.DEFAULT_MAX_AGE_MS)
      releaseQuotaBenches((id) => id.startsWith(`${target.providerID}/`) && !id.includes("#"), now)
  }
}

/** Reconciles retained gate state with the plans that still feed the gate (#1340): an
 * ended plan derives no replacement snapshot, so without this step a known-full snapshot
 * it produced would gate its credential/provider indefinitely on the feed paths that
 * produce no new snapshot (every plan ended, or no gating snapshot derived). Only
 * plan-derived state attributable to a plan outside `livePlanIDs` is cleared: reactive
 * `attempt:` snapshots are attempt evidence, not plan capacity, and a durable balance
 * baseline is removed only when its own grant's plan has also ended — a baseline whose
 * grant is still live keeps blocking until a fresh snapshot releases it, so a genuinely
 * exhausted credential is never re-admitted just because a neighbouring plan ended. */
export const reconcileQuotaGate = (providerID: string, livePlanIDs: ReadonlySet<string>) => {
  for (const [credentialID, state] of credentialQuota) {
    if (state.target.providerID !== providerID) continue
    if (state.snapshot.planID.startsWith("attempt:")) continue
    if (livePlanIDs.has(state.snapshot.planID)) continue
    credentialQuota.delete(credentialID)
    const record = adjustments.find((item) => item.id === credentialBaselineID(credentialID))
    const grantPlan = (state.balanceHold?.grant ?? record?.balanceGrant)?.split("\n")[0]
    if (grantPlan !== undefined && !livePlanIDs.has(grantPlan)) removeAdjustment(credentialBaselineID(credentialID))
    if (state.gated) logHealth(state.target, "quota-readmitted", `credential:${credentialID}`, undefined, credentialID)
  }
  // Durable balance baselines restored after a restart may have no in-memory state at
  // all (#1380): the loops above only see live gate state, so a deleted plan's baseline
  // record would otherwise persist -- and keep blocking its credential via the restored
  // hold -- indefinitely. Clear those whose grant's plan no longer feeds the gate; a
  // baseline whose grant plan is still live is a still-applicable depleted balance plan
  // and keeps its hold.
  for (const item of [...adjustments]) {
    if (item.providerID !== providerID || item.credentialID === undefined) continue
    if (item.id !== credentialBaselineID(item.credentialID) || item.balanceBaseline === undefined) continue
    if (credentialQuota.has(item.credentialID)) continue
    const grantPlan = item.balanceGrant?.split("\n")[0]
    if (grantPlan !== undefined && !livePlanIDs.has(grantPlan)) removeAdjustment(item.id)
  }
  const state = providerQuota.get(providerID)
  if (!state) {
    // Same restored-only gap on the provider scope: a balance skip record with no
    // in-memory state whose grant's plan has ended is stale and clears here.
    const record = adjustments.find((item) => item.id === `quota:${providerID}` && item.balanceBaseline !== undefined)
    const grantPlan = record?.balanceGrant?.split("\n")[0]
    if (record && grantPlan !== undefined && !livePlanIDs.has(grantPlan)) removeAdjustment(record.id)
    return
  }
  if (state.snapshot.planID.startsWith("attempt:") || livePlanIDs.has(state.snapshot.planID)) return
  providerQuota.delete(providerID)
  const record = adjustments.find((item) => item.id === `quota:${providerID}`)
  if (record) {
    const grantPlan = record.balanceGrant?.split("\n")[0]
    // The provider skip id is shared with the reactive gate, whose records carry an
    // attempt-reported note: only the proactive plan-derived record is this gate's to clear.
    if (
      grantPlan !== undefined
        ? !livePlanIDs.has(grantPlan)
        : record.note?.startsWith("quota exhausted (proactive snapshot)")
    )
      removeAdjustment(record.id)
  }
  if (state.gated) logHealth(state.target, "quota-readmitted", `provider:${providerID}`)
}

// A feed covers only one route's providers; keep its TTL independent per provider and location.
const lastQuotaFeedAtByProvider = new Map<string, number>()
// The gathered-snapshot pass (release + plant, #1974/#8086) keeps its OWN feed stamps,
// keyed apart from the plan-derived gate's above (code#8086): the two passes run back to
// back in one resolution with the same `now`, so a stamp shared between them is always
// consumed by the gate first and the snapshot pass is never due in production.
const lastGatheredFeedAtByProvider = new Map<string, number>()

export const resetQuotaFeed = () => {
  lastQuotaFeedAtByProvider.clear()
  lastGatheredFeedAtByProvider.clear()
}

const feedDue = (stamps: Map<string, number>, now: number, location?: string, providerID?: string) => {
  const key = JSON.stringify([location ?? null, providerID ?? null])
  const lastFeedAt = stamps.get(key) ?? 0
  if (now - lastFeedAt < currentConstants(location).quotaGate.feedTtlMs) return false
  stamps.set(key, now)
  return true
}

export const shouldFeedQuota = (now = Date.now(), location?: string, providerID?: string) =>
  feedDue(lastQuotaFeedAtByProvider, now, location, providerID)

/** The gathered-snapshot pass's own due-ness (code#8086): independent of the gate's
 * stamps, so the release and plant judgements fire on fresh gathered readings even when
 * the plan-derived gate fed the same provider in the same resolution. */
export const shouldFeedGatheredQuota = (now = Date.now(), location?: string, providerID?: string) =>
  feedDue(lastGatheredFeedAtByProvider, now, location, providerID)

/** The longest a single exhaustion reading may hold a gate: a stated reset further out than
 * this is capped rather than believed. This is the single source of truth for the quota-reset
 * ceiling: ModelRouteTuning derives its prediction bound from the configured value
 * (currentConstants().quotaGate.maxMs) instead of keeping a second constant in step by hand. */
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
  /** What the attempt actually reported: "balance-exhaustion" (a QuotaExceeded tag, or an
   * insufficient-credits answer) may install an increase-only balance hold; a plain
   * "rate-limit" (HTTP 429) keeps the timed recovery below even when the pool's last
   * snapshot was balance-shaped (#1014). Callers that predate classification omit it and
   * keep the historical balance-exhaustion reading. */
  classification: "balance-exhaustion" | "rate-limit" = "balance-exhaustion",
  location?: string,
) => {
  const gate = currentConstants(location).quotaGate
  const previous = credentialID ? credentialQuota.get(credentialID) : providerQuota.get(target.providerID)
  if (classification !== "rate-limit" && previous?.snapshot.balance === true) {
    const snapshot = { ...previous.snapshot, percent: null, resetAt: null, observedAt: now, stale: false }
    const balanceHold: BalanceHold = {
      benchedBalance: previous.snapshot.remaining,
      judgedBalance: previous.snapshot.remaining,
      grant: grantIdentity(previous.snapshot),
      origin: "attempt",
      ...(previous.snapshot.expired !== undefined ? { expired: previous.snapshot.expired } : {}),
    }
    if (credentialID) {
      credentialQuota.set(credentialID, { snapshot, target, gated: true, balanceHold })
      persistCredentialBalanceHold(credentialID, balanceHold, target.providerID)
      logHealth(target, "quota-gated", `credential:${credentialID} balance-insufficient`, undefined, credentialID)
      return
    }
    providerQuota.set(target.providerID, { snapshot, target, gated: true, balanceHold })
    addAdjustment({
      id: `quota:${target.providerID}`,
      match: `${target.providerID}/`,
      action: "skip",
      balanceBaseline: previous.snapshot.remaining,
      balanceHoldBalance: previous.snapshot.remaining,
      balanceGrant: grantIdentity(previous.snapshot),
      balanceHoldOrigin: "attempt",
      quotaSkipOrigin: "attempt",
      ...(previous.snapshot.expired !== undefined ? { balanceHoldExpired: previous.snapshot.expired } : {}),
      note: "balance exhausted (attempt-reported); held until a fresh balance increase",
    })
    logHealth(target, "quota-gated", `provider:${target.providerID} balance-insufficient`)
    return
  }
  const until = Math.min(resetAt ?? now + gate.fallbackMs, now + gate.maxMs)
  if (credentialID) {
    observeCredentialQuotaState(
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
      false,
      location,
    )
    return
  }
  // #1976: a credential-less quota answer is one model family's evidence. The skip it
  // plants names the answering target alone, so sibling families on the same provider
  // (independent quota windows behind one door) keep serving. Only corroboration promotes
  // the skip to provider scope: a second distinct target of the provider answering quota
  // while the first family's hold still stands — a two-source standard.
  // Corroboration is judged from this
  // failure ledger, keyed by answering target; a family's entry counts while its own
  // stated hold is still in force.
  const sources = quotaFailureSources.get(target.providerID) ?? new Map<string, number>()
  for (const [source, sourceUntil] of sources) if (sourceUntil <= now) sources.delete(source)
  sources.set(key(target), until)
  quotaFailureSources.set(target.providerID, sources)
  if (sources.size >= QUOTA_SKIP_CORROBORATION_SOURCES) {
    addAdjustment({
      id: `quota:${target.providerID}`,
      match: `${target.providerID}/`,
      action: "skip",
      until,
      quotaSkipOrigin: "attempt",
      note: "quota exhausted (attempt-reported, corroborated across model families); held until the stated reset",
    })
    return
  }
  const id = quotaModelSkipID(target)
  addAdjustment({
    id,
    match: `${target.providerID}/${target.id}`,
    action: "skip",
    until,
    quotaSkipOrigin: "attempt",
    note: "quota exhausted (attempt-reported); held until the stated reset",
  })
}

/** The gate on one credential at `now`: `{ until }` (the snapshot's reset, null when it gave
 * none) while a known-full snapshot holds it out of routes, undefined while it is eligible.
 * Passing the reset re-admits and logs it, like a cooldown expiring. */
export const credentialQuotaBlocked = (
  credentialID: string,
  now = Date.now(),
  location?: string,
): { readonly until: number | null } | undefined => {
  const state = credentialQuota.get(credentialID)
  // No in-memory state but a durable baseline record: the hold survives the restart and
  // blocks selection (including credential fallback) until a fed snapshot releases it.
  // A threshold-derived restored hold is judged by its latest judged balance (falling
  // back to its benched balance for records written before judged balances were
  // persisted) under the judging Location's threshold (#1461): a balance that Location
  // admits does not block it, while a null balance (an expired-balance bench) gives
  // nothing to admit against.
  if (!state) {
    const restored = restoredCredentialHold(credentialID)
    if (!restored) return undefined
    const judgedBalance = restored.judgedBalance ?? restored.benchedBalance
    if (
      restored.origin === "threshold" &&
      restored.expired !== true &&
      judgedBalance !== null &&
      !deadBalance(judgedBalance, currentConstants(location).quotaGate.balanceDeadThreshold)
    )
      return undefined
    return { until: null }
  }
  // A threshold-derived hold blocks only a Location whose own threshold still judges
  // the retained snapshot known-full (#1461); attempt-reported holds block every
  // Location, as before. The gated flag is left alone on the admitting path: the
  // hold still blocks other Locations, so this is not a global re-admission.
  if (state.balanceHold) {
    if (holdBlocks(state.balanceHold, state.snapshot, now, location)) return { until: null }
    // A retained reactive timed gate blocks every Location until its reset, even
    // one whose threshold admits the held balance (#1461).
    if (state.timedGateUntil !== undefined && state.timedGateUntil > now) return { until: state.timedGateUntil }
    return undefined
  }
  if (QuotaSnapshot.isKnownFull(state.snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)) {
    state.gated = true
    return { until: state.snapshot.resetAt }
  }
  if (state.gated) {
    state.gated = false
    logHealth(state.target, "quota-readmitted", `credential:${credentialID}`, undefined, credentialID)
  }
  return undefined
}

/** Whether a target's own provider quota gate currently blocks it: the provider-scope
 * mirror of `credentialQuotaBlocked`, judged from the provider's own gate state alone.
 * There is no pool-level verdict (Drew, 2026-11-07): a pool cannot run out — only
 * models, credentials, and providers can — so a leaf is excluded by its own provider's
 * gate or not at all, never by the state of other leaves in its route group. A restored
 * provider balance record with no in-memory state yet is not judged here: its durable
 * `quota:` skip excludes through `skipped` until the first fed snapshot re-arms the
 * state, so the leaf stays out on its own provider's record either way. */
export const providerQuotaBlocked = (
  target: Model.Ref,
  now = Date.now(),
  location?: string,
): { readonly until: number | null } | undefined => {
  const state = providerQuota.get(target.providerID)
  if (!state) return undefined
  // Judged exactly as the credential scope is (#1461): a threshold-derived hold blocks
  // only a Location whose own threshold still judges the retained snapshot known-full;
  // a retained reactive timed gate blocks every Location until its reset.
  if (state.balanceHold) {
    if (holdBlocks(state.balanceHold, state.snapshot, now, location)) return { until: null }
    if (state.timedGateUntil !== undefined && state.timedGateUntil > now) return { until: state.timedGateUntil }
    return undefined
  }
  if (QuotaSnapshot.isKnownFull(state.snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold)) {
    state.gated = true
    return { until: state.snapshot.resetAt }
  }
  if (state.gated) {
    state.gated = false
    logHealth(state.target, "quota-readmitted", `provider:${target.providerID}`)
  }
  return undefined
}

/** Ends a state's bench on a success: an ordinary success only ends an expired bench
 * (recover), but a success on a claimed half-open probe ends the bench outright (#1123) — the
 * probe was admitted precisely to learn whether the leaf serves again, and it does. */
const endBench = (target: Model.Ref, state: HealthState, now: number, credentialID?: string) => {
  if (state.probeClaimedAt === undefined || state.cooldownUntil <= now) {
    recover(target, state, now, credentialID)
    return
  }
  state.cooldownUntil = 0
  state.samples = []
  state.benchReason = undefined
  state.benchQuotaResetAt = undefined
  state.probeClaimedAt = undefined
  state.probeClaimToken = undefined
  logHealth(
    target,
    "cooldown-end",
    credentialID ? `probe succeeded credential:${credentialID}` : "probe succeeded",
    undefined,
    credentialID,
  )
}

export const completed = (
  target: Model.Ref,
  policy: Policy,
  sample: { readonly firstTokenMs: number; readonly responseMs: number; readonly tokensPerSecond: number },
  now = Date.now(),
  credentialID?: string,
  location?: string,
  probeClaim?: ProbeClaim,
) => {
  // A success clears the serving credential's failure count and bench (#6); the target-level
  // accounting below is unchanged, since the target did serve the request.
  if (credentialID) {
    const credentialState = credentialEntry(target, credentialID)
    credentialState.outcomes = pushOutcome(credentialState.outcomes, true)
    credentialState.consecutiveFailures = 0
    if (!probeClaim || credentialState.probeClaimedAt === undefined || credentialState.probeClaimToken === probeClaim.token)
      endBench(target, credentialState, now, credentialID)
  }
  const state = entry(target)
  state.outcomes = pushOutcome(state.outcomes, true)
  state.consecutiveFailures = 0
  // A success on the target is the path-health signal: any infra hold on it clears.
  if (infraHolds.delete(key(target)))
    logHealth(target, "infra-cleared", "a success on the target cleared the infra hold")
  // A stale completion (an older pick's late success after a newer pick re-claimed) must not
  // end the newer claim's bench (#1486): the outstanding token no longer names this pick.
  if (!probeClaim || state.probeClaimedAt === undefined || state.probeClaimToken === probeClaim.token)
    endBench(target, state, now)
  // The pick may have claimed a different probe credential than the serving one (#1486):
  // its bench ends here too, while serving-credential accounting above is unchanged.
  if (probeClaim?.credentialID && probeClaim.credentialID !== credentialID)
    endProbeScope(target, now, probeClaim.credentialID, probeClaim)
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
    state.benchReason = "slow"
    state.benchQuotaResetAt = undefined
    state.probeClaimedAt = undefined
    state.probeClaimToken = undefined
    logHealth(target, "cooldown-start", "slow", state.cooldownUntil)
  }
}

/** Test seam; health is intentionally process-local and never persists prompts or request contents. */
export const resetHealth = () => {
  limits.clear()
  ModelRouteMembership.reset()
  usage.clear()
  adjustments = []
  health.clear()
  credentialHealth.clear()
  infraHolds.clear()
  credentialQuota.clear()
  providerQuota.clear()
  quotaEvents.clear()
  restoredDemotionAttempts.clear()
  quotaFailureSources.clear()
  continuity.clear()
  recentFailures.length = 0
  lastQuotaFeedAtByProvider.clear()
  lastGatheredFeedAtByProvider.clear()
  probeClaimSeq = 0
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
 * rotates by smooth weights over the candidates it is given — the walk passes only the active
 * tier's candidates, so that rotation is the within-tier one (#1122); weighted draws by relative
 * ratio. Only the outcome is sticky. */
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
  // A spent window's reset learned after a quota bench was planted arms that bench's probe
  // (#1123), in the same scope the snapshot was recorded in.
  const resetAt = ModelRouteLimits.exhaustedWindowResetAt(snapshot, now, QuotaSnapshot.DEFAULT_MAX_AGE_MS)
  if (resetAt !== undefined) armBenchProbe(target, credentialID, resetAt, now)
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

/** A reset usable to cap a quota bench must belong to this target and serving credential, describe an
 * actually exhausted provider window (not a nearby window), and still be a fresh future reset. Plan
 * snapshots are provider/credential scoped and already carry their own freshness and full-window checks.
 * The reactive quota gate's bounded fallback is deliberately not considered a window reset. */
const quotaResetAt = (
  target: Model.Ref,
  credentialID: string | undefined,
  now: number,
  location?: string,
): number | undefined => {
  const resets: number[] = []
  const rateLimit = rateLimitOf(target, credentialID)
  const providerReset = rateLimit
    ? ModelRouteLimits.exhaustedWindowResetAt(rateLimit, now, QuotaSnapshot.DEFAULT_MAX_AGE_MS)
    : undefined
  if (providerReset !== undefined) resets.push(providerReset)

  const planQuota = credentialID ? credentialQuota.get(credentialID) : providerQuota.get(target.providerID)
  if (
    planQuota &&
    planQuota.target.providerID === target.providerID &&
    planQuota.snapshot.balance !== true &&
    QuotaSnapshot.isKnownFull(planQuota.snapshot, now, currentConstants(location).quotaGate.balanceDeadThreshold) &&
    planQuota.snapshot.observedAt <= now &&
    planQuota.resetObservedAt !== undefined &&
    planQuota.resetObservedAt <= now &&
    now - planQuota.resetObservedAt <= QuotaSnapshot.DEFAULT_MAX_AGE_MS &&
    planQuota.actualResetAt !== undefined &&
    planQuota.actualResetAt > now
  )
    resets.push(planQuota.actualResetAt)

  return resets.length > 0 ? Math.max(...resets) : undefined
}

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
  /** Set on a balance quota skip: the balance the pool was benched at. The skip survives a
   * restart through the adjustment record, and this baseline is what lets the gate keep
   * requiring a fresh balance *increase* after one — without it the first above-threshold
   * snapshot would clear the skip even when the balance never moved. */
  readonly balanceBaseline?: number | null
  /** The grant (plan + window) `balanceBaseline` belongs to: baselines compare only within
   * one grant, so a funded replacement grant is not blocked by the dead grant's leftover. */
  readonly balanceGrant?: string
  /** How the balance hold this record persists was installed (#1461): see BalanceHold's
   * `origin`. A restored threshold-derived hold is judged under the judging Location's
   * balanceDeadThreshold; an attempt-reported one keeps its unconditional force. */
  readonly balanceHoldOrigin?: "threshold" | "attempt"
  /** Set on a quota skip record: how the skip was planted (#1974/#1976). "attempt" marks a
   * reactive skip from observeQuotaFailure — the class eligible for half-open probe
   * re-admission; "proactive" marks a snapshot-derived skip, whose re-admission path is a
   * fresher snapshot. Unset on records written before provenance was tracked. */
  readonly quotaSkipOrigin?: "attempt" | "proactive"
  /** Whether a restored threshold-derived hold was armed by an expired grant, which is
   * known-full regardless of the Location's balanceDeadThreshold. */
  readonly balanceHoldExpired?: boolean
  /** The latest balance a threshold-derived hold was judged from (#1461): persisted
   * separately from `balanceBaseline` so a fresher, lower balance survives a restart as
   * the judgment balance without lowering the increase-only release baseline. */
  readonly balanceHoldBalance?: number | null
  /** Set on a credential's durable balance-baseline record (`quota-credential:<id>`): the
   * credential the baseline belongs to. Such records persist a credential gate across
   * restarts; they are never selection skips (their `match` names the credential). */
  readonly credentialID?: string
  /** Set on a credential's durable balance-baseline record: the provider the credential
   * serves. Held-credential discovery is per provider, and a restored record whose
   * credential is no longer active can only be re-fed under its own provider (#1014). */
  readonly providerID?: string
  /** Set on learned adjustments: the least autonomy a route needs before this one applies to it. Unset
   * means an operator or agent instruction, which applies wherever a route uses rules. */
  readonly requires?: ModelRouteAutonomy.Level
  /** Tuning result computed from one Location's policy; unset is process-wide. */
  readonly location?: string
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

/** Re-applies cooldowns that were still running when the process last stopped.
 *
 * Quota-class benches are re-judged against the current quota snapshot before they
 * re-arm (#1976): a persisted bench is evidence from before the restart, and the
 * gatherer's freshest reading for that exact model/provider leg outranks it. A known
 * reading with headroom discards the bench outright; a known-full reading keeps it,
 * bounded by the reading's own reset when that is sooner; no reading for the leg, a
 * stale reading, or a percent-less reading is no judgement, so the bench restores as
 * persisted. Judgement is strictly per leg: one model family's reading never lifts or
 * holds a sibling family's bench on the same credential, no provider/pool verdict is
 * synthesized, and no attempt is spent probing. Non-quota benches (transport,
 * rate-limit, auth, slow) restore exactly as persisted, readings or not. */
export const seedCooldowns = (
  rows: ReadonlyArray<{ providerID: string; modelID: string; until: number; credentialID?: string; reason?: string }>,
  readings: readonly QuotaCurrent.ProviderReading[] = [],
  now = Date.now(),
) => {
  for (const row of rows) {
    const target = ref({ providerID: row.providerID, model: row.modelID })
    const benchClass = row.reason?.split(" credential:")[0]
    let until = row.until
    let quotaResetAt: number | undefined
    if ((benchClass === "quota" || benchClass === "quota retry-after") && readings.length > 0) {
      const reading = modelWindowReading(readings, row.providerID, row.modelID)
      if (reading) {
        const snapshot = {
          planID: "quota-current",
          window: "gathered",
          providerID: row.providerID,
          percent: reading.percent,
          remaining: null,
          resetAt: reading.resetAt,
          observedAt: reading.observedAt,
          stale: now - reading.observedAt > QuotaSnapshot.DEFAULT_MAX_AGE_MS,
        }
        if (QuotaSnapshot.known(snapshot)) {
          if (!QuotaSnapshot.isKnownFull(snapshot, now, currentConstants().quotaGate.balanceDeadThreshold)) continue
          if (reading.resetAt !== null && reading.resetAt > now) {
            quotaResetAt = reading.resetAt
            if (reading.resetAt < until) until = reading.resetAt
          }
        }
      }
    }
    // A credential-scoped cooldown restores onto that credential only (#870): the healthy
    // credentials behind the same target stay routable after a restart.
    const state = row.credentialID ? credentialEntry(target, row.credentialID) : entry(target)
    state.cooldownUntil = until
    // The bench keeps its class across the restart, so a quota reset learned afterwards can
    // still arm its half-open probe (#1123). The stored reason names the credential on
    // credential rows; the class is the part before that suffix.
    if (benchClass) state.benchReason = benchClass
    if (quotaResetAt !== undefined) state.benchQuotaResetAt = quotaResetAt
  }
}

/** Rebuilds demotion counts from the route_attempt ledger after a restart (#1151).
 * Rows are replayed oldest first through the same recording path live failures use, so
 * retention and the per-target cap match live behaviour; `demoted` then applies the
 * judging Location's own window over the cache, so rows outside that window never
 * demote. Deduplication is by the row's ledger id: a restore repeated over the same
 * ledger never counts one attempt twice, while distinct attempts that share a
 * millisecond still count individually, exactly as live recording counts them. A
 * credential's rows restore onto that credential only (#6), exactly as live recording
 * scopes them. Seeding retains the full supported restore horizon
 * (ModelRouteLog.MAX_DEMOTION_WINDOW_MS), not the window of whichever Locations
 * happen to be registered when the restore runs: a Location with a longer demotion
 * window can activate after the restore, and pruning the replay against the
 * then-current retention (four hours by default) would discard failures its policy
 * still counts, unrecoverably - the restored-id set bars a second restore. Judging
 * still applies each Location's own window over the retained cache, so the wider
 * seeding retention never demotes a target its policy would not. */
export const seedDemotion = (
  rows: ReadonlyArray<{ id: number; time: number; providerID: string; modelID: string; credentialID?: string }>,
) => {
  for (const row of rows.toSorted((left, right) => left.time - right.time)) {
    if (restoredDemotionAttempts.has(row.id)) continue
    restoredDemotionAttempts.add(row.id)
    recordQuota(
      ref({ providerID: row.providerID, model: row.modelID }),
      row.time,
      row.credentialID,
      ModelRouteLog.MAX_DEMOTION_WINDOW_MS,
    )
  }
}

ModelRouteLog.onRestoreCooldowns(seedCooldowns)
ModelRouteLog.onRestoreLimits(seedLimits)
ModelRouteLog.onRestoreUsage(seedUsage)
ModelRouteLog.onRestoreDemotion(seedDemotion)

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

/** Tuning results are computed from Location-specific policy and only apply there. */
const appliesLocation = (item: Adjustment, scope: { readonly location?: string }) =>
  item.location === undefined || item.location === scope.location

/** A target the route's learned adjustments skip. Only routes that let the tuner decide see these. */
export const skipped = (target: Model.Ref, now = Date.now(), scope: WeightScope = {}) =>
  activeAdjustments(now).some(
    (item) =>
      item.action === "skip" &&
      adjustmentOn(item, now) &&
      matches(item, target) &&
      appliesOn(item, scope) &&
      appliesLocation(item, scope) &&
      quotaSkipBlocks(item, now, scope.location),
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
  /** The Location directory whose route settings govern this judgement, when the caller
   * knows it: behavior consumers read that Location's settings, not the unscoped
   * fallback (#1423). */
  readonly location?: string
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
    // A route id names a pool, so it matches in any case.
    if (!match.routes.some((id) => path.some((entry) => entry.toLowerCase() === id.toLowerCase()))) return false
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
    else weight *= item.factor ?? currentConstants(scope.location).overrides.preferredFactor
  }
  const afterPrefer = weight
  if (scope.fixed !== true) {
    for (const item of activeAdjustments(now)) {
      if (
        item.action !== "weight" ||
        !adjustmentOn(item, now) ||
        !matches(item, target) ||
        !appliesOn(item, scope) ||
        !appliesLocation(item, scope)
      )
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
    demotion: weight * (demoted(target, now, scope.credentialID, scope.location) ? currentConstants(scope.location).demotion.factor : 1),
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
  location?: string,
) =>
  sessionID !== undefined &&
  continuityOf(routeID, sessionID)?.current === key(target) &&
  steady(target, credentialID, location) &&
  !demoted(target, now, credentialID, location)

/** The scope overrides and weights are judged against: this route (and nested ids reached on the
 * way in), whether it is `fixed`, and the route-level schedule rules. */
export const scopeOf = (definition: Definition, path: readonly string[] = [], location?: string): WeightScope => ({
  routeID: definition.id,
  routes: [definition.id, ...path.filter((id) => id !== definition.id)],
  fixed: !ModelRouteAutonomy.usesRules(definition.autonomy),
  autonomy: definition.autonomy,
  ...(definition.schedules?.length ? { schedules: definition.schedules } : {}),
  ...(location === undefined ? {} : { location }),
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
  location?: string,
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
    ...(location === undefined ? {} : { location }),
  })
  /** The average weight multiplier of a nested group's leaves, judged with the schedules that reach
   * into that group. The group's own weight stays in `weights`; a parent then scales the two.
   * `layer` picks which step of the weight computation is averaged: the final effective weight
   * (`demotion`, what ranking has always used) or the pre-demotion weight (`adjustment`, the key
   * round-robin tiers are built from, #1122). */
  const factor = (
    nodeIndex: number,
    inherited: readonly WeightRule[],
    path: readonly string[],
    layer: "adjustment" | "demotion" = "demotion",
  ) => {
    const node = definition.nodes[nodeIndex]
    const nodePath = node?.routeID && !path.includes(node.routeID) ? [...path, node.routeID] : path
    const rules = [...inherited, ...(node?.schedules ?? [])]
    const scope = scopeAt(rules, nodePath)
    const eligible = openLeaves(nodeIndex)
    return eligible.length === 0
      ? 1
      : eligible.reduce(
          (sum, index) =>
            sum +
            tracedWeightOf(definition.targets[index], 1, now, { ...scope, credentialID: credentialOf?.(index) })[
              layer
            ],
          0,
        ) / eligible.length
  }
  /** Whether every leaf that could serve under a group right now is quota-demoted. A group with a
   * single undemoted door is not demoted: its own walk reaches that door first (#1122). */
  const allDemoted = (nodeIndex: number) => {
    const eligible = openLeaves(nodeIndex)
    return (
      eligible.length > 0 && eligible.every((index) => demoted(definition.targets[index], now, credentialOf?.(index), location))
    )
  }
  const label = (child: Node["children"][number]) => {
    if (child.leaf !== undefined)
      return `${definition.targets[child.leaf]?.providerID}/${definition.targets[child.leaf]?.id}`
    if (child.node === undefined) return "unknown"
    const group = definition.nodes[child.node]
    // A provider-route group is named by its reference as written in config: the
    // provider route id plus the one model the group serves (`openai-plan/gpt-6.1-terra`).
    if (group?.providerRoute !== undefined) {
      const first = leaves(child.node)[0]
      const model = first === undefined ? undefined : definition.targets[first]?.id
      return model === undefined ? group.providerRoute : `${group.providerRoute}/${model}`
    }
    return `opencode-route/${group?.routeID ?? child.node}`
  }
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
    const excluded = node.children.flatMap((child, position) => {
      // A provider-route group with no leaves — no member offers the model it was asked
      // for — has no leaves to exclude one by one; name the group itself so a zero-ready
      // group is never silent in the parent decision.
      if (
        child.node !== undefined &&
        definition.nodes[child.node]?.providerRoute !== undefined &&
        leaves(child.node).length === 0
      )
        return [{ candidate: label(child), reason: "no-ready-members" }]
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
          ...(excluded.length > 0 ? { detail: { excluded } } : {}),
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
    /** Round-robin tiers (#1122): in a round-robin node a child's weight is its priority tier, not a
     * share. The tier key is the pre-demotion weight — demotion's 0.01 factor would smear a demoted
     * heavyweight into the middle tiers (100 x 0.01 ties the nominal 1s) — so a demoted child sorts
     * below every non-demoted tier instead, keeping its weight order among the demoted, and still
     * serves as last resort. A group is demoted only when every door under it is. Other modes never
     * read this. */
    /** Tier keys are rounded to 12 decimal places: a group's weight averages its leaves'
     * adjusted weights, so (0.1 + 0.1 + 0.1) / 3 lands on 0.10000000000000002 while an
     * equally-weighted leaf sits at exactly 0.1 — computation noise must not split one
     * tier in two (#1421). */
    const tierKey = (weight: number) => Math.round(weight * 1e12) / 1e12
    const tiers =
      node.selection === "round-robin"
        ? node.children.map((child, position) => {
            const base = node.weights[position] ?? 1
            if (child.leaf !== undefined)
              return {
                weight: tierKey(traces[position]?.adjustment ?? base),
                demoted: demoted(definition.targets[child.leaf], now, credentialOf?.(child.leaf), location),
              }
            if (child.node !== undefined)
              return {
                weight: tierKey(base * factor(child.node, rules, nodePath, "adjustment")),
                demoted: allDemoted(child.node),
              }
            return { weight: base, demoted: false }
          })
        : undefined
    /** Tier order over positions: non-demoted first, heavier tier first; the sort is stable, so a
     * tier keeps its configured order. This is `rank` for round-robin nodes, in the plain walk and
     * in the failover tail alike — a dispatch exhausts one tier before it touches the next. */
    const byTier = (from: readonly number[]) =>
      tiers === undefined
        ? [...from]
        : [...from].toSorted((left, right) => {
            const a = tiers[left]
            const b = tiers[right]
            if (a.demoted !== b.demoted) return a.demoted ? 1 : -1
            return b.weight - a.weight
          })
    /** The positions sharing the first position's tier: the only candidates a round-robin draw (or
     * a sticky choice) may pick from while any of them is available. */
    const topTier = (from: readonly number[]) => {
      if (tiers === undefined || from.length === 0) return from
      const head = tiers[byTier(from)[0]]
      return from.filter((position) => {
        const tier = tiers[position]
        return tier.demoted === head.demoted && tier.weight === head.weight
      })
    }
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
            return key(target) === current && !demoted(target, now, credentialOf?.(leaf), location)
          })
    const rank = (from: readonly number[]) =>
      [...from].toSorted((left, right) => (effective[right] ?? 1) - (effective[left] ?? 1))
    const sorted = node.selection === "round-robin" ? byTier(positions) : rank(positions)
    let ordered = sorted
    let decisionReason = sorted.some((position, index) => position !== positions[index]) ? "adjusted" : "ordered"
    if (node.selection === "ordered" && currentPosition !== undefined) {
      ordered = [currentPosition, ...positions.filter((position) => position !== currentPosition)]
      decisionReason = "sticky"
    } else if (sessionID && sessionScoped(node.selection)) {
      // Round-robin draws and sticks inside the top tier only (#1122). A sticky pick from a lower
      // tier — made while the top tier was down — is honoured only while it sits in the active tier,
      // so a recovered tier takes the session back instead of stranding it on the fallback. The
      // draw's weights are the tier keys: equal inside a tier, so the rotation there stays even.
      // Weighted draws keep the whole candidate set and the effective weights, exactly as before.
      const pool = node.selection === "round-robin" ? topTier(positions) : positions
      const chosen =
        priorSticky !== undefined && pool.includes(priorSticky)
          ? priorSticky
          : draw
            ? selectSessionTarget(
                selectionKey,
                sessionID,
                node.selection,
                pool,
                node.children.map((_, position) =>
                  node.selection === "round-robin" ? (tiers?.[position]?.weight ?? 1) : (effective[position] ?? 1),
                ),
                random,
              )
            : undefined
      if (chosen !== undefined)
        ordered = [
          chosen,
          ...(node.selection === "round-robin" ? byTier : rank)(
            positions.filter((position) => position !== chosen),
          ),
        ]
      decisionReason =
        priorSticky !== undefined && pool.includes(priorSticky) ? "sticky" : draw ? "drawn" : decisionReason
    }
    const chosen = ordered[0]
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
          // The tier each candidate sorted into, round-robin nodes only (#1122): the pre-demotion
          // weight it tiers by, and whether demotion holds it below every live tier.
          ...(tiers === undefined
            ? {}
            : {
                tiers: Object.fromEntries(
                  positions.map((position) => [
                    label(node.children[position]),
                    { weight: tiers[position].weight, demoted: tiers[position].demoted },
                  ]),
                ),
              }),
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
export const served = (routeID: string, sessionID: string, target: Model.Ref, location?: string) => {
  const id = continuityKey(routeID, sessionID)
  const current = key(target)
  const prior = continuity.get(id)
  if (prior?.origin === undefined || prior.origin === current) return remember(id, { current, away: 0 })
  remember(id, {
    current,
    origin: prior.origin,
    away: Math.min(prior.away + 1, currentConstants(location).continuity.hedgeRequests),
  })
}

/** The origin a session should hedge back to: only just after it moved, and never once it has
 * settled on the new target. */
export const hedgeHome = (routeID: string, sessionID: string, location?: string) => {
  const state = continuityOf(routeID, sessionID)
  if (state?.origin === undefined || state.away >= currentConstants(location).continuity.hedgeRequests)
    return undefined
  return state.origin
}

/** The rest of the machinery's constants — everything `Settings` above does not already
 * hold — assembled here, after the mechanisms they parameterize, from the named constant at
 * each one. The defaults ARE today's behavior; config (experimental.routes.settings)
 * or configureConstants() replaces a value only where it sets one. Deliberately absent, as
 * invariants rather than knobs: the health /
 * session / continuity LRU bounds, the recent-failure ring (200) and quota-event history
 * (50) caps, and the usage-accounting bucket widths. */
export interface Constants {
  readonly bench: {
    readonly maxCooldownMs: number
    readonly multiplier: number
    readonly failureCapMs: number
    readonly retryAfterMinMs: number
    readonly cooldownCapMs: number
    readonly quotaCooldownCapMs: number
  }
  readonly demotion: { readonly factor: number }
  readonly quotaGate: {
    readonly maxMs: number
    readonly fallbackMs: number
    readonly feedTtlMs: number
    readonly balanceDeadThreshold: number
    /** Percent of a quota window at or above which a new root session is not started
     * on the pool (#566). Subsessions are unaffected. */
    readonly rootStartMaxPct: number
  }
  readonly escalation: { readonly outcomeWindow: number }
  readonly network: { readonly windowMs: number; readonly providers: number; readonly providerModels: number }
  readonly membership: { readonly waitMs: number }
  readonly continuity: { readonly hedgeRequests: number }
  readonly overrides: { readonly preferredFactor: number }
}

export const DEFAULT_CONSTANTS: Constants = {
  bench: {
    maxCooldownMs: MAX_COOLDOWN_MS,
    // The `**` ladder in bench(): each consecutive failure multiplies the previous bench.
    multiplier: 2,
    // The ceiling on an ordinary failure's escalated bench (#2212): the grace a leg gets
    // before the route may try it again stays short, per Drew's failover spec (2026-11-08).
    failureCapMs: 120_000,
    // The floor in bench(): a stated retry-after is believed, but never as less than this.
    retryAfterMinMs: 1_000,
    // The caps policy() applies to a route health block's bench bases.
    cooldownCapMs: 3_600_000,
    quotaCooldownCapMs: 86_400_000,
  },
  demotion: { factor: DEMOTED_FACTOR },
  quotaGate: {
    maxMs: QUOTA_GATE_MAX_MS,
    fallbackMs: QUOTA_GATE_FALLBACK_MS,
    // shouldFeedQuota's default: how often quota snapshots are fed into the gate.
    feedTtlMs: 60_000,
    balanceDeadThreshold: QuotaSnapshot.DEFAULT_BALANCE_DEAD_THRESHOLD,
    rootStartMaxPct: QuotaSnapshot.DEFAULT_ROOT_START_MAX_PCT,
  },
  escalation: { outcomeWindow: OUTCOME_WINDOW },
  network: { windowMs: NETWORK_WINDOW_MS, providers: NETWORK_PROVIDERS, providerModels: PROVIDER_MODELS },
  // The bounded wait a request gives a membership-capped leg before it fails over
  // (#2253): short enough that a capped leg can never hold a session, long enough
  // that a slot freeing a moment later is worth taking. The caps themselves are
  // declared on the provider definition, not here.
  membership: { waitMs: 5_000 },
  continuity: { hedgeRequests: ORIGIN_HEDGE_REQUESTS },
  overrides: { preferredFactor: PREFERRED_FACTOR },
}

type ConstantsPatch = Partial<{
  bench: Partial<Constants["bench"]>
  demotion: Partial<Constants["demotion"]>
  quotaGate: Partial<Constants["quotaGate"]>
  escalation: Partial<Constants["escalation"]>
  network: Partial<Constants["network"]>
  membership: Partial<Constants["membership"]>
  continuity: Partial<Constants["continuity"]>
  overrides: Partial<Constants["overrides"]>
}>

let constants: Constants = DEFAULT_CONSTANTS

const mergeConstants = (base: Constants, patch: ConstantsPatch | undefined): Constants =>
  patch === undefined
    ? base
    : {
        bench: { ...base.bench, ...patch.bench },
        demotion: { ...base.demotion, ...patch.demotion },
        quotaGate: { ...base.quotaGate, ...patch.quotaGate },
        escalation: { ...base.escalation, ...patch.escalation },
        network: { ...base.network, ...patch.network },
        membership: { ...base.membership, ...patch.membership },
        continuity: { ...base.continuity, ...patch.continuity },
        overrides: { ...base.overrides, ...patch.overrides },
      }

/** Replaces machinery constants wholesale-group by group, the constants counterpart of
 * configure(). Tests use it; production values arrive through config. */
export const configureConstants = (next: ConstantsPatch) => {
  constants = mergeConstants(constants, next)
}

/** The constants in force: the compiled defaults, then configureConstants(), then config
 * (experimental.routes.settings), in that order. The config groups are picked field by
 * field where config's grouping differs from this one: demotion.after / demotion.windowMs
 * and the escalation switch live in `Settings`, not here. */
export const currentConstants = (location?: string): Constants => {
  const config = settingsReaderFor(location)?.()
  if (!config) return constants
  return mergeConstants(constants, {
    ...(config.bench ? { bench: config.bench } : {}),
    ...(config.demotion?.factor !== undefined ? { demotion: { factor: config.demotion.factor } } : {}),
    ...(config.quotaGate ? { quotaGate: config.quotaGate } : {}),
    ...(config.escalation?.outcomeWindow !== undefined
      ? { escalation: { outcomeWindow: config.escalation.outcomeWindow } }
      : {}),
    ...(config.network ? { network: config.network } : {}),
    ...(config.membership ? { membership: config.membership } : {}),
    ...(config.continuity ? { continuity: config.continuity } : {}),
    ...(config.overrides ? { overrides: config.overrides } : {}),
  })
}
