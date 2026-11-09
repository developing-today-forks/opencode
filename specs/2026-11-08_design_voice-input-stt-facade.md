# Voice input — speech-to-text behind the façade (`POST /v1/audio/transcriptions`) — design

- Status: draft — parked for `user/review`; adoption is Drew's decision before any implementation follow-up is split
- Date: 2026-11-08
- Issues: [#1678](https://github.com/developing-today-forks/opencode/issues/1678) (this design); parent [#1146](https://github.com/developing-today-forks/opencode/issues/1146); registry precedent [#1554](https://github.com/developing-today-forks/opencode/issues/1554)
- Scope of this document: design only. No runtime code, no endpoint, no client capture is implemented by the design PR.

## 1. Intent and verified starting point

A user who wants to speak a prompt must currently leave OpenCode, transcribe elsewhere, and paste text back. Speech-to-text (STT) is provider-shaped — providers differ in formats, pricing units, streaming support, diarization, and audio retention — which is exactly what the #1146 façade pattern is for: one ingestion path on a common endpoint, provider detail passed through as much as possible inside a normalized envelope, and provider keys owned by the façade layer so no client ever holds an STT provider's key.

Verified on current `main` (2b14dfb9ec, 2026-11-08; earlier triage on b2459a47 reached the same conclusions):

- **No server façade route exists.** The only in-tree occurrence of the transcriptions path outside `node_modules` is the provider protocol constant `PATH = "/audio/transcriptions"` in `packages/ai/src/protocols/openai-transcription.ts`. There is no handler under `packages/server/src/handlers/` for audio, and no microphone capture in the TUI or app (the TUI's `audio` code is attention-sound playback only).
- **The provider layer already exists and must be reused, not redesigned.** `packages/ai` ships a complete transcription API:
  - `packages/ai/src/transcription.ts` — `TranscriptionModel`, `TranscriptionRequest` (`model`, `audio: Media.Asset`, optional `language`, `prompt`, `timestamps: "none" | "segment" | "word"`, `diarize`, `speakers`, `providerOptions`), `TranscriptionResponse` (`text`, optional `segments[]`, `words[]`, `language`, `durationSeconds`, `usage: MediaUsage`, `notices`, `providerMetadata`), `TranscriptionSegment` (`text`, `startSeconds`, `endSeconds`, optional `speaker`), `TranscriptionWord` (same plus optional `confidence`), and the event union (`generation-queued`, `generation-progress`, `text-delta`, `segment`, `finish`).
  - `packages/ai/src/transcription-client.ts` — the client service over that model.
  - Protocols for five providers, each with recorded tests: OpenAI (`openai-transcription.ts`), Google (`google-transcription.ts`), Deepgram (`deepgram-transcription.ts`), AssemblyAI (`assemblyai-transcription.ts`), ElevenLabs (`elevenlabs-transcription.ts`); provider registrations in `packages/ai/src/providers/{openai,google,deepgram,assemblyai,elevenlabs}.ts` each expose a `transcription(modelID)` factory.
  - Route kinds already distinguish the delivery shapes this design must name: inline (batch), stream, and queued (AssemblyAI's submit-and-poll is the queued precedent), composed via `MediaModel.fromRoute`.
  - `MediaUsage` (`packages/ai/src/schema/events.ts`) is already a tagged union — `tokens`, `seconds`, `characters`, `credits`, `compute` — because media providers bill in different units. Transcription accounting inherits this; it does not invent a token-only fiction.
- **The façade precedent is the 2026-11-01 design** (`specs/2026-11-01T04-10-00Z_design_openai-facades.md`): same server, same `ServerAuth`, `model` accepts a concrete `provider/model` ref (pass-through) or a route name resolved by the same selection machinery as chat, OpenAI error envelope, and every call observed by `ModelRouteLog` so it lands in the `route_attempt` ledger.
- **The registry precedent is embeddings** (`packages/core/src/embeddings.ts`, #1554): models register in a catalog (`EMBEDDING_MODELS`) with provider id, model id, capabilities, and backend kind; backends are interchangeable to every layer above the service; every call records a `route_attempt` row through the same `ModelRouteLog` observer, with `session_id` NULL and `route_id ""` for a direct concrete ref. A local/native backend kind exists alongside HTTP backends — the STT registry adopts the same shape so a local Whisper-class backend is a registration, not a redesign.

## 2. Façade endpoint

### 2.1 Placement

Mirror the chat façades: translation/service code in one new module under `packages/core/src/` (working name `transcription-facade.ts`, beside `embeddings.ts`), the HTTP surface declared in the existing server protocol/handler structure with one new handler file under `packages/server/src/handlers/`, registered alongside the completions handler (`packages/server/src/handlers/completions.ts`). No session is created, no agent loop runs: the façade is routing-only, like the route proxy and the embeddings door. If the public Protocol/`HttpApi` surface changes at implementation time, `bun run generate` is run from `packages/client` per `AGENTS.md`; generated client files are never hand-edited.

### 2.2 Request

`POST /v1/audio/transcriptions`, `multipart/form-data`, OpenAI-compatible field names:

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | yes | Audio asset. Accepted media types and caps are §5. The bytes become the `Media.Asset` of a `TranscriptionRequest`; they are never written to the session store by the façade. |
| `model` | yes | Concrete ref `provider/model` (pass-through) **or** a route name (bare or `opencode-route/<route-id>`) resolved through the same selection machinery as chat traffic, per the 2026-11-01 design §2. Ambiguity resolves to the route, as chat callers already depend on. |
| `language` | no | Explicit ISO hint, forwarded to `TranscriptionRequest.language`. Absent = provider auto-detect (§7). |
| `prompt` | no | Provider prompt/context hint, forwarded verbatim where the protocol supports it. |
| `response_format` | no | `json` (default, the normalized envelope of §2.3) or `verbose_json` (envelope plus provider-native payload under `provider_response`). `text`/`srt`/`vtt` are **not** offered by the façade: they discard the envelope the accounting and client contracts depend on. |
| `timestamp_granularities[]` | no | Subset of `segment`, `word`; maps to `TranscriptionRequest.timestamps` (`none` when absent). Asking for a granularity the resolved route cannot produce fails typed (§2.4), it does not silently downgrade — the request schema already states this rule. |
| `diarize` / `speakers` | no | Forwarded to `TranscriptionRequest.diarize` / `speakers`. In the envelope from day one (§7); provider support varies. |
| `stream` | no | `true` requests the SSE contract of §6. Only valid when the resolved route is a stream route; otherwise a typed 400 (§2.4), never a silent batch fallback. |
| `provider_options` | no | JSON object forwarded as `providerOptions` for the resolved provider only. This is the sole per-request provider-specific channel, mirroring the chat façades' rule that pass-through happens via provider options, never by forwarding unknown top-level fields blindly. |

Authentication is the existing server auth (Basic server password, `auth_token` query parameter, pairing session tokens; Bearer extraction as specified for the chat façades). The caller never sends an STT provider key: provider credentials are resolved server-side from the provider registration (§3).

### 2.3 Response envelope (batch)

`200`, `application/json`. The envelope **is** `TranscriptionResponse`, serialized with OpenAI-flavoured field names where a direct equivalent exists and internal names otherwise; nothing the provider reported is flattened away:

```json
{
  "text": "…full transcript…",
  "language": "en",
  "duration": 12.4,
  "segments": [{ "text": "…", "start": 0.0, "end": 4.2, "speaker": "A" }],
  "words": [{ "word": "…", "start": 0.0, "end": 0.3, "speaker": "A", "confidence": 0.98 }],
  "usage": { "type": "seconds", "seconds": 12.4 },
  "notices": [],
  "provider_metadata": { "provider": "deepgram", "model": "…" }
}
```

Rules:

- `text` is always present on success. `segments`, `words`, `language`, `duration`, `usage` are present exactly when the provider reported them; absence means "not reported", never a fabricated zero/empty value.
- Speaker labels are provider-native (`A`, `0`, `spk:0`, `speaker_0`, or a known-speaker name) and pass through unnormalized — that is the existing `TranscriptionSegment` contract, and normalizing them in the façade would destroy information clients may map themselves.
- `language` is the provider-native detected/echoed value, lowercased but not normalized (existing contract: `en`, `english`, `en_us` are all possible). Clients must not string-compare it against one canonical form.
- `usage` is the `MediaUsage` tagged union verbatim, so a seconds-billed provider and a token-billed provider are both represented truthfully.
- With `response_format=verbose_json`, one additional field `provider_response` carries the provider-native response payload. This is the pass-through escape hatch; the normalized fields remain authoritative for clients and accounting.

### 2.4 Errors

OpenAI error envelope `{ "error": { "message", "type", "code" } }`, mapped from the internal `AIError` / provider-failure classification (`classifyProviderFailure` in the protocols), consistent with the chat façades:

| Status | `code` examples | When |
| --- | --- | --- |
| 400 | `invalid_audio`, `unsupported_media_type`, `audio_too_large`, `stream_not_supported`, `timestamps_not_supported` | Malformed multipart, unaccepted codec/container, cap exceeded (§5), `stream=true` on a non-stream route, requested timestamp granularity the route cannot produce. |
| 401 | `unauthenticated` | No/invalid server auth. |
| 404 | `model_not_found` | `model` matches no concrete ref and no route. |
| 413 | `audio_too_large` | Duration/size cap exceeded when detected from headers before body read (either 400 or 413 is acceptable at implementation, but one must be chosen and tested). |
| 429 | `quota_exceeded`, `rate_limit` | Provider quota/rate limit, with the provider's reset hint preserved in `message` — caller retry logic keys on this shape, as with the chat façades. |
| 502 / 503 | `upstream_failure`, `no_route_candidate` | Provider failure after failover is exhausted, or every route candidate is gated/demoted. |

Failover follows chat semantics: on a retryable failure the resolver's next candidate is tried; the façade invents no second policy. A queued route (AssemblyAI-style submit-and-poll) is still one façade call from the caller's perspective — polling is the route's internal business, surfaced only as `generation-progress` events on a stream or as latency on a batch call.

## 3. STT provider registry

Mirror `EMBEDDING_MODELS`, do not invent a parallel mechanism. A registration (working name `TRANSCRIPTION_MODELS` in the façade module) names:

- `ref` — the catalog ref callers address: `provider/model`.
- `providerID` / `modelID` — resolving to the existing `packages/ai` provider `transcription(modelID)` factory; the registry holds no protocol code.
- `capabilities` — declared, per registration: `stream: boolean`, `timestamps: ("segment" | "word")[]`, `diarize: boolean`, `maxDurationSeconds`, accepted media types. Capabilities come from the registration/protocol (the OpenAI protocol already computes exactly this shape), never assumed from the provider's brand.
- `backend` kind — `http` (the provider API, the default and the only kind in phase 1) or `native-local` (a Whisper-class model running in-process/on-device, the direct analogue of embeddings' `native-onnx` kind). Phase 1 registers HTTP backends only; the kind field exists from day one so the local backend is a later registration flip, as #1554/#1690 did for embeddings.
- `apiKeyEnv` / credential reference — the environment/config source of the provider key.

Config gating and key ownership:

- Registrations are gated by the same config machinery as chat providers, including `disabled_providers`-style exclusion: a disabled provider's refs vanish from resolution and from any future `GET /v1/models`-style listing, exactly as chat refs do.
- **Keys are registered and renewed by the provider/façade layer** (the #1146 rule). Clients authenticate to the OpenCode server once with existing server auth. No STT key is ever sent to, stored by, or renewable by a TUI/OpenChamber client.
- Each registration carries a boolean `audio_leaves_machine` flag (false only for a `native-local` backend) and a `retention` note naming the provider's documented audio-retention posture where known. §5 surfaces the flag to clients; the registry is the single source of truth for it.

First registrations (phase 1, on adoption): the five providers whose protocols and recorded tests already exist — OpenAI, Deepgram, Google, AssemblyAI, ElevenLabs — one implementation ticket per backend as #1678's expansion path prescribes, each verified against its recorded fixtures before it is enabled by default.

## 4. Accounting parity

Every façade transcription call records a `route_attempt` row through the same `ModelRouteLog` observer the generation and embeddings paths use — no new table, no silent skip:

- `session_id` = NULL (the door convention: façade calls have no session).
- `route_id` = `""` for a direct concrete ref; the resolved route id when `model` named a route.
- Usage columns carry what `MediaUsage` reported: seconds-billed calls record duration-derived usage in the ledger's existing media convention (as embeddings record `tokens_input` from the backend report and `tokens_output = 0`); a provider that reports no usage records the attempt with no usage values rather than an invented number.
- Failures record the attempt and its classified failure, so quota demotion (the resolver's existing demote-on-failure discipline) applies to STT routes exactly as it does to chat routes.

Parity test owed by the implementation ticket: a recorded-fixture transcription through the façade produces (a) an envelope equal to the provider-native response's normalized form and (b) exactly one `route_attempt` row per provider attempt, including failover attempts.

## 5. Inputs, limits, retention, privacy

### 5.1 File input

A client submits an existing audio file as the `file` part (§2.2). The client does not transcode before submit in phase 1; the façade rejects an unaccepted container/codec with `unsupported_media_type` naming what is accepted for the resolved registration, so the client can offer conversion as a follow-up rather than guessing.

### 5.2 Limits (bounded by default, #1127)

Concrete defaults, overridable per registration but never silently unlimited:

- Maximum duration: **600 seconds** per call (prompt-scale voice input; long-form is explicitly out of phase 1, §7).
- Maximum upload size: **25 MiB**.
- Accepted containers/codecs: those the resolved registration declares (phase-1 floor: `wav`, `mp3`, `m4a`, `webm`, `ogg` where the provider accepts them).
- Exceeding a cap is a typed error (§2.4) detected before provider submission; the façade never truncates audio silently — a truncated transcript presented as complete is a correctness failure, not a convenience.

### 5.3 Retention and privacy defaults

- **Default discard.** The façade retains no audio after the call completes (success or failure). Audio is held in memory / request-scoped temporary storage only for the duration of provider submission. No audio is written to the session store, the ledger, or logs; logs may carry duration, media type, provider, and model — never audio bytes or transcript text.
- Transcript text belongs to the caller: it lands in the client (§6.3) and only enters a session if the user sends it as a message, at which point normal session retention applies to the message, not to the audio.
- Before a recording/file is submitted, the client surfaces the resolved registration's `audio_leaves_machine` flag and, for hosted providers, that the provider's own retention policy applies to the submitted audio. A `native-local` registration is the only path that can promise audio never leaves the machine, and the UI must not imply otherwise for hosted backends.

## 6. Client specification (TUI and OpenChamber)

Shared behaviour (endpoint, envelope, errors, limits) is defined once above. Clients differ only in capture and rendering.

### 6.1 Capture

Both clients offer two entry points: **attach file** (§5.1) and **record**.

Recording state machine, identical in both clients: `idle → recording → reviewing → submitting → inserted | error`, with **cancel available in `recording` and `reviewing`**, discarding captured audio immediately and locally. Recording shows an unambiguous live indicator (elapsed time + level/waveform where the platform supports it) and the §5 duration cap counting down; hitting the cap stops capture and moves to `reviewing`, it does not auto-submit.

- **TUI:** capture uses the terminal host's microphone access via the platform audio path available to the Bun process; where no capture device/path exists, the record affordance is hidden and file attach remains (a visible dead control is worse than an absent one). The affordance lives in the composer, beside attach.
- **OpenChamber:** capture uses its own webview media-permissions path (`getUserMedia`-equivalent); a denied permission produces an in-composer explanation with the file-attach fallback, not a modal dead end.

### 6.2 Review before send

Captured/file audio is **never auto-submitted and never auto-sent**. `reviewing` offers: play back (where the platform supports it), submit for transcription, re-record, and discard. Submitting calls the façade once; an error (§2.4 shapes) renders in the composer with retry/discard, and the audio is retained locally until the user discards or the transcript is inserted.

### 6.3 How the transcript lands

Decided here, per #1678's candidate analysis: **the transcript is inserted into the composer as editable draft text — voice is an input method, not an auto-send.** Rationale: STT errors on code identifiers and file names are common, and an uneditable auto-sent transcript makes the user pay for every misrecognition with a follow-up correction message.

- Insertion appends at the cursor (or replaces a selection), marked as un-sent draft like any typed text.
- Provenance (provider, model, duration, language if reported) is shown in the review/insertion affordance and, if the user sends the message, attached as message-part metadata — not pasted into the visible text.
- An explicit user opt-in ("submit transcript directly") may be added by a client later; it is out of phase 1 and must never become the default silently.

### 6.4 Streaming partials in the client

When §6 streaming is used, partial `text-delta` text renders in the composer area as provisional (visually distinct, e.g. dimmed) and is **not** committed to the draft until the `finish` event arrives; only the finish event's transcript is inserted per §6.3. A stream that errors mid-way leaves the pre-recording draft untouched and returns to the §6.2 error state with the audio still held locally.

## 7. Batch vs streaming, and the open questions — resolved or phased

**Batch vs streaming (named up front, as the intake risk requires).** Providers differ sharply: some stream natively, some are batch-only, AssemblyAI-style providers are queued/poll. The façade therefore makes delivery shape a **capability of the resolved route**, not a promise of the endpoint:

- Phase 1 ships **batch only**: one request, one envelope (§2.3), regardless of whether the route internally streams or polls to produce it. Every existing protocol can satisfy batch via its finish event.
- Phase 2 adds **streaming partials** as an opt-in (`stream=true`) over SSE, reusing the existing `TranscriptionEvent` grammar serialized as `transcript.text.delta` / `transcript.text.segment` / `transcript.text.done` frames (the OpenAI protocol's frame names) ending with `data: [DONE]`, consistent with the chat façades' streaming translation. Only stream-capable registrations accept it; others return the typed `stream_not_supported` error. There is no server-side fake-streaming of a batch result as word-by-word deltas.

Open questions from #1678, dispositioned:

| Question | Disposition |
| --- | --- |
| Hosted APIs vs local/on-device first? | **Phased.** Phase 1: hosted HTTP registrations (protocols already exist). Local Whisper-class backend is a `native-local` registration kind designed in §3 from day one, implemented as its own later ticket — mirroring how embeddings went HTTP-first, native flip second (#1554). |
| Streaming-partial contract — normalize or pass through? | **Resolved:** normalize into the existing `TranscriptionEvent` grammar (§7 above). The fidelity knowingly traded away is provider-specific interim metadata, which remains available under `provider_metadata` on the finish frame. |
| Language: auto-detect vs hint vs per-session setting? | **Resolved:** per-call `language` hint wins when present; otherwise provider auto-detect; the reported language returns in the envelope unnormalized (§2.3). No per-session STT language setting in phase 1. |
| Diarization / speaker labels in scope? | **Resolved:** in the envelope and request from day one (`diarize`, `speakers`, segment/word `speaker`), because the internal schemas already carry them; per-provider support is a capability flag, and requesting diarization from a route that cannot do it fails typed rather than silently returning unlabeled segments. |
| Long-form / chunking (meetings vs prompts)? | **Explicitly out of phase 1.** The §5 caps define prompt-scale input. Long-form (chunking, resumable queued jobs, speaker-attributed meeting transcripts) is a separate product decision and, if adopted, its own design — the queued route kind is the natural substrate, but nothing in phase 1 pre-commits to it. |
| Privacy: per-backend "audio leaves the machine" flag? | **Resolved: yes** — registry flag (§3), surfaced pre-submit (§5.3). Provider retention notes live on the registration. |

## 8. Implementation split (filed only on adoption)

Per #1678's expansion path, after Drew adopts this design:

1. Façade transcriptions route + registry skeleton (batch, one provider end-to-end, ledger parity + parity tests).
2. One ticket per remaining STT backend registration.
3. OpenCode TUI: file attach + capture + review + composer insertion.
4. OpenChamber: capture + insertion on its media-permissions path.
5. Streaming partials (phase 2 of §7).
6. Local `native-local` backend registration (Whisper-class), if prioritized.

#1678 stays open until adoption; it closes or splits when Drew accepts, amends, or rejects this design. This document must also be linked from #1146 when the design PR lands.

## 9. Non-goals

- No runtime implementation in the design PR; no endpoint, registry code, or client capture ships with this document.
- No new provider protocols: everything routes through the existing `packages/ai` transcription API.
- No text-to-speech, no realtime/live-conversation voice mode, no voice commands — this design covers transcription of bounded audio into draft text only.
- No per-caller API keys for the façade (a pre-existing stretch goal of the chat façade design, unchanged here).
