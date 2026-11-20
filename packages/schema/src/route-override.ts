export * as RouteOverride from "./route-override.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

/** `avoid` takes a target out of rotation, `prefer` favours it, `allow-over-budget` lets it run past
 * its soft budget. Mirrors `ModelRouteOverrides.Action` in core, which owns the stored file. */
export const Action = Schema.Literals(["avoid", "prefer", "allow-over-budget"]).annotate({
  identifier: "RouteOverride.Action",
})
export type Action = typeof Action.Type

/** A recurring time window attached to an override, in the canonical shape core's
 * `ModelRouteSchedule` stores. The resolved `excludedWindows` objects are server-internal
 * and are not carried on the wire. */
export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  daysOfWeek: optional(Schema.Array(Schema.Number)),
  daysOfMonth: optional(Schema.Array(Schema.Number)),
  start: optional(Schema.String),
  end: optional(Schema.String),
  timezone: optional(Schema.String),
  dates: optional(Schema.Array(Schema.String)),
  excludeDates: optional(Schema.Array(Schema.String)),
  excludeWindows: optional(Schema.Array(Schema.String)),
  from: optional(Schema.Number),
  until: optional(Schema.Number),
}).annotate({ identifier: "RouteOverride.Window" })

/** One stored route override, exactly as core's `ModelRouteOverrides` keeps it in
 * `route-overrides.json`. An entry must carry `until` or a `schedule` and name at least one
 * provider or model pattern; the server validates with core's parse before storing, so a
 * malformed entry is rejected instead of being silently widened or ignored by routing. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: Schema.String,
  action: Action,
  providers: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
  routes: Schema.Array(Schema.String),
  fixed: Schema.Boolean,
  factor: optional(Schema.Number),
  weight: optional(Schema.Number),
  schedule: optional(Window),
  until: optional(Schema.Number),
  text: Schema.String,
  source: Schema.Literals(["user", "interpreter"]),
  createdAt: Schema.Number,
}).annotate({ identifier: "RouteOverride.Info" })
