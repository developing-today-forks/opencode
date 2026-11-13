import { Provider } from "@opencode/core/provider"
import { ProviderNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

// Provider.Info deliberately carries no model inventory; the HTTP shape
// (Provider.InfoWithModels) embeds each definition's resolved models so API
// consumers can discover models per provider (#560).
const withModels = (definition: Provider.Definition) => ({
  ...definition.provider,
  models: Array.from(definition.models.values()),
})

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const providers = yield* Provider.Service
          const snapshot = yield* providers.snapshot()
          return yield* response(Effect.succeed(snapshot.available.map(withModels)))
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const providers = yield* Provider.Service
          // get serves exactly the set list serves (#661): snapshot().available
          // excludes disabled providers and records whose models belong to a
          // previous account's connection, so neither can leak its catalog
          // through get while being absent from list. Like list, this read
          // returns the current snapshot without waiting on plugin settlement.
          const snapshot = yield* providers.snapshot()
          const definition = snapshot.available.find((item) => item.provider.id === ctx.params.providerID)
          if (!definition)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(withModels(definition)))
        }),
      )
  }),
)
