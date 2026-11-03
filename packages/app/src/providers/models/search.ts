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

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)

  if (!search) return true

  const compactSearch = compactModelSearch(query)

  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}
