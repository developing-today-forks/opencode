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
          "The aggregate view over the route_attempt ledger for a time window (#2497): per provider/model attempt, token, and latency totals; hedge counts and wins; error groups with up to 300 characters of the latest error message and last-seen time; and window coverage. Credentials and raw provider error bodies are not served.",
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
