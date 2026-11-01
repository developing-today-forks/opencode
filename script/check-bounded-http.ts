#!/usr/bin/env bun
/**
 * Regression net for the unbounded outbound HTTP class (design #1127,
 * phase 3, #1129 — follow-up to the per-site audit family that produced
 * 62+ individual unbounded-fetch / unbounded-read issues).
 *
 * The contract (design #1127) is "bounded by default": every outbound
 * call carries a deadline (a `signal`, composed through `deadlineSignal`
 * from `@opencode/util/http-body` or `AbortSignal.timeout` / a caller
 * signal) and every response body is read through a bounded or excerpt
 * reader (`readBoundedResponseText` / `readExcerptResponseText` from
 * `@opencode/util/http-body`, or `collectBoundedResponseBody` from
 * packages/core/src/tool/http-body.ts for Effect HttpClient sites).
 * This gate scans every `src` tree under packages/ (`.ts`/`.tsx`/`.astro` files - Astro frontmatter executes server-side, so its fetch/read sites are in scope) with the two sweep
 * patterns —
 *   P-A: a `fetch(` call site. The pattern is deliberately line-shaped:
 *        a call whose options carry a signal still matches, exactly as
 *        a guarded prototype read still matches check-proto-reads — the
 *        allowlist disposition is what records that the site is bounded.
 *   P-B: a `.text()` / `.json()` / `.arrayBuffer()` read on a
 *        lowercase (value) receiver or chained off a call — the shape of
 *        a response-body read that did not pass through a bounded or
 *        excerpt reader (those readers replace the direct read, so a
 *        direct read is always a candidate). The read must be
 *        zero-argument: `.json({...})` builds a response and
 *        `api.json("POST", ...)` calls another abstraction, neither is
 *        a body read. `Response.json(...)` the constructor does not
 *        match: its receiver is capitalised.
 * — and requires every hit to be listed in
 * script/check-bounded-http.allowlist.txt with its disposition (bounded
 * at the site naming the helper, a local / inbound / non-response read
 * with the reason, or tracked by an issue). A new unbounded call fails
 * the gate until a human dispositions it; an allowlist entry whose line
 * no longer exists is stale and also fails, so the list cannot silently
 * rot. The initial allowlist is the remaining-surfaces inventory for
 * the contract: hits dispositioned as unbounded are known remaining
 * work, not hidden ones.
 *
 * Comment-only lines are skipped: a comment mentioning `fetch(` is
 * documentation, not a call site.
 *
 * Usage:
 *   bun run script/check-bounded-http.ts   # exit 1 listing unlisted/stale hits
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const SCAN_ROOTS: string[] = [
  "packages/ai/src",
  "packages/app/src",
  "packages/client/src",
  "packages/cli/src",
  "packages/codemode/src",
  "packages/console/app/src",
  "packages/console/function/src",
  "packages/core/src",
  "packages/desktop/src",
  "packages/function/src",
  "packages/gui-extensions/src",
  "packages/http-recorder/src",
  "packages/httpapi-codegen/src",
  "packages/latex/src",
  "packages/merman/src",
  "packages/plugin/src",
  "packages/plugin-browser/src",
  "packages/plugin-github/src",
  "packages/posts/src",
  "packages/protocol/src",
  "packages/schema/src",
  "packages/script/src",
  "packages/sdk/src",
  "packages/server/src",
  "packages/session-ui/src",
  "packages/simulation/src",
  "packages/stats/app/src",
  "packages/stats/core/src",
  "packages/stats/server/src",
  "packages/theme/src",
  "packages/tui/src",
  "packages/ui/src",
  "packages/util/src",
  "packages/web/src",
]

export const ALLOWLIST_PATH = "script/check-bounded-http.allowlist.txt"

export const PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  // A body read takes no arguments: `.json({...})` / `.text("...")` /
  // `api.json("POST", ...)` are response construction or method calls
  // on other abstractions, not response-body reads.
  /(?:^|[^\w.])(?:[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*)\.(?:text|json|arrayBuffer)\s*\(\s*\)/,
  /\)\.(?:text|json|arrayBuffer)\s*\(\s*\)/,
]

export interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
}

export const hitKey = (file: string, text: string) => `${file} :: ${text}`

const isCommentOnly = (text: string) => text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")

/** Every line of `source` matching a sweep pattern, as hits for `file`. */
export function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  source.split("\n").forEach((raw, index) => {
    const text = raw.trim()
    if (text && !isCommentOnly(text) && PATTERNS.some((pattern) => pattern.test(text)))
      hits.push({ file, line: index + 1, text })
  })
  return hits
}

/**
 * Parse the allowlist: `file :: exact trimmed line :: disposition` per line.
 * Entries are occurrence-aware (as in check-proto-reads, #1086): the value
 * is the list of dispositions for the key, so N identical lines in a file
 * need N entries — one entry no longer silently covers a copy-pasted
 * duplicate line.
 */
export function parseAllowlist(source: string): Map<string, string[]> {
  const entries = new Map<string, string[]>()
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split(" :: ")
    if (parts.length < 3) throw new Error(`Malformed allowlist line (want file :: line :: disposition): ${line}`)
    const key = hitKey(parts[0], parts[1])
    entries.set(key, [...(entries.get(key) ?? []), parts.slice(2).join(" :: ")])
  }
  return entries
}

export const unlistedHits = (hits: Hit[], allowlist: Map<string, string[]>) => {
  const seen = new Map<string, number>()
  return hits.filter((hit) => {
    const key = hitKey(hit.file, hit.text)
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    return occurrence > (allowlist.get(key)?.length ?? 0)
  })
}

export const staleEntries = (hits: Hit[], allowlist: Map<string, string[]>) => {
  const counts = new Map<string, number>()
  for (const hit of hits) {
    const key = hitKey(hit.file, hit.text)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const stale: string[] = []
  for (const [key, dispositions] of allowlist) {
    for (let excess = dispositions.length - (counts.get(key) ?? 0); excess > 0; excess--) stale.push(key)
  }
  return stale
}

/** Extensions whose files execute code: TS/TSX plus Astro (frontmatter runs server-side). */
export const SCANNED_EXTENSIONS: string[] = [".ts", ".tsx", ".astro"]

export const isScannedFile = (name: string) => SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))

function collect(root: string, dir: string, hits: Hit[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(root, path, hits)
    else if (isScannedFile(entry.name))
      hits.push(...scanSource(path.slice(root.length + 1), readFileSync(path, "utf8")))
  }
}

async function main() {
  const root = join(import.meta.dir, "..")
  const hits: Hit[] = []
  for (const scanRoot of SCAN_ROOTS) collect(root, join(root, scanRoot), hits)
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  const unlisted = unlistedHits(hits, allowlist)
  const stale = staleEntries(hits, allowlist)
  if (unlisted.length || stale.length) {
    for (const hit of unlisted)
      console.error(
        `Unlisted bounded-http candidate at ${hit.file}:${hit.line}:\n  ${hit.text}\n  Bound it at the site (deadlineSignal / AbortSignal.timeout + readBoundedResponseText / readExcerptResponseText / collectBoundedResponseBody), or add its disposition to ${ALLOWLIST_PATH}.`,
      )
    for (const key of stale)
      console.error(`Stale allowlist entry (the line no longer matches a sweep pattern): ${key}`)
    process.exit(1)
  }
  console.log(
    `All ${hits.length} bounded-http candidates in ${SCAN_ROOTS.length} scan roots are dispositioned in ${ALLOWLIST_PATH}.`,
  )
}

if (import.meta.main) await main()
