import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

export interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** A drift guard: package trees of one kind on disk must all appear in the gate's scan roots. */
export interface TreeCheck {
  readonly kind: "script" | "src"
  /** Gate file named in the failure message as the place to add the missing root. */
  readonly gateFile: string
}

export interface GateDefinition {
  readonly name: string
  readonly scanRoots: readonly string[]
  readonly scannedExtensions: readonly string[]
  readonly allowlistPath: string
  readonly patterns: readonly RegExp[]
  readonly candidate: string
  readonly remediation: string
  readonly summary: (hitCount: number, rootCount: number, allowlistPath: string) => string
  readonly treeChecks?: readonly TreeCheck[]
}

export const hitKey = (file: string, text: string) => `${file} :: ${text}`

const isCommentOnly = (text: string) => text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")

/** Return every matching, non-comment source line for a gate's declared patterns. */
export function scanSource(file: string, source: string, patterns: readonly RegExp[]): Hit[] {
  const hits: Hit[] = []
  source.split("\n").forEach((raw, index) => {
    const text = raw.trim()
    if (text && !isCommentOnly(text) && patterns.some((pattern) => pattern.test(text)))
      hits.push({ file, line: index + 1, text })
  })
  return hits
}

/** Parse `file :: exact hit line :: disposition`, retaining ` :: ` inside the hit line. */
export function parseAllowlist(source: string): Map<string, string[]> {
  const entries = new Map<string, string[]>()
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split(" :: ")
    if (parts.length < 3) throw new Error(`Malformed allowlist line (want file :: line :: disposition): ${line}`)
    const key = hitKey(parts[0], parts.slice(1, -1).join(" :: "))
    entries.set(key, [...(entries.get(key) ?? []), parts.at(-1)!])
  }
  return entries
}

/** An allowlist entry covers one matching occurrence, not every identical copy. */
export const unlistedHits = (hits: Hit[], allowlist: Map<string, string[]>) => {
  const seen = new Map<string, number>()
  return hits.filter((hit) => {
    const key = hitKey(hit.file, hit.text)
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    return occurrence > (allowlist.get(key)?.length ?? 0)
  })
}

/** Return one stale key for each excess disposition. */
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

export const isScannedFile = (name: string, extensions: readonly string[]) => extensions.some((ext) => name.endsWith(ext))

/** Walk one scan root in stable order and emit POSIX repo-relative hit keys on every platform. */
export function collect(
  root: string,
  dir: string,
  hits: Hit[],
  patterns: readonly RegExp[],
  extensions: readonly string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(root, path, hits, patterns, extensions)
    else if (isScannedFile(entry.name, extensions))
      hits.push(...scanSource(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"), patterns))
  }
}

/**
 * Every package-owned tree on disk under `root` whose directory name is in
 * `names`: a directory at any nesting depth below the package-name level
 * (packages/console/app, packages/stats/core) whose parent directory (the
 * package root) or the tree itself carries a package.json. Folders with no
 * package.json at either level (skill assets, content folders) are not
 * package trees and are excluded, as is any node_modules subtree. A found
 * tree is not descended into.
 */
export function treesOnDisk(root: string, names: readonly string[]): string[] {
  const trees: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue
      const path = join(dir, entry.name)
      const rel = relative(root, path).split(sep).join("/")
      if (
        names.includes(entry.name) &&
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

/** Package-owned script trees on disk, matching the historical bounded-http inventory (#1425). */
export const scriptTreesOnDisk = (root: string) => treesOnDisk(root, ["script", "scripts"])

/** Script trees present on disk but absent from `roots` — the #1425 escape, as a failing condition. */
export const unscannedScriptTrees = (root: string, roots: readonly string[]) =>
  scriptTreesOnDisk(root).filter((tree) => !roots.includes(tree))

/** Package-owned src trees on disk — the mirror of scriptTreesOnDisk for src roots (#1494). */
export const srcTreesOnDisk = (root: string) => treesOnDisk(root, ["src"])

/** Src trees present on disk but absent from `roots` — the #1494 escape, as a failing condition. */
export const unscannedSrcTrees = (root: string, roots: readonly string[]) =>
  srcTreesOnDisk(root).filter((tree) => !roots.includes(tree))

export interface UnscannedTree {
  readonly kind: TreeCheck["kind"]
  readonly tree: string
  readonly gateFile: string
}

export interface GateResult {
  readonly hits: Hit[]
  readonly unlisted: Hit[]
  readonly stale: string[]
  readonly unscannedTrees: UnscannedTree[]
}

/** Evaluate a gate's declaration against a root and its allowlist text. */
function evaluate(gate: GateDefinition, root: string, allowlist: Map<string, string[]>): GateResult {
  const hits: Hit[] = []
  for (const scanRoot of gate.scanRoots)
    collect(root, join(root, scanRoot), hits, gate.patterns, gate.scannedExtensions)
  const unscannedTrees: UnscannedTree[] = []
  for (const check of gate.treeChecks ?? []) {
    const onDisk = check.kind === "script" ? scriptTreesOnDisk(root) : srcTreesOnDisk(root)
    for (const tree of onDisk)
      if (!gate.scanRoots.includes(tree)) unscannedTrees.push({ kind: check.kind, tree, gateFile: check.gateFile })
  }
  return {
    hits,
    unlisted: unlistedHits(hits, allowlist),
    stale: staleEntries(hits, allowlist),
    unscannedTrees,
  }
}

/** Evaluate a gate declaration against its root and allowlist text. */
export function evaluateGate(gate: GateDefinition, root: string, allowlistText: string): GateResult {
  return evaluate(gate, root, parseAllowlist(allowlistText))
}

/**
 * Execute a gate declaration as a CLI: the repo root is this module's
 * parent directory and the allowlist is loaded from the declaration's
 * allowlist path. Exit 1 listing every failure, or print the summary.
 */
export async function runGate(gate: GateDefinition): Promise<void> {
  const root = join(import.meta.dir, "..")
  const allowlist = parseAllowlist(await Bun.file(join(root, gate.allowlistPath)).text())
  const result = evaluate(gate, root, allowlist)
  if (result.unlisted.length || result.stale.length || result.unscannedTrees.length) {
    for (const { kind, tree, gateFile } of result.unscannedTrees)
      console.error(
        `Unscanned ${kind} tree on disk: ${tree}\n  Add it to SCAN_ROOTS in ${gateFile} and disposition its hits in ${gate.allowlistPath}.`,
      )
    for (const hit of result.unlisted)
      console.error(
        `Unlisted ${gate.candidate} at ${hit.file}:${hit.line}:\n  ${hit.text}\n  ${gate.remediation} ${gate.allowlistPath}.`,
      )
    for (const key of result.stale) console.error(`Stale allowlist entry (the line no longer matches a sweep pattern): ${key}`)
    process.exit(1)
  }
  console.log(gate.summary(result.hits.length, gate.scanRoots.length, gate.allowlistPath))
}
