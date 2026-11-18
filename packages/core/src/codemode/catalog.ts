export * as CodeModeCatalog from "./catalog.js"

import { Schema } from "effect"
import { Text } from "../util/text.js"

export type Tool = {
  readonly type: "tool"
  readonly name: string
  readonly description: string
  /** Read only for the tools the catalog shows. */
  readonly signature: string
  readonly pinned?: boolean
}

export type Namespace = {
  readonly type: "namespace"
  readonly name: string
  readonly description?: string
  readonly tools: ReadonlyArray<Tool | Namespace>
}

export type Inventory = {
  readonly tools: ReadonlyArray<Tool | Namespace>
}

const Listing = Schema.Struct({
  path: Schema.String,
  line: Schema.String,
  pinned: Schema.optionalKey(Schema.Boolean),
})
export type Listing = typeof Listing.Type

const NamespaceSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Every tool's path, so an update can tell a new tool from one that was not shown. */
  tools: Schema.Array(Schema.String),
  entries: Schema.Array(Listing),
  inline: Schema.optionalKey(Schema.Boolean),
})
export type NamespaceSummary = typeof NamespaceSummary.Type

export const Summary = Schema.Struct({
  total: Schema.Number,
  namespaces: Schema.Array(NamespaceSummary),
})
export type Summary = typeof Summary.Type

export type Options = {
  readonly budget?: number
}

const DESCRIPTION_LIMIT = 120
const CHARACTERS_PER_TOKEN = 4
const INLINE_BUDGET = 2_000

<<<<<<< HEAD
// Keep namespace inventory available for updates/search, but only render summaries and
// listings that fit the inline budget. Full listings are selected round-robin.
=======
// Keep every namespace visible, then select full listings one per namespace per round, in path order, until the
// inline budget is exhausted. The selection depends only on the tools, and only selected signatures are rendered.
>>>>>>> upstream-anomalyco/dev
export function summarize(inventory: Inventory, options: Options = {}): Summary {
  const budget = options.budget ?? INLINE_BUDGET
  const flattened = flatten(inventory.tools)
  const namespaces = [...Map.groupBy(flattened.tools, (tool) => tool.path.split(".", 1)[0] ?? tool.path)]
    .sort(([left], [right]) => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
    .map(([name, namespaceEntries]) => {
      const description = flattened.namespaces.get(name)?.description
<<<<<<< HEAD
      const listings = namespaceEntries
        .map((entry) => {
          const firstLine = entry.description.split("\n", 1)[0]?.trim() ?? ""
          const description =
            firstLine.length > DESCRIPTION_LIMIT ? Text.truncate(firstLine, DESCRIPTION_LIMIT - 3) + "..." : firstLine
          const suffix = description.length === 0 ? "" : ` // ${description}`
          return {
            path: entry.path,
            line: `  - ${entry.signature}${suffix}`,
            ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
          }
        })
        .toSorted((left, right) => {
          if (left.path < right.path) return -1
          if (left.path > right.path) return 1
          return 0
        })
      const ranked = rankListings(listings)
      const pinned = new Set(
        namespaceEntries
          .filter((entry) => entry.pinned)
          .map((entry) => listings.find((listing) => listing.path === entry.path))
          .filter((listing) => listing !== undefined),
      )
=======
      const sorted = namespaceEntries.toSorted((left, right) => {
        if (left.path < right.path) return -1
        if (left.path > right.path) return 1
        return 0
      })
>>>>>>> upstream-anomalyco/dev
      return {
        name,
        ...(description === undefined ? {} : { description }),
        tools: sorted.map((entry) => entry.path),
        selectionOrder: sorted.filter((entry) => !entry.tool.pinned),
        selectedListings: sorted.filter((entry) => entry.tool.pinned).map(listing),
        selectionIndex: 0,
        inline: false,
      }
    })

<<<<<<< HEAD
  const pinnedCost = namespaces
    .flatMap((namespace) => namespace.listings.filter((listing) => namespace.selectedListings.has(listing)))
    .reduce((total, listing) => total + cost(listing.line), 0)
  let remaining = Math.max(0, budget - pinnedCost)
  const summaryCandidates = namespaces
    .map((namespace) => {
      // Reserve the longest header this namespace can render with: the shown count at
      // render time can be anything from 0 ("none shown") up to the full count, and a
      // header reserved for a shorter label would let the rendered catalog exceed the
      // budget when a longer label is used.
      const header = {
        name: namespace.name,
        ...(namespace.description === undefined ? {} : { description: namespace.description }),
        count: namespace.listings.length,
        entries: [],
        inline: true,
      }
      return {
        namespace,
        cost: Math.max(
          cost(namespaceLine(header, 0)),
          cost(namespaceLine(header, Math.max(0, namespace.listings.length - 1))),
        ),
      }
    })
    .toSorted((left, right) => {
      if (left.cost !== right.cost) return left.cost - right.cost
      if (left.namespace.name < right.namespace.name) return -1
      if (left.namespace.name > right.namespace.name) return 1
      return 0
    })
  for (const candidate of summaryCandidates) {
    if (candidate.cost > remaining) continue
    candidate.namespace.inline = true
    remaining -= candidate.cost
  }

  const active = new Set(namespaces.filter((namespace) => namespace.inline))
=======
  const active = new Set(namespaces)
  // TODO: Bound namespace discovery once large namespace inventories and descriptions can no longer stay inline.
  let remaining =
    budget -
    namespaces.reduce(
      (total, namespace) =>
        total +
        cost(
          namespaceLine({
            name: namespace.name,
            ...(namespace.description === undefined ? {} : { description: namespace.description }),
            tools: namespace.tools,
            entries: [],
          }),
        ),
      0,
    ) -
    namespaces
      .flatMap((namespace) => namespace.selectedListings)
      .reduce((total, listing) => total + cost(listing.line), 0)
>>>>>>> upstream-anomalyco/dev
  while (active.size > 0) {
    for (const namespace of active) {
      const entry = namespace.selectionOrder[namespace.selectionIndex]
      const candidate = entry && listing(entry)
      if (!candidate || cost(candidate.line) > remaining) {
        active.delete(namespace)
        continue
      }
      namespace.selectedListings.push(candidate)
      namespace.selectionIndex += 1
      remaining -= cost(candidate.line)
      if (namespace.selectionIndex === namespace.selectionOrder.length) active.delete(namespace)
    }
  }

<<<<<<< HEAD
  const namespaceSummaries = namespaces.map((namespace) => ({
    name: namespace.name,
    ...(namespace.description === undefined ? {} : { description: namespace.description }),
    count: namespace.listings.length,
    entries: namespace.listings.filter((listing) => namespace.selectedListings.has(listing)),
    inline: namespace.inline,
  }))
=======
>>>>>>> upstream-anomalyco/dev
  return {
    total: flattened.tools.length,
    namespaces: namespaces.map((namespace) => ({
      name: namespace.name,
      ...(namespace.description === undefined ? {} : { description: namespace.description }),
      tools: namespace.tools,
      entries: namespace.selectedListings,
    })),
  }
}

/** Looks up any tool's listing as the catalog would show it. */
export function lookup(inventory: Inventory) {
  const tools = new Map(flatten(inventory.tools).tools.map((entry) => [entry.path, entry]))
  return (path: string) => {
    const entry = tools.get(path)
    return entry === undefined ? undefined : listing(entry)
  }
}

function listing(entry: { readonly path: string; readonly tool: Tool }) {
  const firstLine = entry.tool.description.split("\n", 1)[0]?.trim() ?? ""
  const description =
    firstLine.length > DESCRIPTION_LIMIT ? firstLine.slice(0, DESCRIPTION_LIMIT - 3) + "..." : firstLine
  const suffix = description.length === 0 ? "" : ` // ${description}`
  return { path: entry.path, line: `  - ${entry.tool.signature}${suffix}` }
}

function flatten(entries: ReadonlyArray<Tool | Namespace>, path: ReadonlyArray<string> = []) {
  const tools: Array<{ readonly path: string; readonly tool: Tool }> = []
  const namespaces = new Map<string, Namespace>()
  for (const entry of entries) {
    if (entry.type === "tool") {
      tools.push({ path: [...path, entry.name].join("."), tool: entry })
      continue
    }
    const next = [...path, entry.name]
    namespaces.set(next.join("."), entry)
    const nested = flatten(entry.tools, next)
    tools.push(...nested.tools)
    for (const [name, namespace] of nested.namespaces) namespaces.set(name, namespace)
  }
  return { tools, namespaces }
}

<<<<<<< HEAD
export function namespaceLine(namespace: typeof NamespaceSummary.Type, shown = namespace.entries.length) {
  const count = namespace.count === 1 ? "1 tool" : `${namespace.count} tools`
  const label = shown === namespace.count ? count : shown === 0 ? `${count}, none shown` : `${count}, ${shown} shown`
=======
export function namespaceLine(namespace: NamespaceSummary, shown = namespace.entries.length) {
  const count = namespace.tools.length === 1 ? "1 tool" : `${namespace.tools.length} tools`
  const label =
    shown === namespace.tools.length ? count : shown === 0 ? `${count}, none shown` : `${count}, ${shown} shown`
>>>>>>> upstream-anomalyco/dev
  return `- ${namespace.name} (${label})${namespace.description === undefined ? "" : ` // ${namespace.description}`}`
}

export function cost(text: string) {
  return Math.round(text.length / CHARACTERS_PER_TOKEN)
}
