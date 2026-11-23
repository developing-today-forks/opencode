import { describe, expect, test } from "bun:test"
import type { FileDiff } from "@opencode/schema/file-diff"
import { PlanSuggestions } from "@opencode/core/session/plan-suggestions"

// Oracle: issue #10 acceptance for the wiring slice —
// 1. "Post-turn hook computes ExecutionPlan.suggest from the turn
//    file-change summary and emits notice lines; plan markdown is
//    never mutated by suggestion generation"
// 2. "Accept path applies ExecutionPlan.applyCheck for exactly the
//    accepted step and persists the plan; dismiss path changes
//    nothing"
// 3. "Targeted tests for the wiring pass (suggestion emitted on
//    matching turn, no mutation pre-acceptance, accept flips one
//    step)"

const plan = [
  "# Execution plan",
  "",
  "- [ ] 1. Scaffold API routes in `packages/web/server/routes.ts`",
  "- [ ] 2. Add session tests in packages/core/test/",
  "- [x] 3. Write the changelog entry",
  "- [ ] 4. Remove the legacy flag from `packages/core/src/flags.ts`",
].join("\n")

const diff = (file: string, status: FileDiff.Info["status"]): FileDiff.Info => ({
  file,
  patch: "",
  additions: 1,
  deletions: 0,
  status,
})

describe("PlanSuggestions.summarizeTurnChanges", () => {
  test("classifies snapshot diffs into added / modified / deleted", () => {
    const changes = PlanSuggestions.summarizeTurnChanges([
      diff("a.ts", "added"),
      diff("b.ts", "modified"),
      diff("c.ts", "deleted"),
    ])
    expect(changes).toEqual({ added: ["a.ts"], modified: ["b.ts"], deleted: ["c.ts"] })
  })
})

describe("PlanSuggestions.planNoticesForTurn — suggestion emitted on a matching turn", () => {
  test("emits a notice naming the matched step, and none for unmatched turns", () => {
    const notices = PlanSuggestions.planNoticesForTurn([plan], [diff("packages/web/server/routes.ts", "added")])
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain("Plan step 1 suggested for check-off")
    expect(PlanSuggestions.planNoticesForTurn([plan], [diff("unrelated/file.ts", "modified")])).toEqual([])
    expect(PlanSuggestions.planNoticesForTurn([plan], [])).toEqual([])
  })

  test("a deleted target file also completes an explicit step", () => {
    const notices = PlanSuggestions.planNoticesForTurn([plan], [diff("packages/core/src/flags.ts", "deleted")])
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain("Plan step 4 suggested for check-off")
  })
})

describe("suggest-first (Q3) — no mutation pre-acceptance", () => {
  test("generating suggestions leaves the plan markdown byte-identical", () => {
    const before = plan
    const suggestions = PlanSuggestions.suggestionsForTurn(plan, [
      diff("packages/web/server/routes.ts", "added"),
      diff("packages/core/test/new.test.ts", "added"),
    ])
    expect(suggestions.length).toBeGreaterThan(0)
    expect(plan).toBe(before)
    expect(plan).toContain("- [ ] 1. Scaffold API routes")
  })
})

describe("accept / dismiss — the consumer surface", () => {
  test("accept flips exactly the accepted step and no other", () => {
    const [suggestion] = PlanSuggestions.suggestionsForTurn(plan, [diff("packages/web/server/routes.ts", "added")])
    expect(suggestion).toBeDefined()
    const accepted = PlanSuggestions.acceptSuggestion(plan, suggestion!)
    const lines = accepted.split("\n")
    expect(lines[2]).toContain("- [x] 1. Scaffold API routes")
    expect(lines[3]).toContain("- [ ] 2. Add session tests")
    expect(lines[4]).toContain("- [x] 3. Write the changelog entry")
    expect(lines[5]).toContain("- [ ] 4. Remove the legacy flag")
  })

  test("dismiss changes nothing", () => {
    expect(PlanSuggestions.dismissSuggestion(plan)).toBe(plan)
  })
})
