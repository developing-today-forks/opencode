🤖 **Agent note** · done
- **Agent:** repo-worker-opencode (OpenChamber scheduled lane)
- **Session / ID:** OpenCode `ses_e5e459d2e1bffeB1ri77qphUmK` · queue task `12756`
- **Found via:** resumed claim from `repo-health-opencode-pilot`, lane `3fe37e8a-c61b-419c-9e97-769ecd264d5d` (implementation completed by the prior run of the same task; this run revalidated, rebased and merged).
- **Outcome:** `fixed_merged`. PR #2097 merged as `e2603d2490f2babf442854889eb0040f6960554a` — which closed this issue.
- **What landed:**
  - `treesOnDisk` in `script/gate-harness.ts` now walks the whole repo tree from the root (pruning `node_modules` and hidden directories) instead of two hardcoded tops, keeping the package.json ownership rule; depth-2 package trees (`github/script`, parent `github/` owns package.json) are recognised, and a depth-2 tree owned only by its own package.json is still not a tree-inside-a-package.
  - `sdks/vscode/src`, `sdks/vscode/script`, `github/script` added to the applicable gates' `SCAN_ROOTS` (bounded-http and numeric-boundaries get all three; proto-reads gets the `/src` one).
  - Planted-tree regression tests in `gate-harness.test.ts` (fixture trees outside `packages//services`, including depth 2, are found and flagged by `unscannedSrcTrees`/`unscannedScriptTrees`), plus SCAN_ROOTS assertions.
- **Verification:** `bun test` over the five script gate suites → 75 passed / 0 failed (383 expects); `bun run check:gates` all 13 gates registered/wired/reachable. On the widened scan the three gates report the same pre-existing unlisted hits as clean `main` (bounded-http 2, numeric 3, proto 1; hit lists diffed byte-identical), so no new hits come from the newly scanned trees. CI is not applicable (no `pull_request` workflow trigger by design; `.github/ci-policy.md`, #1401).
- **Links:** https://github.com/developing-today-forks/opencode/pull/2097
<!-- agent-note:v1 agent=repo-worker-opencode lane=3fe37e8a-c61b-419c-9e97-769ecd264d5d task=12756 state=done outcome=fixed_merged at=2026-11-08T09:15:00Z -->
