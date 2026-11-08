export * as ModelGovernance from "./model-governance.js"

import { Effect, Schema } from "effect"
import type { Entry } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { Agent } from "@opencode/schema/agent"
import { Config } from "../config.js"
import { ModelRouteExpansion } from "../model-route-expansion.js"
import type { Session } from "../session.js"
import { SessionSchema } from "./schema.js"

export class DeniedError extends Schema.TaggedError<DeniedError>()("ModelGovernance.DeniedError", {
  message: Schema.String,
}) {}

/** The model-relevant slice of an agent definition, resolved from config entries. */
export type Definition = {
  model?: Model.Ref
  models?: readonly Model.Selector[]
  excludedModels?: readonly Model.Selector[]
  subagentModels?: readonly Model.Selector[]
  subagentExcludedModels?: readonly Model.Selector[]
  maxDepth?: number
}

/**
 * Agent definitions from config entries, merged in entry order the way the
 * config agent plugin applies them: later documents override earlier fields.
 * Agents defined only by plugins carry no definition here and are treated as
 * unrestricted by the definition layer; session policy still governs them.
 *
 * Callers feed this directory-expanded entries (ConfigAgentDocuments, via
 * GovernanceConfig and the SubagentDepth callers), so an agent defined only
 * in a Markdown file under a config directory is visible here with the same
 * fields the config agent plugin applies to the agent editor (#1107).
 */
export function agentDefinitions(entries: readonly Entry[]): Map<string, Definition> {
  const definitions = new Map<string, Definition>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [id, item] of Object.entries(entry.info.agents ?? {})) {
      const current = definitions.get(id) ?? {}
      if (item.model !== undefined)
        current.model = {
          id: Model.ID.make(item.model.model),
          providerID: Provider.ID.make(item.model.providerID),
          ...(item.model.variant === undefined ? {} : { variant: Model.VariantID.make(item.model.variant) }),
        }
      if (item.models !== undefined) current.models = item.models
      if (item.excluded_models !== undefined) current.excludedModels = item.excluded_models
      if (item.subagent_models !== undefined) current.subagentModels = item.subagent_models
      if (item.subagent_excluded_models !== undefined) current.subagentExcludedModels = item.subagent_excluded_models
      if (item.max_depth !== undefined) current.maxDepth = item.max_depth
      definitions.set(id, current)
    }
  }
  return definitions
}

type Tagged = { selector: Model.Selector; layer: string }

const refString = (ref: Model.Ref) => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

function intersectSelectors(a: readonly Model.Selector[], b: readonly Model.Selector[]): Model.Selector[] {
  const result: Model.Selector[] = []
  for (const left of a) {
    for (const right of b) {
      const narrower = Model.Selector.intersect(left, right)
      if (narrower !== undefined && !result.includes(narrower)) result.push(narrower)
    }
  }
  return result
}

function intersectAllowed(
  current: Tagged[] | undefined,
  list: readonly Model.Selector[] | undefined,
  layer: string,
): Tagged[] | undefined {
  if (list === undefined) return current
  if (current === undefined) return list.map((selector) => ({ selector, layer }))
  const result: Tagged[] = []
  for (const existing of current) {
    for (const selector of list) {
      const narrower = Model.Selector.intersect(existing.selector, selector)
      if (narrower === undefined) continue
      if (result.some((item) => item.selector === narrower)) continue
      // The narrower selector is the one that binds, so it keeps its layer.
      result.push({ selector: narrower, layer: narrower === existing.selector ? existing.layer : layer })
    }
  }
  return result
}

function unionExcluded(
  current: Tagged[],
  list: readonly Model.Selector[] | undefined,
  layer: string,
): Tagged[] {
  if (list === undefined) return current
  const result = [...current]
  for (const selector of list) {
    if (!result.some((item) => item.selector === selector)) result.push({ selector, layer })
  }
  return result
}

function applyOverride(
  definition: { allowed: readonly Model.Selector[] | undefined; excluded: readonly Model.Selector[] | undefined },
  override: SessionSchema.AgentOverride | undefined,
) {
  if (override === undefined) return definition
  // An override that addresses only the subagent lists leaves the agent's own lists
  // alone: its force must not clear a list group it never mentions (#508). An override
  // carrying no list fields at all (e.g. the Task tool's `{ model, force }`) still
  // forces the agent's own lists, as its documentation promises.
  if (
    override.models === undefined &&
    override.excludedModels === undefined &&
    (override.subagentModels !== undefined || override.subagentExcludedModels !== undefined)
  )
    return definition
  if (override.force === true) return { allowed: override.models, excluded: override.excludedModels }
  return {
    allowed:
      override.models === undefined
        ? definition.allowed
        : definition.allowed === undefined
          ? override.models
          : intersectSelectors(definition.allowed, override.models),
    excluded: [...(definition.excluded ?? []), ...(override.excludedModels ?? [])],
  }
}

/**
 * The same override composition for an agent's subagent lists: an override's
 * `subagentModels` / `subagentExcludedModels` narrow (or, with `force`,
 * replace) the lists it overrides, exactly as its `models` / `excludedModels`
 * do for the agent's own lists in `applyOverride`.
 */
function applySubagentOverride(
  definition: { allowed: readonly Model.Selector[] | undefined; excluded: readonly Model.Selector[] | undefined },
  override: SessionSchema.AgentOverride | undefined,
) {
  if (override === undefined) return definition
  // Symmetrically, an override carrying no subagent lists at all leaves the launching
  // agent's subagent lists in force — its force is aimed at the child agent's own
  // lists and must not clear a group it never mentions (#508).
  if (override.subagentModels === undefined && override.subagentExcludedModels === undefined) return definition
  return applyOverride(definition, {
    models: override.subagentModels,
    excludedModels: override.subagentExcludedModels,
    force: override.force,
  })
}

/**
 * The provider catalog governance judges route targets against: the slice of
 * each catalog model the target set depends on. Call sites supply it from the
 * location's provider snapshot when one is initialized; without a catalog,
 * route targets are judged literally as before (see `routeTargets`).
 */
export type CatalogModel = {
  enabled: boolean
  variants: readonly { id: string }[]
}
export type Catalog = ReadonlyMap<string, ReadonlyMap<string, CatalogModel>>

/** Route targets from config entries, following nested route references.
 * Each target is judged at the variant it will actually run, mirroring the
 * runtime resolution in model-resolver.ts: the target selection's own variant
 * wins, else the route-requested variant remapped through the target's
 * `variants` (an unremapped requested variant runs as-is), else the target's
 * `defaultVariant`. A nested route inherits its referencing selection's
 * variant, else the outer requested variant — the intermediate target object's
 * own `defaultVariant`/`variants` never reach the inner route's leaves, exactly
 * as in the model-routes plugin's expansion.
 *
 * The target SET mirrors the runtime too (#530): a target whose `until` has
 * passed is dropped, a target naming a `*` pattern expands to every matching
 * catalog model via the shared `ModelRouteExpansion.matchingModels` the
 * plugin runs, a provider-route target expands over its configured concrete
 * members, a door-set target (provider `*`, #637) expands over every catalog
 * door via the shared `matchingProviders` minus its exclusions, and catalog
 * models that are disabled are dropped. Per leaf,
 * the effective variant is filtered the way the plugin expansion filters it
 * before the resolver runs: a pinned or requested variant runs at the
 * target's remap of it when the leaf offers the remapped variant, else at
 * the variant itself when the leaf offers it, else the leaf is dropped
 * (#869); a `defaultVariant` applies only when the leaf offers it. Expansion needs the catalog: when none is supplied
 * (or the provider is absent from it), a pattern target is judged as its
 * literal ref and a concrete target is judged as named, exactly as
 * governance behaved before it had a catalog. A concrete target the catalog
 * does not hold is still judged as named (fail-closed: an allowed list can
 * reject it), where the plugin would drop it. */
/** A variants-remap lookup with own-property semantics: a requested variant
 * named after an Object.prototype member (e.g. "constructor") is unremapped
 * unless the target's variants record defines it itself (#831). */
const ownVariant = (
  variants: Readonly<Record<string, string>> | undefined,
  requested: string,
): string | undefined => (variants && Object.hasOwn(variants, requested) ? variants[requested] : undefined)

function routeTargets(
  entries: readonly Entry[],
  routeID: string,
  seen: Set<string>,
  requestedVariant?: Model.VariantID,
  catalog?: Catalog,
): Model.Ref[] {
  if (seen.has(routeID)) return []
  seen.add(routeID)
  const configuredRoutes = Config.latest(entries, "experimental")?.routes
  const routes = configuredRoutes?.models
  const providerRoutes = configuredRoutes?.providers
  // Own-property lookup: a route named after an Object.prototype member
  // (e.g. "constructor") must read as an unknown route, not the inherited
  // member (#831).
  const route = routes && Object.hasOwn(routes, routeID) ? routes[routeID] : undefined
  if (route === undefined) return []
  const requested = requestedVariant === "default" ? undefined : requestedVariant
  return route.targets.flatMap((target) => {
    const selection = "providerID" in target ? target : target.model
    const object = "providerID" in target ? undefined : target
    const selectionVariant =
      selection.variant === undefined || selection.variant === "default"
        ? undefined
        : Model.VariantID.make(selection.variant)
    if (object?.until !== undefined && Date.now() >= object.until) return []
    if (selection.providerID === "opencode-route")
      return routeTargets(entries, selection.model, seen, selectionVariant ?? requested, catalog)
    const rawVariant =
      selectionVariant ??
      (requested === undefined
        ? object?.defaultVariant === undefined
          ? undefined
          : Model.VariantID.make(object.defaultVariant)
        : Model.VariantID.make(ownVariant(object?.variants, requested) ?? requested))
    const literal = {
      id: Model.ID.make(selection.model),
      providerID: Provider.ID.make(selection.providerID),
      ...(rawVariant === undefined ? {} : { variant: rawVariant }),
    } satisfies Model.Ref
    const models = catalog?.get(selection.providerID)
    // The variant a known catalog leaf actually runs, or undefined when the
    // leaf is dropped (disabled, or its fixed variant is not offered).
    const leaf = (
      providerID: string,
      id: string,
      model: CatalogModel,
      doorModels?: ReadonlyMap<string, CatalogModel>,
    ): Model.Ref[] => {
      if (!model.enabled) return []
      const offers = (variant: string) => model.variants.some((item) => item.id === variant)
      // Runtime producibility (#985): a variant also runs when the door's catalog
      // exposes it as a suffixed model id (`${id}-${variant}`), as proxy catalogs
      // enumerate effort levels that way and carry no variant list for them.
      const producible = (variant: string) => offers(variant) || (doorModels?.has(`${id}-${variant}`) ?? false)
      // A pinned or route-requested variant resolves through the target's remap
      // table exactly as the plugin expansion resolves it (#869): the remapped
      // variant when the leaf offers it, else the variant itself when offered,
      // else the leaf is pruned — governance must not judge a variant that never
      // runs, nor keep a leaf the plugin drops. The remap read itself is
      // own-property only (#831's ownVariant).
      const wanted = selectionVariant ?? requested
      if (wanted !== undefined) {
        const remapped = ownVariant(object?.variants, wanted)
        const variant =
          remapped !== undefined && producible(remapped)
            ? Model.VariantID.make(remapped)
            : producible(wanted)
              ? wanted
              : undefined
        return variant === undefined
          ? []
          : [{ id: Model.ID.make(id), providerID: Provider.ID.make(providerID), variant }]
      }
      const variant =
        object?.defaultVariant !== undefined && offers(object.defaultVariant)
          ? Model.VariantID.make(object.defaultVariant)
          : undefined
      return [
        {
          id: Model.ID.make(id),
          providerID: Provider.ID.make(providerID),
          ...(variant === undefined ? {} : { variant }),
        },
      ]
    }
    // Provider routes share the target's provider namespace with concrete providers:
    // a catalog provider always wins, just as it does during runtime expansion.
    if (catalog !== undefined && !catalog.has(selection.providerID)) {
      const providerRoute =
        providerRoutes && Object.hasOwn(providerRoutes, selection.providerID)
          ? providerRoutes[selection.providerID]
          : undefined
      if (providerRoute !== undefined) {
        // The runtime drops a provider route whose id names a configured model
        // route (configuredProviderRoutes in model-routes.ts): the declaration is
        // ignored, so the target is dropped with it instead of being expanded
        // over members runtime would never reach.
        if (routes && Object.hasOwn(routes, selection.providerID)) return []
        return providerRoute.providers.flatMap((providerID) => {
          const memberModels = catalog.get(providerID)
          if (memberModels === undefined) return []
          if (!selection.model.includes("*")) {
            const known = memberModels.get(selection.model)
            return known === undefined ? [] : leaf(providerID, selection.model, known, memberModels)
          }
          return ModelRouteExpansion.matchingModels(selection.model, memberModels).flatMap(([id, model]) =>
            leaf(providerID, id, model, memberModels),
          )
        })
      }
    }
    // A door-set target (`*/model`, #637) is judged over every catalog door
    // except its exclusions, via the same shared helper the plugin expands
    // with; without a catalog it is judged literally, as patterns are.
    if (selection.providerID === "*") {
      if (catalog === undefined) return [literal]
      return ModelRouteExpansion.matchingProviders(catalog, object?.exclude ?? [], "opencode-route").flatMap(
        ([providerID, doorModels]) =>
          ModelRouteExpansion.matchingModels(selection.model, doorModels).flatMap(([id, model]) =>
            leaf(providerID, id, model, doorModels),
          ),
      )
    }
    if (!selection.model.includes("*")) {
      const known = models?.get(selection.model)
      return known === undefined ? [literal] : leaf(selection.providerID, selection.model, known, models)
    }
    if (models === undefined) return [literal]
    return ModelRouteExpansion.matchingModels(selection.model, models).flatMap(([id, model]) =>
      leaf(selection.providerID, id, model, models),
    )
  })
}

export type Input = {
  /** The launching session; its ancestry supplies the hard subtree filter. */
  parent: SessionSchema.Info
  /** The child session's agent, when known. */
  agent?: Agent.ID
  /** The explicit model choice for the child, when one was made. */
  model?: Model.Ref
  /** The per-call override from the launching tool, when one was supplied. */
  override?: SessionSchema.AgentOverride
}

/**
 * The model governance judges for `input`, in precedence order: the explicit
 * choice, the per-call override's model, the session policy's per-agent
 * override, the child agent's configured default, then the parent's model.
 * Session creation stores this model on a model-less child so the model that
 * is checked is the model that runs (#507): the runner otherwise resolves a
 * model-less session against the global default, which governance never saw.
 */
export function checkedModel(entries: readonly Entry[], input: Input): Model.Ref | undefined {
  const definitions = agentDefinitions(entries)
  const policyOverride =
    input.agent === undefined ? undefined : input.parent.subagentPolicy?.agentOverrides?.[input.agent]
  const definition = input.agent === undefined ? undefined : definitions.get(input.agent)
  return input.model ?? input.override?.model ?? policyOverride?.model ?? definition?.model ?? input.parent.model
}

/**
 * Answers whether a child of `input.parent`, running `input.agent`, may run its
 * would-be model: the explicit choice, then the (possibly overridden) agent
 * default, then the parent's model. Restrictions compose by intersection down
 * the tree — ancestor session policies are hard, the launching agent's subagent
 * lists bind its direct children, and the child agent's own lists apply with
 * explicit overrides (policy `agentOverrides`, then the per-call override).
 * An override's subagent lists compose into the launching agent's layer with
 * the same force semantics as its own lists compose into the child's layer.
 * A route-named model passes only when every target of the route passes, each
 * judged at its effective variant (see `routeTargets`).
 */
export const assertAllowed = Effect.fn("ModelGovernance.assertAllowed")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries"> & { catalog?: () => Effect.Effect<Catalog | undefined> },
  input: Input,
) {
  const entries = yield* config.entries()
  const catalog = config.catalog ? yield* config.catalog() : undefined
  const definitions = agentDefinitions(entries)

  const chain: SessionSchema.Info[] = [input.parent]
  const seen = new Set([input.parent.id])
  let current = input.parent
  // A fork is projected top-level (no parentID) but is a child of its source
  // for governance (spec §6.2): follow the fork link when there is no parent
  // link, so a fork cannot escape the policies above its source (#505).
  let governanceParentID = current.parentID ?? current.fork?.sessionID
  while (governanceParentID) {
    if (seen.has(governanceParentID))
      return yield* new DeniedError({ message: `Session parent cycle: ${governanceParentID}` })
    seen.add(governanceParentID)
    const parentID = governanceParentID
    current = yield* sessions
      .get(parentID)
      .pipe(Effect.mapError(() => new DeniedError({ message: `Parent session not found: ${parentID}` })))
    chain.push(current)
    governanceParentID = current.parentID ?? current.fork?.sessionID
  }

  // Layer 1: ancestor session policies, hard at every level.
  let allowed: Tagged[] | undefined
  let excluded: Tagged[] = []
  // Every layer that narrowed the allowed set, kept so a denial can name what
  // bound it even when the intersection leaves nothing allowed.
  const restrictionLayers: string[] = []
  const narrow = (list: readonly Model.Selector[] | undefined, layer: string) => {
    if (list !== undefined && !restrictionLayers.includes(layer)) restrictionLayers.push(layer)
    allowed = intersectAllowed(allowed, list, layer)
  }
  for (const session of chain) {
    const layer = `session policy of session ${session.id}`
    narrow(session.subagentPolicy?.models, layer)
    excluded = unionExcluded(excluded, session.subagentPolicy?.excludedModels, layer)
  }

  // The explicit overrides for this launch, applied to both the launching
  // agent's subagent lists (layer 2) and the child agent's own lists (layer 3).
  const policyOverride =
    input.agent === undefined ? undefined : input.parent.subagentPolicy?.agentOverrides?.[input.agent]

  // Layer 2: the launching agent's subagent lists bind the children it
  // launches, with the launch's explicit overrides composed into them — an
  // override's subagent lists bind even when the launching agent has no
  // config definition to override.
  const launcher = input.parent.agent === undefined ? undefined : definitions.get(input.parent.agent)
  if (input.parent.agent !== undefined) {
    const layer = `subagent models of agent ${input.parent.agent}`
    const overridden = applySubagentOverride(
      applySubagentOverride(
        { allowed: launcher?.subagentModels, excluded: launcher?.subagentExcludedModels },
        policyOverride,
      ),
      input.override,
    )
    narrow(overridden.allowed, layer)
    excluded = unionExcluded(excluded, overridden.excluded, layer)
  }

  // Layer 3: the child agent's own lists, with explicit overrides applied.
  const definition = input.agent === undefined ? undefined : definitions.get(input.agent)
  const overridden = applyOverride(
    applyOverride({ allowed: definition?.models, excluded: definition?.excludedModels }, policyOverride),
    input.override,
  )
  if (input.agent !== undefined) {
    const layer = `models of agent ${input.agent}`
    narrow(overridden.allowed, layer)
    excluded = unionExcluded(excluded, overridden.excluded, layer)
  }

  const model = checkedModel(entries, input)
  if (model === undefined) return

  const targets =
    model.providerID === "opencode-route"
      ? routeTargets(entries, model.id, new Set(), model.variant, catalog)
      : undefined
  const checked = targets !== undefined && targets.length > 0 ? targets : [model]
  for (const target of checked) {
    const deniedBy = excluded.find((item) => Model.Selector.matches(item.selector, target))
    if (deniedBy !== undefined)
      return yield* new DeniedError({
        message: `Model ${refString(target)}${targets !== undefined ? ` (target of route ${refString(model)})` : ""} is not allowed for this subagent: it is excluded by ${deniedBy.layer} (${deniedBy.selector}). Allowed models: ${allowed === undefined ? "any model not excluded" : allowed.map((item) => item.selector).join(", ") || "none"}.`,
      })
    if (allowed !== undefined && !allowed.some((item) => Model.Selector.matches(item.selector, target)))
      return yield* new DeniedError({
        message: `Model ${refString(target)}${targets !== undefined ? ` (target of route ${refString(model)})` : ""} is not allowed for this subagent. Allowed models: ${allowed.map((item) => item.selector).join(", ") || "none"}. Bound by ${(allowed.length > 0 ? [...new Set(allowed.map((item) => item.layer))] : restrictionLayers).join(", ")}.`,
      })
  }
})
