import { Effect, Option } from "effect"
import type { Document, Entry } from "@opencode/schema/config"
import { Config } from "../../config.js"
import { Provider } from "../../provider.js"

export interface SettingsConflict {
  readonly providerID: string
  readonly seatedPackage: string
  readonly conflictingPackage: string
}

/**
 * Package seating for one provider across config documents (#1858): the first
 * document (entry order) declaring `providers[id].package` seats that provider.
 * A later document declaring a *different* package for the same id is in
 * conflict: its settings for that id must not fold into the seated provider —
 * otherwise any plugin that merely names a provider in config can hijack the
 * settings (including baseURL) of the provider another package owns.
 * Documents declaring no package are user config and always fold.
 */
export function seating(entries: readonly Entry[], id: string) {
  let seated: string | undefined
  const conflicts: SettingsConflict[] = []
  const conflicting = new Set<Entry>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    const info = entry.info.providers?.[id]
    if (!info || info.package === undefined) continue
    if (seated === undefined) {
      seated = info.package
      continue
    }
    if (info.package !== seated) {
      conflicts.push({ providerID: id, seatedPackage: seated, conflictingPackage: info.package })
      conflicting.add(entry)
    }
  }
  return { seated, conflicts, conflicting }
}

/** Every seating conflict across all providers named in the entries (#1858). */
export function settingsConflicts(entries: readonly Entry[]) {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const id of Object.keys(entry.info.providers ?? {})) ids.add(id)
  }
  return [...ids].flatMap((id) => seating(entries, id).conflicts)
}

export const configuredSettings = Effect.fn("ProviderPlugin.configuredSettings")(function* (id: Provider.ID) {
  const providers = yield* Provider.Service
  const current = (yield* providers.get(id))?.settings
  const service = yield* Effect.serviceOption(Config.Service)
  const entries = Option.isSome(service) ? yield* service.value.entries() : []
  for (const conflict of seating(entries, id).conflicts)
    yield* Effect.logWarning(
      "config declares a conflicting package for a provider; the conflicting document's settings for that provider are ignored",
      {
        providerID: conflict.providerID,
        seatedPackage: conflict.seatedPackage,
        conflictingPackage: conflict.conflictingPackage,
      },
    )
  return foldSettings(entries, id, current)
})

export function foldSettings(
  entries: readonly Entry[],
  id: string,
  initial: Provider.Settings | undefined,
): Provider.Settings | undefined {
  const { conflicting } = seating(entries, id)
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<Provider.Settings | undefined>(
      (settings, entry) =>
        conflicting.has(entry)
          ? settings
          : (Provider.mergeOverlay(settings, entry.info.providers?.[id]?.settings) as Provider.Settings | undefined),
      initial,
    )
}
