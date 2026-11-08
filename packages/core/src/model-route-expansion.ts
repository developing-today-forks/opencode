export * as ModelRouteExpansion from "./model-route-expansion.js"

/**
 * The models a route target pattern represents, shared by the model-routes
 * plugin (which runs the expanded set) and session model governance (which
 * judges it) so the two can never disagree on what a `*` pattern means (#530).
 * A model id without a pattern resolves to itself when the provider's catalog
 * holds it; a pattern matches every catalog model id it covers, in the
 * provider's order.
 */
/**
 * The doors a door-set target (#637) expands over: every provider in the
 * catalog except the routes provider itself and the target's exclusions.
 * Exclusions always win. Shared by the model-routes plugin (which runs the
 * expanded set) and session model governance (which judges it), like
 * `matchingModels`, so the two can never disagree on what a door set means.
 * Providers removed by `disabled_providers` are absent from the catalog
 * already, so they can never contribute a leaf.
 */
export function matchingProviders<K extends string, T>(
  providers: ReadonlyMap<K, ReadonlyMap<string, T>>,
  exclude: readonly string[] = [],
  routesProvider?: string,
): [K, ReadonlyMap<string, T>][] {
  return [...providers].filter(([providerID]) => providerID !== routesProvider && !exclude.includes(providerID))
}

export function matchingModels<T>(pattern: string, models: ReadonlyMap<string, T> | undefined): [string, T][] {
  if (!models) return []
  if (!pattern.includes("*")) {
    const model = models.get(pattern)
    return model ? [[pattern, model] as const] : []
  }
  const matcher = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  )
  return [...models].filter(([id]) => matcher.test(id))
}
