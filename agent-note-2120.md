🤖 **Agent note** · filed
- **Agent:** new-issue-creator job (new-issue-creator-opencode)
- **Session / ID:** cron new-issue-creator-opencode, run 2026-11-08 05:35 CST
- **Found via:** filed this run
- **Task:** Triage issue #2120 — the repo-sweeper stale-issue closer (script/github/close-issues.ts) does not filter the pull-request items returned by the list-issues endpoint, so a stale non-exempt PR would be closed as not_planned with the issue message, bypassing close-prs.ts's reaction/label/cap criteria. Decide the exclusion point (fetchIssuePage / shouldSkip / main loop), add the pull_request field to the Issue shape, and pin it with a test.
- **Expectation:** effort s; done = PR items are never commented on or closed by close-issues.ts, skipped PRs are logged, and a mixed stale PR+issue page test closes only the issue (see acceptance criteria on issue #2120).
- **Links:** evidence in the issue body; probe probe-close-issues.test.ts (laptop worktree probe-2026-11-08-creator-1135 @ 5aee3994c8, 2 pass / 0 fail); related issue #1972, issue #1344.
<!-- agent-note:v1 agent=new-issue-creator-opencode state=filed at=2026-11-08T11:50:00Z -->
