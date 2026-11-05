import { describe, expect, test } from "bun:test"
import {
  GATE_REGISTRY,
  gateWiringViolations,
  stepEventRequirements,
  type GateUse,
  type GateWiringInput,
} from "./gate-harness"

/**
 * Fixtures for the gate wiring meta-check (#1527). The happy baseline
 * covers the current registry; the live `check:gates` run separately
 * checks that registry against the on-disk package scripts and workflows.
 */
const happyUses: GateUse[] = GATE_REGISTRY.map((entry) => ({
  workflow: entry.workflow,
  script: entry.script,
  packagePath: entry.packagePath,
  stepIf: "runner.os == 'Linux'",
}))

const happy: GateWiringInput = {
  rootScripts: [
    ...GATE_REGISTRY.filter((entry) => entry.packagePath === ".").map((entry) => entry.script),
    "dev",
    "test",
    "typecheck",
  ],
  generatedPackages: GATE_REGISTRY.filter((entry) => entry.script === "check:generated").map(
    (entry) => entry.packagePath,
  ),
  uses: happyUses,
  workflowTriggers: {
    "test.yml": ["workflow_dispatch", "schedule", "push"],
    "check.yml": ["workflow_dispatch"],
  },
}

describe("gateWiringViolations", () => {
  test("the registered, wired, reachable snapshot is clean", () => {
    expect(gateWiringViolations(happy)).toEqual([])
  })

  test("an unregistered root gate script fails", () => {
    const violations = gateWiringViolations({ ...happy, rootScripts: [...happy.rootScripts, "check:experimental"] })
    expect(violations).toHaveLength(1)
    expect(violations[0].rule).toBe("unregistered-gate")
    expect(violations[0].detail).toContain("check:experimental")
  })

  test("an unregistered package check:generated fails", () => {
    const violations = gateWiringViolations({
      ...happy,
      generatedPackages: [...happy.generatedPackages, "packages/newpkg"],
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].rule).toBe("unregistered-gate")
    expect(violations[0].detail).toContain("packages/newpkg")
  })

  test("a registered gate no workflow step invokes fails as unwired", () => {
    const violations = gateWiringViolations({
      ...happy,
      uses: happy.uses.filter((use) => use.script !== "check:workflows"),
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].rule).toBe("unwired-gate")
    expect(violations[0].detail).toContain("check:workflows")
  })

  // The #1508 shape, verbatim in structure: check.yml triggers only on
  // workflow_dispatch, and its "Lint changed files" step carried
  // `if: github.event_name == 'pull_request'`, so the step could never
  // run. lint:changed is the gate that step invokes.
  test("a step gated on an event its workflow never triggers on fails as unreachable (the #1508 shape)", () => {
    const violations = gateWiringViolations({
      ...happy,
      uses: happy.uses.map((use) =>
        use.script === "lint:changed" ? { ...use, stepIf: "github.event_name == 'pull_request'" } : use,
      ),
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].rule).toBe("unreachable-gate")
    expect(violations[0].detail).toContain("pull_request")
    expect(violations[0].detail).toContain("lint:changed")
  })

  test("an unreachable event alternative does not fail when another OR branch is a declared trigger", () => {
    const violations = gateWiringViolations({
      ...happy,
      uses: happy.uses.map((use) =>
        use.script === "lint:changed"
          ? { ...use, stepIf: "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'" }
          : use,
      ),
    })
    expect(violations).toEqual([])
  })

  test("graceful expressions do not false-positive: non-event ifs and equalities naming a declared trigger pass", () => {
    const violations = gateWiringViolations({
      ...happy,
      uses: happy.uses.map((use) =>
        use.workflow === "test.yml" ? { ...use, stepIf: "github.event_name == 'workflow_dispatch'" } : use,
      ),
    })
    expect(violations).toEqual([])
  })

  test("a registry entry naming a deleted script fails as stale", () => {
    const violations = gateWiringViolations({
      ...happy,
      rootScripts: happy.rootScripts.filter((name) => name !== "check:bounded-http"),
    })
    expect(violations.map((violation) => violation.rule)).toContain("stale-registry-entry")
  })
})

describe("stepEventRequirements", () => {
  test("extracts single- and double-quoted event_name equalities only", () => {
    expect(stepEventRequirements("github.event_name == 'pull_request'")).toEqual(["pull_request"])
    expect(stepEventRequirements('github.event_name == "schedule" && runner.os == \'Linux\'')).toEqual(["schedule"])
    expect(stepEventRequirements("runner.os == 'Linux'")).toEqual([])
    expect(stepEventRequirements("github.event_name != 'push'")).toEqual([])
  })
})
