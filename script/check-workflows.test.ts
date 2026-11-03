import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { collectViolations, parseWorkflow, sourceViolations, triggerNames, workflowFiles, workflowViolations } from "./check-workflows"

const compliant = [
  "name: example",
  "on:",
  "  push:",
  "    branches: [main]",
  "  workflow_dispatch:",
  "jobs:",
  "  test:",
  "    timeout-minutes: 15",
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - run: echo ok",
].join("\n")

describe("triggerNames", () => {
  test("reads the map form", () => {
    expect(triggerNames(parseWorkflow(compliant))).toEqual(["push", "workflow_dispatch"])
  })

  test("reads the list form", () => {
    expect(triggerNames(parseWorkflow("on: [push, workflow_dispatch]"))).toEqual(["push", "workflow_dispatch"])
  })

  test("reads the string form", () => {
    expect(triggerNames(parseWorkflow("on: workflow_dispatch"))).toEqual(["workflow_dispatch"])
  })

  test("reads the on:-as-boolean-true quirk (YAML 1.1 parsers)", () => {
    // A YAML 1.1 parser turns the unquoted key `on` into boolean true,
    // which a JS object carries under the "true" key.
    const workflow = { true: { push: null, workflow_dispatch: null }, jobs: {} }
    expect(triggerNames(workflow)).toEqual(["push", "workflow_dispatch"])
    expect(workflowViolations(".github/workflows/example.yml", workflow)).toEqual([])
  })
})

describe("sourceViolations", () => {
  test("a compliant workflow has no violations", () => {
    expect(sourceViolations(".github/workflows/example.yml", compliant)).toEqual([])
  })

  test("flags a pull_request trigger (map form)", () => {
    const violations = sourceViolations(
      ".github/workflows/example.yml",
      compliant.replace("  push:", "  pull_request:"),
    )
    expect(violations.map((violation) => violation.rule)).toEqual(["no-pr-trigger"])
    expect(violations[0].file).toBe(".github/workflows/example.yml")
  })

  test("flags a pull_request_target trigger (list form)", () => {
    const violations = sourceViolations(
      ".github/workflows/example.yml",
      ["on: [pull_request_target, workflow_dispatch]", "jobs:", "  test:", "    timeout-minutes: 15"].join("\n"),
    )
    expect(violations.map((violation) => violation.rule)).toEqual(["no-pr-trigger"])
  })

  test("exact-key matching: pull_request_review_comment and issue_comment are not PR triggers", () => {
    const violations = sourceViolations(
      ".github/workflows/opencode.yml",
      [
        "on:",
        "  issue_comment:",
        "    types: [created]",
        "  pull_request_review_comment:",
        "    types: [created]",
        "  workflow_dispatch:",
        "jobs:",
        "  opencode:",
        "    timeout-minutes: 60",
      ].join("\n"),
    )
    expect(violations).toEqual([])
  })

  test("flags a workflow with no workflow_dispatch", () => {
    const violations = sourceViolations(
      ".github/workflows/example.yml",
      ["on: [push]", "jobs:", "  test:", "    timeout-minutes: 15"].join("\n"),
    )
    expect(violations.map((violation) => violation.rule)).toEqual(["require-workflow-dispatch"])
  })

  test("flags a job with no timeout-minutes, naming the job", () => {
    const violations = sourceViolations(
      ".github/workflows/example.yml",
      [
        "on: [workflow_dispatch]",
        "jobs:",
        "  test:",
        "    timeout-minutes: 15",
        "  lint:",
        "    runs-on: ubuntu-24.04",
      ].join("\n"),
    )
    expect(violations.map((violation) => violation.rule)).toEqual(["require-timeout-minutes"])
    expect(violations[0].job).toBe("lint")
  })

  test("a reusable-workflow job (job-level uses:) needs no timeout-minutes", () => {
    const violations = sourceViolations(
      ".github/workflows/agents.yml",
      [
        "on: [workflow_dispatch]",
        "jobs:",
        "  scheduled:",
        "    uses: developing-today/code/.github/workflows/pm-scheduled.yml@main",
      ].join("\n"),
    )
    expect(violations).toEqual([])
  })

  test.each(["timeout-minutes", "runs-on", "steps", "env", "defaults"])(
    "flags %s on a reusable-workflow caller job",
    (key) => {
      const violations = sourceViolations(
        ".github/workflows/agents.yml",
        [
          "on: [workflow_dispatch]",
          "jobs:",
          "  scheduled:",
          "    uses: developing-today/code/.github/workflows/pm-scheduled.yml@main",
          `    ${key}: 60`,
        ].join("\n"),
      )
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        rule: "reusable-workflow-caller-keys",
        job: "scheduled",
      })
      expect(violations[0].detail).toContain(key)
    },
  )

  test("allows GitHub's reusable-workflow caller keywords", () => {
    const violations = sourceViolations(
      ".github/workflows/agents.yml",
      [
        "on: [workflow_dispatch]",
        "jobs:",
        "  scheduled:",
        "    name: Scheduled tasks",
        "    uses: developing-today/code/.github/workflows/pm-scheduled.yml@main",
        "    with: { schedule: daily }",
        "    secrets: inherit",
        "    strategy: { matrix: { task: [bolt] } }",
        "    needs: prepare",
        "    if: true",
        "    concurrency: scheduled",
        "    permissions: { contents: read }",
        "    cache-mode: disabled",
      ].join("\n"),
    )
    expect(violations).toEqual([])
  })
})

describe("the current tree", () => {
  test("every workflow in .github/workflows follows the policies (#1406)", () => {
    const root = join(import.meta.dir, "..")
    const { files, violations } = collectViolations(root)
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain(".github/workflows/test.yml")
    expect(violations).toEqual([])
    expect(workflowFiles(root)).toEqual(files)
  })
})
