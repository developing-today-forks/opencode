# Custom formats and realtime duplex audio through the façade

- **Date:** 2026-11-23
- **Status:** exploratory design; no implementation authorized by this record
- **Tracking issue:** [developing-today-forks/opencode#1680](https://github.com/developing-today-forks/opencode/issues/1680)
- **Parent / policy context:** [#1146](https://github.com/developing-today-forks/opencode/issues/1146)
- **Prior inventory:** [PR #2033](https://github.com/developing-today-forks/opencode/pull/2033), which merged `specs/2026-11-08_design_realtime-audio-facade.md`

This record upgrades the inventory-first design in PR #2033 to an implementation-ready decision framework. It retains that design's evidence-backed conclusion: **do not build a normalized realtime façade without a named consumer; when a consumer appears, prefer a minimal session-setup tunnel that keeps media out of the façade.** Custom-format handling for bounded request/response audio remains a separate, earlier capability.

## 1. Problem and context

The existing façade model is request/response: one bounded input is translated and routed to a provider, then a bounded result is returned. Audio adds two distinct problems:

1. **Custom formats:** senders may provide raw PCM, G.711 μ-law/A-law, Opus, or containerized media with differing sample rates, channel counts, and framing. A receiver that assumes one WAV/PCM shape can reject valid input or decode it as noise.
2. **Realtime duplex:** a live voice session sends and receives concurrently over a long-lived connection. It needs turn-taking, interruption, backpressure, lifecycle, and usage semantics that a request/response adapter does not provide.

The repository has a WebSocket precedent in the PTY handlers, but no realtime audio protocol, WebRTC media server, or committed in-repository audio consumer. PR #2033 records the provider-shape and format inventory, current façade precedents, and the absence of a concrete custom-format case or consumer as checked on 2026-11-08. Those external provider details are a dated inventory, not a compatibility promise; implementation work must re-check the selected provider's current documentation.

### Goals

- Give bounded audio endpoints a precise, safe policy for declared custom formats.
- Preserve a path to realtime duplex audio without imposing one provider's event grammar on all providers.
- Keep credentials, resource limits, usage records, and failures inside the existing façade's security and accounting posture.
- Specify the evidence and decision gates required before any live-audio implementation begins.

### Non-goals

- Building a media server, SFU, TURN service, SIP gateway, or universal audio codec layer.
- Normalizing provider-native barge-in, tool-call, or playback-control semantics before two real consumers demonstrate a shared contract.
- Recording or retaining raw audio in the façade.
- Promising resumable live sessions, terminal microphone support, or a particular provider as the permanent standard.

## 2. Alternatives and tradeoffs

| Alternative | Advantages | Costs / risks | Decision |
| --- | --- | --- | --- |
| Do nothing until a named consumer appears | No speculative protocol or maintenance surface; preserves the exploratory intent of #1680 | Does not satisfy a future live-audio consumer by itself | **Chosen now for realtime media.** Keep the inventory and trigger below current. |
| Normalize every provider into one duplex event protocol | Uniform clients and centralized lifecycle/accounting | Provider grammars differ; translation can silently change interruption, turn-taking, or tool behavior; large compatibility burden | Reject for now. Reconsider only with at least two materially different consumers and parity tests. |
| WebSocket façade relay (media passes through server) | Fits existing server precedent; server retains provider credentials; can enforce framing and limits | Adds latency, bandwidth, backpressure, and a long-lived resource per session; provider-specific media handling stays in the server | Keep as a future adapter if a consumer requires server-mediated media. Not the first choice. |
| WebRTC terminated by this server | Native browser media, low-latency media transport | Requires ICE/DTLS/SRTP and media-server operations absent from this repository; large security and deployment surface | Defer; explicitly not in the first implementation. |
| Façade setup + direct client-to-provider relay/tunnel | Small façade surface; media takes the provider's supported WS/WebRTC path; short-lived credentials can be scoped to one session | Provider support varies; client carries an ephemeral credential and provider-native media semantics | **Recommended first live-audio step** when a named consumer and provider are selected. It is setup brokering, not a normalized media façade. |

## 3. Chosen approach and contracts

### 3.1 Bounded custom-format reception

Use the existing media-registration seam: each provider capability declares accepted media types and any explicit encoding/sample-rate constraints. The caller declares `encoding`, `sample_rate`, and `channels` for headerless input. Containerized input may be sniffed; if a caller declaration conflicts with the sniffed type, reject it rather than guessing.

Apply this deterministic policy per provider capability:

1. **Pass through** unchanged when the provider declares support for the received format.
2. **Transcode** only a small allowlist owned by the façade: G.711 μ-law/A-law to or from PCM16, and PCM sample-rate conversion among 8, 16, 24, and 48 kHz. Keep conversion in-process; do not add a media service. Record source and target formats in result/attempt metadata.
3. **Reject** unsupported or ambiguous input with a typed error naming the received format and accepted set. Never silently guess-decode.

Bounded submissions inherit the existing 20 MiB media asset cap. A future streaming-reception endpoint must additionally enforce duration and byte-rate ceilings before it is exposed; the initial proposal is a 600-second hard maximum, configurable only downward by deployment policy. No user-controlled setting may disable limits.

### 3.2 Realtime setup and transport

When a concrete consumer triggers work, begin with a setup-only endpoint, tentatively `POST /v1/realtime/sessions`. Authenticated input selects a provider/model or route and supplies provider-specific session configuration in an opaque, validated envelope. The façade resolves the route, asks the provider adapter to create a session, and returns a façade session id, provider endpoint, short-lived credential (only when the provider supports scoped ephemeral credentials), expiry, and a redacted configuration echo. Long-lived provider credentials never leave the server.

The first transport is provider-native and direct client-to-provider. The façade is not in the media path. If a later use case requires server relay, use a WebSocket adapter behind the same session-setup interface; each provider adapter may pass provider-native events through. Do not expose a global event-translation contract by default.

### 3.3 Session, usage, and failure model

- A realtime session is an independent façade object bound to one resolved provider/model and route; it is not implicitly an OpenCode chat session or message part.
- Sessions have a 5-minute idle timeout and a 60-minute hard maximum by default. The server closes at the limit with a typed reason. Operators may lower these limits; raising them requires an explicit resource review.
- A disconnect ends the session. Reconnect creates a new session; resume/replay is not promised because the provider inventory does not establish compatible replay guarantees.
- The façade stores no audio. Transcript retention, if any, belongs to the calling product and must be separately disclosed.
- Create one route-attempt record at session setup and finalize it on close, provider error, or enforced expiry with duration and provider-reported usage. A recovery sweeper marks abandoned rows finalized-by-timeout after the hard maximum; it must not fabricate usage.
- Normalize setup errors and a small socket/session error envelope (`code`, `message`, `provider_error`). Keep provider-native control events intact. Do not translate barge-in, playback markers, or mid-stream tool calls in this phase.

### 3.4 Backpressure and resource safety

The direct tunnel has no façade media queues. If server relay is later selected, use bounded queues in both directions, with per-session byte and frame limits. On slow-consumer overflow, discard oldest audio frames first and emit a counted drop event; never silently discard control/error events. If control traffic cannot be delivered within its bound, close the session with a typed overload reason. Enforce per-user and global concurrent-session limits before allocating provider sessions. Release provider sessions, sockets, timers, and accounting state on every close/error path.

## 4. Security and capability analysis

- Reuse existing server authentication and authorization for session setup; check that the caller may use the selected provider/model before creating upstream state.
- Keep long-lived provider keys server-side. Client-visible credentials must be provider-minted, short-lived, scoped to one session, and unusable for renewal. If a provider cannot mint a suitably scoped credential, use server relay or do not expose direct connection.
- Validate endpoint hosts and protocols against the selected provider registration to prevent caller-supplied URL/SSRF behavior. Never let opaque session configuration override credential, host, route, or resource policy.
- Redact credentials, audio payloads, and sensitive provider config from logs. Log session id, route, duration, byte counts, normalized error code, and usage only.
- Treat each provider capability as explicit: supported encodings, transport, credential mode, session expiry, usage source, and whether relay is possible. Unsupported capabilities fail closed instead of falling back to undocumented behavior.
- Default to no audio retention. Any later recording feature requires a separate privacy and retention design.

## 5. Dependency-ordered implementation slices

No implementation slice starts until #1680's review/adoption gate is resolved and a named consumer/provider pair is recorded. The following are candidate slices, not a commitment to build all of them.

| Order | Slice and dependency | Acceptance criteria |
| --- | --- | --- |
| 0 | **Ground one consumer and provider** — prerequisite for every build slice | A tracking issue names the product/client, provider/model, supported transport, real input formats, credential mode, latency target, and privacy expectation; provider documentation and a minimal capability probe are linked. If no consumer exists, stop here. |
| 1 | **Bounded custom-format contract** — may proceed independently if the chosen use case is request/response audio; depends on slice 0 | Provider registration advertises accepted formats; supported allowlisted conversions round-trip a golden corpus within documented tolerance; ambiguous and unsupported inputs return typed errors; size/duration caps are tested. Oracle: golden audio fixtures plus exact declared capability table. |
| 2 | **Realtime session setup and lifecycle** — depends on slice 0; may be tunnel-only | Contract tests prove authenticated setup, provider/model authorization, ephemeral credential scope/expiry, session close, idle/max-duration expiry, disconnect-as-restart, and idempotent cleanup. No media normalization is introduced. |
| 3 | **Accounting and failure recovery** — depends on slice 2 | Each setup creates one route-attempt; close/error/timeout finalizes it once; provider usage is preserved; a simulated process crash is swept without fabricated usage. Model-based oracle: lifecycle state machine and exactly-once finalization invariant. |
| 4 | **One provider adapter and client integration** — depends on slices 2–3 | The named client completes one supported provider session, observes provider-native events unchanged, and verifies credential non-disclosure, error closure, and usage read-back in an integration test. |
| 5 | **Optional relay or second provider** — depends on demonstrated need from slice 4 | For relay, stress test demonstrates bounded memory under a slow reader/writer, audio-drop accounting, preserved control errors, concurrency limits, and cleanup. A second provider must show why a shared normalized event would preserve semantics before normalization is added. |
| 6 | **Client expansion** — per client, depends on slice 4 | OpenChamber acceptance covers permission handling, capture/playback, interruption UX, and teardown. OpenCode/TUI is a separate spike and proceeds only if supported microphone/playback tools and a usable barge-in interaction are demonstrated on each target platform. |

## 6. Rollout and rollback

Ship behind a disabled-by-default capability flag. Roll out in this order: provider adapter tests; internal/staging session setup with synthetic or non-sensitive audio; one named consumer behind an allowlist; limited production concurrency; then broader enablement only after the operational metrics below remain within bounds. Keep custom-format request/response support independently gated from realtime sessions.

Monitor setup success/error rates, active and expired sessions, duration, provider-reported usage, timeout finalizations, bytes per session, dropped frames (if relay is enabled), and credential-redaction checks. Alert on abandoned accounting rows, unbounded active-session growth, and provider session leaks.

Rollback by disabling the capability flag and rejecting new session setup with a typed unavailable error. Existing sessions are allowed to close within the hard maximum unless a security incident requires immediate termination. Revert the provider adapter independently; do not roll back shared bounded-media behavior unless its own canary fails. Persisted accounting rows remain readable and are not deleted during rollback.

## 7. Verification plan

Before a first implementation PR, the worker must attach evidence for:

1. Unit/property tests for declared-format validation, size and duration bounds, and exact-once resource cleanup. Oracles: capability declarations, configured limits, and lifecycle invariants.
2. Golden-corpus conversion tests for each allowlisted codec/sample-rate conversion, including malformed and truncated input rejection. Oracle: decoded reference samples with a documented numerical tolerance.
3. Model-based lifecycle tests covering setup, active, close, provider failure, idle expiry, hard expiry, disconnect, retry as a new session, and crash recovery. Oracle: the session state machine and one accounting finalization per session.
4. Integration proof against the selected provider's test/sandbox endpoint, showing ephemeral credentials expire and cannot access another session, provider-native events pass unchanged, no audio/credential appears in logs, and usage is finalized.
5. Slow-client/load tests for any relay implementation, measuring bounded memory, backpressure behavior, control-event preservation, and session cleanup.
6. Client acceptance on the named platform: permissions, capture/playback, interruption or explicit lack of interruption, network loss, and teardown. TUI acceptance is not inferred from browser acceptance.

No live restart or production audio test is required to accept this design document. Provider claims from the Nov 8 inventory must be refreshed before implementation; this document does not claim a current live provider compatibility test.

## 8. Open questions and deciders

| Question | Default until resolved | Decider |
| --- | --- | --- |
| Which concrete client and use case needs realtime audio, and what custom format has actually been encountered? | No realtime implementation; require a named consumer and real sample/format declaration. | Feature requester / consumer owner, recorded on #1680. |
| Which provider/model is the first supported target, and does it offer a sufficiently scoped ephemeral credential? | No direct client connection unless credential scope and expiry are documented and tested; otherwise server relay or defer. | Façade maintainer, with provider adapter owner supplying evidence. |
| Is direct provider connection acceptable for the consumer's privacy/network posture, or is server relay required? | Prefer direct provider path only when security review and client network policy allow it. | Security reviewer for the deployment, recorded on the implementation issue. |
| Is WebRTC termination in this server required? | No; defer media-server infrastructure. | Server/platform maintainer, after slice 0 demonstrates a requirement. |
| Should any provider-native conversation-control event be normalized? | No; pass through unchanged. | Façade maintainer and consumer owner, based on two-provider parity evidence. |
| Should live audio attach to an OpenCode conversation? | No; use a standalone session id. | Product owner for the named client; not a façade-level assumption. |
| Should TUI microphone/playback support be built? | No commitment; require a platform-specific capability spike. | OpenCode TUI maintainer after a runnable platform prototype. |

These are design decisions for the named roles, not gates to begin evidence collection. The existing `user/review` label on #1680 remains the adoption/review mechanism; no unresolved question is represented as an approval already granted.

## 9. Record, tracking, and follow-up

This dated document is the sufficient-design record for #1680 and supplements, rather than deletes, the provider inventory in `specs/2026-11-08_design_realtime-audio-facade.md`. The source issue remains the tracking issue and receives a link to this record/PR. Queue task 21541 carries the doc-upgrade slice.

No implementation follow-up issue is filed now: the recommended approach is conditional on adoption and a named consumer. If #1680 is adopted, the first follow-up issue must carry slice 0 (consumer/provider grounding), link this design, and enqueue in the same pass. Only after slice 0 passes should implementation tickets be filed for the applicable slices above; each ticket must include its dependency, owned paths, and acceptance criteria. If no named consumer appears, the correct outcome remains no implementation.
