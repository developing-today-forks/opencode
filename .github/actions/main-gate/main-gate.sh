#!/usr/bin/env bash
# main-gate — the Phase 3 release gate (developing-today/code#1782, step 7;
# rule recorded in .github/ci-policy.md, "Release gate" section).
#
# Refuse to publish from a SHA whose main-gate is not green: for the exact
# SHA being published, the latest completed run of each watched main-tier
# workflow (test, check, nix-eval — the same set .github/workflows/
# main-broken.yml watches) on branch main must have conclusion "success".
# A failed, cancelled, or missing conclusion is a refusal (fail-closed):
# re-run the publish workflow once main is green for that SHA.
#
# Override (hotfix path, named in .github/ci-policy.md): repository
# variable MAIN_GATE_OVERRIDE=1 bypasses the gate with a warning in the
# run log; unset it immediately after the hotfix release.
set -u
sha="${1:?usage: main-gate.sh <sha>}"
repo="${GH_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$repo" ]; then echo "::error::main-gate: no repository known (set GH_REPO or GITHUB_REPOSITORY)"; exit 1; fi
if [ "${MAIN_GATE_OVERRIDE:-}" = "1" ]; then
  echo "::warning::main-gate: BYPASSED for $sha via MAIN_GATE_OVERRIDE=1 (hotfix override, .github/ci-policy.md). Unset the variable after this release."
  exit 0
fi
fail=0
for wf in test check nix-eval; do
  conclusion="$(gh api "repos/$repo/actions/workflows/$wf.yml/runs?head_sha=$sha&branch=main&status=completed&per_page=1" --jq '.workflow_runs[0].conclusion // "missing"')"
  echo "main-gate: $wf @ $sha (branch main) -> $conclusion"
  if [ "$conclusion" != "success" ]; then fail=1; fi
done
if [ "$fail" -ne 0 ]; then
  echo "::error::main-gate: refusing to publish from $sha — its main-gate (test/check/nix-eval) is not green. Wait for a green main for this SHA and re-run the publish workflow, or use the MAIN_GATE_OVERRIDE hotfix path in .github/ci-policy.md."
  exit 1
fi
echo "main-gate: $sha is green on test/check/nix-eval — publish may proceed."
