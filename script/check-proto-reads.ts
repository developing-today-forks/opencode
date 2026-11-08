#!/usr/bin/env bun
/**
 * Regression net for the prototype-chain dictionary-read class (#865,
 * follow-up to the #833 audit).
 *
 * A bare `record[key]` read walks the prototype chain: an externally
 * supplied key like "constructor" resolves to an inherited member instead
 * of missing, and a `?? fallback` never fires because inherited members are
 * not nullish. The blessed fix is `ownValue`/`ownOr` from
 * packages/core/src/util/record.ts. This gate scans every package-owned
 * src tree on disk (every packages src tree incl. the console and stats
 * subtrees, plus the services src trees; #1369 completed the
 * #912/#1361 per-tree extensions) with the sweep patterns pinned on #833 —
 *   P-A: an uppercase plain-object table read by a variable key
 *   P-C: a bracket read with a `??` fallback (the most dangerous shape)
 *   P-D: a bracket read whose key is a computed expression (contains a
 *        call) with a `??` fallback — P-C's bracket shape requires a plain
 *        dotted key, so `values[key.trim()] ?? fallback` evaded both
 *        patterns until #1086
 * — and requires every hit to be listed in
 * script/check-proto-reads.allowlist.txt with its disposition (guarded at
 * the site, safe by construction with the reason, or tracked by an issue).
 * A new bare read fails the gate until a human dispositions it; an
 * allowlist entry whose line no longer exists is stale and also fails, so
 * the list cannot silently rot.
 *
 * Usage:
 *   bun run script/check-proto-reads.ts   # exit 1 listing unlisted/stale hits
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
]
/** @deprecated single-root name kept for compatibility; use SCAN_ROOTS. */
export const SCAN_ROOT = "packages/core/src"
export const ALLOWLIST_PATH = "script/check-proto-reads.allowlist.txt"

export const PATTERNS: RegExp[] = [/\b[A-Z][A-Z_0-9]{2,}\[[a-zA-Z_]/, /\[[a-zA-Z_.]+\] \?\?/, /\[[^\]]*\([^\]]*\] \?\?/]

export const SCANNED_EXTENSIONS = [".ts"] as const
export const GATE = {
  name: "proto-reads",
  scanRoots: SCAN_ROOTS,
  scannedExtensions: SCANNED_EXTENSIONS,
  allowlistPath: ALLOWLIST_PATH,
  patterns: PATTERNS,
  candidate: "prototype-chain read candidate",
  remediation: "Guard it with ownValue/ownOr (packages/core/src/util/record.ts), or add its disposition to",
  summary: (count: number, rootCount: number, allowlist: string) =>
    `All ${count} prototype-chain read candidates in ${rootCount} scan roots are dispositioned in ${allowlist}.`,
  treeChecks: [{ kind: "src", gateFile: "script/check-proto-reads.ts" }],
} as const

export const ProtoReads = { GATE, PATTERNS } as const

export type { Hit }
export const hitKey = gateHarness.hitKey
export const parseAllowlist = gateHarness.parseAllowlist
export const staleEntries = gateHarness.staleEntries
export const unlistedHits = gateHarness.unlistedHits
export const unscannedSrcTrees = gateHarness.unscannedSrcTrees
export const scanSource = (file: string, source: string) => gateHarness.scanSource(file, source, PATTERNS)
export const isScannedFile = (name: string) => gateHarness.isScannedFile(name, SCANNED_EXTENSIONS)
export function collect(root: string, dir: string, hits: Hit[]) {
  return gateHarness.collect(root, dir, hits, PATTERNS, SCANNED_EXTENSIONS)
}

async function main() {
  const root = join(import.meta.dir, "..")
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  gateHarness.runGate(GATE, root, allowlist)
}

if (import.meta.main) await main()
