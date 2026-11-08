#!/usr/bin/env bun
/**
 * Gate wiring meta-check (#1527, design #1525 phase 3).
 *
 * The gate registry lives as data in the shared harness
 * (`script/gate-harness.ts`: GATE_REGISTRY). This gate fails when:
 *
 *   1. a root `check:*` / `lint:*` script, `test:lint-rules`, or a
 *      package `check:generated` script exists but is unregistered;
 *   2. a registered gate is invoked by no step of its owning workflow;
 *   3. a registered gate's invoking step is unreachable — its `if:`
 *      equates `github.event_name` to an event the workflow never
 *      triggers on (the #1508 shape: check.yml's lint step required
 *      `pull_request`, which check.yml does not trigger on).
 *
 * Choice recorded for #1527: a sibling `check:gates` gate (this file),
 * not a rule inside check:workflows — workflow *policy* (#1406/#1503)
 * and gate *wiring* (#1527) fail for different reasons and are triaged
 * by different fixes, so they report separately. This gate registers
 * itself in GATE_REGISTRY and is wired in test.yml like the others.
 *
 * Usage:
 *   bun run script/check-gates.ts   # exit 1 listing wiring violations
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"
import { GATE_REGISTRY, gateWiringViolations, type GateUse } from "./gate-harness"
import { parseWorkflow, triggerNames, workflowFiles } from "./check-workflows"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function packageScripts(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(parsed) || !isRecord(parsed["scripts"])) return {}
  return parsed["scripts"] as Record<string, string>
}

/** Repo-relative package dirs (one and two levels deep) whose package.json declares `check:generated`. */
export function generatedPackages(root: string): string[] {
  const found: string[] = []
  const scan = (relative: string) => {
    if ("check:generated" in packageScripts(join(root, relative, "package.json"))) found.push(relative)
  }
  for (const area of ["packages", "services"]) {
    const areaPath = join(root, area)
    if (!existsSync(areaPath)) continue
    for (const entry of readdirSync(areaPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      scan(`${area}/${entry.name}`)
      const nested = join(areaPath, entry.name)
      for (const child of readdirSync(nested, { withFileTypes: true }))
        if (child.isDirectory()) scan(`${area}/${entry.name}/${child.name}`)
    }
  }
  return found.toSorted((a, b) => a.localeCompare(b))
}

/** Every `bun run <script>` invocation in a workflow's steps, with its working directory and `if:`. */
export function workflowUses(file: string, source: string): GateUse[] {
  const workflow = parseWorkflow(source)
  const base = file.split("/").at(-1) ?? file
  const uses: GateUse[] = []
  if (!isRecord(workflow["jobs"])) return uses
  for (const job of Object.values(workflow["jobs"])) {
    if (!isRecord(job) || !Array.isArray(job["steps"])) continue
    for (const step of job["steps"]) {
      if (!isRecord(step) || typeof step["run"] !== "string") continue
      const workingDirectory =
        typeof step["working-directory"] === "string" ? step["working-directory"].split(sep).join("/") : "."
      for (const match of step["run"].matchAll(/bun run\s+([^\s]+(?:\s+[^\s]+){0,2})/g)) {
        const tokens = (match[1] ?? "").split(/\s+/)
        let packagePath = workingDirectory
        let script = tokens[0] ?? ""
        if (tokens[0] === "--cwd") {
          packagePath = tokens[1] ?? workingDirectory
          script = tokens[2] ?? ""
        }
        if (!script) continue
        uses.push({
          workflow: base,
          script,
          packagePath,
          stepIf: typeof step["if"] === "string" ? step["if"] : undefined,
        })
      }
    }
  }
  return uses
}

/** The on-disk wiring snapshot for the whole repo under `root`. */
export function collectWiring(root: string) {
  const files = workflowFiles(root)
  const workflowTriggers: Record<string, readonly string[]> = {}
  const uses: GateUse[] = []
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8")
    workflowTriggers[file.split("/").at(-1) ?? file] = triggerNames(parseWorkflow(source))
    uses.push(...workflowUses(file, source))
  }
  return {
    rootScripts: Object.keys(packageScripts(join(root, "package.json"))),
    generatedPackages: generatedPackages(root),
    uses,
    workflowTriggers,
  }
}

function main() {
  const root = join(import.meta.dir, "..")
  const violations = gateWiringViolations(collectWiring(root))
  if (violations.length) {
    for (const violation of violations) console.error(`Gate wiring violation [${violation.rule}]: ${violation.detail}.`)
    process.exit(1)
  }
  console.log(
    `All ${GATE_REGISTRY.length} registered gates are registered, wired, and reachable (root check:*/lint:* scripts, test:lint-rules, and package check:generated scripts all covered).`,
  )
}

if (import.meta.main) main()
