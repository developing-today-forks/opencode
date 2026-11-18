🤖 **Agent note** · done
- **Agent:** repo-worker-opencode (OpenChamber scheduled lane)
- **Session / ID:** OpenCode `ses_e5e459d2e1bffeB1ri77qphUmK` · queue task `12745`
- **Found via:** atomic claim from `repo-health-opencode-pilot`, lane `3fe37e8a-c61b-419c-9e97-769ecd264d5d`
- **Outcome:** `fixed_merged`. PR #1726 (the open PR from completed queue task 9959) was conflicted with `main`; it was rebased onto `main` @ `4a6a5a559d`, its disposition refined, verified, and merged as `42e133c49b55a199b5c60b46d68293a1a07aac62` — which closed this issue.
- **What landed:**
  - `parseOpenCodeGoUsage`, `parseConsoleGoUsage`, `parseConsoleBillingBalance` pinned with payload-shaped fixtures, including the micro-cents `(used / limit) * 100` conversion, the incomplete-meter drop, the over-limit clamp, and `fetchOpenCodeGoUsage`'s all-dropped → thrown `usage data could not be parsed` path.
  - `resolveResetAt` pinned for daily/weekly/monthly UTC arithmetic across week/month/year boundaries, including the weekly next-Monday `d + ((8 - dow) % 7 || 7)` and its on-Monday `+7d` behavior; the UTC/weekday assumption is now commented in the code.
- **Rule 3 disposition — ADOPTED, with the rule-4 boundary named.** A percent-bearing opencode-go entry now keeps its window and publishes an absent/non-positive reset as an honest `resetAt: null` (contract rule 3, the meta/sibling precedent), instead of silently dropping the window. An entry with no usable percent still publishes no window (contract rule 4 — no figure, no window), the same disposition codex's pinned percent-less case takes; the #1724 gate-drift test (empty percent mints no 0%-used window) stays green under that boundary. The two rules meet because a window needs a quota figure while a reset is metadata that can honestly be absent. This is an adopted change, not a rebuttal.
- **Inventory:** the `types.ts` parser-inventory rows for opencode-go and openrouter flip from known-lossy to conforming. Noted on #1794.
- **Tests:** `bun test test/quota.test.ts` → 167 passed / 0 failed (521 expects); `bun typecheck` clean. CI is not applicable: this repo has no `pull_request` workflow trigger by design (`.github/ci-policy.md`, #1401), so a PR branch reports no checks.
- **Links:** https://github.com/developing-today-forks/opencode/pull/1726 · https://github.com/developing-today-forks/opencode/issues/1794
<!-- agent-note:v1 agent=repo-worker-opencode lane=3fe37e8a-c61b-419c-9e97-769ecd264d5d task=12745 state=done outcome=fixed_merged at=2026-11-08T09:10:00Z -->
