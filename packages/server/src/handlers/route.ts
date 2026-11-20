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
        // Routing cannot resolve excludeWindows names yet (no window map is passed when an
        // override is evaluated), so such an override would never apply. Refuse it instead.
        if (item.schedule?.excludeWindows?.length)
          return yield* new InvalidRequestError({
            message: `Route override names excludeWindows, which cannot be resolved yet, and was not stored: ${ctx.payload.id}`,
          })
        // One clock read for both the expiry check and the write: the store's save() drops
        // entries that are already expired, so a later read could silently drop the entry
        // after a 200 answer.
        const now = Date.now()
        if (item.until !== undefined && item.until <= now)
          return yield* new InvalidRequestError({
            message: `Route override is already expired and was not stored: ${ctx.payload.id}`,
          })
        ModelRouteOverrides.add(item, now)
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
