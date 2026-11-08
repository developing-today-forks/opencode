#!/usr/bin/env bun
/**
 * Regression net for the bare string->number conversion class (design
 * #992, phase 3, #995 — follow-up to the numeric normalisation design
 * whose phase 1 (#993) introduced the shared primitives in
 * packages/core/src/util/number.ts).
 *
 * A bare `Number(...)` / `parseInt(...)` / `parseFloat(...)` on an
 * externally supplied string silently produces NaN, truncates trailing
 * garbage ("12abc" -> 12 via parseInt), or maps "" to 0, and each call
 * site invents its own answer. The blessed direction is the #993
 * primitives (pageLimit and friends) or an explicit local disposition.
 * This gate scans every production `src` tree under packages/ and
 * services/, and (since #1517) every script tree (root `script/`, each
 * package script/scripts tree — including nested package trees such as
 * `packages/console/app/script` and `packages/plugins/figma/script` —
 * and `services/www/script`), matching check-bounded-http's explicit
 * root inventory, with the sweep patterns —
 *   P-A: a `Number(` call. The pattern is deliberately line-shaped and
 *        word-bounded: `Number.isFinite(` / `Number.isNaN(` are
 *        internal arithmetic predicates, not conversions, and do not
 *        match; a longer identifier ending in Number (e.g. toNumber()
 *        does not match either.
 *   P-B: a `parseInt(` call (any radix handling — the class is the
 *        bare conversion, not the radix).
 *   P-C: a `parseFloat(` call.
 * — and requires every hit to be listed in
 * script/check-numeric-boundaries.allowlist.txt with its disposition
 * (converted through a #993 primitive, safe by construction with the
 * reason, or a pre-existing baseline conversion inventoried for design
 * #992). A new bare conversion fails the gate until a human
 * dispositions it; an allowlist entry whose line no longer exists is
 * stale and also fails, so the list cannot silently rot. The initial
 * allowlist is the current baseline: existing conversions are known
 * inventory, not hidden ones, and migrating them onto the #993
 * primitives is #993/#994 scope, not this net's.
 *
 * Comment-only lines are skipped: a comment mentioning `Number(` is
 * documentation, not a call site.
 *
 * Scope note (#1517, mirroring bounded-http #1394): the script trees
 * are in scope. They are operator-run local/CI tooling, but they run
 * the release, publish, and CI paths, and bare conversions there
 * escaped precisely because this gate did not scan them. This gate's
 * own checker and tests self-match (pattern literals, fixtures);
 * those hits are dispositioned in the allowlist as fixtures, not
 * hidden.
 *
 * Usage:
 *   bun run script/check-numeric-boundaries.ts   # exit 1 listing unlisted/stale hits
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
  // Script trees (#1517, mirroring bounded-http #1394, nested trees
  // #1425): root script/, every packages/*/script and
  // packages/*/scripts — at any nesting depth (console/app,
  // plugins/figma) — and services/*/script where present. main()
  // fails when a package script tree exists on disk but is not
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
  // Escaped trees (#1758): vscode extension package outside
  // packages//services, plus the depth-2 github/script tree.
  "github/script",
  "sdks/vscode/script",
  "sdks/vscode/src",
]

export const ALLOWLIST_PATH = "script/check-numeric-boundaries.allowlist.txt"

export const PATTERNS: RegExp[] = [/\bNumber\s*\(/, /\bparseInt\s*\(/, /\bparseFloat\s*\(/]

/** Extensions whose files execute code in the scanned packages. */
export const SCANNED_EXTENSIONS: string[] = [".ts", ".tsx"]

export const isScannedFile = (name: string) => gateHarness.isScannedFile(name, SCANNED_EXTENSIONS)

export const GATE = {
  name: "numeric-boundaries",
  scanRoots: SCAN_ROOTS,
  scannedExtensions: SCANNED_EXTENSIONS,
  allowlistPath: ALLOWLIST_PATH,
  patterns: PATTERNS,
  candidate: "numeric-boundary candidate",
  remediation: "Convert it through the shared primitives (packages/core/src/util/number.ts, #993), or add its disposition to",
  summary: (count: number, rootCount: number, allowlist: string) =>
    `All ${count} numeric-boundary candidates in ${rootCount} scan roots are dispositioned in ${allowlist}.`,
  treeChecks: [
    { kind: "script", gateFile: "script/check-numeric-boundaries.ts" },
    { kind: "src", gateFile: "script/check-numeric-boundaries.ts" },
  ],
} as const

export const NumericBoundaries = { GATE, PATTERNS } as const

export type { Hit }
export const hitKey = gateHarness.hitKey
export const parseAllowlist = gateHarness.parseAllowlist
export const staleEntries = gateHarness.staleEntries
export const unlistedHits = gateHarness.unlistedHits
export const scanSource = (file: string, source: string) => gateHarness.scanSource(file, source, PATTERNS)
export function collect(root: string, dir: string, hits: Hit[]) {
  return gateHarness.collect(root, dir, hits, PATTERNS, SCANNED_EXTENSIONS)
}

export const srcTreesOnDisk = gateHarness.srcTreesOnDisk
export const unscannedSrcTrees = (root: string, roots: readonly string[] = SCAN_ROOTS) =>
  gateHarness.unscannedSrcTrees(root, roots)
export const scriptTreesOnDisk = gateHarness.scriptTreesOnDisk
export const unscannedScriptTrees = (root: string, roots: readonly string[] = SCAN_ROOTS) =>
  gateHarness.unscannedScriptTrees(root, roots)

async function main() {
  const root = join(import.meta.dir, "..")
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  gateHarness.runGate(GATE, root, allowlist)
}

if (import.meta.main) await main()
