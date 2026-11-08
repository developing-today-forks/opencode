/** Wildcard (glob) matching for the TUI model picker (#230), sharing the
 * semantics of the app picker (packages/app/src/providers/models/search.ts)
 * and the route-pool matcher of PR #233: a pattern containing "/" is matched
 * against the full provider/model text; a pattern without "/" is matched
 * against the model id (the last "/" segment) alone, so it applies across
 * providers. "*" is the only wildcard; matching is case-insensitive and
 * anchored. */
export const isWildcardSearch = (query: string) => query.includes("*")

const globToRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? ".*" : `\\${char}`))}$`, "i")

export const matchesWildcardSearch = (query: string, values: string[]) => {
  const pattern = query.trim()
  if (!isWildcardSearch(pattern)) return false
  const regex = globToRegExp(pattern)
  if (pattern.includes("/")) return values.some((value) => regex.test(value.trim()))
  return values.some((value) => {
    const trimmed = value.trim()
    return regex.test(trimmed.split("/").at(-1) ?? trimmed)
  })
}
