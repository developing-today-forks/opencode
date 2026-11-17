export * as ExecutionPlan from "./execution-plan.js"

import crypto from "node:crypto"

/**
 * The execution-plan contract: parsing and check-off for the markdown
 * checklist plans agents write (`- [ ] 1. Scaffold API routes`), owned by
 * OpenCode so every consumer (OpenChamber's Project Knowledge Plans view
 * included) reads the same shape (issue #10, ruling Q1, 2026-11-11).
 *
 * Check-off is SUGGEST-FIRST (ruling Q3, 2026-11-16): a finished turn's
 * file-change summary only ever produces suggestions. A suggestion never
 * mutates the plan; accepting one checks the step, and dismissing one is
 * the uncheck path — the plan file changes only through `applyCheck` /
 * `applyUncheck`, called by whoever accepted.
 *
 * Matching is MIXED (ruling Q2, 2026-11-11): a step that names explicit
 * file or directory targets is suggested only when every target was
 * touched; a step without explicit targets falls back to inferred-scope
 * matching, which is guidance-grade and labelled as such.
 */

export interface TurnFileChanges {
  readonly added: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
}

export interface StepTargets {
  readonly files: readonly string[]
  readonly directories: readonly string[]
}

export interface Step {
  /** 0-based position among the plan's steps, in document order. */
  readonly index: number
  /** 0-based line number of the step in the source markdown. */
  readonly line: number
  readonly checked: boolean
  /** The step's text after the checkbox, trimmed. */
  readonly text: string
  readonly targets: StepTargets
}

export type SuggestionBasis = "explicit" | "inferred"
export type SuggestionConfidence = "high" | "low"

export interface Suggestion {
  /** Stable id for a step's content: dismiss/accept bookkeeping keys on it. */
  readonly id: string
  readonly stepIndex: number
  readonly line: number
  readonly text: string
  readonly basis: SuggestionBasis
  readonly confidence: SuggestionConfidence
  /** Changed files that satisfied (explicit) or matched (inferred) the step. */
  readonly matchedFiles: readonly string[]
  /** Inferred-scope tokens that matched; empty for explicit suggestions. */
  readonly matchedTokens: readonly string[]
}

const stepPattern = /^(\s*)[-*] \[( |x|X)\]\s+(.*)$/

const normalizePath = (value: string) =>
  value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/[.,;:]+$/, "")

const isDirectoryRef = (value: string) => value.endsWith("/")

const looksLikeFile = (value: string) => value.includes("/") && /\.[a-z0-9]+$/i.test(value) && !value.includes(" ")

const looksLikeDirectory = (value: string) => isDirectoryRef(value) && value.includes("/") && !value.includes(" ")

/** Explicit targets named in a step's text: backticked paths first, then bare path tokens. */
export const extractTargets = (text: string): StepTargets => {
  const files = new Set<string>()
  const directories = new Set<string>()
  const add = (raw: string) => {
    const value = normalizePath(raw.trim())
    if (!value) return
    if (isDirectoryRef(value)) {
      if (looksLikeDirectory(value)) directories.add(value)
      return
    }
    if (looksLikeFile(value)) files.add(value)
  }
  for (const match of text.matchAll(/`([^`]+)`/g)) add(match[1]!)
  for (const token of text.split(/\s+/)) add(token)
  return { files: [...files], directories: [...directories] }
}

/** Parse a plan markdown document into its checklist steps, in document order. */
export const parse = (markdown: string): Step[] => {
  const steps: Step[] = []
  const lines = markdown.split("\n")
  lines.forEach((raw, line) => {
    const match = stepPattern.exec(raw)
    if (!match) return
    const text = match[3]!.trim()
    steps.push({
      index: steps.length,
      line,
      checked: match[2] !== " ",
      text,
      targets: extractTargets(text),
    })
  })
  return steps
}

const stopwords = new Set([
  "the",
  "and",
  "for",
  "with",
  "into",
  "from",
  "that",
  "this",
  "then",
  "step",
  "add",
  "update",
  "create",
  "implement",
  "write",
  "make",
  "use",
  "using",
  "all",
  "new",
  "file",
  "files",
  "code",
  "test",
  "tests",
])

/** Scope tokens inferred from a step's prose: distinctive words that could name a file or directory. */
export const inferScopeTokens = (text: string): string[] => {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 4) continue
    if (stopwords.has(raw)) continue
    if (/^\d+$/.test(raw)) continue
    tokens.add(raw)
  }
  return [...tokens]
}

const pathTokens = (file: string): string[] => {
  const parts = normalizePath(file).toLowerCase().split("/")
  const tokens = new Set<string>()
  for (const part of parts) {
    if (!part) continue
    tokens.add(part)
    const stem = part.replace(/\.[a-z0-9]+$/i, "")
    if (stem) tokens.add(stem)
  }
  return [...tokens]
}

const suggestionID = (step: Step) =>
  `plan-step-${step.index}-${crypto.createHash("sha256").update(step.text).digest("hex").slice(0, 8)}`

/**
 * Suggest check-offs for a turn's file changes. Pure: the plan markdown is
 * never mutated, already-checked steps are never suggested, and an explicit
 * step is suggested only when EVERY explicit target was touched (a deleted
 * file counts as touched — removing a file can be a step's whole work).
 */
export const suggest = (markdown: string, changes: TurnFileChanges): Suggestion[] => {
  const changed = [...changes.added, ...changes.modified, ...changes.deleted].map(normalizePath)
  if (changed.length === 0) return []
  const suggestions: Suggestion[] = []
  for (const step of parse(markdown)) {
    if (step.checked) continue
    const { files, directories } = step.targets
    if (files.length + directories.length > 0) {
      const matched = new Set<string>()
      const satisfied =
        files.every((target) => {
          const hit = changed.find((file) => file === target)
          if (hit) matched.add(hit)
          return hit !== undefined
        }) &&
        directories.every((directory) => {
          const hit = changed.find((file) => file.startsWith(directory))
          if (hit) matched.add(hit)
          return hit !== undefined
        })
      if (!satisfied) continue
      suggestions.push({
        id: suggestionID(step),
        stepIndex: step.index,
        line: step.line,
        text: step.text,
        basis: "explicit",
        confidence: "high",
        matchedFiles: [...matched],
        matchedTokens: [],
      })
      continue
    }
    const tokens = inferScopeTokens(step.text)
    if (tokens.length === 0) continue
    const matchedFiles: string[] = []
    const matchedTokens = new Set<string>()
    for (const file of changed) {
      const own = pathTokens(file)
      const hits = tokens.filter((token) => own.includes(token))
      if (hits.length === 0) continue
      matchedFiles.push(file)
      for (const hit of hits) matchedTokens.add(hit)
    }
    if (matchedFiles.length === 0) continue
    suggestions.push({
      id: suggestionID(step),
      stepIndex: step.index,
      line: step.line,
      text: step.text,
      basis: "inferred",
      confidence: "low",
      matchedFiles,
      matchedTokens: [...matchedTokens],
    })
  }
  return suggestions
}

/** One-line timeline notice for a suggestion, e.g. for the turn summary (issue #10 acceptance 3). */
export const notice = (suggestion: Suggestion) =>
  suggestion.basis === "explicit"
    ? `Plan step ${suggestion.stepIndex + 1} suggested for check-off: ${suggestion.text} (files complete: ${suggestion.matchedFiles.join(", ")})`
    : `Plan step ${suggestion.stepIndex + 1} suggested for check-off (inferred scope, please confirm): ${suggestion.text}`

const flip = (markdown: string, stepIndex: number, checked: boolean): string => {
  const lines = markdown.split("\n")
  let seen = -1
  for (let line = 0; line < lines.length; line++) {
    const match = stepPattern.exec(lines[line]!)
    if (!match) continue
    seen++
    if (seen !== stepIndex) continue
    lines[line] = lines[line]!.replace(/\[( |x|X)\]/, checked ? "[x]" : "[ ]")
    return lines.join("\n")
  }
  return markdown
}

/** Accept a suggestion: return the plan with that step checked. The only write path a suggestion has. */
export const applyCheck = (markdown: string, suggestion: Pick<Suggestion, "stepIndex">) =>
  flip(markdown, suggestion.stepIndex, true)

/** Uncheck a step (the manual adjust path after an accepted check). Dismissing a suggestion needs no call: it changes nothing. */
export const applyUncheck = (markdown: string, stepIndex: number) => flip(markdown, stepIndex, false)
