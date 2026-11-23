import { Flock } from "@opencode/util/flock"
import { readText, writeTextAtomic } from "../util/persistence"

/**
 * A JSONL store file shared by every TUI process on the machine (the prompt
 * history, prompt stash, and frecency stores under the state directory).
 *
 * Mutations from one instance are serialized on a promise chain. Whole-file
 * rewrites additionally run under a per-file Flock and re-read the file
 * inside the lock, applying the transform to that fresh state — so a rewrite
 * never drops entries another process appended after this instance loaded
 * its in-memory snapshot. Rewrites go through an atomic temp-file + rename,
 * so a concurrent reader never observes a torn file.
 */
export function createJsonlFile<Entry>(input: {
  file: string
  locks: string
  parse: (text: string) => Entry[]
  serialize: (entries: Entry[]) => string
  readText?: (file: string) => Promise<string>
  writeText?: (file: string, content: string) => Promise<void>
}) {
  const readFileText = input.readText ?? readText
  const writeFileText = input.writeText ?? writeTextAtomic
  let pending: Promise<unknown> = Promise.resolve()

  /** Run a disk operation after every previously queued operation from this instance. */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation)
    pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Read a store file, treating a missing file as a new empty store. Any
   * other read failure is propagated so callers never mistake an I/O error
   * for valid empty state.
   */
  const readRaw = (file: string) =>
    readFileText(file).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return ""
      throw error
    })

  /** Read and parse the file as it currently stands on disk. */
  const read = async () => input.parse(await readRaw(input.file))

  /**
   * Lock-guarded read-modify-write. The transform receives the entries as
   * currently stored, plus the raw file text (for self-heal comparisons),
   * and returns the replacement entries, or undefined to leave the file
   * untouched. Resolves with the entries the file holds afterwards.
   */
  const update = (transform: (current: Entry[], raw: string) => Entry[] | undefined): Promise<Entry[]> =>
    enqueue(() =>
      Flock.withLock(
        input.file,
        async () => {
          // A failed fresh read must refuse the rewrite: transforming an
          // assumed-empty snapshot would discard the existing store.
          const raw = await readRaw(input.file)
          const current = input.parse(raw)
          const next = transform(current, raw)
          if (next === undefined) return current
          await writeFileText(input.file, input.serialize(next))
          return next
        },
        { dir: input.locks },
      ),
    )

  return { enqueue, read, update }
}

export type JsonlFile<Entry> = ReturnType<typeof createJsonlFile<Entry>>

/**
 * Combine entries loaded from disk with the entries an instance accumulated
 * in memory while the load was in flight: loaded entries first, then the
 * in-memory entries the load did not see, capped at the newest `limit`.
 * A slow load must never wipe state a mutation already recorded.
 */
export function mergeLoadedEntries<Entry>(
  loaded: Entry[],
  pending: Entry[],
  key: (entry: Entry) => string,
  limit: number,
) {
  const seen = new Set(loaded.map(key))
  return [...loaded, ...pending.filter((entry) => !seen.has(key(entry)))].slice(-limit)
}
