// Orders running subagents as a tree: each one followed by the running subagents below it, at any depth, each with
// its depth below the nearest listed ancestor. A subagent whose ancestors are not listed starts at depth 0. Siblings
// keep their input order.
export function nestRunning<T extends { readonly sessionID: string }>(
  items: readonly T[],
  parentOf: (sessionID: string) => string | undefined,
): { item: T; depth: number }[] {
  const listed = new Map(items.map((item) => [item.sessionID, item]))
  // The nearest listed ancestor, with a cycle guard.
  const ancestor = (sessionID: string) => {
    const seen = new Set([sessionID])
    let parent = parentOf(sessionID)
    while (parent !== undefined && !seen.has(parent)) {
      if (listed.has(parent)) return parent
      seen.add(parent)
      parent = parentOf(parent)
    }
    return undefined
  }
  const children = Map.groupBy(items, (item) => ancestor(item.sessionID))
  const placed = new Set<string>()
  const walk = (parent: string | undefined, depth: number): { item: T; depth: number }[] =>
    (children.get(parent) ?? []).flatMap((item) => {
      if (placed.has(item.sessionID)) return []
      placed.add(item.sessionID)
      return [{ item, depth }, ...walk(item.sessionID, depth + 1)]
    })
  const rows = walk(undefined, 0)
  // Items in a parent cycle have no root to hang from; they start their own branches.
  for (const item of items) if (!placed.has(item.sessionID)) rows.push(...walk(ancestor(item.sessionID), 0))
  return rows
}
