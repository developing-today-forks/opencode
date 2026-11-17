export * as PlanSuggestions from "./plan-suggestions.js"

import type { FileDiff } from "@opencode/schema/file-diff"
import { ExecutionPlan } from "../execution-plan.js"

/**
 * Post-turn wiring for the ExecutionPlan engine (issue #10, follow-on
 * from the engine slice in PR #2514).
 *
 * The engine (`ExecutionPlan.suggest`) is pure: it turns a plan
 * markdown document plus a turn's file-change summary into check-off
 * suggestions. This module is the seam between that engine and a
 * finished turn:
 *
 * - {@link summarizeTurnChanges} classifies the turn's snapshot diff
 *   (`FileDiff.Info[]`, the same shape `Snapshot.diff` returns) into
 *   the `{ added, modified, deleted }` summary the engine consumes.
 * - {@link planNoticesForTurn} runs the engine over every active plan
 *   and renders the timeline notice lines. Suggestion generation
 *   NEVER mutates a plan (ruling Q3, suggest-first): the markdown
 *   inputs are read-only here and no write path exists in this
 *   module's turn path.
 * - The consumer surface is {@link acceptSuggestion} /
 *   {@link dismissSuggestion}: accepting returns the plan with
 *   exactly that step checked (via `ExecutionPlan.applyCheck`, the
 *   only write path a suggestion has) and the caller persists the
 *   returned markdown; dismissing returns the plan unchanged — the
 *   uncheck path is dismissing, per Q3.
 *
 * Plans live in the project's Project Knowledge plans directory,
 * {@link PLANS_RELATIVE_DIRECTORY} (`.openchamber/plans/`, named by
 * issue #10's specification); OpenCode owns the parsing contract
 * (ruling Q1) while consumers such as OpenChamber's Plans view read
 * and write the same markdown files.
 */

/** Project-relative directory holding the active plan markdown files. */
export const PLANS_RELATIVE_DIRECTORY = ".openchamber/plans"

/** Classify a turn's per-file diffs into the engine's change summary. */
export const summarizeTurnChanges = (diffs: readonly FileDiff.Info[]): ExecutionPlan.TurnFileChanges => {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const diff of diffs) {
    if (diff.status === "added") added.push(diff.file)
    else if (diff.status === "deleted") deleted.push(diff.file)
    else modified.push(diff.file)
  }
  return { added, modified, deleted }
}

/** Suggestions for one plan from one turn's diffs. Pure; never mutates `markdown`. */
export const suggestionsForTurn = (markdown: string, diffs: readonly FileDiff.Info[]): ExecutionPlan.Suggestion[] =>
  ExecutionPlan.suggest(markdown, summarizeTurnChanges(diffs))

/**
 * Timeline notice lines for a finished turn, across every active
 * plan: one `ExecutionPlan.notice` line per suggestion, in plan
 * order. An empty result means the turn suggested nothing.
 */
export const planNoticesForTurn = (plans: readonly string[], diffs: readonly FileDiff.Info[]): string[] => {
  if (diffs.length === 0) return []
  const changes = summarizeTurnChanges(diffs)
  return plans.flatMap((markdown) => ExecutionPlan.suggest(markdown, changes).map(ExecutionPlan.notice))
}

/**
 * Accept a suggestion: the plan markdown with exactly the
 * suggestion's step checked. The caller persists the returned
 * markdown to the plan file; nothing is written here.
 */
export const acceptSuggestion = (
  markdown: string,
  suggestion: Pick<ExecutionPlan.Suggestion, "stepIndex" | "text">,
): string => ExecutionPlan.applyCheck(markdown, suggestion)

/** Dismiss a suggestion: the plan, unchanged. Dismissing is the uncheck path (Q3). */
export const dismissSuggestion = (markdown: string): string => markdown
