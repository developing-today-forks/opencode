# Spec: `*-direct` providers emulate the vendor wire

Status: **Active doctrine.** Direction set by Drew 2026-11-05 01:13 CST (correction to the
ACP-embedding direction). The audit history is recorded on
`developing-today-forks/opencode#1717`; this file is the repo's own record of it.

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

**Resolved follow-up:** a Vibe 401 invalidates the cached credential, re-prepares the request, and
retries once through `VibeAuth.invalidate()` (`packages/ai/src/providers/vibe.ts`). This picks up a
rotated or revoked key without waiting for a server restart.

## Inference-time vendor-runtime check (2026-11-08)

No provider in `packages/ai/src/providers` hosts, spawns, or drives a vendor binary at inference
time. The only `child_process` use in the providers tree is `secret-tool` keyring lookups
(`vibe-auth.ts`, `antigravity-auth.ts`); the same applies to the quota providers that read keyring
entries. This is the rule-1 half of the audit, applied repo-wide.

## Audit snapshot (2026-11-27)

The six-provider classification was recorded on `#1717` on 2026-11-08 and checked against current
main. `#1818`'s rotating Claude Code credential gap was implemented by PR #2126; Muse's stored
inference-key preference was implemented by PR #2161. The status column distinguishes a completed
implementation from the still-unverified lifetime of the Muse account token.

| Provider | Auth class | Rule 1 (no runtime) | Status |
| --- | --- | --- | --- |
| `vibe-direct` | S (static workspace key) | clean | **COMPLIANT**; 401 invalidation and one retry are wired in current main |
| `antigravity-direct` | R (OAuth access + refresh token) | clean | **COMPLIANT**; refresh exchange runs in-process |
| `muse-direct` | Stored inference `api_key` is primary; the `dca:` account token has no recorded expiry or refresh token and was rejected in two probes (rotation/revocation remains a caveat). | clean | Stored-key remedy implemented by PR #2161; account-token lifetime remains unverified and a rejected account credential requires Muse app sign-in |
| `commandcode` | S (static API key from `~/.commandcode/auth.json`) | clean | **COMPLIANT**; no renewal needed |
| `claude-code` | R (single-use rotating OAuth refresh token) | clean | **COMPLIANT**; refresh is persisted atomically before using the new access token (PR #2126) |
| `opencode-route` (façade) | S (`OPENCODE_API_KEY`); downstream leaves retain their own classifications | clean | **COMPLIANT** at the façade; leaf status is inherited |
| `deepseek` | S (`DEEPSEEK_API_KEY`) | clean | **COMPLIANT**; no renewal needed |
