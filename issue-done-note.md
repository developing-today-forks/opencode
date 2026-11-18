🤖 **Agent note** · done
- **Agent:** repo-worker-opencode (OpenChamber scheduled lane)
- **Session / ID:** OpenCode `ses_e5e459d2e1bffeB1ri77qphUmK` · queue task `12776`
- **Found via:** atomic claim from `repo-health-opencode-pilot`, lane `3fe37e8a-c61b-419c-9e97-769ecd264d5d`
- **Outcome:** `fixed_merged`. PR #2104 merged as `2961e602aa011cd3c8dbefb51ec3708ca126c333` — which closed this issue.
- **Fix:** the rolling/subscription window publishes through a new `rollingWindowKey(windowSeconds)` at **both** sites (`parseSubscriptionQuota` and the module-private `keyUsageResult`). The key remains the duration-derived label (`5h`, `1d`, …) except when that label would be `"weekly"` — then it publishes under its semantic role name `"rolling"` and survives beside the fixed weekly entry (contract rule 1). Non-colliding labels are unchanged.
- **Key shape (as the packet asked to note):** with a weekly-length rolling window and a weekly entry coexisting, consumers see `windows.rolling` (carrying `windowSeconds: 604800`, its real duration) **and** `windows.weekly`, each with its own percent. The role name was chosen over a suffixed label so the map is unambiguous by role, with the true duration in the window's `windowSeconds`.
- **Tests (oracle: contract rule 1 + the filing probe payloads):** 604800s rolling 10% + weekly 90% now publishes both; the 18000s (`5h`) and 86400s (`1d`) controls still publish both with their labels; a weekly-length rolling window with no weekly entry still publishes once; the same coexistence is pinned through the `keyUsageResult` fetch path (10080-minute rolling). `bun test test/quota.test.ts` → 171 passed / 0 failed (536 expects); `bun typecheck` clean. CI not applicable (no `pull_request` trigger by design; `.github/ci-policy.md`, #1401).
- **Inventory:** meta's `types.ts` parser-inventory row flips from known-lossy to conforming. Noted on #1794.
- **Links:** https://github.com/developing-today-forks/opencode/pull/2104 · https://github.com/developing-today-forks/opencode/issues/1794
<!-- agent-note:v1 agent=repo-worker-opencode lane=3fe37e8a-c61b-419c-9e97-769ecd264d5d task=12776 state=done outcome=fixed_merged at=2026-11-08T09:18:00Z -->
