#!/usr/bin/env bun
/**
 * Regression net for the workflow policies that until now were
 * convention only (#1406):
 *
 *   1. No workflow triggers on `pull_request` or `pull_request_target`.
 *      The no-PR-trigger policy (PR #1401) exists so a fork PR can never
 *      run code with this repo's credentials; CI runs on push to main,
 *      on a schedule, and by hand instead.
 *   2. Every workflow declares `workflow_dispatch`, so any workflow can
 *      be run by hand when its automatic triggers are not enough.
 *   3. Every job declares `timeout-minutes`, so a hung job cannot burn a
 *      runner until the platform default (360 minutes) kills it. This
 *      half of the policy already regressed twice and was caught by hand
 *      both times (#1326, #1184). Reusable-workflow jobs (a job-level
 *      `uses:`) are exempt: the called workflow owns its timeouts and
 *      the caller cannot set `timeout-minutes` on such a job.
 *
 * Trigger matching is by exact key: `pull_request_review_comment` and
 * `issue_comment` are different events, not PR triggers — opencode.yml
 * carries both and is compliant. The trigger list comes from the parsed
 * YAML, never from text search, so a workflow that merely mentions
 * `pull_request` in a comment or a step (review.yml's steps read
 * `github.event.pull_request`) is not flagged.
 *
 * YAML handling: the `on:` value arrives in string form (`on: push`),
 * list form (`on: [push, workflow_dispatch]`), or map form (the usual
 * shape). Under a YAML 1.1 parser the unquoted key `on` parses as the
 * boolean `true`, so the trigger map is looked up under `on`, `true`,
 * and `"true"` alike; Bun.YAML keeps `on` a string, and the other two
 * lookups keep this gate correct if the parser ever changes.
 *
 * Usage:
 *   bun run script/check-workflows.ts   # exit 1 listing policy violations
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"

export const WORKFLOWS_DIR = ".github/workflows"

export const FORBIDDEN_TRIGGERS = ["pull_request", "pull_request_target"] as const

export const REQUIRED_TRIGGER = "workflow_dispatch"

export interface Violation {
  readonly file: string
  readonly rule: string
  readonly job?: string
  readonly detail: string
}

type Parsed = Record<string, unknown>

const isRecord = (value: unknown): value is Parsed => typeof value === "object" && value !== null && !Array.isArray(value)

/** Parse one workflow file's YAML source. */
export function parseWorkflow(source: string): Parsed {
  const parsed: unknown = Bun.YAML.parse(source)
  if (!isRecord(parsed)) throw new Error("workflow YAML did not parse to a mapping")
  return parsed
}

/**
 * The workflow's trigger names, from any `on:` shape. Exact keys only:
 * a map contributes its keys, a list its entries, a string itself.
 */
export function triggerNames(workflow: Parsed): string[] {
  // A boolean `true` key (the YAML 1.1 reading of `on`) stringifies to
  // "true" in a JS object, so the second lookup covers that quirk.
  const on = workflow["on"] ?? workflow["true"]
  if (typeof on === "string") return [on]
  if (Array.isArray(on)) return on.filter((entry): entry is string => typeof entry === "string")
  if (isRecord(on)) return Object.keys(on)
  return []
}

/** Every policy violation in one parsed workflow, in rule order. */
export function workflowViolations(file: string, workflow: Parsed): Violation[] {
  const violations: Violation[] = []
  const triggers = triggerNames(workflow)
  for (const trigger of FORBIDDEN_TRIGGERS) {
    if (triggers.includes(trigger))
      violations.push({
        file,
        rule: "no-pr-trigger",
        detail: `triggers on ${trigger}; workflows run on push, schedule, or dispatch, never on pull requests (#1401)`,
      })
  }
  if (!triggers.includes(REQUIRED_TRIGGER))
    violations.push({
      file,
      rule: "require-workflow-dispatch",
      detail: `does not declare ${REQUIRED_TRIGGER}; every workflow must be runnable by hand`,
    })
  if (isRecord(workflow["jobs"])) {
    for (const [name, job] of Object.entries(workflow["jobs"])) {
      if (!isRecord(job)) continue
      if ("uses" in job) continue
      if (!("timeout-minutes" in job))
        violations.push({
          file,
          rule: "require-timeout-minutes",
          job: name,
          detail: `job ${name} does not declare timeout-minutes; a hung job would run to the 360-minute platform default (#1326, #1184)`,
        })
    }
  }
  return violations
}

/** Every policy violation in one workflow file's YAML source. */
export function sourceViolations(file: string, source: string): Violation[] {
  return workflowViolations(file, parseWorkflow(source))
}

/** Sorted repo-relative paths of the workflow files under `root`. */
export function workflowFiles(root: string): string[] {
  return readdirSync(join(root, WORKFLOWS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => join(WORKFLOWS_DIR, entry.name).split(sep).join("/"))
    .toSorted((a, b) => a.localeCompare(b))
}

/** Every policy violation in every workflow file under `root`. */
export function collectViolations(root: string): { files: string[]; violations: Violation[] } {
  const files = workflowFiles(root)
  const violations = files.flatMap((file) => sourceViolations(file, readFileSync(join(root, file), "utf8")))
  return { files, violations }
}

function main() {
  const root = join(import.meta.dir, "..")
  const { files, violations } = collectViolations(root)
  if (violations.length) {
    for (const violation of violations)
      console.error(
        `Workflow policy violation in ${violation.file}${violation.job ? ` (job ${violation.job})` : ""} [${violation.rule}]: ${violation.detail}.`,
      )
    process.exit(1)
  }
  console.log(`All ${files.length} workflows in ${WORKFLOWS_DIR} follow the workflow policies (no PR triggers, ${REQUIRED_TRIGGER} declared, timeout-minutes on every non-reusable job).`)
}

if (import.meta.main) main()
