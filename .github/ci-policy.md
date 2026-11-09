# CI policy — basic tier, main tier (no PR triggers, no push triggers)

This repo follows the fleet CI design `ci-fast-pr-full-main`
(developing-today/code#1779; phases code#1780/#1781/#1782, tracker
code#1599): the basic tier validates fast, the main tier runs
everything, and a red main is owned by the remediation chain
(`.github/workflows/main-broken.yml`). Tuning the line between the
tiers means editing this table — never the pipeline shape.

No workflow triggers on `pull_request` or `pull_request_target`:
that is the deliberate no-PR-trigger policy (PR #1401, enforced by
the workflow-policy gate, #1406) so a fork PR can never run code
with this repo's credentials.

Since PR #1635 there is likewise no push-triggered validation:
every `push:` trigger was removed from the validation workflows
(Drew's dispatch/schedule-only ruling), and this file was reconciled
to that reality by #1927. The tiers therefore run **by manual
dispatch and on schedule only** — a merge to `main` starts no
validation run by itself. The single remaining `push:` trigger in
the repo is `nix-hashes.yml` (paths-gated to `bun.lock`,
`package.json`, `flake.lock`, and the nix node_modules inputs): it
is a hash-maintenance automation, not a validation tier, and it is
the exception that proves the rule below. There is no PR tier and
no push tier, whatever older text said (#1533).

## Change-class policy (design §3.3)

Highest class wins when a change spans classes.

| class | trigger paths (examples) | basic tier |
|---|---|---|
| 0 — prose | `**.md`, `docs/`, comments-only changes | nothing, or markdown lint only |
| 1 — config/data | `**.json/yaml/toml` non-build, `.github/**` (non-workflow) | syntax parse + lint of changed files |
| 2 — package source (default) | one package's `src` + tests | lint/format + typecheck/syntax of affected packages + affected unit tests |
| 3 — elevated | lockfiles, `go.mod`/`go.sum` roots, `flake.nix`/`flake.lock`, build definitions, `.github/workflows/**`, shared/core libraries | class 2 + compile check of affected packages |
| 4 — nix expressions | `**.nix` | class 1 + parse/eval of the changed files only (never full flake check in the basic tier) |

## Merge requirement

**Merge requirement: none at the PR. No checks run on a pull
request at all (no-PR-trigger policy, PR #1401 / gate #1406), so
nothing can gate a merge from the PR side — and no validation run
starts automatically at merge time either. Validation happens when
the tier workflows are dispatched against `main` (and, for `test`,
on the nightly schedule); a red main is owned by the remediation
chain (`main-broken.yml`, which watches the tier workflows'
`workflow_run` completions on `main`).**

The basic tier's checks are named so the tier is recognizable in
the check list on a `main` run — they carry the `basic` prefix:

- `basic typecheck` (workflow `check`) — typecheck + changed-file lint
- `basic affected packages` (workflow `test`) — affected-package detection
- `basic unit (<os>)` (workflow `test`) — unit tests of affected packages
- `e2e (<os>)` (workflow `test`) — the aggregator: it reports green
  when the e2e suite is tier-skipped, so the name stays stable in
  the check list; the suite itself is main-tier

Workflow names (`test`, `check`, `nix-eval`) are deliberately NOT
renamed: the Phase 3 watcher (`main-broken.yml`) references them by
name in its `workflow_run` trigger. Job display names carry the tier
label instead. The full main-tier jobs (`build`, `e2e` suites) run
in the same dispatched or scheduled runs, after the basic tier.

## How the classes map to this repo's workflows

- `check` (typecheck + changed-file lint) — the basic tier's core;
  **manual dispatch only** (`workflow_dispatch`). Unchanged by the
  tier split.
- `test` — basic tier: `affected` + `unit` for affected packages
  only. Main tier: `build` and `e2e` additionally run **on manual
  dispatch and on the nightly schedule (`0 3 * * *`)**, which
  re-runs the full suite as a backstop. The `e2e (<os>)` aggregator
  job treats a tier-skipped e2e suite as the expected result on
  those runs.
- `nix-eval` — full evaluation on **manual dispatch only** (there
  is no push trigger and no paths-gated PR variant, because there
  are no PR triggers).
- `storybook` — **manual dispatch only**; unchanged apart from the
  standard concurrency group.

## Release gate (Phase 3, code#1782 step 7)

**No publish workflow publishes from a SHA whose main-gate is not
green.** The main-gate for a SHA is the set of watched main-tier
workflows — `test`, `check`, `nix-eval`, the same set
`main-broken.yml` watches: for the exact SHA being published, the
latest completed run of each on branch `main` must have conclusion
`success`. A failed, cancelled, or missing conclusion refuses the
publish (fail-closed). Enforcement is the reusable
`.github/actions/main-gate` check: `publish.yml` gates its `version`
job on it (every other job follows through `needs`), and
`publish-vscode.yml` and `publish-github-action.yml` gate their
`publish` jobs on it the same way, with one refinement: those
publishers take their release from the newest `vscode-v*` /
`github-v*` tag (by committer date), not from the run's SHA, so
their gate jobs resolve that tag once, gate its peeled commit (for
vscode, the checked-out code's SHA is gated as well), and pass the
same tag to the publish script as a pinned argument — the gated
commit is always the published one. `release-github-action.yml` only
cuts the `github-v*` tag and publishes nothing itself; the publish it
feeds is gated, so it carries no separate gate. Because the tier
workflows run only on dispatch or schedule, a publish dispatch whose
gate has not completed for that SHA is refused: dispatch the tier
workflows, wait for a green main for that SHA, then re-run
(dispatch) the publish workflow.

Hotfix override: set the repository variable `MAIN_GATE_OVERRIDE=1`
to bypass the gate for one release — the bypass is announced as a
warning in the run log — and unset it immediately afterwards. The
override is for a legitimate hotfix that cannot wait for a green
main; it is not a way to make red-main releases routine.

## Dedup rule

A commit must not run the same suite twice: no workflow triggers
on `pull_request` at all (#1401), and validation workflows carry
no `push:` trigger at all (#1635), so a merge produces **zero**
automatic validation runs — each tier run is a deliberate dispatch
(or the nightly scheduled `test` run), never a duplicate of a
push-triggered one.

## Concurrency standard (design §4)

Runs on `main` are keyed by `run_id` so they are never cancelled;
branch and dispatch runs on other refs cancel on supersede.
`check.yml` and `test.yml` express this as a `case(...)` on
`github.ref`; `nix-eval.yml` and `storybook.yml` still carry the
equivalent template expression:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_id || github.ref }}
  cancel-in-progress: true
```

Publish/release workflows extend the `run_id` keying to tag pushes and
manual dispatches, so a release is never cancelled mid-publish. A
publish/release workflow whose ONLY trigger is manual dispatch is the
exception: its dispatches share one group keyed by workflow + ref with
cancel-in-progress: false and queue: max, so dispatches serialize --
never-cancelled must not mean never-queued when concurrent runs would
compute the same release (release-github-action, #1035).
Issue/PR management is NOT event-triggered: `repo-sweeper.yml` runs
every 15 minutes (`*/15 * * * *`, single live run, cancel-in-progress)
and performs all management duties in one pass — contributor labels,
issue compliance + duplicate checks, compliance rechecks, triage, the
72-hour compliance closes, and the daily stale-issue / low-reaction-PR
closers (gated to their original 02:00 / 22:00 UTC windows). It
replaced `pr-management`, `duplicate-issues`, `triage`, `close-issues`,
`close-prs` and `compliance-close`. Event-based only where a human
waits synchronously: `opencode` (`/oc`, `/opencode` mentions) and
`review` (`/review` command). `pr-standards` carries no PR
trigger either (#1401); it is dispatch-run only. Scheduled singleton and deploy workflows keep
`cancel-in-progress: false` deliberately.
Never pair `queue: max` with a `cancel-in-progress` expression that
can evaluate true for `issues`/`pull_request_target` events — GitHub
rejects that combination and the workflow never runs.
