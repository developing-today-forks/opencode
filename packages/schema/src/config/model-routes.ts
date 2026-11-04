export * as ConfigModelRoutes from "./model-routes.js"

import { Schema } from "effect"
import { CacheFormat } from "../model-compatibility.js"
import { ConfigModel } from "./model.js"
import { optional, PositiveInt } from "../schema.js"

// Field descriptions sit inside optional(...): annotated outside it, a description never reaches the
// generated JSON schema, so editors and the OpenAPI document show nothing for the field.
const BoundedPositiveInt = PositiveInt.check(Schema.isLessThanOrEqualTo(3_600_000))
const SampleCount = PositiveInt.check(Schema.isLessThanOrEqualTo(50))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
/** A duration of at most a day: bench bases and their caps, the retry-after floor, the network window. */
const DayDurationMs = PositiveInt.check(Schema.isLessThanOrEqualTo(86_400_000))
/** A duration of at most 90 days: a quota gate can believe a provider reset up to 30 days out,
 * so the ceiling for gate-scale durations sits well past the one hour that bounds a bench base. */
const LongDurationMs = PositiveInt.check(Schema.isLessThanOrEqualTo(7_776_000_000))
/** One note per line: `match: text`, with a non-empty match before the first colon and non-empty text after it.
 * The match cannot hold a colon, so the first colon is the separator. */
export const NOTE_LINE = /^[^:\r\n]*[^\s:][^:\r\n]*:[^\r\n]*\S[^\r\n]*$/

/** A reference to a named window in experimental.routes.windows: the name alone, or
 * `{ "name": ..., "invert": true }` for eligibility only while the window is NOT active.
 * Shared by model-route targets and provider-route members so a window gate means the
 * same thing at provider, model, pair and route granularity in both route kinds (#1140). */
export const WindowRef = Schema.Union([
  Schema.String,
  Schema.Struct({
    name: Schema.String,
    invert: Schema.Boolean.pipe(optional),
  }),
])
export type WindowRef = typeof WindowRef.Type

/** An ordered model target: either `provider/model`, `provider/model#variant`, or an object with
 * per-target variant defaults and remaps. A target whose provider is `*` is a door-set target
 * (#637): it runs its model on every door (provider) whose catalog lists the model, minus the
 * doors named in the target's `exclude` list. */
const TargetObject = Schema.Struct({
  model: ConfigModel.Selection.annotate({
    description:
      "Provider/model reference. A route may reference another route. The provider may be `*` (a door-set target, #637): the model runs on every door that lists it, except the doors in `exclude`.",
  }),
  exclude: Schema.Array(Schema.String)
    .annotate({
      description:
        "Doors (provider ids) excluded from a door-set target (a target whose provider is `*`). Exclusions always win over the door set: an excluded door never contributes a leaf, even when its catalog lists the model. Providers removed by `disabled_providers` never reach expansion at all. Has no effect on a target that names a single provider.",
    })
    .pipe(optional),
  defaultVariant: Schema.String.annotate({
    description: "Variant used when the route is selected without an explicit variant.",
  }).pipe(optional),
  variants: Schema.Record(Schema.String, Schema.String).annotate({
    description:
      'Remaps a route-level variant to this target\'s variant, e.g. { "low": "high" } runs this target at high when the route is selected at low.',
  }).pipe(optional),
  until: PositiveInt.annotate({
    description:
      "Epoch milliseconds after which this target leaves the route. Used for time-limited pool membership; takes effect when the configuration reloads.",
  }).pipe(optional),
  limit: Schema.Struct({
    context: PositiveInt.annotate({
      description:
        "Caps the context this target serves within the route, below its own limit — e.g. 100000 keeps this target on requests inside a pricing tier that ends at 100k context. A request that does not fit this ceiling and the route's own cap skips this target like any other ineligible target.",
    }),
  })
    .annotate({
      description: "Per-target context ceiling within the route; a request that does not fit skips this target.",
    })
    .pipe(optional),
  cache_format: CacheFormat.pipe(optional),
  window: WindowRef.annotate({
    description:
      'Eligibility gate: the name of a window defined in experimental.routes.windows, or { "name": ..., "invert": true }. The target is only in the route while the named window is active, or while it is not active when inverted — e.g. a DeepSeek target gated on the inverse of "deepseek-peak" is a candidate off-peak only, and the same target gated on "deepseek-peak" itself is the peak fallback. An unknown window name drops the gate, leaving the target always eligible.',
  }).pipe(optional),
})
export const Target = Schema.Union([ConfigModel.Selection, TargetObject]).annotate({
  identifier: "Config.ModelRoute.Target",
})
export type Target = typeof Target.Type

/** Request and token allowances for one target. A target that reaches `softLimit` of any allowance is
 * passed over until it recovers, so traffic moves before the provider starts refusing it. */
export class Budget extends Schema.Class<Budget>("Config.ModelRoute.Budget")({
  requestsPerMinute: PositiveInt.pipe(optional),
  requestsPerDay: PositiveInt.pipe(optional),
  tokensPerMinute: PositiveInt.pipe(optional),
  tokensPerDay: PositiveInt.pipe(optional),
  softLimit: Schema.Finite.check(Schema.isBetween({ minimum: 0.125, maximum: 1 }))
    .annotate({
      description: "Fraction of an allowance at which the target is passed over. Defaults to 0.9.",
    })
    .pipe(optional),
}) {}

/** Per-target circuit-breaker and response-performance thresholds. */
export class Health extends Schema.Class<Health>("Config.ModelRoute.Health")({
  firstTokenTimeoutMs: Schema.Union([BoundedPositiveInt, Schema.Literal(false)])
    .annotate({
      description:
        "Fail over if the target produces no response output within this many milliseconds. Defaults to 10000.",
    })
    .pipe(optional),
  maxResponseTimeMs: BoundedPositiveInt.annotate({
    description:
      "Count a completed response as slow when it exceeds this many milliseconds, measured to the end of the model's response. Tools that the step runs afterwards do not count.",
  }).pipe(optional),
  minOutputTokensPerSecond: PositiveFinite.annotate({
    description:
      "Count a completed response as slow when output throughput, from the model's first output to the end of its response, falls below this rate.",
  }).pipe(optional),
  sampleWindow: SampleCount.annotate({
    description: "Number of completed requests in the rolling performance window. Defaults to 5.",
  }).pipe(optional),
  slowThreshold: SampleCount.annotate({
    description: "Slow requests in the window that mark a target degraded. Defaults to 3.",
  }).pipe(optional),
  cooldownMs: BoundedPositiveInt.annotate({
    description: "How long a failed or degraded target is skipped. Defaults to 60000.",
  }).pipe(optional),
  quotaCooldownMs: BoundedPositiveInt.annotate({
    description:
      "How long a target is skipped after the provider reports an exhausted quota without saying when it resets. A reported retry-after always wins. Defaults to 900000.",
  }).pipe(optional),
}) {}

const DayOfWeek = Schema.Union([
  Schema.Literals([
    "sun",
    "sunday",
    "mon",
    "monday",
    "tue",
    "tuesday",
    "tues",
    "wed",
    "wednesday",
    "thu",
    "thursday",
    "thur",
    "thurs",
    "fri",
    "friday",
    "sat",
    "saturday",
  ]),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
]).annotate({
  description: "A weekday as a name or 0 (Sunday) to 6 (Saturday).",
})

const DayOfMonth = Schema.Union([
  Schema.Literal(-1),
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
]).annotate({ description: "A day of the month, 1 to 31, or -1 for the last day of the month." })

const WindowName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))

/** A recurring local-time window. Days and time bounds all have to match when set, so
 * `daysOfMonth: [1..7]` with `daysOfWeek: ["mon"]` is the first Monday of the month. */
export class Window extends Schema.Class<Window>("Config.ModelRoute.Window")({
  daysOfWeek: Schema.Array(DayOfWeek)
    .annotate({
      description: "Weekdays the window is active on. Empty or unset means every day.",
    })
    .pipe(optional),
  daysOfMonth: Schema.Array(DayOfMonth)
    .annotate({
      description: "Days of the month the window is active on. Empty or unset means every day.",
    })
    .pipe(optional),
  dates: Schema.Array(Schema.String)
    .annotate({
      description:
        'Specific local calendar dates the window is active on, each "YYYY-MM-DD" or an inclusive range "YYYY-MM-DD/YYYY-MM-DD", read as calendar days in the window\'s timezone. Unset means every date. Use for one-off days a recurring day list cannot express, such as a holiday calendar defined once as a named window.',
    })
    .pipe(optional),
  excludeDates: Schema.Array(Schema.String)
    .annotate({
      description:
        'Local calendar dates the window is never active on, each "YYYY-MM-DD" or an inclusive range "YYYY-MM-DD/YYYY-MM-DD", in the window\'s timezone. Exclusions win over every other field — e.g. a weekday peak window with the provider\'s public holidays here stays off on those holidays.',
    })
    .pipe(optional),
  excludeWindows: Schema.Array(WindowName)
    .annotate({
      description:
        "Names of windows defined in experimental.routes.windows; while any named window is active, this window is not. A named window that is only a list of dates is a reusable holiday calendar shared by many windows. An unknown name or a reference cycle drops this window rather than applying it without its exclusion.",
    })
    .pipe(optional),
  start: Schema.String.annotate({
    description:
      'Local start of the daily window as "HH:mm". Unset means from the start of the day. A start later than the end runs past midnight into the following morning.',
  }).pipe(optional),
  end: Schema.String.annotate({
    description: 'Local end of the daily window as "HH:mm", exclusive. Unset means to the end of the day.',
  }).pipe(optional),
  timezone: Schema.String.annotate({
    description: 'IANA timezone such as "America/Chicago". Unset means the host\'s local timezone.',
  }).pipe(optional),
  from: PositiveInt.annotate({
    description: "Epoch milliseconds before which the window never applies.",
  }).pipe(optional),
  until: PositiveInt.annotate({
    description: "Epoch milliseconds after which the window never applies.",
  }).pipe(optional),
}) {}

/** A schedule's window: inline, or the name of a window defined once in
 * experimental.routes.windows and reused by every rule that shares the meter's clock. */
const ScheduleWindow = Schema.Union([Window, Schema.String]).annotate({
  description:
    "When the change is in force: a window object, or the name of a window from experimental.routes.windows. An unknown name drops the rule.",
})

/** A time-bound weight change inside one route. `factor` scales a target's weight; `weight` replaces
 * it. Everything is unchanged outside the window. */
export class Schedule extends Schema.Class<Schedule>("Config.ModelRoute.Schedule")({
  id: Schema.String.annotate({ description: "Name for the schedule, shown in decisions and editors." }).pipe(optional),
  targets: Schema.Array(Schema.String)
    .annotate({
      description:
        'Target references this change covers, `*` allowed, e.g. ["deepseek/*", "openai/gpt-6-*"]. Empty or unset means every target of the route.',
    })
    .pipe(optional),
  when: ScheduleWindow,
  factor: PositiveFinite.annotate({
    description:
      "Multiplies the target's configured weight while the window is active. 0.8 makes a weight of 2 become 1.6; 1.2 makes it 2.4. Exactly one of factor and weight is expected.",
  }).pipe(optional),
  weight: PositiveFinite.annotate({
    description:
      "Sets the target's weight outright while the window is active, instead of scaling it. Applied before any user preference for the target.",
  }).pipe(optional),
  note: Schema.String.annotate({ description: "Why the schedule exists, kept for review." }).pipe(optional),
}) {}

/** A scheduled weight change that applies across routes, optionally scoped to some of them. */
export class GlobalSchedule extends Schema.Class<GlobalSchedule>("Config.ModelRoute.GlobalSchedule")({
  id: Schema.String.pipe(optional),
  providers: Schema.Array(Schema.String)
    .annotate({
      description: "Provider IDs the change covers, compared case-insensitively.",
    })
    .pipe(optional),
  models: Schema.Array(Schema.String)
    .annotate({
      description: 'Model ID patterns the change covers, `*` allowed, e.g. ["*flash*"].',
    })
    .pipe(optional),
  targets: Schema.Array(Schema.String)
    .annotate({
      description: 'Full `provider/model` patterns, `*` allowed, e.g. ["deepseek/*", "openai/gpt-6-*"].',
    })
    .pipe(optional),
  routes: Schema.Array(Schema.String)
    .annotate({
      description: "Route IDs the change is limited to, including nested ones. Empty or unset means every route.",
    })
    .pipe(optional),
  when: ScheduleWindow,
  factor: PositiveFinite.annotate({
    description: "Multiplies the target's configured weight while the window is active.",
  }).pipe(optional),
  weight: PositiveFinite.annotate({
    description: "Sets the target's weight outright while the window is active, instead of scaling it.",
  }).pipe(optional),
  note: Schema.String.pipe(optional),
}) {}

export class Route extends Schema.Class<Route>("Config.ModelRoute.Route")({
  name: Schema.String.pipe(optional),
  system: Schema.String.annotate({
    description:
      "System prompt this route carries, prepended to the caller's own system text on every request the route serves (persona routes, #1413: the design-code door's injected design prompt, carried by the route instead of a proxy). A route nested inside another route does not stack its prompt: only the addressed route's prompt applies.",
  }).pipe(optional),
  targets: Schema.Array(Target).annotate({
    description: "Ordered provider/model references. A route may include another route reference.",
  }),
  cache_format: CacheFormat.pipe(optional),
  health: Health.pipe(optional),
  budgets: Schema.Record(Schema.String, Budget)
    .annotate({
      description:
        'Allowances keyed by target model reference, e.g. { "openai/gpt-6-luna": { "requestsPerDay": 500, "tokensPerMinute": 200000 } }. Usage is counted from every request OpenCode makes to the target and is restored from history after a restart.',
    })
    .pipe(optional),
  hedgeAfterMs: BoundedPositiveInt.annotate({
    description:
      "Send the same request to the next target when the current one has produced no output after this many milliseconds. The first to answer wins and the other is cancelled; nothing is shown or run before a winner is known. Costs a duplicate request whenever the first target is slow. Off by default.",
  }).pipe(optional),
  attempts: SampleCount.annotate({
    description:
      "Total requests to make against one target before failing over to the next, so 2 allows one retry. Defaults to 2. Retries only happen before any response output, so no tool call ever runs twice.",
  }).pipe(optional),
  autonomy: Schema.Literals(["fixed", "rules", "adaptive", "predictive", "agent"]).annotate({
    description:
      "How much the route may decide for itself; each level includes the ones before it. fixed: configured order with failover only. rules: adds selection modes, weights, budgets and provider rate-limit holds. adaptive: adds the scheduled review that skips or down-weights targets from recent history. predictive: adds time-of-day and error-text prediction. agent: adds route_stats and route_adjust so the model can inspect and steer routing. Unset keeps the behavior from before levels existed.",
  }).pipe(optional),
  selection: Schema.Literals(["ordered", "round-robin", "weighted"]).annotate({
    description:
      "How a session picks its target: ordered uses the configured order (default), round-robin rotates per new session, weighted draws by weights. Either way the choice is sticky for the session and failover falls through the remaining targets in order.",
  }).pipe(optional),
  weights: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThan(0)))
    .annotate({
      description:
        'Relative ratios for the weighted selection mode, keyed by target model reference, e.g. { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 } sends about 3/4 of new sessions to the first target. Targets without a weight count as 1. A nested route is keyed as "opencode-route/<id>" and is chosen as one unit by this route; it then picks among its own members using its own selection and weights.',
    }).pipe(optional),
  schedules: Schema.Array(Schedule).annotate({
    description:
      "Time-bound weight changes for this route's targets, e.g. peak hours that make a provider lighter. Weights order every selection mode: inside an active window the targets are ranked by effective weight, and equal weights keep their configured order.",
  }).pipe(optional),
  limit: Schema.Struct({
    context: PositiveInt.annotate({
      description:
        "Caps the context limit the route presents, below every target's own limit — e.g. 100000 keeps sessions on this route inside a pricing tier that ends at 100k context, or compacts them earlier than the targets would. The effective limit is the smaller of this cap and the targets' minimum, so a cap can never raise a route above what its targets support.",
    }),
  })
    .annotate({
      description: "Limits the route presents as its own, regardless of its targets' limits.",
    })
    .pipe(optional),
}) {}

/** Periodic, automatic use of the routing history. Off by default. */
export class Tuning extends Schema.Class<Tuning>("Config.ModelRoute.Tuning")({
  enabled: Schema.Boolean.annotate({
    description:
      "Review routing history on a schedule and put the resulting adjustments in force without asking, for every route that uses rules as well as those at adaptive or higher. They only lower a target's share or skip it, and lapse on their own. Defaults to false.",
  }).pipe(optional),
  intervalMinutes: PositiveInt.check(Schema.isLessThanOrEqualTo(1440))
    .annotate({
      description: "Minutes between reviews. Defaults to 15.",
    })
    .pipe(optional),
  windowHours: PositiveInt.check(Schema.isLessThanOrEqualTo(336))
    .annotate({
      description: "How much history each review looks at. Defaults to 24.",
    })
    .pipe(optional),
  notes: Schema.Array(Schema.String)
    .annotate({
      description:
        "What the history cannot say, one note per line as `match: text`, where `match` is a case-insensitive substring of provider/model. A text that states when a limit returns, such as `reset at 2026-01-01` or `back in 3 hours`, skips the matching targets until then. The rest is shown to the agent by route_stats.",
    })
    .pipe(optional),
}) {}

/** How routing history records failed requests. */
export class Log extends Schema.Class<Log>("Config.ModelRoute.Log")({
  captureErrorBodies: Schema.Boolean.annotate({
    description:
      "Keep the first 2 KB of a failed request's error body in the routing history, with credentials redacted. A provider body can echo the request, so this is off by default. Defaults to false.",
  }).pipe(optional),
}) {}

/** The bench ladder: how a failure benches a target (or one of its credentials), and how far
 * the bench can run. A stated retry-after is believed as-is within these bounds; every other
 * failure class doubles its bench per consecutive failure, and the count resets only on a
 * success. */
export class Bench extends Schema.Class<Bench>("Config.ModelRoute.Settings.Bench")({
  maxCooldownMs: LongDurationMs.annotate({
    description: "The longest bench any failure can impose, however far the ladder escalates. Defaults to 86400000 (24h).",
  }).pipe(optional),
  multiplier: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description:
        "Each consecutive failure multiplies the bench by this. 1 keeps every bench at its base. Defaults to 2.",
    })
    .pipe(optional),
  retryAfterMinMs: DayDurationMs.annotate({
    description: "A provider's stated retry-after is believed, but never as less than this. Defaults to 1000.",
  }).pipe(optional),
  cooldownCapMs: DayDurationMs.annotate({
    description: "Caps a route health block's failure cooldown (cooldownMs). Defaults to 3600000 (1h).",
  }).pipe(optional),
  quotaCooldownCapMs: LongDurationMs.annotate({
    description: "Caps a route health block's quota cooldown (quotaCooldownMs). Defaults to 86400000 (24h).",
  }).pipe(optional),
}) {}

/** Quota-error demotion: a target that keeps answering "out of quota" drops to the end of
 * every order instead of being retried first on each new session. */
export class Demotion extends Schema.Class<Demotion>("Config.ModelRoute.Settings.Demotion")({
  after: PositiveInt.check(Schema.isLessThanOrEqualTo(50))
    .annotate({
      description:
        "Quota errors within the window that demote a target. Capped at 50, the number of quota events retained per target, so a threshold can never be set beyond what is counted. Defaults to 3.",
    })
    .pipe(optional),
  windowMs: LongDurationMs.annotate({
    description: "How long a quota error counts toward demotion. Defaults to 14400000 (4h).",
  }).pipe(optional),
  factor: Schema.Finite.check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(1))
    .annotate({
      description: "A demoted target's weight is multiplied by this. Defaults to 0.01.",
    })
    .pipe(optional),
}) {}

/** The quota gate: how long an exhaustion reading (a quota snapshot, or one attempt's
 * exhaustion answer) holds a target, credential or provider out of routes. */
export class QuotaGate extends Schema.Class<QuotaGate>("Config.ModelRoute.Settings.QuotaGate")({
  maxMs: LongDurationMs.annotate({
    description:
      "The longest a single exhaustion reading may hold a gate: a stated reset further out than this is capped rather than believed. Defaults to 2592000000 (30 days).",
  }).pipe(optional),
  fallbackMs: LongDurationMs.annotate({
    description:
      "The hold when an exhaustion reading states no usable reset: long enough to stop a 429 on every turn, short enough that a recovered pool is retried promptly. Defaults to 1800000 (30 minutes).",
  }).pipe(optional),
  feedTtlMs: LongDurationMs.annotate({
    description: "How often quota snapshots are fed into the gate. Defaults to 60000.",
  }).pipe(optional),
  balanceDeadThreshold: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
    .annotate({
      description: "A credit balance at or below this USD amount is treated as exhausted. Defaults to 0.1.",
    })
    .pipe(optional),
}) {}

/** Escalation: when a route races its next target because the current one keeps giving up. */
class EscalationClass extends Schema.Class<EscalationClass>("Config.ModelRoute.Settings.Escalation")({
  enabled: Schema.Boolean.annotate({
    description: "Whether routes race their next target once the current one keeps giving up. Defaults to true.",
  }).pipe(optional),
  afterGiveUps: SampleCount.annotate({
    description:
      "Give-ups among a target's recent outcomes that mark it unsteady and start escalation. Cannot exceed the outcome window, because the count reads only the retained outcomes in that window. Defaults to 2.",
  }).pipe(optional),
  outcomeWindow: SampleCount.annotate({
    description: "Recent finished requests per target that the give-up count reads. Defaults to 5.",
  }).pipe(optional),
}) {}

/** Escalation as it decodes: the cross-field invariant the fields cannot state alone (#1163).
 * The give-up count reads only the `outcomeWindow` most recent outcomes, so an effective
 * `afterGiveUps` above the effective window could never be reached and escalation would be
 * silently inert. Reject that combination at decode, applying the field defaults (2 and 5)
 * when either side is omitted, so one-sided overrides are checked too. Equality is valid:
 * every outcome in the window giving up reaches the threshold exactly. */
export const Escalation = EscalationClass.check(
  Schema.makeFilter((escalation: EscalationClass) =>
    (escalation.afterGiveUps ?? 2) <= (escalation.outcomeWindow ?? 5)
      ? undefined
      : "escalation afterGiveUps must not exceed outcomeWindow",
  ),
)
export type Escalation = EscalationClass

/** Telling a provider-wide fault from a local network fault. When several models of one
 * provider are cooling, the provider itself is demoted to last resort; when several unrelated
 * providers fail at once, the fault is more likely the user's network, so none is punished. */
export class Network extends Schema.Class<Network>("Config.ModelRoute.Settings.Network")({
  windowMs: DayDurationMs.annotate({
    description: "The window recent transport failures are compared within. Defaults to 30000.",
  }).pipe(optional),
  providers: PositiveInt.check(Schema.isGreaterThan(1))
    .annotate({
      description:
        "Unrelated providers failing within the window that mark the fault as the local network. At least 2: a single provider failing is that provider's fault. Defaults to 3.",
    })
    .pipe(optional),
  providerModels: PositiveInt.annotate({
    description: "Models of one provider cooling at once that demote the provider itself to last resort. Defaults to 2.",
  }).pipe(optional),
}) {}

/** Continuity: a session that just failed over may hedge back to the target it came from. */
export class Continuity extends Schema.Class<Continuity>("Config.ModelRoute.Settings.Continuity")({
  hedgeRequests: PositiveInt.annotate({
    description: "Requests a session that just failed over may hedge back to its origin for. Defaults to 2.",
  }).pipe(optional),
}) {}

/** Defaults for the user's own route preferences. */
export class Overrides extends Schema.Class<Overrides>("Config.ModelRoute.Settings.Overrides")({
  preferredFactor: PositiveFinite.annotate({
    description: "How much a user's \"prefer\" lifts a target when they don't say by how much. Defaults to 3.",
  }).pipe(optional),
}) {}

/** Global defaults for the route machinery itself — the bench ladder, quota demotion and
 * gating, escalation, network-suspect detection, continuity hedging and the preference
 * default. Every value defaults to what the machinery does when nothing is configured; set
 * only what should differ. A route's own health block still overrides the bench bases for
 * that route, bounded by the bench caps here. */
export class Settings extends Schema.Class<Settings>("Config.ModelRoute.Settings")({
  bench: Bench.annotate({ description: "The bench ladder for failed or degraded targets." }).pipe(optional),
  demotion: Demotion.annotate({ description: "Quota-error demotion." }).pipe(optional),
  quotaGate: QuotaGate.annotate({ description: "How long quota exhaustion readings hold targets out." }).pipe(
    optional,
  ),
  escalation: Escalation.annotate({ description: "Racing the next target after give-ups." }).pipe(optional),
  network: Network.annotate({ description: "Telling a provider-wide fault from a local network fault." }).pipe(
    optional,
  ),
  continuity: Continuity.annotate({ description: "Hedging back to a failover origin." }).pipe(optional),
  overrides: Overrides.annotate({ description: "Defaults for the user's route preferences." }).pipe(optional),
}) {}

const RouteID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))

export const Info = Schema.Record(RouteID, Route).annotate({ identifier: "Config.ModelRoutes" })
export type Info = typeof Info.Type

/** A provider route: a selection over concrete providers, with the same selection modes as a
 * model route - ordered, round-robin (weights are priority tiers), weighted - except at provider
 * level. A route target names a provider route exactly like a concrete one
 * (`openai-plan/gpt-6.1-terra`), and resolution picks the member that serves the model, so an
 * account order is defined once instead of once per model. */
export class ProviderRoute extends Schema.Class<ProviderRoute>("Config.ModelRoute.ProviderRoute")({
  providers: Schema.Array(Schema.String).annotate({
    description:
      "Member provider ids, in configured order. Members must be concrete providers: a provider route cannot name another provider route (no nesting), and the routes provider is not a member. A member that names no known provider contributes no leaves.",
  }),
  selection: Schema.Literals(["ordered", "round-robin", "weighted"])
    .annotate({
      description:
        "How the serving member is picked for a model: ordered uses the first ready member, round-robin rotates per session (a weight is a priority tier there), weighted draws by weights. The choice is sticky per session and failover falls through the remaining members in order - the model-route selection modes, at provider level. Defaults to ordered.",
    })
    .pipe(optional),
  weights: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThan(0)))
    .annotate({
      description:
        'Relative weights keyed by member provider id, e.g. { "openai.alternate": 2, "openai": 1 }. Members without a weight count as 1. In a round-robin provider route a weight is a priority tier; in a weighted one it is a relative ratio; in an ordered one weights rank the failover order.',
    })
    .pipe(optional),
  windows: Schema.Record(Schema.String, WindowRef)
    .annotate({
      description:
        'Per-member eligibility gates keyed by member provider id: the name of a window defined in experimental.routes.windows, or { "name": ..., "invert": true }. A member is a candidate only while its named window is active (or, inverted, only while it is not) — the provider-granularity counterpart of a model-route target\'s `window` gate, so a provider can be benched by the clock wherever it participates: as a model-route leaf or as a provider-route member (#1140). An unknown window name drops the gate, leaving the member always eligible.',
    })
    .pipe(optional),
  schedules: Schema.Array(Schedule)
    .annotate({
      description:
        "Time-bound weight changes for this provider route's members, in the same shape as a model route's schedules: `targets` are `provider/model` patterns (`*` allowed), so a rule can name a provider (`openai/*`), a model (`*/gpt-6-*`), a provider/model pair, or every member (empty targets). The rules apply to the concrete leaves the provider route expands to, exactly as a model route's schedules apply to its targets.",
    })
    .pipe(optional),
}) {}

/** Named, reusable time windows, defined once and referenced by schedules and target gates.
 * Windows belong to the meter, not the model: `deepseek-peak` is defined here a single time and
 * every rule that follows DeepSeek's clock names it. */
export const Windows = Schema.Record(WindowName, Window).annotate({ identifier: "Config.ModelRoute.Windows" })
export type Windows = typeof Windows.Type

/** The provider routes defined in experimental.routes.providers, keyed by id. An id that
 * names a concrete provider, the routes provider, or a configured route is rejected at load:
 * concrete providers always win a `<id>/<model>` reference. */
export const ProviderRoutes = Schema.Record(RouteID, ProviderRoute).annotate({
  identifier: "Config.ModelRoute.ProviderRoutes",
})
export type ProviderRoutes = typeof ProviderRoutes.Type
