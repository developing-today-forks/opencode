#!/usr/bin/env bun
/**
 * Regression net for the prototype-chain dictionary-read class (#865,
 * follow-up to the #833 audit).
 *
 * A bare `record[key]` read walks the prototype chain: an externally
 * supplied key like "constructor" resolves to an inherited member instead
 * of missing, and a `?? fallback` never fires because inherited members are
 * not nullish. The blessed fix is `ownValue`/`ownOr` from
 * packages/core/src/util/record.ts. This gate scans packages/core/src and
 * packages/ai/src (#912) with the two sweep patterns pinned on #833 —
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

export const SCAN_ROOTS = ["packages/core/src", "packages/ai/src"] as const
/** @deprecated single-root name kept for compatibility; use SCAN_ROOTS. */
export const SCAN_ROOT = SCAN_ROOTS[0]
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
  summary: (count: number, _rootCount: number, allowlist: string) =>
    `All ${count} prototype-chain read candidates in ${SCAN_ROOTS.join(", ")} are dispositioned in ${allowlist}.`,
} as const

export const ProtoReads = { GATE, PATTERNS } as const

export type { Hit }
export const hitKey = gateHarness.hitKey
export const parseAllowlist = gateHarness.parseAllowlist
export const staleEntries = gateHarness.staleEntries
export const unlistedHits = gateHarness.unlistedHits
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
