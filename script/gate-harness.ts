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

/**
 * A line is comment-only when it is a `//` line, a block-comment
 * continuation (`*`-led), or a block comment that closes at the end of
 * the line. A line that opens a block comment and closes it before
 * code (a note followed by a statement on the same line) is executable
 * and is scanned.
 */
const isCommentOnly = (text: string) =>
  text.startsWith("//") ||
  text.startsWith("*") ||
  (text.startsWith("/*") && text.indexOf("*/", 2) === text.length - 2)

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
        (existsSync(join(dir, "package.json")) || existsSync(join(path, "package.json")))
      ) {
        trees.push(rel)
        continue
      }
      walk(path)
    }
  }
  for (const top of ["packages", "services", "sdks", "github"]) if (existsSync(join(root, top))) walk(join(root, top))
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
 * Execute a gate declaration as a CLI against an already-loaded allowlist.
 * Each gate's entry point loads its own allowlist with the same
 * `Bun.file(...).text()` line the gates have always carried — that line is
 * itself a bounded-http hit dispositioned in that gate's allowlist, so it
 * stays in the gate files, not here.
 */
export function runGate(gate: GateDefinition, root: string, allowlist: Map<string, string[]>): void {
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

/**
 * The harness as one named namespace: the gates import this object and
 * call its members qualified (`gateHarness.collect(...)`) instead of
 * aliasing value imports, which the repo's AGENTS.md bans.
 */
export const gateHarness = {
  collect,
  evaluateGate,
  hitKey,
  isScannedFile,
  parseAllowlist,
  runGate,
  gateWiringViolations,
  stepEventRequirements,
  scanSource,
  scriptTreesOnDisk,
  srcTreesOnDisk,
  staleEntries,
  treesOnDisk,
  unlistedHits,
  unscannedScriptTrees,
  unscannedSrcTrees,
}

/**
 * Gate registry + wiring meta-check data (#1527, design #1525 phase 3).
 *
 * Every gate the repo promises to run is registered here exactly once:
 * the root `check:*` gates, the root `lint:*` scans, `test:lint-rules`,
 * and each package's `check:generated`. `script/check-gates.ts` (the
 * `check:gates` gate, itself registered below) fails when a gate script
 * exists but is unregistered, when a registered gate is invoked by no
 * step of its owning workflow, or when the invoking step is unreachable
 * because its `if:` requires a `github.event_name` the workflow never
 * triggers on — the #1508 shape, where check.yml's lint step waited for
 * a `pull_request` event its workflow did not declare.
 */
export interface RegisteredGate {
  readonly name: string
  /** The package.json script that runs the gate. */
  readonly script: string
  /** Repo-relative package directory, or "." for the root package. */
  readonly packagePath: string
  /** Basename of the workflow that must invoke the gate. */
  readonly workflow: string
}

export const GATE_REGISTRY: readonly RegisteredGate[] = [
  { name: "check:doc-env-vars", script: "check:doc-env-vars", packagePath: ".", workflow: "test.yml" },
  { name: "check:proto-reads", script: "check:proto-reads", packagePath: ".", workflow: "test.yml" },
  { name: "check:bounded-http", script: "check:bounded-http", packagePath: ".", workflow: "test.yml" },
  { name: "check:numeric-boundaries", script: "check:numeric-boundaries", packagePath: ".", workflow: "test.yml" },
  { name: "check:workflows", script: "check:workflows", packagePath: ".", workflow: "test.yml" },
  { name: "check:gates", script: "check:gates", packagePath: ".", workflow: "test.yml" },
  { name: "lint:changed", script: "lint:changed", packagePath: ".", workflow: "check.yml" },
  { name: "lint:effect-patterns", script: "lint:effect-patterns", packagePath: ".", workflow: "test.yml" },
  {
    name: "lint:effect-simplifications",
    script: "lint:effect-simplifications",
    packagePath: ".",
    workflow: "test.yml",
  },
  { name: "test:lint-rules", script: "test:lint-rules", packagePath: ".", workflow: "test.yml" },
  { name: "client check:generated", script: "check:generated", packagePath: "packages/client", workflow: "test.yml" },
  {
    name: "protocol check:generated",
    script: "check:generated",
    packagePath: "packages/protocol",
    workflow: "test.yml",
  },
  { name: "www check:generated", script: "check:generated", packagePath: "services/www", workflow: "test.yml" },
]

/** Root script names that must be registered: every `check:*` and `lint:*` script, plus `test:lint-rules`. */
export const mustRegisterRootScript = (name: string) =>
  name.startsWith("check:") || name.startsWith("lint:") || name === "test:lint-rules"

/** One observed invocation of a script by a workflow step. */
export interface GateUse {
  readonly workflow: string
  readonly script: string
  /** The step's working directory ("." when the step runs at the repo root). */
  readonly packagePath: string
  /** The step's `if:` expression, when it declares one. */
  readonly stepIf?: string
}

export interface GateWiringInput {
  /** Script names declared by the root package.json. */
  readonly rootScripts: readonly string[]
  /** Repo-relative package directories whose package.json declares a `check:generated` script. */
  readonly generatedPackages: readonly string[]
  readonly uses: readonly GateUse[]
  /** Trigger event names per workflow basename, from the parsed `on:` value. */
  readonly workflowTriggers: Readonly<Record<string, readonly string[]>>
}

export interface GateWiringViolation {
  readonly rule: "unregistered-gate" | "stale-registry-entry" | "unwired-gate" | "unreachable-gate"
  readonly detail: string
}

/** Event names a step `if:` expression requires by equality on `github.event_name`. */
export function stepEventRequirements(stepIf: string): string[] {
  const events: string[] = []
  for (const match of stepIf.matchAll(/github\.event_name\s*={2,3}\s*'([^']+)'/g)) events.push(match[1])
  for (const match of stepIf.matchAll(/github\.event_name\s*={2,3}\s*"([^"]+)"/g)) events.push(match[1])
  return events
}

/** Split OR branches without breaking on parentheses or quoted event names. */
function eventAlternatives(stepIf: string): string[][] {
  const branches: string[] = []
  let start = 0
  let depth = 0
  let quote: "'" | '"' | undefined
  for (let index = 0; index < stepIf.length; index++) {
    const character = stepIf[index]
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "(") depth++
    if (character === ")") depth--
    if (depth === 0 && stepIf.startsWith("||", index)) {
      branches.push(stepIf.slice(start, index))
      start = index + 2
      index++
    }
  }
  branches.push(stepIf.slice(start))
  return branches.map(stepEventRequirements)
}

/**
 * Every wiring violation in the given snapshot, in rule order. Pure:
 * `script/check-gates.ts` supplies the on-disk snapshot and the tests
 * supply fixtures, including the #1508 shape verbatim. Expressions that
 * do not equate `github.event_name` to a literal (e.g. `runner.os`) and
 * equalities naming a declared trigger are not violations.
 */
export function gateWiringViolations(
  input: GateWiringInput,
  registry: readonly RegisteredGate[] = GATE_REGISTRY,
): GateWiringViolation[] {
  const violations: GateWiringViolation[] = []
  const rootEntries = registry.filter((entry) => entry.packagePath === ".")
  for (const name of input.rootScripts) {
    if (!mustRegisterRootScript(name)) continue
    if (!rootEntries.some((entry) => entry.script === name))
      violations.push({
        rule: "unregistered-gate",
        detail: `root script ${name} is not in GATE_REGISTRY (script/gate-harness.ts); register it with its owning workflow or the gate runs nowhere anyone checks (#1527)`,
      })
  }
  for (const packagePath of input.generatedPackages) {
    if (!registry.some((entry) => entry.packagePath === packagePath && entry.script === "check:generated"))
      violations.push({
        rule: "unregistered-gate",
        detail: `${packagePath} declares check:generated but is not in GATE_REGISTRY (script/gate-harness.ts); register it with its owning workflow (#1527)`,
      })
  }
  for (const entry of registry) {
    const exists =
      entry.packagePath === "."
        ? input.rootScripts.includes(entry.script)
        : entry.script === "check:generated" && input.generatedPackages.includes(entry.packagePath)
    if (!exists) {
      violations.push({
        rule: "stale-registry-entry",
        detail: `registered gate ${entry.name} names script ${entry.script} in ${entry.packagePath}, which no longer exists; remove the registry entry (#1527)`,
      })
      continue
    }
    const uses = input.uses.filter(
      (use) => use.workflow === entry.workflow && use.script === entry.script && use.packagePath === entry.packagePath,
    )
    if (!uses.length) {
      violations.push({
        rule: "unwired-gate",
        detail: `registered gate ${entry.name} is invoked by no step of ${entry.workflow}; wire it or remove the registry entry (#1527)`,
      })
      continue
    }
    const triggers = input.workflowTriggers[entry.workflow] ?? []
    for (const use of uses) {
      if (!use.stepIf) continue
      const alternatives = eventAlternatives(use.stepIf)
      if (!alternatives.some((events) => events.length)) continue
      const reachable = alternatives.some((events) => {
        if (!events.length) return true
        const distinctEvents = [...new Set(events)]
        return distinctEvents.length === 1 && triggers.includes(distinctEvents[0])
      })
      if (reachable) continue
      const unavailable = [...new Set(alternatives.flat())].filter((event) => !triggers.includes(event))
      violations.push({
        rule: "unreachable-gate",
        detail: unavailable.length
          ? `gate ${entry.name} in ${entry.workflow} is gated on github.event_name == '${unavailable.join("' or '")}', which ${entry.workflow} never triggers on (triggers: ${triggers.join(", ") || "none"}); the step can never run — the #1508 shape (#1527)`
          : `gate ${entry.name} in ${entry.workflow} requires mutually exclusive github.event_name values (${[...new Set(alternatives.flat())].join(", ")}); the step can never run — the #1527 shape`,
      })
    }
  }
  return violations
}
