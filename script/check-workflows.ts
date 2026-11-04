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
 *      both times (#1326, #1184). Reusable-workflow callers cannot declare
 *      a timeout of their own, so only the called workflow owns timeouts;
 *      caller jobs are instead checked against GitHub's allowed-key list.
 *   4. Every workflow declares a top-level `permissions:` mapping in the
 *      least-privilege posture (#1503): without one, the GITHUB_TOKEN
 *      silently receives the permissive default grant and nothing flags
 *      the drift. Scope keys must be GitHub's documented set and levels
 *      read/write/none; the scalar shorthands (`write-all`, `read-all`)
 *      are not a mapping and never satisfy this. `write` is allowed only
 *      on `contents` (publishing and branch maintenance need it); every
 *      other existing write grant and every existing job-level
 *      `permissions:` block is a named exception below, not a pattern to
 *      copy — job-level blocks replace the top level wholesale on
 *      GitHub's side, so new code declares permissions once, at the top.
 *      Exceptions are ratcheted: one whose grant or job block has been
 *      removed is itself a violation, so the baseline only shrinks.
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

export const REUSABLE_WORKFLOW_CALLER_KEYS = new Set([
  "name",
  "uses",
  "with",
  "secrets",
  "strategy",
  "needs",
  "if",
  "concurrency",
  "permissions",
  "cache-mode",
])

/** GitHub's documented top-level permission scopes. */
export const PERMISSION_SCOPES = new Set([
  "actions",
  "artifact-metadata",
  "attestations",
  "checks",
  "code-quality",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
  "vulnerability-alerts",
])

export const PERMISSION_LEVELS = new Set(["read", "write", "none"])

/** The one scope any workflow may hold at `write` without an exception. */
export const WRITE_PERMITTED_SCOPES = new Set(["contents"])

/**
 * Existing non-`contents` write grants, by workflow file basename and
 * scope (#1503 baseline). Each is load-bearing today — OIDC publishing
 * and sync jobs — and each is expected to disappear, never to be joined
 * by new entries: new write grants beyond `contents` need a policy
 * change, not a baseline edit.
 */
export const PERMISSION_WRITE_EXCEPTIONS: Record<string, ReadonlySet<string>> = {
  "agents.yml": new Set(["id-token"]),
  "containers.yml": new Set(["packages"]),
  "deploy.yml": new Set(["id-token"]),
  "jules-daily-upstream-sync.yml": new Set(["issues", "pull-requests"]),
  "main-broken.yml": new Set(["issues"]),
  "publish.yml": new Set(["id-token", "packages"]),
  "repo-sweeper.yml": new Set(["issues", "pull-requests"]),
  "test.yml": new Set(["checks"]),
}

/**
 * Existing job-level `permissions:` blocks, by workflow file basename
 * and job name (#1503 baseline): the sync and gate jobs that predate
 * the top-level posture. New jobs inherit the top level instead.
 */
export const JOB_PERMISSION_EXCEPTIONS: Record<string, ReadonlySet<string>> = {
  "agents.yml": new Set(["scheduled"]),
  "docs-locale-sync.yml": new Set(["sync-locales"]),
  "docs-update.yml": new Set(["update-docs"]),
  "jules-daily-upstream-sync.yml": new Set(["daily-upstream-sync"]),
  "main-broken.yml": new Set(["watch"]),
  "opencode.yml": new Set(["opencode"]),
  "pr-standards.yml": new Set(["check-compliance", "check-standards"]),
  "publish-github-action.yml": new Set(["main-gate"]),
  "publish-vscode.yml": new Set(["main-gate"]),
  "publish.yml": new Set(["main-gate"]),
  "review.yml": new Set(["check-guidelines"]),
  "stats.yml": new Set(["stats"]),
  "test.yml": new Set(["ci-fix"]),
}

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
  const base = file.split("/").at(-1) ?? file
  const writeExceptions = PERMISSION_WRITE_EXCEPTIONS[base] ?? new Set<string>()
  const grantedWrite = new Set<string>()
  const permissions = workflow["permissions"]
  if (permissions === undefined)
    violations.push({
      file,
      rule: "require-top-level-permissions",
      detail:
        "does not declare top-level permissions; the GITHUB_TOKEN would receive the permissive default grant (#1503)",
    })
  else if (!isRecord(permissions))
    violations.push({
      file,
      rule: "permissions-mapping-form",
      detail: `declares permissions as ${JSON.stringify(permissions)}; the scalar shorthand grants every scope at once and never satisfies the least-privilege posture (#1503)`,
    })
  else
    for (const [scope, level] of Object.entries(permissions)) {
      if (!PERMISSION_SCOPES.has(scope)) {
        violations.push({
          file,
          rule: "permissions-scope",
          detail: `declares unknown permission scope ${scope}; keys must be GitHub's documented set (#1503)`,
        })
        continue
      }
      if (typeof level !== "string" || !PERMISSION_LEVELS.has(level)) {
        violations.push({
          file,
          rule: "permissions-level",
          detail: `declares permission ${scope}: ${JSON.stringify(level)}; levels are read, write, or none (#1503)`,
        })
        continue
      }
      if (level === "write") {
        grantedWrite.add(scope)
        if (!WRITE_PERMITTED_SCOPES.has(scope) && !writeExceptions.has(scope))
          violations.push({
            file,
            rule: "permissions-write-scope",
            detail: `grants ${scope}: write at the top level; write is permitted only on contents — other scopes need a policy change, not a new grant (#1503)`,
          })
      }
    }
  for (const scope of writeExceptions)
    if (!grantedWrite.has(scope))
      violations.push({
        file,
        rule: "stale-permission-exception",
        detail: `the ${scope}: write exception for this workflow is no longer used; remove it from PERMISSION_WRITE_EXCEPTIONS so the baseline only shrinks (#1503)`,
      })
  const jobExceptions = JOB_PERMISSION_EXCEPTIONS[base] ?? new Set<string>()
  const jobsWithPermissions = new Set<string>()
  if (isRecord(workflow["jobs"])) {
    for (const [name, job] of Object.entries(workflow["jobs"])) {
      if (!isRecord(job)) continue
      // Caller jobs are exempt from the job-level rule below, but their
      // permissions block still counts as using a baseline exception.
      if ("permissions" in job) jobsWithPermissions.add(name)
      if ("uses" in job) {
        for (const key of Object.keys(job)) {
          if (REUSABLE_WORKFLOW_CALLER_KEYS.has(key)) continue
          violations.push({
            file,
            rule: "reusable-workflow-caller-keys",
            job: name,
            detail: `job ${name} declares ${key}, which is not allowed on a reusable-workflow caller job`,
          })
        }
        continue
      }
      if ("permissions" in job) {
        if (!jobExceptions.has(name))
          violations.push({
            file,
            rule: "no-job-level-permissions",
            job: name,
            detail: `job ${name} declares its own permissions; a job-level block replaces the workflow's top-level grant wholesale, so permissions are declared once at the top level (#1503)`,
          })
      }
      if (!("timeout-minutes" in job))
        violations.push({
          file,
          rule: "require-timeout-minutes",
          job: name,
          detail: `job ${name} does not declare timeout-minutes; a hung job would run to the 360-minute platform default (#1326, #1184)`,
        })
    }
  }
  for (const name of jobExceptions)
    if (!jobsWithPermissions.has(name))
      violations.push({
        file,
        rule: "stale-permission-exception",
        job: name,
        detail: `the job-level permissions exception for job ${name} is no longer used; remove it from JOB_PERMISSION_EXCEPTIONS so the baseline only shrinks (#1503)`,
      })
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

/**
 * Stale-exception violations for baselined workflows that are absent
 * from the collected file set: when an excepted workflow is deleted or
 * renamed, its exception entries must not survive silently in the maps
 * (a later workflow reusing the filename would inherit the exemption).
 */
export function absentFileExceptions(files: string[]): Violation[] {
  const present = new Set(files.map((file) => file.split("/").at(-1) ?? file))
  const violations: Violation[] = []
  for (const [base, scopes] of Object.entries(PERMISSION_WRITE_EXCEPTIONS))
    if (!present.has(base))
      violations.push({
        file: `${WORKFLOWS_DIR}/${base}`,
        rule: "stale-permission-exception",
        detail: `the ${[...scopes].join(", ")} write exception(s) for this workflow match no file in ${WORKFLOWS_DIR}; remove them from PERMISSION_WRITE_EXCEPTIONS so the baseline only shrinks (#1503)`,
      })
  for (const [base, jobs] of Object.entries(JOB_PERMISSION_EXCEPTIONS))
    if (!present.has(base))
      violations.push({
        file: `${WORKFLOWS_DIR}/${base}`,
        rule: "stale-permission-exception",
        detail: `the job-level permissions exception(s) for job(s) ${[...jobs].join(", ")} match no file in ${WORKFLOWS_DIR}; remove them from JOB_PERMISSION_EXCEPTIONS so the baseline only shrinks (#1503)`,
      })
  return violations
}

/** Every policy violation in every workflow file under `root`. */
export function collectViolations(root: string): { files: string[]; violations: Violation[] } {
  const files = workflowFiles(root)
  const violations = files.flatMap((file) => sourceViolations(file, readFileSync(join(root, file), "utf8")))
  violations.push(...absentFileExceptions(files))
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
  console.log(`All ${files.length} workflows in ${WORKFLOWS_DIR} follow the workflow policies (no PR triggers, ${REQUIRED_TRIGGER} declared, timeout-minutes on every non-reusable job, allowlisted reusable-workflow callers, top-level least-privilege permissions mapping).`)
}

if (import.meta.main) main()
