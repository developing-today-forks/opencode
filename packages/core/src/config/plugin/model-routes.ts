export * as ConfigModelRoutesPlugin from "./model-routes.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import type { ConfigExperimental } from "@opencode/schema/config/experimental"
import { CacheFormat } from "@opencode/schema/model-compatibility"
import { Effect, Result } from "effect"
import { Config } from "../../config.js"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { applyModelConfig } from "./provider.js"
import { Model } from "../../model.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteMatch } from "../../model-route-match.js"
import { ModelRouteMembership } from "../../model-route-membership.js"
import { ModelRouteExpansion } from "../../model-route-expansion.js"
import { ModelRouteSchedule } from "../../model-route-schedule.js"
import { Provider } from "../../provider.js"
import { ConfigEntryObserver } from "./entry-observer.js"
import { Permission } from "../../permission.js"
import { ModelRouteTuning } from "../../model-route-tuning.js"
import { ModelRouteAutonomy } from "../../model-route-autonomy.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { RouteAdjustTool } from "../../tool/plugin/route-adjust.js"
import { RouteStatsTool } from "../../tool/plugin/route-stats.js"
import { RouteUsageTool } from "../../tool/plugin/route-usage.js"

type SourceModel = {
  readonly ref: Model.Ref
  readonly model: Model.Info
  readonly fixedVariant: boolean
  /** Variant used when the route is selected without an explicit one. */
  readonly defaultVariant?: Model.VariantID
  readonly budget?: ModelRoute.Budget
  /** Route-level variant -> this target's variant, or `false` when the target sits that level out. */
  readonly variantMap?: Readonly<Record<string, Model.VariantID | false>>
  /** Prompt-cache format in force for this leaf: its own declaration, else the route's. */
  readonly cacheFormat?: CacheFormat
  /** Effective per-target context ceiling from config: the smallest `limit.context` on the path that
   * reached this leaf, including a nested-route reference's own limit. Undefined when no target on the
   * path declares one; the model's own limit applies on top of what is stored here. */
  readonly contextLimit?: number
}

/** What the pools a pool is nested in hand down to its members. */
type Enclosing = {
  /** The exclusions of every pool on the way in. */
  readonly excludes: readonly ModelRouteMatch.Predicate[]
  /** The variantRules of the pools on the way in above any pin, outermost first. They apply to the levels the
   * expanded pool is selected at, so a member keeps what they say. */
  readonly rules: readonly ModelRouteMatch.Rule[]
  /** Each pin on the way in, outermost first. */
  readonly pins: readonly Pin[]
}

/** A nested pool entered as `opencode-route/<id>#<level>`, with the pools nested in it that have no pin of their
 * own. They run only at that level, so their remaps and rules decide only whether a member sits it out, and such
 * a member is left out. */
type Pin = {
  readonly level: Model.VariantID
  /** The variantRules of the pools at this pin, outermost first. */
  readonly rules: readonly ModelRouteMatch.Rule[]
  /** The members left out here, as a later target names one (`provider/model`, with that target's own
   * `#variant`) and as a model. Nothing later at this pin brings one back, as a member placed here would stop
   * it; a pool above the pin may still take the model on its own terms. */
  readonly leftOut: { readonly targets: Set<string>; readonly models: Set<string> }
}

const POOL_PREFIX = `${ModelRoute.PROVIDER_ID}/`

export const Plugin = define({
  id: "opencode.config.model-routes",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ["experimental"],
      ctx.provider.reload().pipe(Effect.andThen(ctx.tool.reload())),
    )

    ModelRouteLog.onCaptureErrorBodies(() => configuredLog(loaded.entries)?.captureErrorBodies === true)

    // The route machinery's constants, from experimental.routes.settings. Registered
    // under this Location's directory (#1423) so another Location's activation cannot
    // replace them, and removed again when this Location's graph closes.
    const offSettingsConfig = ModelRoute.onSettingsConfig(
      () => settingsConfig(configuredSettings(loaded.entries)),
      ctx.location.directory,
    )
    yield* Effect.addFinalizer(() => Effect.sync(offSettingsConfig))

    // Membership caps (#2253), declared on each provider's own definition
    // (settings.membership). Registered under this Location's directory like the
    // settings above, and removed again when this Location's graph closes.
    const offMembershipLimits = ModelRoute.onMembershipLimits(
      (providerID) => configuredMembershipLimits(loaded.entries, providerID),
      ctx.location.directory,
    )
    yield* Effect.addFinalizer(() => Effect.sync(offMembershipLimits))

    // Quota demotion policy (#1151), from experimental.model_route_demotion. Registered
    // under this Location's directory so another Location's activation cannot replace it,
    // and removed again when this Location's graph closes.
    const offDemotionConfig = ModelRoute.onDemotionConfig(
      () => demotionConfig(configuredDemotion(loaded.entries)),
      ctx.location.directory,
    )
    yield* Effect.addFinalizer(() => Effect.sync(offDemotionConfig))

    // Scheduled review of the routing history, off unless configured.
    yield* ModelRouteTuning.schedule(
      () => configuredTuning(loaded.entries),
      () => Array.from(configuredRoutes(loaded.entries).values(), (route) => route.autonomy),
      ctx.location.directory,
    ).pipe(Effect.forkScoped)

    yield* ctx.tool.transform((editor) => {
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      // Usage is read-only, so it is offered at every autonomy level.
      RouteUsageTool.add(editor, () => ({ routes: configuredRoutes(loaded.entries) }))
      if (!ModelRouteAutonomy.offersTools(Array.from(routes.values(), (route) => route.autonomy))) return
      RouteAdjustTool.add(editor, permission)
      RouteStatsTool.add(editor, permission, () => ({
        routes: configuredRoutes(loaded.entries),
        notes: configuredTuning(loaded.entries)?.notes ?? [],
        location: ctx.location.directory,
      }))
    })

    const runFork = Effect.runForkWith(yield* Effect.context())
    // Transforms replay on every reload, so each diagnostic is logged once while it lasts.
    const report = (diagnostics: ReadonlySet<string>, reported: ReadonlySet<string>) => {
      diagnostics.forEach((message) => {
        if (!reported.has(message)) runFork(Effect.logWarning("model route diagnostic", { message }))
      })
      return diagnostics
    }
    let reportedByProviders: ReadonlySet<string> = new Set()
    let reportedByModels: ReadonlySet<string> = new Set()

    yield* ctx.provider.transform((providers) => {
      if (providers.get(ModelRoute.PROVIDER_ID)) return
      const routes = configuredRoutes(loaded.entries)
      // Provider routes are addressable directly (#1720), so a config declaring only
      // provider routes still has work to do here.
      if (routes.size === 0 && declaredProviderRouteIDs(loaded.entries).size === 0) return
      const windows = configuredWindows(loaded.entries)
      const globalSchedules = weightRulesAcross(configuredSchedules(loaded.entries), windows)
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        providers.list().map((record) => [record.provider.id, record.models] as const),
      )
      const later = builtWithModels(routes)
      const diagnostics = new Set<string>()
      const providerRoutes = configuredProviderRoutes(loaded.entries, new Set(definitions.keys()), routes)
      const models = Array.from(routes, ([id, route]) => {
        if (later.has(id)) return undefined
        const { leaves: expanded, nodes } = expand(id, routes, definitions, windows, providerRoutes)
        if (expanded.length === 0) return undefined
        return routeModel(id, route, expanded, nodes, globalSchedules, ctx.location.directory)
      }).filter((model): model is Model.Info => model !== undefined)
      reportedByProviders = report(diagnostics, reportedByProviders)

      // The routes provider is registered even when no route could be built from
      // definitions alone: a route whose targets are all transform-created (#1001)
      // has no model yet, and the model transform below can only create it if this
      // provider exists in the model editor's candidate set.
      if (routes.size > 0)
        providers.add({
          info: {
            ...Provider.Info.empty(ModelRoute.PROVIDER_ID),
            name: "OpenCode routes",
            activation: "enabled",
          },
          models,
        })

      // Direct provider-route sessions (#1720): a session addressing `<route>/<model>`
      // finds no catalog entry, because expansion only consumes a provider route when
      // a model route seats it. Register each member-offered model under the route id
      // itself, carrying the seat-identical group definition, so direct sessions
      // resolve through the same selection, weights, health, and failover machinery.
      // Built from the pre-synthetic definitions above, so the new records never
      // shadow the provider route at expansion the way a same-named concrete
      // provider would.
      const directByRoute = new Map<string, Model.Info[]>()
      for (const model of buildProviderRouteModels(
        providerRoutes,
        routes,
        definitions,
        windows,
        globalSchedules,
        ctx.location.directory,
      )) {
        const key = String(model.providerID)
        const list = directByRoute.get(key) ?? []
        list.push(model)
        directByRoute.set(key, list)
      }
      for (const [routeID, routeModels] of directByRoute)
        providers.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(routeID)),
            name: routeID,
            activation: "enabled",
          },
          models: routeModels,
        })
    })

    // Pools are built by the provider transform above, which runs before any model
    // transform, so its targets resolve against provider definitions only. Models a
    // model transform creates (Azure deployments are the named case, #236) do not
    // exist yet at that point and can never be placed. This plugin registers in the
    // post group, after every provider plugin, so a model transform registered here
    // runs after those creators: re-expand each route against definition ids union
    // current model ids and rewrite the stored targets in place.
    yield* ctx.model.transform((models) => {
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      const windows = configuredWindows(loaded.entries)
      for (const routeModel of models.list(ModelRoute.PROVIDER_ID)) {
        const current = ModelRoute.definition(routeModel)
        if (!current) continue
        const providerRoutes = configuredProviderRoutes(
          loaded.entries,
          concreteProviderIDs(models, loaded.entries),
          routes,
        )
        const next = retargetDefinition(current, routes, models, windows, providerRoutes)
        if (!next) continue
        // The advertised variants were computed by the provider transform, before the
        // transform-created targets existed, so a retargeted leaf that cannot produce a
        // variant must take it back out here (#869): the resolver gates on the advertised
        // set, and a variant it still advertises would let it run that leaf bare.
        const variants = sameVariants(routeModel.variants, next.variants) ? undefined : next.variants
        if (next.definition === undefined && variants === undefined) continue
        models.update(ModelRoute.PROVIDER_ID, routeModel.id, (draft) => {
          if (next.definition !== undefined)
            draft.settings = { ...draft.settings, [ModelRoute.SETTING]: next.definition }
          if (variants !== undefined)
            draft.variants = variants.map((variant) => ({
              ...(draft.variants.find((item) => item.id === variant.id) ?? {}),
              id: variant.id,
            }))
        })
      }
      // Routes the loop above could not retarget because the provider transform
      // never built them: every target was transform-created, so no route model
      // existed when transforms began (#1001). Build each missing route now,
      // against the same current-model definitions a retarget uses. A route
      // whose targets still resolve to no model is named in a warning instead
      // of vanishing silently.
      const built = new Set(models.list(ModelRoute.PROVIDER_ID).map((model) => String(model.id)))
      const missing = Array.from(routes.keys()).filter((id) => !built.has(id))
      if (missing.length > 0) {
        const providerRoutes = configuredProviderRoutes(
          loaded.entries,
          concreteProviderIDs(models, loaded.entries),
          routes,
        )
        const globalSchedules = weightRulesAcross(configuredSchedules(loaded.entries), windows)
        const routeProviderItems = configuredRouteProviderItems(loaded.entries)
        const routeProviderBaseURL = routeProviderItems.some((item) => item.settings?.baseURL !== undefined)
        for (const id of missing) {
          const created = createRouteModel(
            id,
            routes,
            models,
            windows,
            providerRoutes,
            globalSchedules,
            ctx.location.directory,
          )
          if (!created) {
            console.warn(
              `model route ${JSON.stringify(id)} names targets that resolve to no models after model transforms (experimental.routes.models); the route is not built`,
            )
            continue
          }
          models.update(ModelRoute.PROVIDER_ID, Model.ID.make(id), (draft) => {
            Object.assign(draft, created)
          })
          // The provider plugin's model transform applies configured overrides
          // (disabled, hidden, limits, variants) to route models, but it ran
          // before this route existed and skipped it. Apply the same overrides
          // here so a created route honors the same config as a built one.
          for (const item of routeProviderItems) {
            const config = item.models?.[id]
            if (!config) continue
            applyModelConfig(
              models,
              item,
              {
                providerID: String(ModelRoute.PROVIDER_ID),
                baseURL: routeProviderBaseURL,
                models: new Map([[id, { inherit: false }]]),
              },
              String(ModelRoute.PROVIDER_ID),
              id,
              config,
            )
          }
        }
      }
    })

    // Pools that use the matching or effort keys are built once provider connections are known, so a pattern
    // adds only models that can be used: a model of a provider that is not connected is never offered here.
    yield* ctx.model.transform((editor) => {
      const routes = configuredRoutes(loaded.entries)
      const later = builtWithModels(routes)
      if (later.size === 0) return
      const globalSchedules = weightRulesAcross(configuredSchedules(loaded.entries))
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        editor.provider
          .list()
          .filter((record) => record.provider.id !== ModelRoute.PROVIDER_ID)
          .map((record) => [record.provider.id, record.models] as const),
      )
      const diagnostics = new Set<string>()
      routes.forEach((route, id) => {
        if (!later.has(id)) return
        const {
          leaves,
          nodes,
          diagnostics: found,
        } = expand(id, routes, definitions, (providerID, modelID) => editor.get(providerID, modelID))
        found.forEach((message) => diagnostics.add(message))
        if (leaves.length === 0) return editor.remove(ModelRoute.PROVIDER_ID, id)
        const info = routeModel(id, route, leaves, nodes, globalSchedules)
        editor.update(ModelRoute.PROVIDER_ID, id, (model) => {
          Object.assign(model, info)
        })
      })
      reportedByModels = report(diagnostics, reportedByModels)
    })
  }),
})

/** The route model for one route, built from its expanded leaves: the provider
 * transform builds it from definition-stage leaves, and the model transform
 * builds it the same way for a route whose leaves only exist after model
 * transforms (#1001), so both stages produce the identical model shape. */
function routeModel(
  id: string,
  route: ConfigModelRoutes.Route,
  expanded: readonly SourceModel[],
  nodes: ModelRoute.Node[],
  globalSchedules: readonly ModelRoute.WeightRule[],
  directory?: string,
  /** Direct-addressing identity (#1720): the provider the model is catalogued under and the
   * route id its definition (decision records, health, usage) is keyed by. */
  direct?: { readonly providerID: Provider.ID; readonly routeID: string },
): Model.Info {
  const first = expanded[0].model
  // A leaf serves at most its own limit and the per-target ceilings on the path that reached it.
  const leafCeiling = (target: (typeof expanded)[number]) =>
    Math.min(target.model.limit.context, target.contextLimit ?? Number.POSITIVE_INFINITY)
  const leafContext = Math.min(...expanded.map(leafCeiling))
  const health = ModelRoute.policy(route.health, directory)
  const targetCacheFormats = expanded.map((target) => (target.cacheFormat ? { cacheFormat: target.cacheFormat } : {}))
  return Model.Info.make({
    ...Model.Info.default(direct?.providerID ?? ModelRoute.PROVIDER_ID, Model.ID.make(id)),
    name: route.name?.trim() || id,
    settings: {
      [ModelRoute.SETTING]: {
        id: Model.ID.make(direct?.routeID ?? id),
        ...(route.system ? { system: route.system } : {}),
        targets: expanded.map((target) => target.ref),
        targetVariants: expanded.map((target) => ({
          ...(target.defaultVariant ? { default: target.defaultVariant } : {}),
          ...(target.variantMap ? { map: target.variantMap } : {}),
        })),
        // Routes that declare no cache format keep their stored settings unchanged.
        ...(targetCacheFormats.some((item) => item.cacheFormat !== undefined) ? { targetCacheFormats } : {}),
        health,
        nodes,
        ...(route.attempts !== undefined ? { attempts: route.attempts } : {}),
        ...(route.hedgeAfterMs ? { hedgeAfterMs: route.hedgeAfterMs } : {}),
        ...(route.autonomy ? { autonomy: route.autonomy } : {}),
        ...(route.limit?.context !== undefined ? { limit: { context: route.limit.context } } : {}),
        budgets: expanded.map((target) => target.budget ?? {}),
        // Parallel to targets: each leaf's effective ceiling, so selection can skip a leaf
        // whose ceiling a request does not fit. Stored effective (with the model's own limit
        // folded in) so eligibility needs nothing beyond the definition and the request size.
        ...(expanded.some((target) => target.contextLimit !== undefined)
          ? {
              targetLimits: expanded.map((target) => ({
                context: Math.min(target.model.limit.context, target.contextLimit ?? Number.POSITIVE_INFINITY),
              })),
            }
          : {}),
        ...(globalSchedules.length > 0 ? { schedules: globalSchedules } : {}),
      },
    },
    capabilities: {
      tools: expanded.every((target) => target.model.capabilities.tools),
      input: intersect(expanded.map((target) => target.model.capabilities.input)),
      output: intersect(expanded.map((target) => target.model.capabilities.output)),
    },
    variants: routeVariants(expanded, route.levels),
    cost: first.cost,
    status: "active",
    limit: {
      context: route.limit?.context !== undefined ? Math.min(route.limit.context, leafContext) : leafContext,
      output: Math.min(...expanded.map((target) => target.model.limit.output)),
      ...(expanded.every((target) => target.model.limit.input !== undefined)
        ? {
            // The context cap applies to the presented input limit too: compaction
            // prefers limit.input over limit.context (calculateCeiling), so an uncapped
            // input would silently bypass the cap whenever targets define one.
            input:
              route.limit?.context !== undefined
                ? Math.min(
                    route.limit.context,
                    ...expanded.map((target) =>
                      Math.min(target.model.limit.input!, target.contextLimit ?? Number.POSITIVE_INFINITY),
                    ),
                  )
                : Math.min(
                    ...expanded.map((target) =>
                      Math.min(target.model.limit.input!, target.contextLimit ?? Number.POSITIVE_INFINITY),
                    ),
                  ),
          }
        : {}),
    },
  })
}

/** Pools that use a matching or effort key, or nest a pool that does. They are built with the models of
 * connected providers; every other pool is built from the provider definitions, as it always was. A target
 * remap to false is an effort key too: whether the pool offers a level it sits out depends on the variants of
 * its other targets, and variants configured under a provider's models come only with the models. */
function builtWithModels(routes: ReadonlyMap<string, ConfigModelRoutes.Route>) {
  const uses = (id: string, trail: ReadonlySet<string>): boolean => {
    const route = routes.get(id)
    if (!route || trail.has(id)) return false
    if (
      [
        route.include,
        route.exclude,
        route.contains,
        route.notContains,
        route.match,
        route.levels,
        route.variantRules,
      ].some((value) => value !== undefined) ||
      (route.targets ?? []).some((target) => Object.values(targetSpec(target).variants ?? {}).includes(false))
    )
      return true
    const next = new Set(trail).add(id)
    return (route.targets ?? []).some((target) => {
      const ref = targetRef(targetSpec(target).model)
      return (
        ref.providerID === ModelRoute.PROVIDER_ID &&
        uses(ModelRouteMatch.poolsNamed(routes.keys(), ref.id)[0] ?? ref.id, next)
      )
    })
  }
  return new Set([...routes.keys()].filter((id) => uses(id, new Set())))
}

/** Direct-addressing models for configured provider routes (`<route>/<model>`, #1720).
 * Expansion only consumes a provider route when a model route seats it, so a session
 * addressing the route provider directly finds no catalog entry and dies as
 * provider.no-route. Each model the route's members offer gets a synthetic model under
 * the route id carrying the same group definition a seat would expand to — selection,
 * weights, windows, schedules, health, and failover included — so direct sessions
 * resolve through the identical machinery. */

/** Direct-addressing models for configured provider routes (`<route>/<model>`, #1720).
 * Expansion only consumes a provider route when a model route seats it, so a session
 * addressing the route provider directly finds no catalog entry and dies as
 * provider.no-route. Each model the route's members offer gets a synthetic model under
 * the route id carrying the same group definition a seat would expand to — selection,
 * weights, windows, schedules, health, and failover included — so direct sessions
 * resolve through the identical machinery. */
export function buildProviderRouteModels(
  providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute>,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
  globalSchedules: readonly ModelRoute.WeightRule[] = [],
  directory?: string,
): Model.Info[] {
  const models: Model.Info[] = []
  for (const [routeID, providerRoute] of providerRoutes) {
    const offered = new Set<string>()
    for (const member of providerRoute.providers)
      for (const [modelID] of definitions.get(Provider.ID.make(member)) ?? []) offered.add(modelID)
    for (const modelID of offered) {
      const synthID = `${routeID}/${modelID}`
      const synthRoutes = new Map(routes)
      const synthRoute = {
        targets: [{ model: { providerID: routeID, model: modelID } }],
        selection: providerRoute.selection,
        autonomy: "rules",
      } as unknown as ConfigModelRoutes.Route
      synthRoutes.set(synthID, synthRoute)
      const { leaves: expanded, nodes } = expand(synthID, synthRoutes, definitions, windows, providerRoutes)
      // No servable leaf (every member's copy disabled): leave the model unregistered so
      // the miss branch can diagnose no-eligible-member instead of serving a dead entry.
      if (expanded.length === 0) continue
      models.push(
        routeModel(modelID, synthRoute, expanded, nodes, globalSchedules, directory, {
          providerID: Provider.ID.make(routeID),
          routeID: synthID,
        }),
      )
    }
  }
  return models
}

/** The provider ids that are concrete: every catalogued provider except the direct-addressing
 * records a configured provider route registered under its own id (#1720), which would
 * otherwise read as a concrete provider colliding with the route that created them. */
function concreteProviderIDs(models: ModelCatalogEditor, entries: readonly Entry[]) {
  const declared = declaredProviderRouteIDs(entries)
  return new Set(
    models.provider
      .list()
      .filter((record) => !isDirectRouteProvider(declared, record))
      .map((record) => record.provider.id),
  )
}

/** Whether a catalogued provider is the direct-addressing record a provider route registered
 * under its own id (#1720): a route id whose models all carry a route definition. */
function isDirectRouteProvider(
  routeIDs: Iterable<string>,
  record: { readonly provider: { readonly id: Provider.ID }; readonly models: ReadonlyMap<string, Model.Info> },
) {
  return (
    new Set(routeIDs).has(record.provider.id) && Array.from(record.models.values()).some(ModelRoute.definition)
  )
}

function configuredTuning(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<
      ModelRouteTuning.Settings | undefined
    >((found, entry) => entry.info.experimental?.routes?.tuning ?? found, undefined)
}

function configuredLog(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<
      ConfigModelRoutes.Log | undefined
    >((found, entry) => entry.info.experimental?.routes?.log ?? found, undefined)
}

function configuredDemotion(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<
      ConfigExperimental.ModelRouteDemotion | undefined
    >((found, entry) => entry.info.experimental?.model_route_demotion ?? found, undefined)
}

/** The demotion policy in the core's shape: only the fields config actually set — a decoded
 * demotion block carries every unset field as undefined, and passing those through would
 * erase the defaults they sit over. */
function demotionConfig(
  demotion: ConfigExperimental.ModelRouteDemotion | undefined,
): ModelRoute.DemotionConfig | undefined {
  if (!demotion) return undefined
  const threshold = demotion.threshold
  const windowMs = demotion.window_ms
  if (threshold === undefined && windowMs === undefined) return undefined
  return {
    ...(threshold !== undefined ? { threshold } : {}),
    ...(windowMs !== undefined ? { windowMs } : {}),
  }
}

/** The membership caps one provider declares on its own definition (#2253): its
 * config `options` migrate into `settings` at load (the v1 provider migration), so
 * the declaration is read from there. Later documents win, as they do for the
 * provider's other settings. */
export function configuredMembershipLimits(
  entries: readonly Entry[],
  providerID: string,
): ModelRouteMembership.Limits | undefined {
  let found: ModelRouteMembership.Limits | undefined
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      const limits = ModelRouteMembership.limitsOf(entry.info.providers?.[providerID]?.settings)
      if (limits) found = limits
    })
  return found
}

function configuredSettings(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<
      ConfigModelRoutes.Settings | undefined
    >((found, entry) => entry.info.experimental?.routes?.settings ?? found, undefined)
}

/** The machinery settings in the core's shape: only the fields config actually set, group by
 * group — a decoded settings block carries every unset field as undefined, and passing those
 * through would erase the defaults they sit over. */
function settingsConfig(
  settings: ConfigModelRoutes.Settings | undefined,
): ModelRoute.SettingsConfig | undefined {
  if (!settings) return undefined
  const group = <T extends object>(value: T | undefined): Partial<T> | undefined => {
    if (!value) return undefined
    const fields = Object.entries(value).filter(([, field]) => field !== undefined)
    return fields.length > 0 ? (Object.fromEntries(fields) as Partial<T>) : undefined
  }
  const bench = group(settings.bench)
  const demotion = group(settings.demotion)
  const quotaGate = group(settings.quotaGate)
  const escalation = group(settings.escalation)
  const network = group(settings.network)
  const membership = group(settings.membership)
  const continuity = group(settings.continuity)
  const overrides = group(settings.overrides)
  if (!bench && !demotion && !quotaGate && !escalation && !network && !membership && !continuity && !overrides)
    return undefined
  return {
    ...(bench ? { bench } : {}),
    ...(demotion ? { demotion } : {}),
    ...(quotaGate ? { quotaGate } : {}),
    ...(escalation ? { escalation } : {}),
    ...(network ? { network } : {}),
    ...(membership ? { membership } : {}),
    ...(continuity ? { continuity } : {}),
    ...(overrides ? { overrides } : {}),
  }
}

export function configuredRoutes(entries: readonly Entry[]) {
  const routes = new Map<string, ConfigModelRoutes.Route>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.entries(entry.info.experimental?.routes?.models ?? {}).forEach(([id, route]) => routes.set(id, route))
    })
  return routes
}

/** The provider-route ids the config declares, before validation: the reference set for
 * direct-addressing diagnostics (#1720). A declared id that validation drops (concrete
 * provider collision, configured-route collision, no concrete members) is still a route
 * the user meant, so the miss branch can name why it does not resolve instead of the
 * generic unknown-provider error. */
export function declaredProviderRouteIDs(entries: readonly Entry[]) {
  const declared = new Set<string>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.keys(entry.info.experimental?.routes?.providers ?? {}).forEach((id) => declared.add(id))
    })
  return declared
}

/** The configured provider entries for the routes provider itself, in document
 * order: their per-model entries are the overrides the provider plugin applies
 * to built routes, replayed here for routes created after its transform ran. */
function configuredRouteProviderItems(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((file) => Object.entries(file.info.providers ?? {}))
    .filter(([id]) => id === String(ModelRoute.PROVIDER_ID))
    .map(([, item]) => item as ConfigProvider.Info)
}

function configuredSchedules(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.experimental?.routes?.schedules ?? [])
}

/** A named window that cannot be applied is dropped, but never silently (#734): a typo'd or
 * unreadable window name would otherwise remove a target's eligibility gate or a schedule rule
 * with no signal anywhere. The warning names the window and where it was referenced. */
const warnDroppedWindow = (name: string, site: string, reason: string) =>
  console.warn(`model-route window ${JSON.stringify(name)} ${reason} (${site}); it is dropped, not applied`)

/** The named windows defined in config, parsed once so schedules and target gates can reference
 * them by name. An entry with an unreadable window is dropped rather than applied. */
export function configuredWindows(entries: readonly Entry[]) {
  const parsed = new Map<string, ModelRouteSchedule.Window>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.entries(entry.info.experimental?.routes?.windows ?? {}).forEach(([name, window]) => {
        const read = ModelRouteSchedule.parse(window)
        if (read) {
          parsed.set(name, read)
          return
        }
        warnDroppedWindow(name, "experimental.routes.windows", "is defined but cannot be parsed")
      })
    })
  // Second pass: resolve each window's excludeWindows against the full set (its own name is on
  // the resolution path, so a self-reference is a cycle). An unknown name or a cycle drops the
  // window with a warning, like an unparseable one — never apply it without its exclusion.
  const windows = new Map<string, ModelRouteSchedule.Window>()
  parsed.forEach((window, name) => {
    const resolved = ModelRouteSchedule.resolveExclusions(window, parsed, new Set([name]))
    if (resolved) {
      windows.set(name, resolved)
      return
    }
    warnDroppedWindow(name, "experimental.routes.windows", "names an unknown or cyclic excludeWindows window")
  })
  return windows
}

/** A provider route that cannot be applied is dropped, but never silently (#734's rule,
 * as for windows): the warning names the provider and why. */
const warnDroppedProviderRoute = (id: string, reason: string) =>
  console.warn(
    `provider route ${JSON.stringify(id)} ${reason} (experimental.routes.providers); it is dropped, not applied`,
  )

/** The provider routes config declares, validated against the providers that exist and the
 * routes that are configured, in the runtime's shape. An id that names a concrete provider, the
 * routes provider, or a configured route is dropped with a warning: the id shares the provider
 * namespace at a route's reference site, so a concrete provider always wins the reference, and
 * a route's name would make decision records ambiguous. Members are validated independently
 * of the caller's known-provider set (#1420): a member that is "*" (the door-set wildcard),
 * the routes provider, or another declared provider route is dropped with a warning, since
 * provider routes do not nest and a wildcard would dispatch outside the declared membership.
 * A remaining member that names a concrete provider is a member. A member that names no
 * known provider and cannot act as a pattern at expansion is kept, with a warning: it
 * contributes no leaves, like a target naming an unknown provider. */
export function configuredProviderRoutes(
  entries: readonly Entry[],
  knownProviders: ReadonlySet<string>,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
) {
  const declared = new Map<string, ConfigModelRoutes.ProviderRoute>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.entries(entry.info.experimental?.routes?.providers ?? {}).forEach(([id, provider]) =>
        declared.set(id, provider),
      )
    })
  const providerRoutes = new Map<string, ModelRoute.ProviderRoute>()
  declared.forEach((provider, id) => {
    if (id === ModelRoute.PROVIDER_ID || knownProviders.has(id)) {
      warnDroppedProviderRoute(id, "names a concrete provider, which keeps the reference")
      return
    }
    if (routes.has(id)) {
      warnDroppedProviderRoute(id, "names a configured route, which would make decision records ambiguous")
      return
    }
    const members: string[] = []
    for (const member of provider.providers) {
      // Membership is validated before the known-provider test (#1420): "*", the routes
      // provider, and another declared provider route are dropped regardless of which
      // caller supplied the known set, so both call paths validate the same config.
      if (member === "*" || member === ModelRoute.PROVIDER_ID || declared.has(member)) {
        const reason =
          member === "*"
            ? "is a wildcard, not a concrete provider"
            : "is not a concrete provider (provider routes do not nest)"
        console.warn(
          `provider route ${JSON.stringify(id)}: member ${JSON.stringify(member)} ${reason}; the member is dropped`,
        )
        continue
      }
      if (members.includes(member)) {
        console.warn(
          `provider route ${JSON.stringify(id)}: member ${JSON.stringify(member)} is listed twice; the duplicate is dropped`,
        )
        continue
      }
      if (!knownProviders.has(member))
        console.warn(
          `provider route ${JSON.stringify(id)}: member ${JSON.stringify(member)} names no known provider; it contributes no leaves`,
        )
      members.push(member)
    }
    if (members.length === 0) {
      warnDroppedProviderRoute(id, "has no concrete member providers")
      return
    }
    providerRoutes.set(id, {
      providers: members,
      selection: provider.selection ?? "ordered",
      weights: provider.weights ?? {},
      ...(provider.windows ? { windows: provider.windows } : {}),
      ...(provider.schedules?.length ? { schedules: provider.schedules } : {}),
    })
  })
  return providerRoutes
}

/** A schedule's window: inline (parsed as before), or the name of a configured window.
 * An unknown name resolves to undefined, which drops the rule — with a warning naming it. */
const resolveWindow = (
  when: ConfigModelRoutes.Schedule["when"] | ConfigModelRoutes.GlobalSchedule["when"],
  windows: ReadonlyMap<string, ModelRouteSchedule.Window>,
  site: string,
): ModelRouteSchedule.Window | undefined => {
  if (typeof when !== "string") {
    const parsed = ModelRouteSchedule.parse(when)
    if (!parsed) return undefined
    if (!parsed.excludeWindows?.length) return parsed
    const resolved = ModelRouteSchedule.resolveExclusions(parsed, windows)
    if (!resolved)
      warnDroppedWindow(parsed.excludeWindows.join(", "), site, "names an unknown or cyclic excludeWindows window")
    return resolved
  }
  const window = windows.get(when)
  if (!window) warnDroppedWindow(when, site, "is not a defined window")
  return window
}

/** A target's eligibility gate, resolved from its `window` against the configured windows.
 * An unknown name drops the gate, leaving the target always eligible — with a warning naming it. */
const gateFor = (
  window: string | { name: string; invert?: boolean } | undefined,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window>,
  site: string,
): ModelRoute.Gate | undefined => {
  if (window === undefined) return undefined
  const name = typeof window === "string" ? window : window.name
  const parsed = windows.get(name)
  if (!parsed) {
    warnDroppedWindow(name, site, "is not a defined window")
    return undefined
  }
  return { name, window: parsed, ...(typeof window !== "string" && window.invert ? { invert: true } : {}) }
}

/** The schedule rules a route declares for its own targets, in a shape the runtime can judge. An
 * entry with an unreadable window, or with nothing to change, is dropped rather than applied; the
 * config loader has already reported it (scheduleProblems in config/normalize.ts). */
export function routeWeightRules(
  route: ConfigModelRoutes.Route,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
): ModelRoute.WeightRule[] {
  return (route.schedules ?? []).flatMap((schedule) => {
    if (schedule.factor === undefined && schedule.weight === undefined) return []
    const window = resolveWindow(
      schedule.when,
      windows,
      schedule.id ? `route schedule ${JSON.stringify(schedule.id)}` : "a route schedule",
    )
    if (!window) return []
    const targets = (schedule.targets ?? []).map((target) => target.trim()).filter(Boolean)
    return [
      {
        ...(schedule.id ? { id: schedule.id } : {}),
        ...(targets.length > 0 ? { match: { targets } } : {}),
        window,
        ...(schedule.factor !== undefined ? { factor: schedule.factor } : {}),
        ...(schedule.weight !== undefined ? { weight: schedule.weight } : {}),
        ...(schedule.note ? { note: schedule.note } : {}),
      },
    ]
  })
}

/** The global schedule rules in a shape the runtime can judge. The route filter stays in the match,
 * so one list serves every route and nested route. An entry with nothing to change, or with an
 * unreadable window, is dropped; the config loader has already reported it. */
export function weightRulesAcross(
  schedules: readonly ConfigModelRoutes.GlobalSchedule[],
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
): ModelRoute.WeightRule[] {
  return schedules.flatMap((schedule) => {
    if (schedule.factor === undefined && schedule.weight === undefined) return []
    const window = resolveWindow(
      schedule.when,
      windows,
      schedule.id ? `global schedule ${JSON.stringify(schedule.id)}` : "a global schedule",
    )
    if (!window) return []
    const targets = (schedule.targets ?? []).map((target) => target.trim()).filter(Boolean)
    const providers = (schedule.providers ?? []).map((provider) => provider.trim()).filter(Boolean)
    const models = (schedule.models ?? []).map((model) => model.trim()).filter(Boolean)
    const routes = (schedule.routes ?? []).map((route) => route.trim()).filter(Boolean)
    const match = {
      ...(targets.length > 0 ? { targets } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(models.length > 0 ? { models } : {}),
      ...(routes.length > 0 ? { routes } : {}),
    }
    return [
      {
        ...(schedule.id ? { id: schedule.id } : {}),
        ...(Object.keys(match).length > 0 ? { match } : {}),
        window,
        ...(schedule.factor !== undefined ? { factor: schedule.factor } : {}),
        ...(schedule.weight !== undefined ? { weight: schedule.weight } : {}),
        ...(schedule.note ? { note: schedule.note } : {}),
      },
    ]
  })
}

/** One route's targets and selection tree, with what the pool's author should hear about it. Targets come
 * from `definitions`; `candidate` returns a model as it can be used now, or undefined when its provider is not
 * connected. Models that matching keys add come only through `candidate`, and a target uses it when it has
 * the model, so configured variants count. The route's declared `levels` are applied here: a target that
 * cannot run one of them sits it out. A nested pool's are applied where it is collected, and here its members
 * sit out every other level. A nested pool pinned as `opencode-route/<id>#<level>` runs only at that level, so
 * its remaps and rules decide only whether a member sits the pin out; such a member is left out, and the rest
 * run at the pin at every level of the pools above, which may still sit them out. */
export type CandidateFn = (providerID: Provider.ID, id: Model.ID) => Model.Info | undefined

type ExpandShared = {
  readonly candidate: CandidateFn
  readonly members: Map<string, ReadonlySet<string>>
  readonly models: () => readonly { readonly providerID: Provider.ID; readonly id: Model.ID }[]
}

function expandCollected(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window>,
  providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute>,
  candidate: CandidateFn,
  trailArg: ReadonlySet<string>,
  shared: ExpandShared,
  enteredAt: readonly Pin[] = [],
) {
  const diagnostics: string[] = []
  const result: SourceModel[] = []
  const nodes: ModelRoute.Node[] = []
  const leafByKey = new Map<string, number>()
  const seen = new Set<string>()
  const placed = new Set<string>()

  const allowed = new Map<number, ReadonlySet<string>>()
  let cut = false

  // A pool named in any case: the one spelled exactly so, else the first that matches ignoring case, with a
  // warning when several do.
  const poolNamed = (routeID: string, name: string) => {
    const named = ModelRouteMatch.poolsNamed(routes.keys(), name)
    if (named.length > 1)
      diagnostics.push(
        `pool ${routeID} names ${name}, which matches ${named.join(", ")} ignoring case; it uses ${named[0]}`,
      )
    return named[0]
  }

  // A term that names a pool, as an id or with the route provider prefix, in any case, stands for that
  // pool and its models. A pool already on the way in adds nothing for that name.
  const reference =
    (routeID: string, within: ReadonlySet<string>) =>
    (text: string): ModelRouteMatch.Predicate | undefined => {
      const prefixed = text.toLowerCase().startsWith(POOL_PREFIX)
      const poolID =
        ModelRouteMatch.poolsNamed(routes.keys(), text).length > 0
          ? poolNamed(routeID, text)
          : prefixed
            ? poolNamed(routeID, text.slice(POOL_PREFIX.length))
            : undefined
      if (poolID === undefined) {
        if (prefixed) diagnostics.push(`pool ${routeID} names ${text}, which is not a pool`)
        return undefined
      }
      if (within.has(poolID)) {
        cut = true
        return () => false
      }
      const members = shared.members.get(poolID) ?? membersOf(poolID, within)
      return (cand) => members.has(`${cand.providerID}/${cand.id}`)
    }
  const membersOf = (poolID: string, within: ReadonlySet<string>) => {
    const named = expandCollected(poolID, routes, definitions, windows, providerRoutes, candidate, within, shared)
    named.diagnostics.forEach((message) => {
      if (!diagnostics.includes(message)) diagnostics.push(message)
    })
    const members = new Set(named.leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}`))
    if (named.cut) cut = true
    else shared.members.set(poolID, members)
    return members
  }

  // Each route becomes a group node with its own selection mode and weights, so a weighted route
  // nested in another is chosen as one unit and then splits among its own members.
  const visit = (
    routeID: string,
    inheritedVariant: Model.VariantID | undefined,
    trail: ReadonlySet<string>,
    inheritedCacheFormat: CacheFormat | undefined,
    inheritedLimit: number | undefined,
    override?: { route: ConfigModelRoutes.Route; providerRoute: string; keepEmpty?: boolean },
    enclosing: Enclosing = { excludes: [], rules: [], pins: [] },
    reattach = false,
  ): number | undefined => {
    if (trail.has(routeID)) {
      cut = true
      return
    }
    const current = override?.route ?? routes.get(routeID)
    if (!current) return
    // The pin this pool runs at, when a pool on the way in was entered at one: the last such pin.
    const pin = enclosing.pins.at(-1)
    // A pool pinned at a level it does not declare offers its members nowhere there.
    if (pin !== undefined && current.levels !== undefined && !current.levels.includes(pin.level)) {
      diagnostics.push(`pool ${routeID} is pinned at level ${pin.level}, which it does not declare, so it adds nothing`)
      return
    }
    const nextTrail = new Set(trail).add(routeID)
    // The config loader skips a pool with a malformed matching key, so this fails only for a pool that
    // never went through it; such a pool contributes nothing rather than part of what it says.
    const compiled = ModelRouteMatch.compile(current, reference(routeID, nextTrail))
    if (Result.isFailure(compiled)) {
      diagnostics.push(
        `pool ${routeID} is skipped: ${compiled.failure.map((problem) => `${problem.path.join(".")}: ${problem.message}`).join("; ")}`,
      )
      return
    }
    const excludes = [...enclosing.excludes, compiled.success.excludes]
    // A remap or rule applies to the levels of the pool that declares it: above any pin, every level the expanded
    // pool is selected at; at a pin, that one level.
    const own = compiled.success.rules
    const rules = pin === undefined ? [...enclosing.rules, ...own] : enclosing.rules
    const pins =
      pin === undefined ? enclosing.pins : [...enclosing.pins.slice(0, -1), { ...pin, rules: [...pin.rules, ...own] }]
    const excluded = (candidate: ModelRouteMatch.Candidate) => excludes.some((test) => test(candidate))
    const nodeIndex = nodes.length
    const node: {
      routeID: string
      providerRoute?: string
      selection: ModelRoute.Node["selection"]
      weights: number[]
      schedules: ModelRoute.WeightRule[]
      children: ModelRoute.Node["children"][number][]
    } = {
      routeID,
      ...(override ? { providerRoute: override.providerRoute } : {}),
      selection: ModelRouteAutonomy.usesRules(current.autonomy) ? (current.selection ?? "ordered") : "ordered",
      weights: [],
      schedules: routeWeightRules(current, windows),
      children: [],
    }
    nodes.push(node)
    const attached = new Set<string>()
    const attach = (child: ModelRoute.Node["children"][number], key: string) => {
      node.children.push(child)
      // A nested pool's weight key names a pool, so it matches in any case.
      const weight =
        current.weights?.[key] ??
        (child.node === undefined
          ? undefined
          : Object.entries(current.weights ?? {}).find(
              ([name]) =>
                name.toLowerCase() === key.toLowerCase() ||
                name.toLowerCase().endsWith(`/${key.toLowerCase()}`),
            )?.[1])
      node.weights.push(ModelRouteAutonomy.usesRules(current.autonomy) ? (weight ?? 1) : 1)
    }
    const applying = (list: readonly ModelRouteMatch.Rule[], candidate: ModelRouteMatch.Candidate) =>
      list.filter((rule) => rule.applies(candidate)).map((rule) => rule.map)
    // What a member keeps: the rules above any pin, outermost first, then the target's own remap. At a pin the
    // remap applies only to the pin, which a member pinned here runs at whatever the level: its remaps to a
    // variant stay, as they always have, its false entries only decide whether it is left out, and the rules
    // above come last, so a pool above may still sit it out.
    const levelMap = (
      candidate: ModelRouteMatch.Candidate,
      model: Model.Info,
      variants: Readonly<Record<string, string | false>> = {},
    ) =>
      effort(
        model,
        pin === undefined
          ? [...applying(rules, candidate), variants]
          : [
              Object.fromEntries(Object.entries(variants).filter(([, to]) => to !== false)),
              ...applying(rules, candidate),
            ],
      )
    // Whether a member sits out a pin it is under: each pin's rules, and at the last one the target's own remap.
    const sitsOutPin = (
      candidate: ModelRouteMatch.Candidate,
      model: Model.Info,
      variants: Readonly<Record<string, string | false>> = {},
    ) =>
      pins.some(
        (each, index) =>
          effort(model, [...applying(each.rules, candidate), ...(index === pins.length - 1 ? [variants] : [])])[
            each.level
          ] === false,
      )
    const first = result.length
    const childPairs = new Set<string>()
    for (const target of current.targets ?? []) {
      const spec = targetSpec(target)
      const ref = targetRef(spec.model)
      if (spec.until !== undefined && Date.now() >= spec.until) continue
      // A per-target limit composes down the reach path: the smallest ceiling wins, so a
      // nested-route reference's own limit caps every leaf reached through it.
      const own = "limit" in spec ? spec.limit?.context : undefined
      const ceiling = own === undefined ? inheritedLimit : Math.min(own, inheritedLimit ?? own)
      if (ref.providerID === ModelRoute.PROVIDER_ID) {
        const poolID = poolNamed(routeID, ref.id) ?? ref.id
        const off = Object.entries(spec.variants ?? {}).flatMap(([level, to]) => (to === false ? [level] : []))
        const leaveOut = (at: Pin) => {
          const brought = expandCollected(
            poolID, routes, definitions, windows, providerRoutes, candidate, nextTrail, shared,
            ref.variant === undefined
              ? []
              : [{ level: ref.variant, rules: [], leftOut: { targets: new Set(), models: new Set() } }],
          )
          brought.diagnostics.forEach((message) => {
            if (!diagnostics.includes(message)) diagnostics.push(message)
          })
          if (brought.cut) cut = true
          brought.leaves.forEach((leaf) => {
            at.leftOut.targets.add(
              `${leaf.ref.providerID}/${leaf.ref.id}${leaf.ref.variant ? `#${leaf.ref.variant}` : ""}`,
            )
            at.leftOut.models.add(`${leaf.ref.providerID}/${leaf.ref.id}`)
          })
        }
        if (pin !== undefined && off.includes(pin.level)) {
          leaveOut(pin)
          continue
        }
        const start = result.length
        const repeated = childPairs.has(poolID)
        childPairs.add(poolID)
        const child = visit(
          poolID,
          ref.variant ?? inheritedVariant,
          nextTrail,
          spec.cache_format ?? current.cache_format ?? inheritedCacheFormat,
          ceiling,
          undefined,
          {
            excludes,
            rules,
            pins:
              ref.variant === undefined
                ? pins
                : [...pins, { level: ref.variant, rules: [], leftOut: { targets: new Set(), models: new Set() } }],
          },
          repeated,
        )
        const nested = routes.get(poolID)
        if (
          pin !== undefined &&
          ref.variant === undefined &&
          nested?.levels !== undefined &&
          !nested.levels.includes(pin.level)
        )
          leaveOut(pin)
        if (pin === undefined && off.length > 0)
          result.slice(start).forEach((leaf, offset) => {
            result[start + offset] = sitOut(leaf, off)
          })
        if (child !== undefined) {
          const gate = gateFor("window" in spec ? spec.window : undefined, windows, `route ${JSON.stringify(routeID)}`)
          attach({ node: child, ...(gate ? { gate } : {}) }, `${poolID}`)
        }
        continue
      }
      const providerRoute = providerRoutes.get(String(ref.providerID))
      if (providerRoute && !definitions.has(ref.providerID)) {
        // A provider route target: the members' leaves for this one model, grouped under
        // the provider route's own selection. The group is built by visiting a route shaped like
        // the provider route for the model, so every leaf rule (variant producibility, ceilings,
        // budgets, dedup) applies verbatim; the referencing route's autonomy gates the
        // group's selection and weights exactly as it gates the route's own. One group per
        // matched model id, so a glob fans out per model and a group never mixes models.
        // Concrete providers win the reference: a provider route whose id a real provider holds
        // is never consulted (config load drops those; this is the same rule at expansion).
        const gate = gateFor("window" in spec ? spec.window : undefined, windows, `route ${JSON.stringify(routeID)}`)
        const matched: string[] = []
        for (const member of providerRoute.providers) {
          for (const [modelID] of ModelRouteExpansion.matchingModels(
            String(ref.id),
            definitions.get(Provider.ID.make(member)),
          )) {
            if (!matched.includes(modelID)) matched.push(modelID)
          }
        }
        for (const modelID of matched) {
          const group = visit(
            String(ref.providerID),
            ref.variant ?? inheritedVariant,
            nextTrail,
            spec.cache_format ?? current.cache_format ?? inheritedCacheFormat,
            ceiling,
            {
              providerRoute: String(ref.providerID),
              route: {
                targets: providerRoute.providers.map((member) => ({
                  model: { providerID: member, model: modelID },
                  ...("variants" in spec && spec.variants ? { variants: spec.variants } : {}),
                  ...("defaultVariant" in spec && spec.defaultVariant ? { defaultVariant: spec.defaultVariant } : {}),
                  // A member's own window gate (#1140): the provider is a candidate only
                  // while its named window allows it, exactly as a model-route target's
                  // gate benches that target's provider/model pair.
                  ...(providerRoute.windows?.[member] ? { window: providerRoute.windows[member] } : {}),
                })),
                selection: providerRoute.selection,
                weights: Object.fromEntries(
                  Object.entries(providerRoute.weights).map(([member, weight]) => [`${member}/${modelID}`, weight]),
                ),
                // The provider route's own schedules ride on the group, so they scale
                // the concrete member leaves exactly as a model route's schedules
                // scale its targets (#1140).
                ...(providerRoute.schedules?.length ? { schedules: providerRoute.schedules } : {}),
                ...(current.autonomy ? { autonomy: current.autonomy } : {}),
              } as unknown as ConfigModelRoutes.Route,
            },
          )
          if (group !== undefined) attach({ node: group, ...(gate ? { gate } : {}) }, `${ref.providerID}/${ref.id}`)
        }
        if (matched.length === 0) {
          // No member offers the model: keep the group in the tree as a leafless node so the
          // decision layer can name the seat in its excluded list with a reason, instead of
          // the seat vanishing without a trace (the silence that hid the provider-routes
          // collapse in production). The node carries no leaves, so it is never a candidate
          // and never changes what a route can serve.
          const group = visit(
            String(ref.providerID),
            ref.variant ?? inheritedVariant,
            nextTrail,
            spec.cache_format ?? current.cache_format ?? inheritedCacheFormat,
            ceiling,
            {
              providerRoute: String(ref.providerID),
              keepEmpty: true,
              route: {
                targets: [],
                selection: providerRoute.selection,
                ...(current.autonomy ? { autonomy: current.autonomy } : {}),
              } as unknown as ConfigModelRoutes.Route,
            },
          )
          if (group !== undefined) attach({ node: group, ...(gate ? { gate } : {}) }, `${ref.providerID}/${ref.id}`)
        }
        continue
      }
      // A door-set target (`*/model`, #637) runs its model on every door whose catalog lists
      // it, minus the target's exclusions; any other target names exactly one provider. The
      // per-leaf logic below is identical either way, with the leaf's own provider.
      const doors: ReadonlyArray<readonly [Provider.ID, ReadonlyMap<string, Model.Info> | undefined]> =
        ref.providerID === "*"
          ? ModelRouteExpansion.matchingProviders(
              definitions,
              "exclude" in spec ? (spec.exclude ?? []) : [],
              ModelRoute.PROVIDER_ID,
            )
          : [[ref.providerID, definitions.get(ref.providerID)]]
      for (const [door, doorModels] of doors) {
        for (const [id, defined] of ModelRouteExpansion.matchingModels(ref.id, doorModels)) {
        const cand = { providerID: door, id: Model.ID.make(id) }
        const requested = ref.variant ?? pin?.level ?? inheritedVariant
        const named = `${door}/${id}${ref.variant ? `#${ref.variant}` : ""}`
        if (pin?.leftOut.targets.has(named)) continue
        const seenKey = `${door}/${id}${requested ? `#${requested}` : ""}`
        if (seen.has(seenKey)) {
          const prior = leafByKey.get(seenKey)
          if (prior !== undefined) {
            if (
              ceiling !== undefined &&
              (result[prior].contextLimit === undefined || ceiling < result[prior].contextLimit)
            )
              result[prior] = { ...result[prior], contextLimit: ceiling }
            // The leaf itself is shared, but when the same parent names the pool again
            // this node still references it, so a pool referenced twice by one parent
            // keeps both group nodes over the same leaf indexes.
            if (reattach && !attached.has(seenKey)) {
              attached.add(seenKey)
              const gate = gateFor(
                "window" in spec ? spec.window : undefined,
                windows,
                `route ${JSON.stringify(routeID)}`,
              )
              attach({ leaf: prior, ...(gate ? { gate } : {}) }, `${door}/${id}`)
            }
          }
          continue
        }
        const model = candidate(door, Model.ID.make(id)) ?? defined
        if (!model.enabled || excluded(cand)) continue
        if (pin !== undefined && sitsOutPin(cand, model, spec.variants ?? {})) {
          pin.leftOut.targets.add(named)
          pin.leftOut.models.add(`${door}/${id}`)
          continue
        }
        // A pinned variant is producible natively or through the target's remap table, matching
        // routeVariants and the resolver: a remap the model can produce wins, else the native
        // variant, else the leaf is pruned. A variant the door's catalog exposes as a
        // suffixed model id ("<model>-<variant>") also counts as producible: proxy
        // catalogs enumerate effort levels that way (Antigravity's gemini-4-argon-high,
        // claude-sonnet-5-5-high), and their definition-stage model info carries no
        // variant list, so the native check alone silently pruned every pinned leaf
        // on those providers (#985).
        const producible = (candidate: string) =>
          model.variants.some((item) => item.id === candidate) || (doorModels?.has(`${id}-${candidate}`) ?? false)
        const remapped = requested ? spec.variants?.[requested] : undefined
        const variant =
          requested === undefined
            ? undefined
            : remapped !== undefined && remapped !== false && producible(remapped)
              ? Model.VariantID.make(remapped)
              : producible(requested)
                ? requested
                : undefined
        if (requested && !variant) continue
        const resolved = Model.Ref.make({
          providerID: door,
          id: Model.ID.make(id),
          ...(variant ? { variant } : {}),
        })
        const key = `${resolved.providerID}/${resolved.id}${resolved.variant ? `#${resolved.variant}` : ""}`
        if (attached.has(key)) {
          // Already attached to this node, but a duplicate target can still tighten the leaf's
          // ceiling: ceilings only ever tighten, whichever reach declares the smaller one.
          const existing = leafByKey.get(key)
          if (
            existing !== undefined &&
            ceiling !== undefined &&
            (result[existing].contextLimit === undefined || ceiling < result[existing].contextLimit)
          )
            result[existing] = { ...result[existing], contextLimit: ceiling }
          continue
        }
        attached.add(key)
        const gate = gateFor("window" in spec ? spec.window : undefined, windows, `route ${JSON.stringify(routeID)}`)
        const leafKey = `${resolved.providerID}/${resolved.id}`
        const existing = leafByKey.get(key)
        if (existing !== undefined) {
          // First reach wins for the leaf itself; a different node re-attaches it by index.
          attach({ leaf: existing, ...(gate ? { gate } : {}) }, leafKey)
          // Ceilings only ever tighten: a leaf reached through several references keeps the smallest
          // per-target ceiling, so a cap cannot be bypassed through another path.
          if (
            ceiling !== undefined &&
            (result[existing].contextLimit === undefined || ceiling < result[existing].contextLimit)
          )
            result[existing] = { ...result[existing], contextLimit: ceiling }
          continue
        }
        const defaultVariant =
          spec.defaultVariant && model.variants.some((item) => item.id === spec.defaultVariant)
            ? Model.VariantID.make(spec.defaultVariant)
            : undefined
        const variantMap = levelMap({ providerID: door, id: Model.ID.make(id) }, model, spec.variants ?? {})
        seen.add(key)
        seen.add(seenKey)
        placed.add(leafKey)
        leafByKey.set(key, result.length)
        attach({ leaf: result.length, ...(gate ? { gate } : {}) }, leafKey)
        // A leaf's own cache_format wins, then the route that declared it, then an enclosing
        // route's. The first route to reach a shared model fixes it for that leaf.
        const cacheFormat = spec.cache_format ?? current.cache_format ?? inheritedCacheFormat
        // Budgets belong to the target: the outermost route that declares one wins, wherever the
        // target was first reached.
        const budget = plainBudget(
          [...nextTrail]
            .filter((id) => ModelRouteAutonomy.usesRules(routes.get(id)?.autonomy))
            .map((id) => routes.get(id)?.budgets?.[leafKey])
            .find((value) => value !== undefined),
        )
        result.push({
          ...(budget ? { budget } : {}),
          ref: resolved,
          model,
          fixedVariant: ref.variant !== undefined || inheritedVariant !== undefined,
          ...(defaultVariant ? { defaultVariant } : {}),
          ...(Object.keys(variantMap).length ? { variantMap } : {}),
          ...(cacheFormat ? { cacheFormat } : {}),
          ...(ceiling !== undefined ? { contextLimit: ceiling } : {}),
        })
        }
      }
    }
    if (compiled.success.selects) {
      for (const entry of shared.models()) {
        const key = `${entry.providerID}/${entry.id}`
        if (placed.has(key) || pin?.leftOut.models.has(key) || !compiled.success.selects(entry) || excluded(entry))
          continue
        const model = candidate(entry.providerID, entry.id)
        if (!model?.enabled) continue
        if (pin !== undefined && !model.variants.some((item) => item.id === pin.level)) continue
        if (pin !== undefined && sitsOutPin(entry, model)) {
          pin.leftOut.targets.add(key)
          pin.leftOut.models.add(key)
          continue
        }
        const variantMap = levelMap(entry, model)
        const budget = plainBudget(
          [...nextTrail]
            .filter((rid) => ModelRouteAutonomy.usesRules(routes.get(rid)?.autonomy))
            .map((rid) => routes.get(rid)?.budgets?.[key])
            .find((value) => value !== undefined),
        )
        const seenKey = `${key}${pin ? `#${pin.level}` : ""}`
        seen.add(seenKey)
        placed.add(key)
        leafByKey.set(seenKey, result.length)
        attach({ leaf: result.length }, key)
        const cacheFormat = current.cache_format ?? inheritedCacheFormat
        result.push({
          ...(budget ? { budget } : {}),
          ref: Model.Ref.make({
            providerID: entry.providerID,
            id: entry.id,
            ...(pin ? { variant: pin.level } : {}),
          }),
          model,
          fixedVariant: pin !== undefined,
          ...(Object.keys(variantMap).length ? { variantMap } : {}),
          ...(cacheFormat ? { cacheFormat } : {}),
        })
      }
    }
    const declared = current.levels
    if (declared !== undefined && routeID !== id && pin === undefined)
      result.slice(first).forEach((leaf, offset) => {
        const index = first + offset
        result[index] = keptTo(leaf, declared)
        allowed.set(index, new Set(declared.filter((level) => allowed.get(index)?.has(level) ?? true)))
      })
    return node.children.length > 0 || override?.keepEmpty ? nodeIndex : undefined
  }

  visit(id, undefined, trailArg, undefined, undefined, undefined, {
    excludes: [],
    rules: [],
    pins: [...enteredAt],
  })
  return { leaves: result, nodes, diagnostics, cut, allowed }
}

/** A target with `false` added for each of `levels` it does not already sit out. */
function sitOut(target: SourceModel, levels: readonly string[]): SourceModel {
  const off = levels.filter((level) => target.variantMap?.[level] !== false)
  if (off.length === 0) return target
  return {
    ...target,
    variantMap: { ...target.variantMap, ...Object.fromEntries(off.map((level) => [level, false] as const)) },
  }
}

/** A member of a pool that declares `levels`, sitting out each declared level it cannot run. */
function keptTo(target: SourceModel, levels: readonly string[]): SourceModel {
  return sitOut(
    target,
    [...new Set(levels)].filter((level) => !runs(target, level)),
  )
}

export function expand(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
  windowsOrCandidate: ReadonlyMap<string, ModelRouteSchedule.Window> | CandidateFn = new Map(),
  providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute> = new Map(),
  candidateArg?: CandidateFn,
  trailArg: ReadonlySet<string> = new Set(),
) {
  const windows: ReadonlyMap<string, ModelRouteSchedule.Window> =
    typeof windowsOrCandidate === "function" ? new Map() : windowsOrCandidate
  const rawCandidate: CandidateFn =
    candidateArg ??
    (typeof windowsOrCandidate === "function"
      ? windowsOrCandidate
      : (providerID, modelID) => definitions.get(providerID)?.get(modelID))
  const memo = new Map<string, Model.Info | undefined>()
  let catalog: readonly { readonly providerID: Provider.ID; readonly id: Model.ID }[] | undefined
  const shared: ExpandShared = {
    candidate: (providerID, modelID) => {
      const key = `${providerID}/${modelID}`
      if (!memo.has(key)) memo.set(key, rawCandidate(providerID, modelID))
      return memo.get(key)
    },
    members: new Map(),
    models: () =>
      (catalog ??= [...definitions].flatMap(([providerID, models]) =>
        [...models.keys()].map((modelID) => ({ providerID, id: Model.ID.make(modelID) })),
      )),
  }
  const collected = expandCollected(id, routes, definitions, windows, providerRoutes, shared.candidate, trailArg, shared)
  const levels = routes.get(id)?.levels
  const asked = [
    ...new Set([
      ...collected.leaves.flatMap((leaf) => [
        ...leaf.model.variants.map((variant) => String(variant.id)),
        ...Object.keys(leaf.variantMap ?? {}),
      ]),
      ...(levels ?? []),
    ]),
  ]
  const opened = collected.leaves.map((leaf, index) => {
    const allowedLevels = collected.allowed.get(index)
    return allowedLevels === undefined ? leaf : sitOut(leaf, asked.filter((level) => !allowedLevels.has(level)))
  })
  if (levels === undefined || opened.length === 0)
    return { leaves: opened, nodes: collected.nodes, diagnostics: collected.diagnostics }
  const leaves = opened.map((leaf) => keptTo(leaf, levels))
  return {
    leaves,
    nodes: collected.nodes,
    diagnostics: [
      ...collected.diagnostics,
      ...[...new Set(levels)]
        .filter((level) => !leaves.some((leaf) => runs(leaf, level)))
        .map(
          (level) => `pool ${id} declares level ${level}, but none of its models can run it, so it is not offered`,
        ),
    ],
  }
}

/** What a retarget produces: the replacement definition, and the variants the route can
 * advertise once the retargeted leaves are known. `definition` is undefined when the
 * expanded target set is unchanged; `variants` is always the set every retargeted leaf
 * can produce, so a caller compares it against the advertised set itself (#869). */
export type Retargeted = {
  readonly definition: ModelRoute.Definition | undefined
  readonly variants: readonly { readonly id: Model.VariantID }[]
}

const sameVariants = (
  left: readonly { readonly id: Model.VariantID }[],
  right: readonly { readonly id: Model.VariantID }[],
) => left.length === right.length && left.every((variant, index) => variant.id === right[index]?.id)

/** The slice of the model editor that re-expansion reads: the immutable provider
 * definitions plus the current, post-model-transform model state. */
export type ModelCatalogEditor = {
  readonly ids: (providerID: Provider.ID) => readonly string[]
  readonly get: (providerID: Provider.ID, modelID: Model.ID) => Model.Info | undefined
  readonly provider: {
    readonly list: () => readonly {
      readonly provider: { readonly id: Provider.ID }
      readonly models: ReadonlyMap<string, Model.Info>
    }[]
  }
}

/** Provider definitions unioned with the models that exist after model transforms
 * have run (#236): for every provider a route target names, the editor's current
 * models are merged over the definition-stage catalog, so transform-created models
 * resolve exactly as catalog models do. */
function currentDefinitions(
  editor: ModelCatalogEditor,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute>,
) {
  // The direct-addressing records of a provider route (#1720) are not concrete providers: left in,
  // they would shadow the provider route at expansion and collapse every seat onto themselves.
  const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
    editor.provider
      .list()
      .filter((record) => !isDirectRouteProvider(providerRoutes.keys(), record))
      .map((record) => [record.provider.id, record.models] as const),
  )
  const targeted = new Set<Provider.ID>()
  for (const route of routes.values()) {
    for (const target of route.targets ?? []) {
      const ref = targetRef(targetSpec(target).model)
      // A door-set target (`*`, #869) names no single provider: every concrete
      // door is targeted, so transform-created models are merged from each
      // door's editor exactly as an explicitly enumerated provider's are.
      // Excluded doors are merged too and stay excluded in expand().
      if (ref.providerID === "*") {
        for (const providerID of definitions.keys()) {
          if (providerID !== ModelRoute.PROVIDER_ID) targeted.add(providerID)
        }
      } else if (ref.providerID !== ModelRoute.PROVIDER_ID) {
        // A provider route target: its members are the concrete providers whose
        // transform-created models the re-expansion must see. The provider route id itself
        // stays out of `definitions`, or it would shadow the provider route at expansion.
        const providerRoute = providerRoutes.get(String(ref.providerID))
        if (providerRoute && !definitions.has(ref.providerID))
          providerRoute.providers.forEach((member) => targeted.add(Provider.ID.make(member)))
        else targeted.add(ref.providerID)
      }
    }
  }
  for (const providerID of targeted) {
    const merged = new Map<string, Model.Info>(definitions.get(providerID) ?? [])
    for (const id of editor.ids(providerID)) {
      const model = editor.get(providerID, Model.ID.make(id))
      if (model) merged.set(String(id), model)
    }
    // The editor does not enumerate every model it holds (a proxy catalog lists
    // effort levels as suffixed ids, not the base model), so a definition-stage
    // entry the editor never names would keep its pre-transform shape — no
    // variants, stale limits — and the re-expansion below would judge targets
    // against it. Refresh every surviving entry from the editor by its own id.
    for (const id of merged.keys()) {
      const model = editor.get(providerID, Model.ID.make(id))
      if (model) merged.set(id, model)
    }
    definitions.set(providerID, merged)
  }
  return definitions
}

/** Builds the route model for a route the provider transform never built — one
 * whose targets were all transform-created (#1001) — from the models that exist
 * after model transforms have run. Returns undefined when the route is unknown
 * or its expansion is still empty, so the caller can name the route in a
 * diagnostic instead of letting it vanish silently. */
export function createRouteModel(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  editor: ModelCatalogEditor,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
  providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute> = new Map(),
  globalSchedules: readonly ModelRoute.WeightRule[] = [],
  directory?: string,
): Model.Info | undefined {
  const route = routes.get(id)
  if (!route) return undefined
  const { leaves, nodes } = expand(
    id,
    routes,
    currentDefinitions(editor, routes, providerRoutes),
    windows,
    providerRoutes,
  )
  if (leaves.length === 0) return undefined
  return routeModel(id, route, leaves, nodes, globalSchedules, directory)
}

/** Re-expands one route's stored definition against the models that exist after model
 * transforms have run: the union of provider-definition ids and current model ids
 * (#236). Transform-created models are resolved from the editor's current state;
 * their ids are enumerated with `ids()` so no catalog model is drafted just to list
 * it. Returns the replacement definition (undefined when the expanded target set is
 * unchanged) together with the variants the retargeted leaves can still produce, or
 * undefined when the expansion is still empty. A route the provider transform never
 * built — one whose targets were all transform-created — has no stored definition
 * to retarget; creating it is createRouteModel's job (#1001). */
export function retargetDefinition(
  current: ModelRoute.Definition,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  editor: ModelCatalogEditor,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
  providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute> = new Map(),
): Retargeted | undefined {
  const definitions = currentDefinitions(editor, routes, providerRoutes)
  const { leaves, nodes } = expand(String(current.id), routes, definitions, windows, providerRoutes)
  if (leaves.length === 0) return undefined
  // The variants the route can still advertise, decided over the retargeted leaves by the
  // same rule the provider transform used over the catalog alone (#869).
  const variants = routeVariants(leaves)
  const targets = leaves.map((leaf) => leaf.ref)
  const targetVariants = leaves.map((leaf) => ({
    ...(leaf.defaultVariant ? { default: leaf.defaultVariant } : {}),
    ...(leaf.variantMap ? { map: leaf.variantMap } : {}),
  }))
  const same =
    targets.length === current.targets.length &&
    targets.every(
      (target, index) =>
        target.providerID === current.targets[index]?.providerID &&
        target.id === current.targets[index]?.id &&
        target.variant === current.targets[index]?.variant,
    )
  // Identical target refs are not enough to keep the stored definition: a
  // transform can add a variant a target's remap names (or a leaf default)
  // without changing any ref, and the stored targetVariants would then be
  // stale — the resolver would find no mapping for a variant the route now
  // advertises and run the model bare instead of at the remapped variant.
  const sameVariants =
    targetVariants.length === current.targetVariants.length &&
    targetVariants.every((entry, index) => {
      const storedEntry = current.targetVariants[index]
      if (storedEntry === undefined || entry.default !== storedEntry.default) return false
      const map = entry.map ?? {}
      const storedMap = storedEntry.map ?? {}
      const keys = Object.keys(map)
      return keys.length === Object.keys(storedMap).length && keys.every((key) => map[key] === storedMap[key])
    })
  if (same && sameVariants) return { definition: undefined, variants }
  const targetCacheFormats = leaves.map((leaf) => (leaf.cacheFormat ? { cacheFormat: leaf.cacheFormat } : {}))
  // Per-target ceilings are parallel to `targets`, so a retarget that adds a leaf
  // (a door set picking up a transform-created model) must rebuild them or the
  // stored entries shift onto the wrong leaves and the new leaf loses its cap
  // (#869 Codex P2). Built by the same rule the provider transform uses.
  const targetLimits =
    current.targetLimits !== undefined || leaves.some((leaf) => leaf.contextLimit !== undefined)
      ? leaves.map((leaf) => ({
          context: Math.min(leaf.model.limit.context, leaf.contextLimit ?? Number.POSITIVE_INFINITY),
        }))
      : undefined
  const { targetCacheFormats: _stored, targetLimits: _storedLimits, ...rest } = current
  const next: ModelRoute.Definition = {
    ...rest,
    targets,
    targetVariants,
    budgets: leaves.map((leaf) => leaf.budget ?? {}),
    ...(targetLimits === undefined ? {} : { targetLimits }),
    nodes,
    ...(targetCacheFormats.some((item) => item.cacheFormat !== undefined) ? { targetCacheFormats } : {}),
  }
  return { definition: next, variants }
}

/** Settings are stored as JSON, which has no undefined: keep only the allowances actually set. */
function plainBudget(budget: ConfigModelRoutes.Budget | undefined): ModelRoute.Budget | undefined {
  if (!budget) return undefined
  const entries = Object.entries(budget).filter(([, value]) => typeof value === "number")
  return entries.length > 0 ? (Object.fromEntries(entries) as ModelRoute.Budget) : undefined
}

function targetSpec(target: ConfigModelRoutes.Target) {
  return typeof target === "string" || "providerID" in target ? { model: target } : target
}

function targetRef(target: ConfigModel.Selection): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(target.providerID),
    id: Model.ID.make(target.model),
    ...(target.variant ? { variant: Model.VariantID.make(target.variant) } : {}),
  })
}

function intersect(values: readonly (readonly string[])[]) {
  const [first, ...rest] = values
  return (first ?? []).filter((value) => rest.every((items) => items.includes(value)))
}

/** Whether a target runs `level` when its pool is selected at it: a pinned target always does, at its
 * pin; any other through its remap or its own variant of that name. A remap to `false` sits it out. */
function runs(target: SourceModel, level: string) {
  const mapped = target.variantMap?.[level]
  if (mapped === false) return false
  return target.fixedVariant || mapped !== undefined || target.model.variants.some((item) => item.id === level)
}

/** A member of a pool that declares `levels`, sitting out each declared level it cannot run. */
/** Level remaps for a target: each map in order, a later one overriding an earlier one level by level. A
 * remap to a variant the model does not have leaves that level alone; false, sitting it out, always
 * applies. */
function effort(
  model: Model.Info,
  maps: readonly Readonly<Record<string, string | false>>[],
): Record<string, Model.VariantID | false> {
  return Object.fromEntries(
    maps.flatMap((map) =>
      Object.entries(map).flatMap(([from, to]): (readonly [string, Model.VariantID | false])[] => {
        if (to === false) return [[from, false]]
        return model.variants.some((item) => item.id === to) ? [[from, Model.VariantID.make(to)]] : []
      }),
    ),
  )
}

export function routeVariants(targets: readonly SourceModel[], levels?: readonly string[]) {
  const offer = (list: readonly string[]) => list.map((id) => ({ id: Model.VariantID.make(id) }))
  if (levels !== undefined)
    return offer([...new Set(levels)].filter((level) => targets.some((target) => runs(target, level))))
  if (targets.some((target) => target.fixedVariant)) return []
  const candidates = new Set(
    targets.flatMap((target) => [
      ...target.model.variants.map((variant) => variant.id),
      ...Object.keys(target.variantMap ?? {}),
    ]),
  )
  return offer(
    [...candidates].filter(
      (level) =>
        targets.some((target) => runs(target, level)) &&
        targets.every((target) => runs(target, level) || target.variantMap?.[level] === false),
    ),
  )
}
