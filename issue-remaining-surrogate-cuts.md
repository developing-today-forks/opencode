## Problem

A third, remaining set of string truncations in `packages/core` and `packages/ai` still cuts at a raw UTF-16 index with no surrogate-pair guard, so a cut that lands inside an astral character (emoji, CJK ext, musical symbols — anything above U+FFFF) emits a lone surrogate. The result is not well-formed text: `isWellFormed()` is `false`, and downstream JSON encoders / `TextEncoder` replace the half-pair with U+FFFD, corrupting the excerpt in front of the model, the user, or an error consumer.

This is the disjoint remainder after the three earlier filings, which are explicitly **not** this set:

- #1966 (closed) — `messaging/log.ts` `clip()` (now guarded).
- #1970 (open) — five cuts in `messaging.ts`.
- #1973 (open) — six cuts: `session/title.ts:35` `truncate()`, `codemode/catalog.ts:69`, `messaging/embedding.ts:1022`, `session/runner/publish-llm-event.ts:670`, `model-route-log.ts:279`, `ripgrep.ts:261`.

## Evidence (main `24200c35a4`)

Full inventory method: every `.slice(0, N)` / `.slice(-N)` / `.slice(-CONST)` site in `packages/core/src` + `packages/ai/src` was classified. The unguarded sites are:

**Model/user-facing content**

1. `packages/core/src/tool/read-filesystem.ts:336` — `clampLine`: `line.slice(0, MAX_LINE_LENGTH)` (2000) + suffix. File lines shown to the model; a pair straddling char 2000 is split.
2. `packages/core/src/session/title.ts:222` — `firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH)` (2000), the "Original request" head of the title-generation prompt. (#1973 covers only the output-side `truncate()` at `:35`.)
3. `packages/core/src/session/title.ts:236` — `recent.slice(-(MAX_CONTEXT_LENGTH - prefix.length))`, the tail cut of the same prompt; can *start* on a low surrogate.
4. `packages/ai/src/route/executor.ts:167` — `providerMessage`: provider error body `text.slice(0, MAX_BODY_CHARS)` (2000) in the error surfaced for a failed request.

**Error / diagnostic excerpts and tails**

5. `packages/core/src/messaging/embedding.ts:734` — HTTP error body `text.slice(0, 500)`.
6. `packages/core/src/embeddings.ts:359` — same shape, `text.slice(0, 500)`.
7. `packages/core/src/messaging/search.ts:176` — regex-worker error `errors.join("").slice(0, 500)`.
8. `packages/core/src/mcp/stdio.ts:150` — MCP server stderr accumulator `(stderr + output).slice(-STDERR_TAIL)` (1000); tail cut can start on a low surrogate, and the accumulator is what later logging reads.
9. `packages/core/src/messaging/embedding.ts:798` — llama-server stderr tail `(tail.text + text).slice(-4096)`, plus its excerpts at `:804` / `:816` (`tail.text.trim().slice(-1000)`).
10. `packages/ai/src/providers/antigravity-auth.ts:349-350` — token-endpoint error body `text.slice(0, 200)` (two branches).
11. `packages/ai/src/providers/muse-direct-auth.ts:159` — key-exchange error body `text.slice(0, 200)`.
12. `packages/ai/src/quota/cdp.ts:182` — `JSON.stringify(result.exceptionDetails).slice(0, 300)`; can split a pair inside a string value and also cut mid-escape.

**Probe** (laptop worktree `probe-2026-11-07-creator-2235`, script `probe-surrogate3.mjs`, expressions copied verbatim, astral U+1F600 straddling each cut): all 11 cut shapes above returned `isWellFormed=false` (head cuts end `\ud83d`, tail cuts begin `\ude00`). Controls clean: the already-guarded precedent `session/compaction.ts` `truncateToolOutput` (counts code points) and a non-straddling cut both returned `isWellFormed=true`.

**Verified safe by construction (do not "fix"):** `protocols/bedrock-converse.ts:284` tool name and `protocols/utils/bedrock-media.ts:68,74` document name (non-ASCII replaced with `_`/` ` before the slice, so the sliced string is ASCII-only); `model-plan.ts:236` slug (same, after `[^a-z0-9]` replacement); `providers/antigravity-auth.ts:217,254,266` binary scan (latin1-decoded, one code unit per byte, ASCII regex runs); `tool/html-markdown.ts:419` indent slice (indent is generated spaces); `session/compaction.ts:895` and `messaging/log.ts:203` (already guarded).

## Why it matters

The read-filesystem clamp and the title prompt cuts corrupt content the model actually reads; the executor/auth/CDP/embedding excerpts corrupt the very error text a user or agent relies on to diagnose a failure (the fleet has repeatedly treated a mangled error excerpt as a misleading signal). The repo already has the correct pattern twice over (`messaging/log.ts` `splitsPair` guard from #1966; code-point counting in `session/compaction.ts`), so these sites are inconsistency, not a design question — but the per-site choice (drop the straddling pair whole vs. back off one unit, and whether the shared guard should finally be promoted out of `messaging/log.ts`) is a triage call, which is why this is filed rather than self-solved.

## Acceptance criteria

- [ ] Every site in the list above truncates without splitting a surrogate pair (output `isWellFormed()` for adversarial astral placement at head and tail cuts), reusing the existing guard pattern or a promoted shared helper.
- [ ] New/updated tests pin at least: the read-filesystem `clampLine` cut, both title-generation prompt cuts (`:222` head, `:236` tail), and the `providerMessage` error excerpt, each with a straddling-pair case and a non-straddling control.
- [ ] The safe-by-construction sites listed above are unchanged (no behavior churn on ASCII-sanitized or latin1 paths).
- [ ] Existing suites for the touched modules stay green (core tool/session/messaging, ai route/providers/quota).
