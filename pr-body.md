## Summary

Fix #1777. A weekly-length rolling window in Meta's quota payload was silently overwritten by the fixed weekly window, because both were written to the window map under the same derived label `"weekly"`. This is contract rule 1 (identity is semantic — a derived label never erases a window).

- **`parseSubscriptionQuota`** and the module-private **`keyUsageResult`**: the rolling/subscription window now publishes through `rollingWindowKey(windowSeconds)`. Its key stays the duration-derived label (`5h`, `1d`, …) except when that label would be `"weekly"` — then it publishes under its semantic role name `"rolling"` and survives beside the weekly entry. `"rolling"` cannot collide with any derived label (a derived label never names a bare role).
- Existing non-colliding labels are unchanged: a 18000s rolling window is still `5h`, an 86400s one still `1d`.
- `types.ts` parser inventory: meta's row flips from known-lossy to conforming.

## Key shape (noted per the packet)

When a weekly-length rolling window coexists with the weekly window, consumers see `windows.rolling` (with `windowSeconds: 604800`, its real duration) **and** `windows.weekly` — both with their own percent. The semantic key was chosen over a suffixed label (`weekly-rolling`) so the map names the two windows unambiguously by role; the duration is carried in the window's own `windowSeconds`.

## Tests

Oracle: the #1794 window contract rule 1 + the filing probe payloads.

- **`parseSubscriptionQuota` (filing probe)**: 604800s rolling 10% + weekly 90% publishes **both** `rolling` (10%, `windowSeconds` 604800) and `weekly` (90%).
- **Controls**: 18000s → `5h` + `weekly`; 86400s → `1d` + `weekly`.
- **Single window**: a weekly-length rolling window with no weekly entry still publishes once (`rolling`).
- **`keyUsageResult` path** (driven through `provider.fetchQuota`): 10080-minute rolling 10% + weekly 90% publishes both.

- `bun test test/quota.test.ts` from `packages/ai`: **171 passed, 0 failed, 536 expects**.
- `bun typecheck` from `packages/ai`: `tsgo --noEmit` clean.
- CI: this repo's workflows have no `pull_request` trigger by design (`.github/ci-policy.md`, #1401), so no checks are reported for a PR branch.

Fixes #1777
