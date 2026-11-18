## Problem

`script/github/close-issues.ts` — the repo-sweeper's daily stale-issue closer (02:00 UTC window in `.github/workflows/repo-sweeper.yml`) — treats pull requests as issues. It never distinguishes the PR items that GitHub's list-issues endpoint returns from real issues, so a stale PR that is not exempt will be commented on and closed **as an issue**, bypassing the separate PR closer's criteria entirely.

## Evidence (verified 2026-11-08, main `5aee3994c8`)

- `script/github/close-issues.ts:52-60` — `fetchIssuePage` calls `GET /repos/{repo}/issues?state=open&sort=updated&direction=asc&per_page=100&page=N` and returns the page cast to `Issue[]`. GitHub's list-issues endpoint returns pull requests as items carrying a `pull_request` field.
- `script/github/close-issues.ts:18-23` — the `Issue` type does not declare `pull_request` at all, so the distinction is invisible to the rest of the script.
- `script/github/close-issues.ts:47-50` — `shouldSkip` exempts only the agent login, TEAM_MEMBERS logins, and OWNER/MEMBER associations. There is no PR check.
- `script/github/close-issues.ts:105-115` (main loop) — every non-exempt item with `updated_at` older than the 60-day cutoff is pushed to `stale` and passed to `closeIssue`, with no PR check.
- `script/github/close-issues.ts:64-82` — `closeIssue` posts the issue message ("issues are automatically closed after 60 days of no activity…") and PATCHes `/issues/{num}` with `state: closed, state_reason: not_planned`, whatever the number actually is.
- Live read of the exact endpoint the script calls (`issues?state=open&sort=updated&direction=asc&per_page=100&page=1`, 2026-11-08): **29 of the first 100 items carry `pull_request != null`** — e.g. PR #777, PR #822, PR #233, and a run of PRs by `developing-today[bot]` whose `author_association` is `NONE` and whose login is in neither TEAM_MEMBERS nor the exempt agent login (`opencode-agent[bot]`), so `shouldSkip` returns **false** for them. Today none is 60 days stale, but any of them that sits untouched for 60 days will be closed by this script.
- Probe `probe-close-issues.test.ts` (laptop worktree `probe-2026-11-08-creator-1135` @ `5aee3994c8`, `bun test` in `script/`): a fake page `[{number:41, pull_request:{…}}, {number:42}]` comes back from `fetchIssuePage` unfiltered (`PAGE_NUMBERS [41, 42]`, `PAGE_HAS_PULL_REQUEST_FIELD [true, false]`), and `closeIssue(41, …)` happily issues `POST …/issues/41/comments` + `PATCH …/issues/41`. 2 pass / 0 fail.
- The bypass: `script/github/close-prs.ts` is the PR closer, with deliberately different criteria — created more than 1 month ago, **fewer than 2 positive reactions** (`close-prs.ts:174`), the `automated-pr-cleanup` label, a PR-specific message, `--max-close` and a 20 s sleep between closes (sweeper passes `--threshold 2 --age-months 1 --sleep-ms 20000 --max-close 50 --execute`). A PR closed by `close-issues.ts` gets none of that: no reaction check, no cleanup label, no cap/sleep, and the wrong message and close reason.

Related: #1972 (the token-convention fix for this same script — its new guard test in `script/github/token.test.ts` scans the invoked scripts for token reads but says nothing about PR items), #1344 (bounded reads for the closer scripts, closed).

## Why it matters

The two closers encode two different policies Drew's repo actually runs: issues close on 60 days of inactivity; PRs close on age + community-reaction criteria with their own labelling and pacing. The issue closer silently overriding the PR policy means an unpopular-but-active-policy-exempt PR — today most plausibly a `developing-today[bot]` PR, which is not exempt in `shouldSkip` — can be closed as `not_planned` with a message telling its author to "open a new one", and no record that the PR cleanup ever considered it.

## Acceptance criteria

- [ ] `close-issues.ts` never comments on or closes an item carrying a `pull_request` field: PR items are excluded from the stale set (in `fetchIssuePage`, `shouldSkip`, or the main loop — one place, stated in a comment), and skipped PRs are logged as skipped, not silently counted as issues.
- [ ] The `Issue` type (or its replacement) reflects the endpoint's real shape, including the optional `pull_request` field, so the distinction stays visible to future edits.
- [ ] A test pins the behaviour with the module's oracle (the endpoint's documented/observed shape): a page mixing a stale non-exempt PR and a stale non-exempt issue selects/closes only the issue; existing exempt-author behaviour is unchanged. A test in the style of `script/github/token.test.ts`'s contract guard is acceptable if the selection logic stays in `main()`.
- [ ] `close-prs.ts` behaviour, the sweeper workflow, and the #1972 token convention are untouched.
