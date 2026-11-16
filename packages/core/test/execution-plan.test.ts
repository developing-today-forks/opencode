import { describe, expect, test } from "bun:test"
import { ExecutionPlan } from "@opencode/core/execution-plan"

// Oracle: issue #10 rulings — Q1 OpenCode owns the plan parsing contract;
// Q2 mixed matching (explicit targets strict, inferred scopes guidance);
// Q3 suggest-first (a suggestion never mutates the plan; accept checks,
// dismiss is the uncheck path).

const plan = [
  "# Execution plan",
  "",
  "- [ ] 1. Scaffold API routes in `packages/web/server/routes.ts`",
  "- [ ] 2. Add session tests in packages/core/test/",
  "- [x] 3. Write the changelog entry",
  "- [ ] 4. Remove the legacy flag from `packages/core/src/flags.ts`",
  "- [ ] 5. Polish the dashboard widgets",
  "not a step line",
].join("\n")

describe("ExecutionPlan.parse", () => {
  test("parses checklist steps in order with checked state and explicit targets", () => {
    const steps = ExecutionPlan.parse(plan)
    expect(steps.length).toBe(5)
    expect(steps[0]).toMatchObject({ index: 0, checked: false })
    expect(steps[0]!.targets.files).toEqual(["packages/web/server/routes.ts"])
    expect(steps[1]!.targets.directories).toEqual(["packages/core/test/"])
    expect(steps[2]!.checked).toBe(true)
    expect(steps[4]!.targets).toEqual({ files: [], directories: [] })
  })
})

describe("ExecutionPlan.suggest — suggest-first (Q3)", () => {
  test("never mutates the plan: suggesting leaves every step unchecked", () => {
    const before = plan
    const suggestions = ExecutionPlan.suggest(plan, {
      added: ["packages/web/server/routes.ts"],
      modified: [],
      deleted: [],
    })
    expect(suggestions.length).toBe(1)
    expect(plan).toBe(before)
    expect(ExecutionPlan.parse(plan)[0]!.checked).toBe(false)
  })

  test("never suggests an already-checked step", () => {
    const suggestions = ExecutionPlan.suggest(plan, {
      added: [],
      modified: ["CHANGELOG.md"],
      deleted: [],
    })
    expect(suggestions.map((item) => item.stepIndex)).not.toContain(2)
  })

  test("no changes means no suggestions", () => {
    expect(ExecutionPlan.suggest(plan, { added: [], modified: [], deleted: [] })).toEqual([])
  })
})

describe("ExecutionPlan.suggest — explicit matching (Q2)", () => {
  test("suggests a file step only when its file was touched, at high confidence", () => {
    const suggestions = ExecutionPlan.suggest(plan, {
      added: [],
      modified: ["packages/web/server/routes.ts", "README.md"],
      deleted: [],
    })
    const hit = suggestions.find((item) => item.stepIndex === 0)
    expect(hit).toMatchObject({ basis: "explicit", confidence: "high" })
    expect(hit!.matchedFiles).toEqual(["packages/web/server/routes.ts"])
  })

  test("a partial explicit match is not suggested", () => {
    const two = "- [ ] Wire `src/a.ts` and `src/b.ts` together"
    expect(ExecutionPlan.suggest(two, { added: ["src/a.ts"], modified: [], deleted: [] })).toEqual([])
    expect(
      ExecutionPlan.suggest(two, { added: ["src/a.ts"], modified: ["src/b.ts"], deleted: [] }).length,
    ).toBe(1)
  })

  test("a directory target is satisfied by any change under it", () => {
    const suggestions = ExecutionPlan.suggest(plan, {
      added: ["packages/core/test/session.test.ts"],
      modified: [],
      deleted: [],
    })
    expect(suggestions.find((item) => item.stepIndex === 1)).toMatchObject({ basis: "explicit" })
  })

  test("a deleted file counts as touched", () => {
    const suggestions = ExecutionPlan.suggest(plan, {
      added: [],
      modified: [],
      deleted: ["packages/core/src/flags.ts"],
    })
    expect(suggestions.find((item) => item.stepIndex === 3)).toMatchObject({ basis: "explicit" })
  })
})

describe("ExecutionPlan.suggest — inferred matching (Q2)", () => {
  test("a prose step matched by scope is guidance-grade, never high confidence", () => {
    const suggestions = ExecutionPlan.suggest(plan, {
      added: [],
      modified: ["packages/web/src/dashboard.tsx"],
      deleted: [],
    })
    const hit = suggestions.find((item) => item.stepIndex === 4)
    expect(hit).toMatchObject({ basis: "inferred", confidence: "low" })
    expect(hit!.matchedTokens).toContain("dashboard")
  })

  test("unrelated changes produce no inferred suggestion", () => {
    const suggestions = ExecutionPlan.suggest(plan, {
      added: [],
      modified: ["docs/guide.md"],
      deleted: [],
    })
    expect(suggestions.find((item) => item.stepIndex === 4)).toBeUndefined()
  })
})

describe("ExecutionPlan accept / uncheck (Q3)", () => {
  test("applyCheck flips exactly the accepted step and nothing else", () => {
    const [suggestion] = ExecutionPlan.suggest(plan, {
      added: ["packages/web/server/routes.ts"],
      modified: [],
      deleted: [],
    })
    const next = ExecutionPlan.applyCheck(plan, suggestion!)
    const beforeLines = plan.split("\n")
    const afterLines = next.split("\n")
    expect(afterLines.length).toBe(beforeLines.length)
    afterLines.forEach((line, index) => {
      if (index === suggestion!.line) expect(line).toContain("- [x]")
      else expect(line).toBe(beforeLines[index])
    })
    expect(ExecutionPlan.parse(next)[0]!.checked).toBe(true)
  })

  test("applyUncheck reverts an accepted check", () => {
    const checked = ExecutionPlan.applyCheck(plan, { stepIndex: 0 })
    expect(ExecutionPlan.applyUncheck(checked, 0)).toBe(plan)
  })

  test("notice names the step and, for explicit matches, the completing files", () => {
    const [suggestion] = ExecutionPlan.suggest(plan, {
      added: ["packages/web/server/routes.ts"],
      modified: [],
      deleted: [],
    })
    expect(ExecutionPlan.notice(suggestion!)).toContain("Plan step 1 suggested")
    expect(ExecutionPlan.notice(suggestion!)).toContain("packages/web/server/routes.ts")
  })
})
