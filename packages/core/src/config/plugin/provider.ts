export * as ConfigProviderPlugin from "./provider.js"

import type { ModelEditor } from "@opencode/plugin/effect/model"
import type { ProviderEditor } from "@opencode/plugin/effect/provider"
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
import { settingsConflicts } from "../../plugin/provider/configured.js"
import { ConfigIntegration } from "../integration.js"
import { ConfigEntryObserver } from "./entry-observer.js"

type Definition = {
  readonly providerID: string
  /** Whether any document's merged config sets the provider's baseURL (#501). */
  readonly baseURL: boolean
  readonly models: ReadonlyMap<string, { readonly inherit: boolean; readonly base?: Model.Info }>
}

export const Plugin = define({
  id: "opencode.config.provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload())),
      ["providers", "model"],
    )
    // Loud startup warning for package-seating conflicts (#1858): the first document
    // declaring a provider's package seats it; a later document naming a different
    // package for the same provider has its settings for that provider ignored in
    // the transforms below (and in foldSettings), so it cannot hijack the provider.
    for (const conflict of settingsConflicts(loaded.entries))
      yield* Effect.logWarning(
        "config declares a conflicting package for a provider; the conflicting document's settings for that provider are ignored",
        {
          providerID: conflict.providerID,
          seatedPackage: conflict.seatedPackage,
          conflictingPackage: conflict.conflictingPackage,
        },
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
      models: new Map<ConfigProvider.Info, Definition>(),
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
        items.filter(([, item, conflict]) => !conflict && item.settings?.baseURL !== undefined).map(([id]) => id),
      )
      for (const [id, item, conflict] of items) {
        const providerID = id
        // The model-routes plugin owns the route provider and returns early when a record
        // already exists, so creating one here would suppress every pool. Its per-model
        // settings are still recorded below and applied by the model transform, after
        // the routes plugin has built the pools.
        const routeProvider = providerID === ModelRoute.PROVIDER_ID
        const { current, source, changed } = routeProvider
          ? { current: providers.get(providerID), source: undefined, changed: false }
          : overlayProvider(providers, providerID, item, undefined, {
              conflict,
              // An instance is available once its own account is connected, unless config supplies the key.
              activate: !conflict && (!instances.has(Provider.ID.make(providerID)) || item.settings?.apiKey !== undefined),
            })
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
        // A configured provider baseURL replaces every catalog per-model endpoint, not only those of configured
        // models (#434). Configured per-model settings are applied later and still win.
        if (!conflict && !routeProvider && item.settings?.baseURL !== undefined)
          for (const [id, model] of providers.get(providerID)?.models ?? [])
            if (model.settings?.baseURL !== undefined)
              providers.models.update(providerID, id, (model) => {
                delete model.settings?.baseURL
              })
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
          applyModelConfig(models, item, definition, providerID, id, config)
        }
      }
    })
  }),
})

/** Applies one configured provider model's overrides (name, limits, variants, cost,
 * disabled/hidden, overlays) onto a model in the editor, inheriting the recorded base
 * model when the definition says to. The provider plugin's model transform applies
 * this to every configured model; the model-routes plugin applies it to a route it
 * creates after that transform has run (#1001), so a newly created route receives
 * exactly the overrides an already-built route receives. */
export function applyModelConfig(
  models: ModelEditor,
  item: ConfigProvider.Info,
  definition: Definition,
  providerID: string,
  id: string,
  config: NonNullable<ConfigProvider.Info["models"]>[string],
) {
  const source = definition.models.get(id)
  const existing = models.get(providerID, id)
  const hadVariants = (existing?.variants.length ?? 0) > 0
  const inherit = source?.inherit || !existing
  overlay(
    models,
    models.provider.get(providerID)?.provider.package,
    item,
    providerID,
    id,
    config,
    inherit && source?.base ? { base: source.base, baseURL: definition.baseURL } : undefined,
  )
  // Inherited variants are spelled for the base model's package, so a package override needs fresh ones.
  // A base without variants has no reasoning support to respell.
  const repackaged =
    source?.base !== undefined &&
    source.base.variants.length > 0 &&
    models.get(providerID, id)?.package !== source.base.package
  if (
    config.variants === undefined &&
    config.capabilities?.reasoning === undefined &&
    // Custom models start without variants, so non-empty variants here came from an earlier transform.
    ((!source?.base && !hadVariants) || repackaged)
  )
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

// Integration documents are left out: their providers authenticate with the integration's connection, so they add no
// integration or method, and the integration's own plugin applies them earlier in the provider chain (`integrate`).
// Package seating (#1858): the first document declaring a provider's package seats it; a later document declaring a
// different package for the same provider is flagged conflicted so its package/settings are not applied.
function configuredProviders(entries: readonly Entry[]) {
  const seated = new Map<string, string>()
  const result: Array<[string, ConfigProvider.Info, boolean]> = []
  for (const entry of entries) {
    if (entry.type !== "document" || entry instanceof ConfigIntegration.Document) continue
    for (const [id, info] of Object.entries(entry.info.providers ?? {})) {
      let conflict = false
      if (info.package !== undefined) {
        const current = seated.get(id)
        if (current === undefined) seated.set(id, info.package)
        else if (current !== info.package) conflict = true
      }
      result.push([id, info, conflict])
    }
  }
  return result
}

/**
 * Applies an integration document's providers. The integration's plugin calls this at its own position in the
 * provider chain, so provider plugins registered after it treat these providers as configured ones rather than
 * as their canonical provider, while user and project config still overlay them in this plugin's late transform.
 */
export function integrate(providers: ProviderEditor, document: ConfigIntegration.Document) {
  for (const [providerID, item] of Object.entries(document.info.providers ?? {})) {
    const { source } = overlayProvider(providers, providerID, item, document.integrationID)
    // An integration lists the models it routes: each starts again from the catalog and takes the provider's
    // package and URL. Its models are complete here, so later model transforms and config apply on top.
    for (const [id, config] of Object.entries(item.models ?? {})) {
      overlay(providers.models, providers.get(providerID)?.provider.package, item, providerID, id, config, {
        base: source?.models.get(config.modelID ?? id) ?? source?.models.get(id),
        baseURL: item.settings?.baseURL !== undefined,
      })
    }
    const configured = providers.get(providerID)
    // Bound to the connection so its providers disappear as soon as the account changes or signs out.
    if (configured)
      providers.add({
        info: configured.provider,
        models: Array.from(configured.models.values()),
        sourceConnection: document.connection,
      })
  }
}

/**
 * Applies one configured provider, first copying its source when `canonical` points it at another provider. A
 * document that lost the package seat (`conflict`) contributes nothing to the seated provider, identity included: its
 * canonical neither remaps the provider nor selects the clone source (#2202).
 */
function overlayProvider(
  providers: ProviderEditor,
  providerID: string,
  item: ConfigProvider.Info,
  integrationID?: ConfigIntegration.Document["integrationID"],
  options: { readonly conflict?: boolean; readonly activate?: boolean } = {},
) {
  const conflict = options.conflict ?? false
  const current = providers.get(providerID)
  const canonical = conflict ? undefined : item.canonical
  const source = providers.get(canonical ?? current?.provider.canonical ?? providerID)
  const changed = canonical !== undefined && canonical !== current?.provider.canonical
  providers.update(providerID, (provider) => {
    if (conflict) return
    if (changed && source && source.provider !== provider)
      Object.assign(provider, structuredClone(source.provider), {
        id: provider.id,
        integrationID: provider.integrationID,
      })
    if (integrationID) provider.integrationID = integrationID
    if (options.activate ?? true) provider.activation = "enabled"
    if (canonical !== undefined) provider.canonical = canonical
    if (item.name) provider.name = item.name
    if (item.package !== undefined) provider.package = item.package
    if (item.compatibility !== undefined) provider.compatibility = { ...provider.compatibility, ...item.compatibility }
    if (item.settings !== undefined) provider.settings = Provider.mergeOverlay(provider.settings, item.settings)
    if (item.headers !== undefined) provider.headers = Provider.mergeHeaders(provider.headers, item.headers)
    if (item.body !== undefined) provider.body = Provider.mergeOverlay(provider.body, item.body)
  })
  return { current, source, changed }
}

/** Applies one configured model, first resetting it to `inherit.base` when it starts again from the catalog. */
function overlay(
  models: Pick<ModelEditor, "update">,
  providerPackage: string | undefined,
  item: ConfigProvider.Info,
  providerID: string,
  id: string,
  config: NonNullable<ConfigProvider.Info["models"]>[string],
  inherit: { readonly base: Model.Info | undefined; readonly baseURL: boolean } | undefined,
) {
  models.update(providerID, id, (model) => {
    if (inherit) {
      if (inherit.base) Object.assign(model, structuredClone(inherit.base))
      if (item.package !== undefined) model.package = undefined
      if (inherit.baseURL && model.settings) delete model.settings.baseURL
    }
    if (config.type !== undefined) model.type = config.type
    if (config.family !== undefined) model.family = config.family
    if (config.name) model.name = config.name
    if (config.modelID !== undefined) model.modelID = config.modelID
    if (config.releaseDate !== undefined) {
      // Calendar-invalid dates (Feb 30) are ignored rather than rolled into another day (#482).
      const released = Model.parseReleaseDate(config.releaseDate)
      if (released !== undefined) model.time = { released }
    }
    if (config.compatibility !== undefined) model.compatibility = { ...model.compatibility, ...config.compatibility }
    if (config.package !== undefined) model.package = config.package
    if (config.settings !== undefined) model.settings = Provider.mergeOverlay(model.settings, config.settings)
    if (config.headers !== undefined) model.headers = Provider.mergeHeaders(model.headers, config.headers)
    if (config.body !== undefined) model.body = Provider.mergeOverlay(model.body, config.body)
    if (config.capabilities !== undefined)
      model.capabilities = Model.mergeCapabilities(config.capabilities, model.capabilities)
    if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
  })
  // Variants are spelled for the final package, which the update above normalizes from `aisdk:*`.
  models.update(providerID, id, (model) => {
    // Configured reasoning replaces the base variants; configured variants still overlay them below.
    if (config.capabilities?.reasoning !== undefined)
      model.variants = [
        ...Variant.resolve(
          { ...model, package: model.package ?? providerPackage },
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
        if (variant.headers !== undefined) existing.headers = Provider.mergeHeaders(existing.headers, variant.headers)
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
    if (config.hidden !== undefined) model.hidden = config.hidden
    if (config.defaultVariant !== undefined) model.defaultVariant = config.defaultVariant
    if (config.lockVariant !== undefined) model.lockVariant = config.lockVariant
  })
}
