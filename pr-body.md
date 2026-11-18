## Summary

Pins the last unpinned quota parsers (#1725, phase 3 of the #1794 window-contract design) and settles the opencode-go window-drop disposition.

- **OpenCode Go API-key usage** (`parseOpenCodeGoUsage`): payload-shaped fixtures for rolling/weekly/monthly, including the over-limit clamp and the missing-field cases.
- **Window-drop disposition — rule 3 adopted, with the rule-4 boundary stated.** A percent-bearing entry now **keeps its window** with an absent/non-positive reset published as an honest `resetAt: null` (contract rule 3), instead of the previous silent drop. An entry with **no usable percent** still publishes **no window** (contract rule 4 — no figure, no window), matching codex's pinned percent-less case. So the old `if (usedPercent === null || resetAt === null) continue` splits into: rule 4 on the figure, rule 3 on the reset. `fetchOpenCodeGoUsage`'s all-dropped → thrown `usage data could not be parsed` path is pinned.
- **OpenCode Console Go** (`parseConsoleGoUsage`) and **billing balance** (`parseConsoleBillingBalance`): pinned, including the micro-cents `(used / limit) * 100` conversion and the incomplete-meter drop.
- **OpenRouter reset math** (`resolveResetAt`): daily/weekly/monthly UTC arithmetic pinned across week, month and year boundaries, including the weekly next-Monday formula `d + ((8 - dow) % 7 || 7)` and its on-Monday `+7d` behavior. The UTC/weekday assumption is now commented in the code.
- `types.ts` parser inventory: the opencode-go and openrouter rows flip from known-lossy to conforming.

## Rule 3 statement (for the #1725 closing note)

Adopted. The opencode-go mapper no longer drops a window the payload did send: a present window with a missing reset keeps the window and nulls the field, the sibling precedent (meta's absent-reset-is-null case, pinned at #1855). The one carve-out is rule 4 — an entry with no quota figure at all publishes no window — which is the same disposition codex's pinned percent-less case takes; the two rules meet cleanly because a quota window needs a figure, while a reset is metadata that can honestly be absent.

## Tests

- `bun test test/quota.test.ts` from `packages/ai`: **167 passed, 0 failed, 521 expects**.
- `bun typecheck` from `packages/ai`: `tsgo --noEmit` clean.
- CI: this repo's workflows have no `pull_request` trigger by design (`.github/ci-policy.md`, #1401), so no checks are reported for a PR branch; local targeted tests + typecheck are the verification.

Fixes #1725
