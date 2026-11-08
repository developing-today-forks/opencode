export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LanguageModel } from "@opencode/ai"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Config } from "../../config.js"
import { ModelAlias } from "../../model-alias.js"
import { ModelResolver } from "../../model-resolver.js"
import { ConfigModelRoutesPlugin } from "../../config/plugin/model-routes.js"
import { SessionSchema } from "../schema.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID, detail: Schema.optional(Schema.String) },
) {
  override get message() {
    // A bare alias target carries an empty model id; name the original input, not a trailing slash.
    if (!this.modelID) return `Model unavailable: ${this.providerID}`
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    // A configured provider-route diagnosis (#1720) names the route-specific cause.
    if (this.detail) return `Model unavailable: ${this.providerID}/${this.modelID}. ${this.detail}`
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error
export type Resolved = ModelResolver.Resolved

export interface Interface {
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
    /** The live request's context size in tokens, when known: route targets whose per-target
     * ceiling it exceeds are skipped (over-limit). Unknown (undefined) never filters. */
    requestTokens?: number,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
    readonly routing?: Resolved["routing"]
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
  ...(options.routing === undefined ? {} : { routing: options.routing }),
})

/** Why a `<provider>/<model>` request found no catalog entry, when a configured provider route
 * explains it (#1720): the generic miss otherwise reads the same for a typo, a route that
 * validation dropped, and a route none of whose members offers the model. */
export const providerRouteDetail = (
  target: { readonly providerID: string; readonly id: string },
  declared: ReadonlySet<string>,
  catalog: ReadonlyArray<Pick<Model.Info, "providerID">>,
): string | undefined => {
  if (declared.size === 0) return undefined
  const present = catalog.some((model) => model.providerID === target.providerID)
  if (declared.has(target.providerID))
    return present
      ? `Provider route "${target.providerID}" has no eligible member offering "${target.id}".`
      : `Provider route "${target.providerID}" is configured but not active: it needs at least one member provider, and its id must not match a provider or a model route (experimental.routes.providers).`
  if (present) return undefined
  return `No provider or provider route is named "${target.providerID}". Configured provider routes: ${Array.from(declared).join(", ")}.`
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const config = yield* Effect.serviceOption(Config.Service)
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available, requestTokens) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        if (!session.model) {
          const resolved = yield* resolver.resolve(undefined, requestTokens)
          if (resolved) return resolved
          return yield* new ModelNotSelectedError({ sessionID: session.id })
        }
        let target = session.model
        if (Option.isSome(config)) {
          const cfg = config.value
          const entries = yield* cfg.entries()
          const aliases = Config.latest(entries, "aliases")
          if (aliases) {
            const allModels = yield* available()
            const exists = ({ providerID, modelID }: { providerID: string; modelID: string }) =>
              allModels.some((m) => m.providerID === providerID && m.id === modelID)
            // A bare alias arrives as the provider field with an empty model id (PR #382's
            // CLI passthrough); build the reference from the alias name alone, keeping any
            // variant, instead of a trailing-slash string alias resolution rejects.
            const refStr = ModelAlias.refString(target)
            try {
              const res = ModelAlias.resolveRef(aliases, refStr, exists)
              target = Model.Ref.make({
                providerID: Provider.ID.make(res.providerID),
                id: Model.ID.make(res.id),
                ...(res.variant ? { variant: Model.VariantID.make(res.variant) } : {}),
              })
            } catch {}
          }
        }
        const catalog = yield* available()
        const selected = catalog.find((model) => model.providerID === target.providerID && model.id === target.id)
        if (!selected) {
          const declared = Option.isSome(config)
            ? ConfigModelRoutesPlugin.declaredProviderRouteIDs(yield* config.value.entries())
            : new Set<string>()
          const detail = providerRouteDetail(target, declared, catalog)
          return yield* new ModelUnavailableError({
            providerID: target.providerID,
            modelID: target.id,
            ...(detail ? { detail } : {}),
          })
        }
        return yield* resolver.resolveModel(selected, target.variant, session.id, requestTokens)
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node] })
