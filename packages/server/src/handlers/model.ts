import { Model } from "@opencode/core/model"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* (ctx) {
          const models = yield* Model.Service
          // The client catalog is a validity catalog, not the picker list (#230):
          // hidden models stay in it so existing sessions and explicit selections
          // keep validating; clients filter hidden records out of their pickers
          // and reveal them only on an exact full-name search. Disabled models
          // stay excluded, as before, and the catalog keeps the picker list's
          // preferred-free ordering so default selection is unchanged.
          const types = ctx.query.types
          // Other model types have no hidden/picker split, so they come from `available`.
          if (types === undefined || types.length === 0 || types.every((type) => type === "chat"))
            return yield* response(models.catalog())
          return yield* response(
            Effect.forEach([...new Set(types)], (type) =>
              type === "chat" ? models.catalog() : models.available([type]),
            ).pipe(Effect.map((lists) => lists.flat())),
          )
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const models = yield* Model.Service
          return yield* response(models.default())
        }),
      )
  }),
)
