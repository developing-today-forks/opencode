# Spec: `*-direct` providers emulate the vendor wire

Status: **Active doctrine.** Direction set by Drew 2026-11-05 01:13 CST (correction to the
ACP-embedding direction). Tracked by `developing-today-forks/opencode#1717`; this file is the
repo's own record of it (acceptance criterion on that issue).

This applies to every `*-direct` provider in this fork.

## The three rules

1. **Emulate, don't embed.** The provider reproduces the first-party client's wire behavior
   itself — endpoints, request shapes, headers, attribution markers (e.g. `call_source`),
   presets/defaults, and token use. No vendor agent runtime is hosted, spawned, or driven
   (no ACP embedding, no subprocess of the vendor binary) at inference time.
2. **Vendor binaries are for login/bootstrap only.** The rare one-time sign-in that provisions
   a credential (e.g. `vibe --setup`) may use the vendor binary. Ideally the binary is not
   needed at runtime at all; a bootstrap an agent or human runs rarely is acceptable only under
   rule 3.
3. **Auth must auto-renew.** The emulated provider's credential must either be a long-lived
   static credential that needs no renewal, or renew itself (refresh flow) without the vendor
   binary and without a browser. A provider whose auth silently dies until someone re-runs a
   vendor login is out of doctrine.
   *Companion rule (Drew, 2026-11-05):* anything browser-born in any provider must have an
   auto-renewing cookie/token built in — never a non-renewing console cookie.

## Superseded direction: ACP embedding

The ACP-embedding approach is superseded by this doctrine. Epic `#1709` and its children
`#1710`–`#1714` are closed as *not planned — direction corrected*. The ACP spike evidence stays
valuable as protocol research; it is not the architecture.

## Applying the doctrine: the per-provider audit

Each custom provider is audited against the three rules and the result recorded on `#1717`:
a **dependency map**, an **auth-class** classification, and a **zero-binary proof** where a
vendor binary exists. The current custom set and the per-provider checkboxes live on `#1717`.

## Reference: `vibe-direct` (COMPLIANT, verified 2026-11-05)

Recorded here as the worked example; the full evidence is on `#1717`.

- **Wire:** `POST https://api.mistral.ai/v1/chat/completions`, streamed, through the fork's
  MistralChat route — the binary's own `api_base` and SDK request shape. No `vibe` binary involved.
- **Auth header:** `Authorization: Bearer <key>` only.
- **Attribution stamp:** `metadata {call_source: "vibe_code", host_kind: "local", call_type: "main_call"}`
  (plus caller `session_id`); `call_source` is the Vibe quota metering key.
- **Auth class:** **Class S — static long-lived credential, renewal unnecessary.** The stored
  credential is a plain workspace API key: no expiry, no refresh token, no exchange; the binary's
  own runtime reads the same static key. It dies only on console-side revocation; renewing is one
  re-run of the bootstrap, which the provider reads in place.
- **Zero-binary proof (2026-11-05, live):** with `vibe`, `vibe-acp`, and `vibe-app-server` renamed
  away, a vibe-direct turn completed end to end on `providerID vibe-direct` /
  `model mistral-vibe-cli-latest`. Details and transcripts on `#1717`.

**Known follow-up (not a doctrine violation):** `vibe-auth` caches the resolved key per server
process and its exported `invalidate()` has no caller, so a rotated key is not picked up until
restart. Wire invalidation (or re-resolution) on authentication failure closes this. Tracked on `#1717`.

## Inference-time vendor-runtime check (2026-11-08)

No provider in `packages/ai/src/providers` hosts, spawns, or drives a vendor binary at inference
time. The only `child_process` use in the providers tree is `secret-tool` keyring lookups
(`vibe-auth.ts`, `antigravity-auth.ts`); the same applies to the quota providers that read keyring
entries. This is the rule-1 half of the audit, applied repo-wide.

## Audit snapshot

| Provider | Auth class | Rule 1 (no runtime) | Status |
| --- | --- | --- | --- |
| `vibe-direct` | S (static key) | clean | **COMPLIANT** (verified 2026-11-05) |
| `antigravity-direct` | shares `vibe-auth` keyring pattern (via `secret-tool`) | clean | pending on `#1717` |
| `muse-direct` | `#13555` verdict (2026-11-08): the `dca:` account token is **not verifiably long-lived** (no expiry or refresh token recorded; two stored tokens returned 401, with rotation/revocation still a caveat). Use the stored minted `api_key` as primary; account-token exchange is bootstrap-only. | clean | api_key-primary remedy implemented; exchange 401 requires Muse app re-auth; account-token lifetime remains unverified |
| `commandcode` | pending classification | clean | pending on `#1717` |
| `claude-code` | stored `expiresAt` — classify leaf expiry | clean | pending on `#1717` |
| `opencode-route` (façade) | leaves inherit their own classifications | clean | pending on `#1717` |
| `deepseek` | API-key class expected | clean | pending on `#1717` |
