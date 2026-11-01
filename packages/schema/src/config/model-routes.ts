export * as ConfigModelRoutes from "./model-routes.js"

import { Schema } from "effect"
import { ConfigModel } from "./model.js"
import { optional, PositiveInt } from "../schema.js"

// Field descriptions sit inside optional(...): annotated outside it, a description never reaches the
// generated JSON schema, so editors and the OpenAPI document show nothing for the field.
const BoundedPositiveInt = PositiveInt.check(Schema.isLessThanOrEqualTo(3_600_000))
const SampleCount = PositiveInt.check(Schema.isLessThanOrEqualTo(50))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
/** One note per line: `match: text`, with a non-empty match before the first colon and non-empty text after it.
 * The match cannot hold a colon, so the first colon is the separator. */
export const NOTE_LINE = /^[^:\r\n]*[^\s:][^:\r\n]*:[^\r\n]*\S[^\r\n]*$/

/** An ordered model target: either `provider/model`, `provider/model#variant`, or an object with
 * per-target variant defaults and remaps. */
const TargetObject = Schema.Struct({
  model: ConfigModel.Selection.annotate({
    description: "Provider/model reference. A route may reference another route.",
  }),
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
  when: Window,
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
  when: Window,
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
  targets: Schema.Array(Target).annotate({
    description: "Ordered provider/model references. A route may include another route reference.",
  }),
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
  autonomy: Schema.Literals(["fixed", "rules", "adaptive", "predictive", "agent"])
    .annotate({
      description:
        "How much the route may decide for itself; each level includes the ones before it. fixed: configured order with failover only. rules: adds selection modes, weights, budgets and provider rate-limit holds. adaptive: adds the scheduled review that skips or down-weights targets from recent history. predictive: adds time-of-day and error-text prediction. agent: adds route_stats and route_adjust so the model can inspect and steer routing. Unset keeps the behavior from before levels existed.",
    })
    .pipe(optional),
  selection: Schema.Literals(["ordered", "round-robin", "weighted"])
    .annotate({
      description:
        "How a session picks its target: ordered uses the configured order (default), round-robin rotates per new session, weighted draws by weights. Either way the choice is sticky for the session and failover falls through the remaining targets in order.",
    })
    .pipe(optional),
  weights: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThan(0)))
    .annotate({
      description:
        'Relative ratios for the weighted selection mode, keyed by target model reference, e.g. { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 } sends about 3/4 of new sessions to the first target. Targets without a weight count as 1. A nested route is keyed as "opencode-route/<id>" and is chosen as one unit by this route; it then picks among its own members using its own selection and weights.',
    })
    .pipe(optional),
  schedules: Schema.Array(Schedule)
    .annotate({
      description:
        "Time-bound weight changes for this route's targets, e.g. peak hours that make a provider lighter. Weights order every selection mode: inside an active window the targets are ranked by effective weight, and equal weights keep their configured order.",
    })
    .pipe(optional),
  limit: Schema.Struct({
    context: PositiveInt.annotate({
      description:
        "Caps the context limit the route presents, below every target's own limit — e.g. 100000 keeps sessions on this route inside a pricing tier that ends at 100k context, or compacts them earlier than the targets would. The effective limit is the smaller of this cap and the targets' minimum, so a cap can never raise a route above what its targets support.",
    }),
  })
    .pipe(optional)
    .annotate({
      description: "Limits the route presents as its own, regardless of its targets' limits.",
    }),
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

const RouteID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))

export const Info = Schema.Record(RouteID, Route).annotate({ identifier: "Config.ModelRoutes" })
export type Info = typeof Info.Type
