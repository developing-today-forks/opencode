#!/usr/bin/env bun
/**
 * Regression net for the prototype-chain dictionary-read class (#865,
 * follow-up to the #833 audit).
 *
 * A bare `record[key]` read walks the prototype chain: an externally
 * supplied key like "constructor" resolves to an inherited member instead
 * of missing, and a `?? fallback` never fires because inherited members are
 * not nullish. The blessed fix is `ownValue`/`ownOr` from
 * packages/core/src/util/record.ts. This gate scans packages/core/src with
 * the two sweep patterns pinned on #833 —
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
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const SCAN_ROOT = "packages/core/src"
export const ALLOWLIST_PATH = "script/check-proto-reads.allowlist.txt"

export const PATTERNS: RegExp[] = [/\b[A-Z][A-Z_0-9]{2,}\[[a-zA-Z_]/, /\[[a-zA-Z_.]+\] \?\?/, /\[[^\]]*\([^\]]*\] \?\?/]

export interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
}

export const hitKey = (file: string, text: string) => `${file} :: ${text}`

/** Every line of `source` matching a sweep pattern, as hits for `file`. */
export function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  source.split("\n").forEach((raw, index) => {
    const text = raw.trim()
    if (text && PATTERNS.some((pattern) => pattern.test(text))) hits.push({ file, line: index + 1, text })
  })
  return hits
}

/**
 * Parse the allowlist: `file :: exact trimmed line :: disposition` per line.
 * Entries are occurrence-aware (#1086): the value is the list of dispositions
 * for the key, so N identical lines in a file need N entries — one entry no
 * longer silently covers a copy-pasted duplicate line.
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

function collect(root: string, dir: string, hits: Hit[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(root, path, hits)
    else if (entry.name.endsWith(".ts"))
      hits.push(...scanSource(path.slice(root.length + 1), readFileSync(path, "utf8")))
  }
}

async function main() {
  const root = join(import.meta.dir, "..")
  const hits: Hit[] = []
  collect(root, join(root, SCAN_ROOT), hits)
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  const unlisted = unlistedHits(hits, allowlist)
  const stale = staleEntries(hits, allowlist)
  if (unlisted.length || stale.length) {
    for (const hit of unlisted)
      console.error(
        `Unlisted prototype-chain read candidate at ${hit.file}:${hit.line}:\n  ${hit.text}\n  Guard it with ownValue/ownOr (packages/core/src/util/record.ts), or add its disposition to ${ALLOWLIST_PATH}.`,
      )
    for (const key of stale)
      console.error(`Stale allowlist entry (the line no longer matches a sweep pattern): ${key}`)
    process.exit(1)
  }
  console.log(`All ${hits.length} prototype-chain read candidates in ${SCAN_ROOT} are dispositioned in ${ALLOWLIST_PATH}.`)
}

if (import.meta.main) await main()
