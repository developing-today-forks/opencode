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
 * (#1425) — and `services/www/script`), in
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
 * precisely because this gate did not scan them. This gate's own
 * checker and tests self-match (pattern literals, fixtures); those
 * hits are dispositioned in the allowlist as fixtures, not hidden.
 *
 * Usage:
 *   bun run script/check-bounded-http.ts   # exit 1 listing unlisted/stale hits
 */
import { gateHarness, type Hit } from "./gate-harness"
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

export type { Hit }
export const hitKey = gateHarness.hitKey
export const parseAllowlist = gateHarness.parseAllowlist
export const staleEntries = gateHarness.staleEntries
export const unlistedHits = gateHarness.unlistedHits
export const scanSource = (file: string, source: string) => gateHarness.scanSource(file, source, PATTERNS)

/** Extensions whose files execute code: TS/TSX plus Astro (frontmatter runs server-side). */
export const SCANNED_EXTENSIONS: string[] = [".ts", ".tsx", ".astro"]

export const isScannedFile = (name: string) => gateHarness.isScannedFile(name, SCANNED_EXTENSIONS)

export function collect(root: string, dir: string, hits: Hit[]) {
  return gateHarness.collect(root, dir, hits, PATTERNS, SCANNED_EXTENSIONS)
}

export const scriptTreesOnDisk = gateHarness.scriptTreesOnDisk
export const srcTreesOnDisk = gateHarness.srcTreesOnDisk
export const unscannedScriptTrees = (root: string, roots: readonly string[] = SCAN_ROOTS) =>
  gateHarness.unscannedScriptTrees(root, roots)
export const unscannedSrcTrees = (root: string, roots: readonly string[] = SCAN_ROOTS) =>
  gateHarness.unscannedSrcTrees(root, roots)

export const GATE = {
  name: "bounded-http",
  scanRoots: SCAN_ROOTS,
  scannedExtensions: SCANNED_EXTENSIONS,
  allowlistPath: ALLOWLIST_PATH,
  patterns: PATTERNS,
  candidate: "bounded-http candidate",
  remediation:
    "Bound it at the site (deadlineSignal / AbortSignal.timeout + readBoundedResponseText / readExcerptResponseText / collectBoundedResponseBody), or add its disposition to",
  summary: (count: number, rootCount: number, allowlist: string) =>
    `All ${count} bounded-http candidates in ${rootCount} scan roots are dispositioned in ${allowlist}.`,
  treeChecks: [
    { kind: "script", gateFile: "script/check-bounded-http.ts" },
    { kind: "src", gateFile: "script/check-bounded-http.ts" },
  ],
} as const

export const BoundedHttp = { GATE, PATTERNS } as const

async function main() {
  const root = join(import.meta.dir, "..")
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  gateHarness.runGate(GATE, root, allowlist)
}

if (import.meta.main) await main()
