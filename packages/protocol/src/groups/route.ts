import { RouteAttempt } from "@opencode/schema/route-attempt"
import { RouteOverride } from "@opencode/schema/route-override"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

const AttemptQuery = Schema.Struct({
  since: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window start (ms epoch). Defaults to 24 hours ago.",
  }),
  until: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window end (ms epoch). Defaults to now.",
  }),
  provider: Schema.String.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  session: Schema.String.pipe(Schema.optional),
  route: Schema.String.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Maximum rows to return (default 100, capped at 1000).",
  }),
})

const StatsQuery = Schema.Struct({
  since: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window start (ms epoch). Defaults to 24 hours ago.",
  }),
  until: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window end (ms epoch). Defaults to now.",
  }),
})

const RollupQuery = Schema.Struct({
  since: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window start (ms epoch), inclusive. Defaults to 24 hours ago.",
  }),
  until: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window end (ms epoch), exclusive, so adjacent windows never count a row twice. Defaults to no end.",
  }),
  bucket: Schema.Literals(["none", "day", "hour", "hourOfDay", "dayOfWeek"]).pipe(Schema.optional).annotate({
    description: "Time bucket: none (the whole window), day, hour, hourOfDay (0-23) or dayOfWeek (0-6, Sunday 0). Defaults to none.",
  }),
  group: Schema.String.pipe(Schema.optional).annotate({
    description: "Comma-separated dimensions to group by: provider, model, variant, credential. Credential is served as an opaque key, never the id.",
  }),
  clock: Schema.Literals(["local", "utc"]).pipe(Schema.optional).annotate({
    description: "Clock the time buckets use: the server's local time zone or UTC. Defaults to utc.",
  }),
})

const DecisionQuery = Schema.Struct({
  since: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window start (ms epoch). Defaults to 24 hours ago.",
  }),
  until: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Window end (ms epoch). Defaults to now.",
  }),
  route: Schema.String.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.optional).annotate({
    description: "Maximum rows to return (default 100, capped at 1000).",
  }),
})

export const RouteGroup = HttpApiGroup.make("server.route")
  .add(
    HttpApiEndpoint.get("route.override.list", "/api/route/overrides", {
      success: Schema.Struct({ data: Schema.Array(RouteOverride.Info) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.override.list",
        summary: "List route overrides",
        description:
          "List the model route overrides currently in force, exactly as routing sees them. The overrides live in the server's own store (route-overrides.json in its data directory); this API is the server-owned surface OpenChamber's duplicate store is being consolidated onto (#2491).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("route.override.add", "/api/route/overrides", {
      payload: RouteOverride.Info,
      success: Schema.Struct({ data: Schema.Array(RouteOverride.Info) }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.override.add",
        summary: "Add a route override",
        description:
          "Store one route override, replacing any stored override with the same ID, and return the overrides now in force. The entry is validated by the same parse routing applies when it reads the store: a malformed entry (no expiry and no schedule, or no provider or model named) is rejected and nothing is stored.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("route.override.remove", "/api/route/overrides/:overrideID", {
      params: { overrideID: Schema.String },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.override.remove",
        summary: "Remove a route override",
        description: "Remove the route override with the given ID, if one is stored.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("route.attempt.list", "/api/route/attempts", {
      query: AttemptQuery,
      success: Schema.Struct({ data: Schema.Array(RouteAttempt.Attempt) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.attempt.list",
        summary: "List route attempts",
        description:
          "Recent route_attempt ledger rows in a time window, newest first, filtered by provider, model, session, or route (#2497). Read-only: this is the server-owned surface that replaces direct opencode.db reads by OpenChamber and the PM-stack aggregator. Rows never carry credentials, provider error bodies, or prompt/response content.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("route.attempt.stats", "/api/route/attempts/stats", {
      query: StatsQuery,
      success: Schema.Struct({ data: RouteAttempt.Stats }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.attempt.stats",
        summary: "Route attempt aggregates",
        description:
          "The aggregate view over the route_attempt ledger for a time window (#2497): per provider/model attempt and token totals, the error breakdown, and the window's coverage (distinct providers, models, sessions, and routes). Read-only; the same shapes the current direct database readers compute.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("route.attempt.rollup", "/api/route/attempts/rollup", {
      query: RollupQuery,
      success: Schema.Struct({ data: Schema.Array(RouteAttempt.RollupRow) }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.attempt.rollup",
        summary: "Route attempt rollup",
        description:
          "Attempt and token totals over the route_attempt ledger in time buckets (day, hour, hour of day, day of week, or the whole window), grouped by any of provider, model, variant and credential (#2795). The PM-stack aggregator reads this instead of opening opencode.db. Credentials are served only as an opaque key; the id never leaves the server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("route.decision.list", "/api/route/decisions", {
      query: DecisionQuery,
      success: Schema.Struct({ data: Schema.Array(RouteAttempt.Decision) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "route.decision.list",
        summary: "List route decisions",
        description:
          "Recent route_decision ledger rows in a time window, newest first, optionally narrowed to one route (#2497). Read-only companion to the route attempts surface.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "route",
      description: "Model routing control owned by the server (consolidated from OpenChamber, #2491).",
    }),
  )
