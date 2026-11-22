export * as SessionRouteTarget from "./route-target.js"

import { Context, Effect, LayerMap, Option } from "effect"
import type { Instance } from "../instance.js"
import { Location } from "../location.js"
import { Model } from "../model.js"
import { ModelRoute } from "../model-route.js"

export type Lookup =
  | { readonly checked: false }
  | { readonly checked: true; readonly definition?: ModelRoute.Definition }

/**
 * The pool a pin names (#2671), judged against the location's current models. Read only from an
 * already-initialized location, like governance: a pin is never a reason to initialize one. An
 * uninitialized location, or one without a Model service, is `checked: false` and the pin is
 * stored unvalidated — selection ignores a pin that names no member, so that is safe.
 */
export const lookup = (
  locations: LayerMap.LayerMap<Location.Ref, Instance.Services, Instance.Error>,
  location: Location.Ref,
  routeID: string,
): Effect.Effect<Lookup> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* locations.contextEffectOption(location)
      if (Option.isNone(context)) return { checked: false } as const
      const models = Context.getOption(context.value, Model.Service)
      if (models._tag === "None") return { checked: false } as const
      const all = yield* models.value.all()
      const definition = all.flatMap((model) => {
        const found = ModelRoute.definition(model)
        return found?.id === routeID ? [found] : []
      })[0]
      return { checked: true, definition } as const
    }),
  ).pipe(Effect.orElseSucceed(() => ({ checked: false }) as const))
