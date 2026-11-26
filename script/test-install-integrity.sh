#!/usr/bin/env bash
# Scripted check for the root `install` script's npm tarball integrity
# verification (issue #2846).
#
# Extracts the verify_tarball function exactly as shipped in `install` and
# exercises it against fixture archives:
#   1. correct dist.integrity (sha512 SRI) passes
#   2. tampered archive fails before extraction (non-zero, "Integrity check failed")
#   3. missing digest fails closed
#   4. correct dist.shasum (sha1) passes when dist.integrity is absent
#   5. mismatched dist.shasum fails
#   6. unsupported dist.integrity algorithm fails closed
#
# In `install` itself, verify_tarball runs after the download and before
# `tar -xzf`, and its `exit 1` triggers the cleanup trap, so a failing case
# here means the archive is never extracted there.
#
# Usage: script/test-install-integrity.sh [path-to-install-script]
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
install_script="${1:-${INSTALL_SCRIPT:-$repo_root/install}}"

if [ ! -f "$install_script" ]; then
    echo "FAIL: install script not found at $install_script" >&2
    exit 1
fi

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

# The function under test, verbatim from the install script.
sed -n '/^verify_tarball() {/,/^}/p' "$install_script" > "$work_dir/verify_tarball.sh"
if ! grep -q '^verify_tarball()' "$work_dir/verify_tarball.sh"; then
    echo "FAIL: verify_tarball not found in $install_script" >&2
    exit 1
fi

RED='' NC=''
# shellcheck disable=SC1091
source "$work_dir/verify_tarball.sh"

fixture="$work_dir/package.tgz"
printf 'fake opencode binary payload\n' > "$work_dir/payload"
tar -czf "$fixture" -C "$work_dir" payload

tampered="$work_dir/tampered.tgz"
printf 'tampered payload\n' > "$work_dir/payload"
tar -czf "$tampered" -C "$work_dir" payload

if command -v openssl >/dev/null 2>&1; then
    good_integrity="sha512-$(openssl dgst -sha512 -binary "$fixture" | openssl base64 -A)"
else
    good_integrity="sha512-$(sha512sum "$fixture" | awk '{print $1}' | sed 's/../\\x&/g' | xargs -0 printf 2>/dev/null || true)"
fi
if command -v sha1sum >/dev/null 2>&1; then
    good_shasum=$(sha1sum "$fixture" | awk '{print $1}')
else
    good_shasum=$(shasum -a 1 "$fixture" | awk '{print $1}')
fi

failures=0

# run_case <name> <integrity> <shasum> <file> <want: pass|fail>
run_case() {
    local name="$1" integrity="$2" shasum="$3" file="$4" want="$5"
    local out status
    out=$( (expected_integrity="$integrity" expected_shasum="$shasum" verify_tarball "$file") 2>&1 )
    status=$?
    if [ "$want" = "pass" ] && [ "$status" -eq 0 ]; then
        echo "PASS: $name"
    elif [ "$want" = "fail" ] && [ "$status" -ne 0 ] && printf '%s' "$out" | grep -q "Integrity check failed"; then
        echo "PASS: $name"
    else
        echo "FAIL: $name (exit=$status, wanted $want; output: $out)" >&2
        failures=$((failures + 1))
    fi
}

run_case "correct dist.integrity passes" "$good_integrity" "" "$fixture" pass
run_case "tampered archive fails before extraction" "$good_integrity" "" "$tampered" fail
run_case "missing digest fails closed" "" "" "$fixture" fail
run_case "correct dist.shasum passes without integrity" "" "$good_shasum" "$fixture" pass
run_case "mismatched dist.shasum fails" "" "0000000000000000000000000000000000000000" "$fixture" fail
run_case "unsupported integrity algorithm fails closed" "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" "" "$fixture" fail

if [ "$failures" -ne 0 ]; then
    echo "$failures case(s) failed" >&2
    exit 1
fi
echo "All install integrity cases passed."
