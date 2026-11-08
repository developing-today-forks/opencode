export * as GovernanceConfig from "./governance-config.js"

import { Context, Effect, LayerMap, Option } from "effect"
import type { Entry } from "@opencode/schema/config"
import { Config } from "../config.js"
import { ConfigAgentDocuments } from "../config/agent-documents.js"
import { FSUtil } from "@opencode/util/fs-util"
import type { Instance } from "../instance.js"
import { Location } from "../location.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { ModelGovernance } from "./model-governance.js"

export type Result = {
  entries: Entry[]
  catalog: ModelGovernance.Catalog | undefined
}

/**
 * The governance inputs for a location: its config entries plus the provider
 * catalog governance judges route targets against (#530). Read only from an
 * already-initialized location context — session operations never initialize
 * a location just to read them. An uninitialized location has no definition
 * layer and supplies no catalog, so route targets are judged literally; a
 * location with no provider service likewise supplies no catalog. Any failure
 * falls back to the empty result.
 *
 * This construction exists exactly once: the session-creation path
 * (session.ts) and the switchAgent / model-selection paths
 * (session/session.ts) must judge against the same catalog, or the same route
 * could be allowed by one entry point and denied by the other.
 */
export const load = (
  locations: LayerMap.LayerMap<Location.Ref, Instance.Services, Instance.Error> | undefined,
  location: Location.Ref,
): Effect.Effect<Result> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (locations === undefined)
        return { entries: [] as Entry[], catalog: undefined as ModelGovernance.Catalog | undefined }
      const context = yield* locations.contextEffectOption(location)
      if (Option.isNone(context))
        return { entries: [] as Entry[], catalog: undefined as ModelGovernance.Catalog | undefined }
      const config = Context.getOption(context.value, Config.Service)
      const rawEntries = config._tag === "Some" ? yield* config.value.entries() : ([] as Entry[])
      // Governance judges the directory-expanded entries, so agents defined
      // only in Markdown under a config directory are governed by the same
      // fields the agent editor applies (#1107). Without an FS in this
      // location the raw entries are judged as before.
      const fs = Context.getOption(context.value, FSUtil.Service)
      const entries =
        fs._tag === "Some" ? yield* ConfigAgentDocuments.expandEntries(fs.value, rawEntries) : rawEntries
      const provider = Context.getOption(context.value, Provider.Service)
      if (provider._tag === "None") return { entries, catalog: undefined }
      const snapshot = yield* provider.value.snapshot()
      const built: ModelGovernance.Catalog = new Map(
        Array.from(snapshot.records, ([providerID, record]) => [
          providerID as string,
          new Map(
            Array.from(record.models, ([id, model]) => [
              id as string,
              { enabled: model.enabled, variants: model.variants },
            ]),
          ),
        ]),
      )
      // The provider snapshot predates model transforms, so models a transform
      // creates (Azure deployments, #236) are invisible to governance's glob and
      // matching-key expansion. Union the catalog with the location's current
      // Model state when one is initialized; current state wins per model, since
      // it is what the runtime resolves against.
      const model = Context.getOption(context.value, Model.Service)
      if (model._tag === "None") return { entries, catalog: built }
      const current = yield* model.value.all()
      return { entries, catalog: withCurrentModels(built, current) }
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({ entries: [] as Entry[], catalog: undefined as ModelGovernance.Catalog | undefined })),
  )

/** A governance catalog unioned with current (post-model-transform) models: every
 * model in `models` is present under its provider, replacing the snapshot entry for
 * the same id, so transform-created models are judged like catalog models (#236). */
export function withCurrentModels(
  catalog: ModelGovernance.Catalog,
  models: readonly Model.Info[],
): ModelGovernance.Catalog {
  const merged = new Map(Array.from(catalog, ([providerID, provider]) => [providerID, new Map(provider)] as const))
  for (const model of models) {
    const providerID = String(model.providerID)
    const provider = merged.get(providerID) ?? new Map<string, ModelGovernance.CatalogModel>()
    provider.set(String(model.id), { enabled: model.enabled, variants: model.variants })
    merged.set(providerID, provider)
  }
  return merged
}
