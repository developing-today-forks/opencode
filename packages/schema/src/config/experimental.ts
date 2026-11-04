export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "../schema.js"
import { ConfigPolicy } from "./policy.js"
import { ConfigModelRoutes } from "./model-routes.js"
import { ConfigAlias } from "./aliases.js"

/** The canonical nested routing config (#1140): every routing key lives under
 * `experimental.routes`. The flat `experimental.model_routes` / `provider_routes` /
 * `model_route_*` spellings stay in this schema (deprecated) so existing config files —
 * including external readers that parse the file directly, such as the route proxy in
 * developing-today/code and OpenChamber's validator — keep validating; the config
 * normalizer folds them into this nested shape and every internal consumer reads only
 * the nested shape after normalization. When both spellings name the same key, the
 * nested value wins and the conflict is diagnosed. */
export class Routes extends Schema.Class<Routes>("ConfigExperimental.Routes")({
  models: ConfigModelRoutes.Info.annotate({
    description: "Named ordered provider/model routes with failure and performance failover",
  }).pipe(optional),
  providers: ConfigModelRoutes.ProviderRoutes.annotate({
    description:
      "Provider routes: named selections over concrete providers (ordered, round-robin, or weighted). A route target names one exactly like a concrete provider — `openai-plan/gpt-6.1-terra` — and resolution picks the member that serves the model, so a provider-level order is defined once instead of once per model.",
  }).pipe(optional),
  schedules: Schema.Array(ConfigModelRoutes.GlobalSchedule)
    .annotate({
      description:
        "Time-bound weight changes across routes: during a local-time window, matching provider/model targets are ranked higher or lower (or given a fixed weight) on every route they appear on. Weights order every selection mode; equal weights keep their configured order.",
    })
    .pipe(optional),
  windows: ConfigModelRoutes.Windows.annotate({
    description:
      'Named, reusable time windows for route rules, keyed by name, e.g. "deepseek-peak": weekdays 01:00-04:00 and 06:00-10:00 UTC. Schedules reference a window by name instead of repeating it, and a route target can gate its eligibility on one: the target is a candidate only while its named window is active (or, inverted, only while it is not). Windows belong to the meter, not the model.',
  }).pipe(optional),
  tuning: ConfigModelRoutes.Tuning.annotate({
    description: "Scheduled review of routing history that adjusts model routes automatically",
  }).pipe(optional),
  log: ConfigModelRoutes.Log.annotate({
    description: "What the routing history records about failed requests",
  }).pipe(optional),
  settings: ConfigModelRoutes.Settings.annotate({
    description:
      "Global defaults for the route machinery: the bench ladder, quota demotion and gating, escalation, network-suspect detection, continuity hedging and the preference default",
  }).pipe(optional),
}) {}

/** Quota-error demotion policy (#1151, design §6 of
 * specs/2026-11-01T04-10-00Z_design_openai-facades.md): how many quota failures
 * inside a rolling window demote a route target. Both fields are optional; an
 * unset field keeps the default (threshold 3, window_ms 14400000 — the values
 * the route machinery has always used), so an unconfigured project behaves
 * exactly as before. The policy is Location-scoped: the model-routes config
 * plugin stores the parsed values per Location and the demotion read resolves
 * the policy for the serving Location. */
export class ModelRouteDemotion extends Schema.Class<ModelRouteDemotion>(
  "ConfigExperimental.ModelRouteDemotion",
)({
  threshold: PositiveInt.check(Schema.isLessThanOrEqualTo(50))
    .annotate({
      description:
        "Quota failures within the window that demote a route target. Capped at 50, the number of quota events retained per target, so a threshold can never be set beyond what is counted. Defaults to 3.",
    })
    .pipe(optional),
  window_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(7_776_000_000))
    .annotate({
      description: "How long a quota failure counts toward demotion, in milliseconds. Defaults to 14400000 (4h).",
    })
    .pipe(optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  aliases: ConfigAlias.Info.annotate({
    description: "Configured aliases for providers, models, and effort levels/variants",
  }).pipe(optional),
  portable_shell_scanner: Schema.Boolean.annotate({
    description: "Enable the experimental portable shell permission scanner. Defaults to false.",
  }).pipe(optional),
  subagent_depth: NonNegativeInt.annotate({
    description:
      "Maximum subagent nesting depth below a top-level session. 0 disables subagents and 1 stops subagents from launching their own. Defaults to 5.",
  }).pipe(optional),
  shell_timeout: NonNegativeInt.annotate({
    description:
      "Default timeout in milliseconds for foreground shell commands. 0 disables the timeout. Defaults to 120000.",
  }).pipe(optional),
  policies: Schema.Array(ConfigPolicy.Info)
    .annotate({
      description: "Deprecated: use top-level policies. Ordered policies controlling access to configured resources",
    })
    .pipe(optional),
  model_route_demotion: ModelRouteDemotion.annotate({
    description:
      "Quota-error demotion policy for model routes: how many quota failures within window_ms demote a target. Defaults to threshold 3 within 14400000ms (4h).",
  }).pipe(optional),
  routes: Routes.annotate({
    description:
      "Routing config in its canonical nested shape: model routes, provider routes, windows, schedules, tuning, log and settings. The flat model_routes / provider_routes / model_route_* keys below are deprecated spellings of these keys and normalize into them.",
  }).pipe(optional),
  model_routes: ConfigModelRoutes.Info.annotate({
    description:
      "Deprecated: use experimental.routes.models. Named ordered provider/model routes with failure and performance failover",
  }).pipe(optional),
  provider_routes: ConfigModelRoutes.ProviderRoutes.annotate({
    description:
      "Deprecated: use experimental.routes.providers. Provider routes: named selections over concrete providers (ordered, round-robin, or weighted). A route target names one exactly like a concrete provider — `openai-plan/gpt-6.1-terra` — and resolution picks the member that serves the model, so a provider-level order is defined once instead of once per model.",
  }).pipe(optional),
  model_route_schedules: Schema.Array(ConfigModelRoutes.GlobalSchedule)
    .annotate({
      description:
        "Deprecated: use experimental.routes.schedules. Time-bound weight changes across routes: during a local-time window, matching provider/model targets are ranked higher or lower (or given a fixed weight) on every route they appear on. Weights order every selection mode; equal weights keep their configured order.",
    })
    .pipe(optional),
  model_route_windows: ConfigModelRoutes.Windows.annotate({
    description:
      'Deprecated: use experimental.routes.windows. Named, reusable time windows for route rules, keyed by name, e.g. "deepseek-peak": weekdays 01:00-04:00 and 06:00-10:00 UTC. Schedules reference a window by name instead of repeating it, and a route target can gate its eligibility on one: the target is a candidate only while its named window is active (or, inverted, only while it is not). Windows belong to the meter, not the model.',
  }).pipe(optional),
  model_route_tuning: ConfigModelRoutes.Tuning.annotate({
    description:
      "Deprecated: use experimental.routes.tuning. Scheduled review of routing history that adjusts model routes automatically",
  }).pipe(optional),
  model_route_log: ConfigModelRoutes.Log.annotate({
    description: "Deprecated: use experimental.routes.log. What the routing history records about failed requests",
  }).pipe(optional),
  model_route_settings: ConfigModelRoutes.Settings.annotate({
    description:
      "Deprecated: use experimental.routes.settings. Global defaults for the route machinery: the bench ladder, quota demotion and gating, escalation, network-suspect detection, continuity hedging and the preference default",
  }).pipe(optional),
}) {}
