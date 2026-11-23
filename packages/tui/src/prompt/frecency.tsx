import path from "path"
import { onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText } from "../util/persistence"
import { createJsonlFile } from "./jsonl"

type FrecencyEntry = { path: string; frequency: number; lastOpen: number }

export const MAX_FRECENCY_ENTRIES = 1000

export function parseFrecency(text: string) {
  const latest = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const entry: unknown = JSON.parse(line)
        if (typeof entry !== "object" || entry === null) return undefined
        if (
          !("path" in entry) ||
          typeof entry.path !== "string" ||
          !("frequency" in entry) ||
          typeof entry.frequency !== "number" ||
          !Number.isFinite(entry.frequency) ||
          !("lastOpen" in entry) ||
          typeof entry.lastOpen !== "number" ||
          !Number.isFinite(entry.lastOpen)
        )
          return undefined
        return { path: entry.path, frequency: entry.frequency, lastOpen: entry.lastOpen }
      } catch {
        return undefined
      }
    })
    .filter((line): line is FrecencyEntry => line !== undefined)
    .reduce<Record<string, FrecencyEntry>>((result, entry) => {
      result[entry.path] = entry
      return result
    }, {})
  return Object.values(latest)
    .sort((a, b) => b.lastOpen - a.lastOpen)
    .slice(0, MAX_FRECENCY_ENTRIES)
}

function calculateFrecency(entry?: { frequency: number; lastOpen: number }) {
  if (!entry) return 0
  return entry.frequency / (1 + (Date.now() - entry.lastOpen) / 86400000)
}

/** Merge two frecency snapshots: the freshest entry per path wins. */
export function mergeFrecency(...lists: FrecencyEntry[][]) {
  const latest = new Map<string, FrecencyEntry>()
  for (const entry of lists.flat()) {
    const existing = latest.get(entry.path)
    if (
      !existing ||
      entry.lastOpen > existing.lastOpen ||
      (entry.lastOpen === existing.lastOpen && entry.frequency > existing.frequency)
    ) {
      latest.set(entry.path, entry)
    }
  }
  return [...latest.values()].sort((a, b) => b.lastOpen - a.lastOpen).slice(0, MAX_FRECENCY_ENTRIES)
}

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const paths = useTuiPaths()
    const frecencyPath = path.join(paths.state, "frecency.jsonl")
    const file = createJsonlFile<FrecencyEntry>({
      file: frecencyPath,
      locks: path.join(paths.state, "locks"),
      parse: parseFrecency,
      serialize: (entries) =>
        entries.length > 0 ? entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" : "",
    })

    const [store, setStore] = createStore({ data: {} as Record<string, { frequency: number; lastOpen: number }> })

    const applyEntries = (entries: FrecencyEntry[]) =>
      setStore(
        "data",
        Object.fromEntries(
          entries.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
        ),
      )

    onMount(async () => {
      // Rewrite valid retained entries to self-heal corruption and enforce
      // the limit, re-reading under the file lock so entries another TUI
      // recorded after this instance started are preserved.
      // A failed startup read leaves the disk untouched (update refuses the
      // rewrite) and falls back to empty loaded state; entries recorded in
      // memory while the load was in flight are preserved by the merge below.
      const lines = await file
        .update((current) => (current.length > 0 ? current : undefined))
        .catch(() => file.read().catch(() => []))
      // Merge rather than replace: updates recorded while the load was in
      // flight are already in the store and must not be wiped by it.
      const memory = Object.entries(store.data).map(([entryPath, entry]) => ({ path: entryPath, ...entry }))
      applyEntries(mergeFrecency(lines, memory))
    })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(paths.cwd, filePath)
      const newEntry = { frequency: (store.data[absolutePath]?.frequency || 0) + 1, lastOpen: Date.now() }
      setStore("data", absolutePath, newEntry)

      if (Object.keys(store.data).length <= MAX_FRECENCY_ENTRIES) {
        // Appends are append-only and never clobber another writer; they are
        // still queued so they cannot interleave with this instance's own
        // compaction below.
        file
          .enqueue(() => appendText(frecencyPath, JSON.stringify({ path: absolutePath, ...newEntry }) + "\n"))
          .catch(() => {})
        return
      }
      // Compaction: merge this instance's snapshot with the fresh on-disk
      // state under the file lock, so entries another TUI recorded are kept.
      const memory = Object.entries(store.data).map(([entryPath, entry]) => ({ path: entryPath, ...entry }))
      file
        .update((current) => mergeFrecency(current, memory))
        .then(applyEntries)
        .catch(() => {})
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(paths.cwd, filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})
