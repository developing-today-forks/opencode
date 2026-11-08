#!/usr/bin/env bash
# Run the unit test suite through turbo, retrying once when the turbo/bun
# orchestrator itself crashes (#90).
#
# Observed on run 39182188357: turbo died of SIGSEGV mid-suite before
# @opencode/core:test ever ran. Bun printed 'Failed to run "turbo" due to
# signal SIGSEGV' and the step exited 139, so the truncated run read as an
# ordinary red run and the unreported packages shipped with no unit verdict.
#
# Only an orchestrator crash (exit 139 or SIGSEGV in the output) is retried and
# annotated. Any other non-zero exit is an ordinary test failure and is passed
# straight through: no retry, no crash annotation. On recurrence both the
# distinct error annotation and the step summary record the turbo and bun
# versions, so the next observation starts from facts rather than a guess.
#
# Turbo replays the tasks that completed before the crash, so a retry only
# executes the missing remainder of the suite.
#
# usage: script/run-unit-tests.sh <command> [args...]
#   script/run-unit-tests.sh bun turbo test --affected --concurrency=3
set +e -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

ATTEMPTS=2
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

crashed() {
  [ "$1" -eq 139 ] || grep -qi sigsegv "$LOG"
}

# A crash can take the binary down hard enough that asking it for its version
# fails too, so fall back to the versions package.json pins.
versions() {
  local turbo bun_version
  turbo="$(bun turbo --version 2>/dev/null || bun -e 'const pkg = await Bun.file("package.json").json(); console.log(pkg.devDependencies.turbo)' 2>/dev/null || true)"
  bun_version="$(bun --version 2>/dev/null || sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' package.json 2>/dev/null || true)"
  echo "turbo ${turbo:-unknown}, bun ${bun_version:-unknown}"
}

summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"
}

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  echo "==> unit tests, attempt ${attempt}/${ATTEMPTS}: $*"
  "$@" 2>&1 | tee "$LOG"
  status=$?

  if [ "$status" -eq 0 ]; then
    if [ "$attempt" -eq 1 ]; then
      exit 0
    fi
    versions_text="$(versions)"
    echo "::notice title=Unit tests passed on retry::The unit test orchestrator crashed on attempt 1/${ATTEMPTS} and the retry passed. ${versions_text}"
    summary "### Unit tests passed on retry" "" "- The turbo/bun orchestrator crashed on attempt 1/${ATTEMPTS}; the retry passed." "- Versions: ${versions_text}"
    exit 0
  fi

  if ! crashed "$status"; then
    exit "$status"
  fi

  detail="exit ${status}"
  if grep -qi sigsegv "$LOG"; then
    detail="${detail} with SIGSEGV in the output"
  fi
  versions_text="$(versions)"

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "::warning title=Unit test orchestrator crashed::Attempt ${attempt}/${ATTEMPTS} crashed (${detail}); retrying once. ${versions_text}"
    attempt=$((attempt + 1))
    continue
  fi

  echo "::error title=Unit test orchestrator crashed twice::Both attempts crashed (${detail}). This is a turbo/bun crash, not a test failure: the run was truncated, so packages after the crash point (e.g. @opencode/core:test) may have no verdict. Versions: ${versions_text}. See issue #90."
  summary "### Unit test orchestrator crashed twice" "" "- Attempt 1 and the retry both crashed (${detail})." "- Versions: ${versions_text}" "- This is not a test failure: the run was truncated, so packages after the crash point may not have executed. See issue #90."
  exit "$status"
done
