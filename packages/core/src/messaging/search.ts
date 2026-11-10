export * as MessagingSearch from "./search.js"

import { createHash } from "crypto"
import { Effect } from "effect"
import { Text } from "../util/text.js"

/**
 * Text scoring shared by message and log search. Fuzzy matching uses character trigrams, the same
 * representation the SQLite FTS5 trigram index stores, so the database narrows candidates and this
 * module ranks them by how much of the query they contain, tolerating typos and partial words.
 */

export function words(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

// Trigrams count Unicode code points, as the SQLite trigram tokenizer does, so a character outside the basic plane
// is one character, never two halves of a surrogate pair.
export function trigrams(text: string): Set<string> {
  const result = new Set<string>()
  for (const word of words(text)) {
    const characters = Array.from(word)
    if (characters.length < 3) {
      result.add(word)
      continue
    }
    for (let index = 0; index + 3 <= characters.length; index++) result.add(characters.slice(index, index + 3).join(""))
  }
  return result
}

/**
 * An FTS5 query matching any trigram of the query words, or undefined when the index cannot narrow the search: a
 * word shorter than three characters still counts toward the fuzzy score, so prefiltering by trigrams would drop
 * texts that match only through it.
 */
export function ftsQuery(query: string) {
  const grams = Array.from(trigrams(query))
  if (grams.length === 0 || grams.some((gram) => Array.from(gram).length < 3)) return undefined
  return grams.map((gram) => `"${gram.replaceAll('"', '""')}"`).join(" OR ")
}

/**
 * An FTS5 phrase matching the exact (case-insensitive) substring, or undefined when it is too short for the
 * trigram index. Surrounding whitespace is part of the substring, as in the SQL fallback.
 */
export function ftsPhrase(query: string) {
  if (Array.from(query).length < 3 || query.trim() === "") return undefined
  return `"${query.replaceAll('"', '""')}"`
}

/**
 * Fuzzy relevance in [0, 1.5]: the share of query trigrams found in the text, plus a bonus for an
 * exact substring and for whole query words. Below about 0.35 a match is mostly noise.
 */
export function fuzzy(query: string, text: string) {
  const needle = query.trim().toLowerCase()
  if (needle === "") return 0
  const haystack = text.toLowerCase()
  const exact = haystack.includes(needle) ? 0.5 : 0
  const grams = trigrams(needle)
  if (grams.size === 0) return exact
  const present = trigrams(haystack)
  const covered = Array.from(grams).filter((gram) => present.has(gram)).length / grams.size
  const queryWords = words(needle)
  const textWords = new Set(words(haystack))
  const whole =
    queryWords.length === 0 ? 0 : queryWords.filter((word) => textWords.has(word)).length / queryWords.length
  return covered * 0.8 + whole * 0.2 + exact
}

export const FUZZY_THRESHOLD = 0.35

/** Semantic matches below this cosine similarity are dropped. */
export const SEMANTIC_FLOOR = 0.15
/** Semantic matches below this share of the best match's similarity are dropped. */
export const SEMANTIC_RELATIVE = 0.6

/** Reciprocal rank fusion of ranked key lists; higher is better. */
export function fuse(lists: ReadonlyArray<ReadonlyArray<string>>, k = 60) {
  const scores = new Map<string, number>()
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)))
  return scores
}

/** Dot product; vectors are L2-normalized so this is cosine similarity. */
export function cosine(left: Float32Array, right: Float32Array) {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index++) sum += left[index] * right[index]
  return sum
}

export function toBytes(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function fromBytes(bytes: Uint8Array) {
  // Copy into an aligned buffer; SQLite blobs may start at any byte offset.
  return new Float32Array(Uint8Array.from(bytes).buffer)
}

export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/** The longest regular expression a search accepts. */
export const MAX_PATTERN = 512
/** How long one search may spend matching a regular expression, in milliseconds. */
export const REGEX_BUDGET_MS = 2000

// Inline source works in source and compiled executables without a separate asset. Patterns and text travel
// over stdin, never executable source. A subprocess can be killed even on Bun versions whose worker threads
// cannot interrupt a native regex call. Progress preserves completed batches if a match stalls.
const regexWorker = String.raw`
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
const regex = (() => {
  try {
    return new RegExp(input.query, "i")
  } catch {
    return new RegExp(input.query.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&"), "i")
  }
})()
const matched = []
for (let index = 0; index < input.texts.length; index++) {
  if (regex.test(input.texts[index])) matched.push(index)
  if ((index + 1) % 64 === 0 || index + 1 === input.texts.length)
    process.stdout.write(JSON.stringify({ matched: matched.splice(0), checked: index + 1 }) + "\n")
}
`

/**
 * Runs all user regex compilation and matching off-thread. The caller's clock enforces the deadline and the
 * subprocess is killed on completion, timeout or interruption, even if one RegExp.test is still backtracking.
 * Items not reported by the worker are counted so the caller can disclose partial results.
 */
export function regexFilter<A>(
  query: string,
  items: ReadonlyArray<A>,
  text: (item: A) => string,
  budget = REGEX_BUDGET_MS,
) {
  return Effect.gen(function* () {
    if (items.length === 0) return { matched: [], unchecked: 0 }
    const { spawn } = yield* Effect.promise(() => import("node:child_process"))
    const { createInterface } = yield* Effect.promise(() => import("node:readline"))
    const progress = { matched: new Set<number>(), checked: 0 }
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, ["--eval", regexWorker], {
          // A compiled Bun executable runs its embedded runtime when this is set; Node ignores it.
          env: { ...process.env, BUN_BE_BUN: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ),
      (worker) =>
        Effect.callback<void>((resume) => {
          if (worker.exitCode !== null || worker.signalCode !== null) return resume(Effect.void)
          worker.once("close", () => resume(Effect.void))
          worker.kill("SIGKILL")
        }),
    )
    yield* Effect.callback<void>((resume) => {
      const lines = createInterface({ input: worker.stdout })
      const errors: string[] = []
      worker.stderr.setEncoding("utf8").on("data", (text: string) => errors.push(text))
      lines.on("line", (line) => {
        const message: { readonly matched: ReadonlyArray<number>; readonly checked: number } = JSON.parse(line)
        message.matched.forEach((index) => progress.matched.add(index))
        progress.checked = message.checked
        if (progress.checked === items.length) resume(Effect.void)
      })
      worker.stdin.on("error", (error) => resume(Effect.die(error)))
      worker.once("error", (error) => resume(Effect.die(error)))
      worker.once("close", () => {
        if (progress.checked < items.length)
          resume(Effect.die(new Error(`Regex worker exited before completing: ${Text.truncate(errors.join(""), 500)}`)))
      })
      worker.stdin.end(JSON.stringify({ query, texts: items.map(text) }))
    }).pipe(Effect.timeoutOrElse({ duration: budget, orElse: () => Effect.void }))
    return {
      matched: items.filter((_, index) => progress.matched.has(index)),
      unchecked: items.length - progress.checked,
    }
  }).pipe(Effect.scoped)
}
