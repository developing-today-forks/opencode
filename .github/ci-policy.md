# CI policy — fast PR tier, full main tier

This repo follows the fleet CI design `ci-fast-pr-full-main`
(developing-today/code#1779; phases code#1780/#1781/#1782, tracker
code#1599): pull requests get basic validation fast, merges to `main`
run everything, and a red main is owned by the remediation chain
(`.github/workflows/main-broken.yml`). Tuning the line between the
tiers means editing this table — never the pipeline shape.

## Change-class policy (design §3.3)

Highest class wins when a change spans classes.

| class | trigger paths (examples) | PR tier |
|---|---|---|
| 0 — prose | `**.md`, `docs/`, comments-only changes | nothing, or markdown lint only |
| 1 — config/data | `**.json/yaml/toml` non-build, `.github/**` (non-workflow) | syntax parse + lint of changed files |
| 2 — package source (default) | one package's `src` + tests | lint/format + typecheck/syntax of affected packages + affected unit tests |
| 3 — elevated | lockfiles, `go.mod`/`go.sum` roots, `flake.nix`/`flake.lock`, build definitions, `.github/workflows/**`, shared/core libraries | class 2 + compile check of affected packages |
| 4 — nix expressions | `**.nix` | class 1 + parse/eval of the changed files only (never full flake check on a PR) |

## Merge requirement

**Merge requirement: the basic-validation (PR) tier only. The full
suite runs on main and is NOT a merge gate.**

The basic tier's checks are named so the tier is recognizable in the
check list — they carry the `basic` prefix:

- `basic typecheck` (workflow `check`) — typecheck + changed-file lint
- `basic affected packages` (workflow `test`) — affected-package detection
- `basic unit (<os>)` (workflow `test`) — unit tests of affected packages
- `e2e (<os>)` (workflow `test`) — the aggregator only on PRs: it
  reports green when the e2e suite is tier-skipped, so the name stays
  stable for branch rules; the suite itself is main-tier

Workflow names (`test`, `check`, `nix-eval`) are deliberately NOT
renamed: the Phase 3 watcher (`main-broken.yml`) references them by
name in its `workflow_run` trigger. Job display names carry the tier
label instead. If branch rules ever require checks by name, require
the `basic`-prefixed names above — the full main-tier jobs (`build`,
`e2e` suites) must never become merge requirements.

## How the classes map to this repo's workflows

- `check` (typecheck + changed-file lint) — the PR tier's core; runs on
  every PR and on push to `main`. Unchanged by the tier split.
- `test` — PR tier: `affected` + `unit` for affected packages only.
  Main tier: `build` and `e2e` additionally run on push to `main`, on
  manual dispatch, and on the nightly schedule (`0 3 * * *`), which
  re-runs the full suite as a backstop. Nothing that ran on PRs before
  the split is lost: the union of push-to-main + nightly covers the old
  PR matrix (`affected`, `unit`, `build`, `e2e-suite`, `e2e`).
  The branch-required `e2e (<os>)` check names still report on PRs via
  the aggregator job, which treats a tier-skipped e2e suite as the
  expected result.
- `nix-eval` — PR tier: paths-gated to nix inputs (`**.nix`,
  `flake.lock`, `nix/**`, this workflow). Main tier: full evaluation on
  every push to `main` (the push trigger carries no paths filter).
- `storybook` — paths-gated already; unchanged apart from the standard
  concurrency group.

## Dedup rule

A commit must not run the same suite twice via `push` +
`pull_request`: PR workflows use `pull_request` (branches: `[main]`);
`push` is restricted to `branches: [main]` everywhere. The
push-to-main run after a merge is the main tier, not a duplicate.

## Concurrency standard (design §4)

PR/branch check runs cancel on supersede; push-to-main runs are keyed
by `run_id` so they are never cancelled:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_id || github.ref }}
  cancel-in-progress: true
```

Publish/release workflows extend the `run_id` keying to tag pushes and
manual dispatches, so a release is never cancelled mid-publish.
Issue/PR management is NOT event-triggered: `repo-sweeper.yml` runs
every 15 minutes (`*/15 * * * *`, single live run, cancel-in-progress)
and performs all management duties in one pass — contributor labels,
issue compliance + duplicate checks, compliance rechecks, triage, the
72-hour compliance closes, and the daily stale-issue / low-reaction-PR
closers (gated to their original 02:00 / 22:00 UTC windows). It
replaced `pr-management`, `duplicate-issues`, `triage`, `close-issues`,
`close-prs` and `compliance-close`. Event-based only where a human
waits synchronously: `opencode` (`/oc`, `/opencode` mentions) and
`review` (`/review` command). `pr-standards` stays a
`pull_request_target` validation workflow (PR standards / template
compliance). Scheduled singleton and deploy workflows keep
`cancel-in-progress: false` deliberately.
Never pair `queue: max` with a `cancel-in-progress` expression that
can evaluate true for `issues`/`pull_request_target` events — GitHub
rejects that combination and the workflow never runs.
