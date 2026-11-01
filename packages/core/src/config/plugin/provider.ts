export * as ConfigProviderPlugin from "./provider.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { Money } from "@opencode/schema/money"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { ModelRoute } from "../../model-route.js"
import { Provider } from "../../provider.js"
import { Variant } from "../../variant.js"
import { configuredInstances } from "../../plugin/provider/instance.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ["providers", "model"],
      ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload())),
    )
    yield* ctx.integration.transform((integrations) => {
      const instances = configuredInstances(loaded.entries)
      for (const [id, provider] of configuredProviders(loaded.entries)) {
        // The route provider is built by the model-routes plugin, not backed by a credential.
        if (id === ModelRoute.PROVIDER_ID) continue
        const integrationID = id
        // Provider plugins have registered their sign-in methods by now, so an instance offers all of them.
        const base = instances.get(Provider.ID.make(id))
        if (base) integrations.copy(base, integrationID)
        if (!integrations.get(integrationID) || (base && integrations.method.list(integrationID).length === 0)) {
          integrations.method.update({
            integrationID,
            method: { type: "key", label: "Manually enter API Key" },
          })
        }
        integrations.update(integrationID, (integration) => {
          integration.name = provider.name || integration.name
        })
        if (provider.env !== undefined) {
          integrations.method.update({
            integrationID,
            method: { type: "env", names: [...provider.env] },
          })
        }
      }
    })

    const sources = {
      defaultModel: undefined as Document["info"]["model"],
      models: new Map<
        ConfigProvider.Info,
        {
          readonly providerID: string
          readonly baseURL: boolean
          readonly models: ReadonlyMap<string, { readonly inherit: boolean; readonly base?: Model.Info }>
        }
      >(),
    }
    yield* ctx.provider.transform((providers) => {
      const next: typeof sources.models = new Map()
      const instances = configuredInstances(loaded.entries)
      const items = configuredProviders(loaded.entries)
      // Whether a provider sets a baseURL is a property of its merged config across all
      // documents, not of the one document that spelled it: an alias defined in an earlier
      // document binds a clone of the catalog model — pinned baseURL included — before a
      // later document's baseURL is seen, so a per-document gate lets that clone resurrect
      // the pin the later document was meant to replace (#501).
      const baseURLProviders = new Set(
        items.filter(([, item]) => item.settings?.baseURL !== undefined).map(([id]) => id),
      )
      for (const [id, item] of items) {
        const providerID = id
        const current = providers.get(providerID)
        const source = providers.get(item.canonical ?? current?.provider.canonical ?? providerID)
        const changed = item.canonical !== undefined && item.canonical !== current?.provider.canonical
        // The model-routes plugin owns the route provider and returns early when a record
        // already exists, so creating one here would suppress every pool. Its per-model
        // settings are still recorded below and applied by the model transform, after
        // the routes plugin has built the pools.
        const routeProvider = providerID === ModelRoute.PROVIDER_ID
        if (!routeProvider)
          providers.update(providerID, (provider) => {
            if (changed && source && source.provider !== provider)
              Object.assign(provider, structuredClone(source.provider), {
                id: provider.id,
                integrationID: provider.integrationID,
              })
            // An instance is available once its own account is connected, unless config supplies the key.
            if (!instances.has(Provider.ID.make(providerID)) || item.settings?.apiKey !== undefined)
              provider.activation = "enabled"
            if (item.canonical !== undefined) provider.canonical = item.canonical
            if (item.name) provider.name = item.name
            if (item.package !== undefined) provider.package = item.package
            if (item.compatibility !== undefined)
              provider.compatibility = { ...provider.compatibility, ...item.compatibility }
            if (item.settings !== undefined) provider.settings = Provider.mergeOverlay(provider.settings, item.settings)
            if (item.headers !== undefined) provider.headers = Provider.mergeHeaders(provider.headers, item.headers)
            if (item.body !== undefined) provider.body = Provider.mergeOverlay(provider.body, item.body)
          })
        // A provider-level baseURL replaces the catalog URL of every model of the provider, not only
        // the models config names (the per-model deletion in the loop below): catalog models such as
        // opencode-go's pin their own per-model `api`, which becomes a model-level baseURL that wins
        // over the provider setting in the runtime merge, so a provider-only override never took
        // effect for them (#434).
        if (!routeProvider && item.settings?.baseURL !== undefined) {
          const catalog = providers.get(providerID)
          if (catalog)
            for (const modelID of catalog.models.keys())
              providers.models.update(providerID, modelID, (model) => {
                if (model.settings) delete model.settings.baseURL
              })
        }
        const definitions = new Map<string, { readonly inherit: boolean; readonly base?: Model.Info }>()
        for (const [id, config] of Object.entries(item.models ?? {})) {
          // Route pools are not defined yet at this stage and have no source model to
          // inherit from; the model transform applies their settings onto the built pool.
          if (routeProvider) {
            definitions.set(id, { inherit: false })
            continue
          }
          const base = source?.models.get(config.modelID ?? id) ?? source?.models.get(id)
          const inherit = changed || !current?.models.has(id)
          // Bind the source at this point in the provider fold. Later source edits/removal
          // and its credential availability must not change an already-defined alias.
          definitions.set(id, { inherit, base: base && structuredClone(base) })
          if (!inherit) continue
          providers.models.update(providerID, id, (model) => {
            if (base) Object.assign(model, structuredClone(base))
            if (item.package !== undefined) model.package = undefined
            if (baseURLProviders.has(providerID) && model.settings) delete model.settings.baseURL
          })
        }
        next.set(item, { providerID, baseURL: baseURLProviders.has(providerID), models: definitions })
      }
      for (const [item, definition] of next) {
        // Route-provider limits are applied by the model transform like its other settings.
        if (definition.providerID === ModelRoute.PROVIDER_ID) continue
        for (const [id, config] of Object.entries(item.models ?? {})) {
          if (config.limit === undefined) continue
          providers.models.update(definition.providerID, id, (model) => {
            model.limit = { ...model.limit, ...config.limit }
          })
        }
      }
      sources.defaultModel = Config.latest(loaded.entries, "model")
      sources.models = next
    })

    // Keep explicit model overrides in their late registration position, after external
    // model transforms. They can recreate or re-enable a model within an available provider.
    yield* ctx.model.transform((models) => {
      const configuredDefault = sources.defaultModel
      if (configuredDefault !== undefined) models.default.set(configuredDefault.providerID, configuredDefault.model)
      for (const [item, definition] of sources.models) {
        const providerID = definition.providerID
        for (const [id, config] of Object.entries(item.models ?? {})) {
          // A route setting names a pool the routes plugin built; never let it create
          // a stand-in model for a pool that does not exist.
          if (providerID === ModelRoute.PROVIDER_ID && !models.get(providerID, id)) continue
          const source = definition.models.get(id)
          const inherit = source?.inherit || !models.get(providerID, id)
          models.update(providerID, id, (model) => {
            if (inherit && source?.base) {
              Object.assign(model, structuredClone(source.base))
              if (item.package !== undefined) model.package = undefined
              if (definition.baseURL && model.settings) delete model.settings.baseURL
            }
            if (config.family !== undefined) model.family = config.family
            if (config.name) model.name = config.name
            if (config.modelID !== undefined) model.modelID = config.modelID
            if (config.releaseDate !== undefined) {
              const released = Model.parseReleaseDate(config.releaseDate)
              if (released !== undefined) model.time = { released }
            }
            if (config.compatibility !== undefined)
              model.compatibility = { ...model.compatibility, ...config.compatibility }
            if (config.package !== undefined) model.package = config.package
            if (config.settings !== undefined) model.settings = Provider.mergeOverlay(model.settings, config.settings)
            if (config.headers !== undefined) model.headers = Provider.mergeHeaders(model.headers, config.headers)
            if (config.body !== undefined) model.body = Provider.mergeOverlay(model.body, config.body)
            if (config.capabilities !== undefined)
              model.capabilities = Model.mergeCapabilities(config.capabilities, model.capabilities)
            if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
            // Configured reasoning replaces the base variants; configured variants still overlay them below.
            if (config.capabilities?.reasoning !== undefined)
              model.variants = [
                ...Variant.resolve(
                  { ...model, package: model.package ?? models.provider.get(providerID)?.provider.package },
                  Variant.supports(config.capabilities.reasoning),
                ),
              ]
            if (config.variants !== undefined) {
              model.variants ??= []
              for (const variant of config.variants) {
                let existing = model.variants.find((item) => item.id === variant.id)
                if (!existing) {
                  existing = { id: variant.id }
                  model.variants.push(existing)
                }
                if (variant.settings !== undefined)
                  existing.settings = Provider.mergeOverlay(existing.settings, variant.settings)
                if (variant.headers !== undefined)
                  existing.headers = Provider.mergeHeaders(existing.headers, variant.headers)
                if (variant.body !== undefined) existing.body = Provider.mergeOverlay(existing.body, variant.body)
              }
            }
            if (config.cost !== undefined) {
              model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                tier: cost.tier && { ...cost.tier },
                input: cost.input,
                output: cost.output,
                cache: {
                  read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
                  write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
                },
              }))
            }
            if (config.disabled !== undefined) model.enabled = !config.disabled
          })
          // Inherited variants are spelled for the base model's package, so a package override needs fresh ones.
          // A base without variants has no reasoning support to respell.
          const repackaged =
            source?.base !== undefined &&
            source.base.variants.length > 0 &&
            models.get(providerID, id)?.package !== source.base.package
          if (config.variants === undefined && config.capabilities?.reasoning === undefined && (!source?.base || repackaged))
            models.update(providerID, id, (model) => {
              const pkg = model.package ?? models.provider.get(providerID)?.provider.package
              // Without a package there is no protocol to respell for — Variant.resolve
              // would return [] and destroy variants the model already carries, such as
              // a route pool's routeVariants (pools deliberately have no package; their
              // provider record carries the empty-string package of Provider.Info.empty).
              if (!pkg) return
              model.variants = [...Variant.resolve({ ...model, package: pkg })]
            })
        }
      }
    })
  }),
})

function configuredProviders(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((file) => Object.entries(file.info.providers ?? {}))
}
