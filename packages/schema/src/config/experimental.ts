export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"
import { ConfigPolicy } from "./policy.js"
import { ConfigModelRoutes } from "./model-routes.js"
import { ConfigAlias } from "./aliases.js"

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
  policies: ConfigPolicy.Info.pipe(Schema.Array, optional).annotate({
    description: "Deprecated: use top-level policies. Ordered policies controlling access to configured resources",
  }),
  model_routes: ConfigModelRoutes.Info.annotate({
    description: "Named ordered provider/model routes with failure and performance failover",
  }).pipe(optional),
  synthetic_providers: ConfigModelRoutes.SyntheticProviders.annotate({
    description:
      "Virtual providers defined as a selection over concrete providers (ordered, round-robin, or weighted). A route target names one exactly like a concrete provider — `openai-plan/gpt-6.1-terra` — and resolution picks the member that serves the model, so a provider-level order is defined once instead of once per model.",
  }).pipe(optional),
  model_route_schedules: Schema.Array(ConfigModelRoutes.GlobalSchedule)
    .annotate({
      description:
        "Time-bound weight changes across routes: during a local-time window, matching provider/model targets are ranked higher or lower (or given a fixed weight) on every route they appear on. Weights order every selection mode; equal weights keep their configured order.",
    })
    .pipe(optional),
  model_route_windows: ConfigModelRoutes.Windows.annotate({
    description:
      'Named, reusable time windows for route rules, keyed by name, e.g. "deepseek-peak": weekdays 01:00-04:00 and 06:00-10:00 UTC. Schedules reference a window by name instead of repeating it, and a route target can gate its eligibility on one: the target is a candidate only while its named window is active (or, inverted, only while it is not). Windows belong to the meter, not the model.',
  }).pipe(optional),
  model_route_tuning: ConfigModelRoutes.Tuning.annotate({
    description: "Scheduled review of routing history that adjusts model routes automatically",
  }).pipe(optional),
  model_route_log: ConfigModelRoutes.Log.annotate({
    description: "What the routing history records about failed requests",
  }).pipe(optional),
}) {}
