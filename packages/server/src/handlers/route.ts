import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"

export const RouteHandler = HttpApiBuilder.group(Api, "server.route", (handlers) =>
  handlers
    .handle(
      "route.override.list",
      Effect.fn(function* () {
        return { data: ModelRouteOverrides.current() }
      }),
    )
    .handle(
      "route.override.add",
      Effect.fn(function* (ctx) {
        // Core's parse is the canonical validator — the same one routing applies when it
        // reads the store. An entry it drops (no expiry and no schedule, no provider or
        // model named, a malformed scope list) is rejected here instead of being stored
        // where routing would silently ignore or widen it.
        const parsed = ModelRouteOverrides.parse({ overrides: [ctx.payload] })
        const item = parsed.find((entry) => entry.id === ctx.payload.id)
        if (!item)
          return yield* new InvalidRequestError({
            message: `Route override is malformed and was not stored: ${ctx.payload.id}`,
          })
        ModelRouteOverrides.add(item)
        return { data: ModelRouteOverrides.current() }
      }),
    )
    .handle(
      "route.override.remove",
      Effect.fn(function* (ctx) {
        ModelRouteOverrides.remove(ctx.params.overrideID)
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
