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
 * This gate scans every `src` tree under packages/ and services/, and
 * (since #1394) every script tree (root `script/`, each package
 * script/scripts tree — including nested package trees such as
 * `packages/console/app/script` and `packages/plugins/figma/script`
 * (#1425) — and `services/www/script`), plus the published
 * GitHub Action under `github/` (since #1436), in
 * (`.ts`/`.tsx`/`.astro` files - Astro frontmatter executes server-side, so its fetch/read sites are in scope) with the two sweep
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
 * Scope note (#1394, superseding the #1256 note): the script trees are
 * in scope. They are operator-run local/CI tooling, but they run the
 * release, publish, and CI paths against api.github.com and registries
 * with a token in env, and every top-level `script/` fetch bug found
 * before this extension (#1275, #1329, #1332, #1337, #1344) escaped
 * precisely because this gate did not scan them. Since #1436 the
 * top-level `github/` tree (the published GitHub Action) is in scope
 * too: it runs in third-party CI on commenter-controlled input. This
 * gate's own checker and tests self-match (pattern literals, fixtures);
 * those hits are dispositioned in the allowlist as fixtures, not hidden.
 *
 * Usage:
 *   bun run script/check-bounded-http.ts   # exit 1 listing unlisted/stale hits
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

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
  "services/changelog/src",
  "services/files/src",
  "services/update/src",
  "services/www/src",
  // Script trees (#1394, nested trees #1425): root script/, every
  // packages/*/script and packages/*/scripts — at any nesting depth
  // (console/app, plugins/figma) — and services/*/script where present.
  // main() fails when a package script tree exists on disk but is not
  // listed here (scriptTreesOnDisk), so this list cannot drift again.
  "script",
  "packages/ai/script",
  "packages/client/script",
  "packages/cli/script",
  "packages/codemode/script",
  "packages/console/app/script",
  "packages/containers/script",
  "packages/core/script",
  "packages/desktop/scripts",
  "packages/http-recorder/script",
  "packages/merman/script",
  "packages/plugin/script",
  "packages/plugin-browser/script",
  "packages/plugin-github/script",
  "packages/plugins/figma/script",
  "packages/posts/script",
  "packages/protocol/script",
  "packages/schema/script",
  "packages/sdk/script",
  "packages/server/script",
  "packages/session-ui/script",
  "packages/simulation/script",
  "packages/theme/script",
  "packages/ui/script",
  "packages/util/script",
  "services/www/script",
  // The published GitHub Action tree (#1436): standalone package with
  // its own lockfile, running in third-party CI on commenter-controlled
  // input — its token-exchange, attachment-download and token-revoke
  // fetches escaped the net precisely because this root was missing.
  "github",
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
 *
 * The disposition is the LAST ` :: `-separated field and the hit text is
 * everything between the file and it (#1394): a hit line can itself
 * contain ` :: ` — the gate's own tests embed allowlist-format literals —
 * while a disposition never does, so this split stays unambiguous for
 * every entry written before this change (all have exactly 3 fields).
 */
export function parseAllowlist(source: string): Map<string, string[]> {
  const entries = new Map<string, string[]>()
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split(" :: ")
    if (parts.length < 3) throw new Error(`Malformed allowlist line (want file :: line :: disposition): ${line}`)
    const key = hitKey(parts[0], parts.slice(1, -1).join(" :: "))
    entries.set(key, [...(entries.get(key) ?? []), parts[parts.length - 1]])
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

export function collect(root: string, dir: string, hits: Hit[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(root, path, hits)
    else if (isScannedFile(entry.name))
      hits.push(...scanSource(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8")))
  }
}

/**
 * Every package script tree on disk under `root` (#1425): a directory
 * named `script` or `scripts` that belongs to a package — its parent
 * directory (the package root, at any nesting depth: packages/ai,
 * packages/console/app, packages/plugins/figma) or the tree itself
 * (packages/containers/script) carries a package.json — and that sits
 * below the package-name level, so the `packages/script` package
 * itself is not mistaken for a script tree. Skill asset folders
 * (packages/plugins/figma/skills/.../scripts, no package.json at
 * either level) are not package script trees and are excluded.
 * Root `script/` is not returned: it is a standing SCAN_ROOTS entry,
 * not a package tree.
 */
export function scriptTreesOnDisk(root: string): string[] {
  const trees: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue
      const path = join(dir, entry.name)
      const rel = relative(root, path).split(sep).join("/")
      if (
        (entry.name === "script" || entry.name === "scripts") &&
        rel.split("/").length >= 3 &&
        (existsSync(join(dir, "package.json")) || existsSync(join(path, "package.json")))
      ) {
        trees.push(rel)
        continue
      }
      walk(path)
    }
  }
  for (const top of ["packages", "services"]) if (existsSync(join(root, top))) walk(join(root, top))
  return trees.toSorted()
}

/** Script trees present on disk but absent from `roots` — the #1425 escape, as a failing condition. */
export const unscannedScriptTrees = (root: string, roots: string[] = SCAN_ROOTS) =>
  scriptTreesOnDisk(root).filter((tree) => !roots.includes(tree))

async function main() {
  const root = join(import.meta.dir, "..")
  const hits: Hit[] = []
  for (const scanRoot of SCAN_ROOTS) collect(root, join(root, scanRoot), hits)
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  const unlisted = unlistedHits(hits, allowlist)
  const stale = staleEntries(hits, allowlist)
  const unscanned = unscannedScriptTrees(root)
  if (unlisted.length || stale.length || unscanned.length) {
    for (const tree of unscanned)
      console.error(
        `Unscanned script tree on disk: ${tree}\n  Add it to SCAN_ROOTS in script/check-bounded-http.ts and disposition its hits in ${ALLOWLIST_PATH}.`,
      )
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
