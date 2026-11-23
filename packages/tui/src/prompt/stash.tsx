import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { parsePromptInfo, type PromptInfo } from "./history"
import { createJsonlFile, mergeLoadedEntries } from "./jsonl"

export type StashEntry = {
  prompt: PromptInfo
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const value = JSON.parse(line) as unknown
        if (!value || typeof value !== "object") return
        const entry = value as Record<string, unknown>
        const prompt = parsePromptInfo(entry.prompt)
        if (!prompt || typeof entry.timestamp !== "number") return
        return { prompt, timestamp: entry.timestamp }
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")
    const file = createJsonlFile<StashEntry>({
      file: stashPath,
      locks: path.join(paths.state, "locks"),
      parse: parsePromptStash,
      serialize: (entries) => (entries.length > 0 ? entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : ""),
    })

    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    onMount(async () => {
      // Rewrite valid retained entries to self-heal corruption and enforce
      // the limit, re-reading under the file lock so entries another TUI
      // pushed after this instance started are preserved.
      // A failed startup read leaves the disk untouched (update refuses the
      // rewrite) and falls back to empty loaded state; entries recorded in
      // memory while the load was in flight are preserved by the merge below.
      const lines = await file
        .update((current) => (current.length > 0 ? current : undefined))
        .catch(() => file.read().catch(() => []))
      // Merge rather than replace: pushes recorded while the load was in
      // flight are already in the store and must not be wiped by it.
      setStore(
        "entries",
        mergeLoadedEntries(lines, [...store.entries], (entry) => JSON.stringify(entry), MAX_STASH_ENTRIES),
      )
    })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
            }
          }),
        )

        file.update((current) => [...current, stash].slice(-MAX_STASH_ENTRIES)).catch(() => {})
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        // Remove the popped entry from the fresh on-disk state, keeping any
        // entries another TUI pushed in the meantime.
        file
          .update((current) => {
            const serialized = current.map((line) => JSON.stringify(line))
            const at = serialized.lastIndexOf(JSON.stringify(entry))
            if (at === -1) return undefined
            return current.filter((_, index) => index !== at)
          })
          .catch(() => {})
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        const entry = store.entries[index]
        // Position of the target among equal entries in this instance's
        // snapshot, so the matching occurrence is removed from disk even if
        // another TUI changed the file since the snapshot was taken.
        const ordinal = store.entries
          .slice(0, index)
          .filter((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)).length
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        file
          .update((current) => {
            const serialized = current.map((line) => JSON.stringify(line))
            const matches = serialized.flatMap((line, at) => (line === JSON.stringify(entry) ? [at] : []))
            if (matches.length === 0) return undefined
            const at = matches[Math.min(ordinal, matches.length - 1)]!
            return current.filter((_, candidate) => candidate !== at)
          })
          .catch(() => {})
      },
    }
  },
})
