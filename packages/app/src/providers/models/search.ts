export const normalizeModelSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

/** The reveal rule for picker-hidden models (#230): only a search that is the
 * model's exact full name (typed completely) reveals it. Partial matches do
 * not. Comparison is case-insensitive and ignores surrounding whitespace. */
export const isExactModelName = (query: string, values: string[]) => {
  const search = query.trim().toLowerCase()
  if (!search) return false
  return values.some((value) => value.trim().toLowerCase() === search)
}

/** Wildcard (glob) matching for picker search (#230), sharing the route-pool
 * matcher semantics of PR #233: a pattern containing "/" is matched against
 * the full provider/model text; a pattern without "/" is matched against the
 * model id (the last "/" segment) alone, so it applies across providers. "*"
 * is the only wildcard; matching is case-insensitive and anchored. */
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

export const matchesModelSearch = (query: string, values: string[]) => {
  if (isWildcardSearch(query)) return matchesWildcardSearch(query, values)

  const search = normalizeModelSearch(query)

  if (!search) return true

  const compactSearch = compactModelSearch(query)

  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}
