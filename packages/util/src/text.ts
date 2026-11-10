export * as Text from "./text.js"

/**
 * Never split a pair — the well-formedness contract for text truncation
 * (design #2208, phase 1 filed as #2209; layering precedent #1127).
 *
 * A string cut at a raw UTF-16 index can land inside a surrogate pair —
 * one half of an astral character (emoji, CJK ext, anything above
 * U+FFFF) — and emit a lone surrogate. The result is not well-formed
 * text: `isWellFormed()` is false, and downstream JSON encoders /
 * `TextEncoder` replace the half-pair with U+FFFD, corrupting whatever
 * the cut was producing. The contract:
 *
 * 1. A cut never splits a surrogate pair. The truncated result is
 *    always well-formed: a pair straddling any cut is dropped whole
 *    (the #1966 house rule, generalised from one file to the repo).
 *    This applies at *every* cut a helper makes — a middle truncation
 *    has two cuts and owes the rule at both.
 * 2. The primitive lives in the lowest layer — this module, in
 *    `@opencode/util`, the one package `ai`, `core`, `tui` and `util`
 *    itself can all import. `core`'s existing `Text` module
 *    (`packages/core/src/util/text.ts`) re-exports this primitive, so
 *    core's landed call sites keep their import and their behaviour.
 * 3. One primitive per cut shape. Head (`truncate`), tail
 *    (`truncateTail`) and middle (`truncateMiddle`) are each stated
 *    once here, each applying rule 1 at every cut it makes. Helpers
 *    with extra structure (filename + preserved extension, ellipsis
 *    insertion, omission markers) compose these primitives rather
 *    than re-deriving the guard; ellipsis handling stays at that
 *    composing-helper level, unchanged.
 * 4. Budgets keep their units. These helpers budget in UTF-16 code
 *    units (`.length`) — rule 1 changes only which side of a
 *    straddling pair the cut falls on, never the unit: the result is
 *    at most the budget, at most one code unit shorter per cut when a
 *    pair straddles. Width-budgeted helpers (`tui` grapheme
 *    `takeWidth`/`truncateWidth`) and code-point-budgeted helpers
 *    (`core` `session/compaction.ts` `truncateToolOutput`) are
 *    different, already pair-safe contracts — named in the inventory
 *    below, unchanged.
 * 5. Safe-by-construction sites are named, not "fixed". Slices of
 *    ASCII-sanitised strings, latin1-decoded binary scans, and
 *    generated-whitespace slices cannot contain a pair; the inventory
 *    records them as safe-by-construction (per #1977's classification)
 *    so the next sweep does not re-file them.
 * 6. Every truncation is inventoried and pinned. The inventory below
 *    covers the truncation sites in `packages/ai/src`,
 *    `packages/core/src`, `packages/util/src` and `packages/tui/src`
 *    with their dispositions, and the shared probe matrix in
 *    `packages/util/test/text.test.ts` pins the conforming helpers
 *    against this contract as the oracle. Unguarded rows are marked
 *    and linked, never asserted as conforming.
 *
 * Inventory (verified against main at filing of #2209; non-budget
 * slices — prefix strips, path segments, array windows, byte chunks —
 * are not truncation sites and are out of scope):
 *
 * Routes through this primitive (via core's `Text` re-export):
 * - core/src/messaging/log.ts `clip()` — head/tail/marker cuts guarded
 *   by `splitsPair` (#1966, #1970)
 * - core/src/messaging.ts — delivered body, preview, toast, firstLine
 *   and rerank cuts via `MessagingLog.splitsPair` (#1970)
 * - core/src/session/title.ts — output-side title via `Text.truncate`
 *   (#1973)
 * - core/src/codemode/catalog.ts — description via `Text.truncate`
 *   (#1973)
 * - core/src/messaging/embedding.ts — clip via `Text.truncate` (#1973)
 * - core/src/session/runner/publish-llm-event.ts — input excerpt via
 *   `Text.truncate` (#1973)
 * - core/src/model-route-log.ts — error body via `Text.truncate`
 *   (#1973)
 * - core/src/ripgrep.ts — match text via `Text.truncate` (#1973)
 *
 * Width contract (grapheme/terminal-width budgets, pair-safe, rule 4):
 * - tui/src/util/locale.ts `takeWidth` / `truncateWidth`
 *
 * Code-point contract (code-point budgets, pair-safe, rule 4):
 * - core/src/session/compaction.ts `truncateToolOutput`
 *
 * Safe-by-construction (rule 5):
 * - util/src/activity-calendar.ts — slices of generated ISO date
 *   strings (ASCII)
 * - util/src/npm.ts, util/src/observability/shared.ts — slices of hex
 *   digests / UUIDs (ASCII)
 * - core/src/messaging/search.ts (hash slice) — hex digest (ASCII)
 * - ai/src bedrock tool/document names and model-plan slugs, and
 *   antigravity-auth latin1 binary scans — ASCII-sanitised / latin1,
 *   per #1977's classification
 *
 * Known-unguarded — NOT conforming, do not assert otherwise:
 * - #1977 (design #2208 phase 2, twelve core+ai sites):
 *   core/src/tool/read-filesystem.ts `clampLine` (line shown to the
 *   model); core/src/session/title.ts title-generation prompt head
 *   and tail cuts; ai/src/route/executor.ts provider error excerpt;
 *   ai/src/quota/cdp.ts page-eval exception excerpt;
 *   ai/src/providers/antigravity-auth.ts and muse-direct-auth.ts
 *   error excerpts; core/src/messaging/search.ts regex-worker error
 *   excerpt; core/src/mcp/stdio.ts stderr tail accumulator;
 *   core/src/messaging/embedding.ts and core/src/embeddings.ts error
 *   excerpts and llama-server stderr tails
 * - #2133 (design #2208 phase 3, five display helpers):
 *   util/src/path.ts `getFilenameTruncated` and `truncateMiddle`;
 *   tui/src/util/locale.ts `truncate`, `truncateLeft` and
 *   `truncateMiddle`
 *
 * Neighbour, not a truncation: ai's `sanitizeSurrogates` governs lone
 * surrogates in map keys (write-side, #2152) — a different failure
 * (sanitised-key collision), not this contract's subject.
 */

/**
 * A cut at `index` splits a surrogate pair when the code unit before it
 * is a high surrogate and the one at it is that pair's low half: keeping
 * either side alone leaves ill-formed text that re-encodes as U+FFFD
 * (#1966). Semantics identical to the guard core's `Text` carried since
 * #1973 — this module is now its home (rule 2).
 */
export const splitsPair = (text: string, index: number) =>
  index > 0 &&
  index < text.length &&
  text.charCodeAt(index - 1) >= 0xd800 &&
  text.charCodeAt(index - 1) <= 0xdbff &&
  text.charCodeAt(index) >= 0xdc00 &&
  text.charCodeAt(index) <= 0xdfff

/** Head cut: truncates to at most `limit` code units, dropping a straddling surrogate pair whole. Budgets are unchanged from core's `Text.truncate`. */
export const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : text.slice(0, splitsPair(text, limit) ? limit - 1 : limit)

/** Tail cut: keeps the last at most `limit` code units, dropping a straddling surrogate pair whole at the cut. */
export const truncateTail = (text: string, limit: number) => {
  if (text.length <= limit) return text
  const start = text.length - limit
  return text.slice(splitsPair(text, start) ? start + 1 : start)
}

/**
 * Middle cut: keeps a head and a tail totalling at most `maxLength`
 * code units (head takes the ceiling half), dropping a straddling
 * surrogate pair whole at *both* cuts. No ellipsis is inserted —
 * composing helpers add their own markers (rule 3).
 */
export const truncateMiddle = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text
  if (maxLength <= 0) return ""
  const head = Math.ceil(maxLength / 2)
  const tail = Math.floor(maxLength / 2)
  const start = text.length - tail
  return (
    text.slice(0, splitsPair(text, head) ? head - 1 : head) +
    (tail > 0 ? text.slice(splitsPair(text, start) ? start + 1 : start) : "")
  )
}
