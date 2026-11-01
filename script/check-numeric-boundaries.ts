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
 * This gate scans packages/core/src, packages/ai/src and
 * packages/cli/src (all three from day one), packages/server/src
 * (added by #1294, the network-boundary package) and
 * packages/console/app/src, packages/console/function/src and
 * packages/function/src (added by #1302, the public console and
 * function packages) with the sweep patterns —
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
 * Usage:
 *   bun run script/check-numeric-boundaries.ts   # exit 1 listing unlisted/stale hits
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const SCAN_ROOTS: string[] = [
  "packages/core/src",
  "packages/ai/src",
  "packages/cli/src",
  "packages/server/src",
  "packages/console/app/src",
  "packages/console/function/src",
  "packages/function/src",
]

export const ALLOWLIST_PATH = "script/check-numeric-boundaries.allowlist.txt"

export const PATTERNS: RegExp[] = [/\bNumber\s*\(/, /\bparseInt\s*\(/, /\bparseFloat\s*\(/]

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

/** Extensions whose files execute code in the scanned packages. */
export const SCANNED_EXTENSIONS: string[] = [".ts", ".tsx"]

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
        `Unlisted numeric-boundary candidate at ${hit.file}:${hit.line}:\n  ${hit.text}\n  Convert it through the shared primitives (packages/core/src/util/number.ts, #993), or add its disposition to ${ALLOWLIST_PATH}.`,
      )
    for (const key of stale) console.error(`Stale allowlist entry (the line no longer matches a sweep pattern): ${key}`)
    process.exit(1)
  }
  console.log(
    `All ${hits.length} numeric-boundary candidates in ${SCAN_ROOTS.length} scan roots are dispositioned in ${ALLOWLIST_PATH}.`,
  )
}

if (import.meta.main) await main()
