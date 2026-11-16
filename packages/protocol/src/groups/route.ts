import { RouteOverride } from "@opencode/schema/route-override"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

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
  .annotateMerge(
    OpenApi.annotations({
      title: "route",
      description: "Model routing control owned by the server (consolidated from OpenChamber, #2491).",
    }),
  )
