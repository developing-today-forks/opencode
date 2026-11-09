# Custom + realtime audio through the façade — inventory and design

- Status: draft — parked for `user/review`; adoption is Drew's decision before any implementation follow-up is split
- Date: 2026-11-08
- Issues: [#1680](https://github.com/developing-today-forks/opencode/issues/1680) (this design, the exploratory sibling of the façade-expansion set); parent [#1146](https://github.com/developing-today-forks/opencode/issues/1146); siblings [#1677](https://github.com/developing-today-forks/opencode/issues/1677) (search), [#1678](https://github.com/developing-today-forks/opencode/issues/1678) (speech-to-text, design in PR #2032), #1679 (image/video generation)
- Conclusion up front: **not-yet for a normalized realtime façade; tunnel-only if and when a concrete consumer appears** (§6). This is the outcome #1680 explicitly allows, and the inventory in §2–§3 is the evidence for it. No runtime code is designed to implementation depth beyond the tunnel sketch in §6.2, deliberately.

## 1. Verified starting point (in-repo evidence)

Checked on current `main` (2b14dfb9ec, 2026-11-08); the Nov 5 triage (task 10124, main 81854860) reached the same conclusions:

- **Zero realtime surface exists.** No occurrence of `audio/realtime` or `v1/realtime` in the fork outside `node_modules`; no realtime protocol under `packages/ai/src/protocols/`; no realtime provider registration. The audio protocols that do exist are request/response or stream-to-completion: transcription (five providers, see the #1678 design) and speech/TTS (`openai-speech.ts`, `google-speech.ts`, `deepgram-speech.ts`, `elevenlabs-speech.ts`, `cartesia-speech.ts`, with a shared `speech-stream.ts` util). Nothing in-tree is duplex.
- **No in-repo demand signal exists yet.** Beyond #1680 itself there is no issue, PR, or code path in this fork asking to send or receive live audio, no telephony integration, and no client surface with microphone playback/capture loops (the TUI's audio code is attention-sound playback only). #1680's own open question — what "custom format" concretely means in cases already hit — has no collected examples in the repo. A design that picked a universal transport and normalization boundary today would be picking them for hypothetical consumers.
- **The server does have a websocket precedent.** `packages/server` already upgrades connections for PTY (`packages/server/src/handlers/pty.ts`, `persistent-pty.ts`, routed in `packages/server/src/routes.ts`) with the standard server auth applied. So "the server cannot do duplex" is false — a websocket façade would extend an existing pattern, not introduce a transport class. There is no WebRTC precedent anywhere in the fork (no ICE/DTLS/SRTP, no SDP handling, no media-server dependency).
- **Media ingest is already bounded.** `packages/ai/src/media.ts` defines `Media.Asset` with detected/declared `mediaType` and a hard 20 MiB cap on downloaded asset bodies (`MAX_DOWNLOAD_BYTES`, matching core's media-ingest limit) — the bounded-by-default posture (#1127) any custom-format reception must inherit.

## 2. Inventory: realtime/live audio interface shapes (provider-documented)

Provider shapes below are as documented by the providers at design time; they are external facts to be re-verified at implementation time, not in-repo evidence. They are catalogued because #1680 requires the inventory before any transport choice.

| Shape | Examples | Transport | Event grammar | Audio expectations | Session creation / auth | Session end |
| --- | --- | --- | --- | --- | --- | --- |
| WebSocket realtime API | OpenAI Realtime API | WSS, JSON control events + base64 audio in JSON frames | Typed client/server events (`session.update`, `input_audio_buffer.append/commit`, `response.create`, `response.audio.delta`, `conversation.item.*`, interruption via server VAD events) | PCM16 (24 kHz) or G.711 μ-law/A-law, negotiated in session config | Server-side: long-lived API key on the WS handshake. Browser-side: server mints a short-lived **ephemeral client secret** and the client connects directly to the provider | Client close, server `error` event, or session time limit |
| WebSocket streaming STT/TTS (one-way live) | Deepgram live transcription; ElevenLabs streaming | WSS, binary audio frames up, JSON results down (STT) or audio down (TTS) | Provider-specific JSON messages; keep-alive/control messages | Wide codec menu incl. μ-law, Opus, linear PCM at declared sample rates | Long-lived key (header/query) or short-lived token minted server-side | Close frame; provider idle timeouts |
| WebRTC realtime | OpenAI Realtime via WebRTC; various voice-agent platforms | WebRTC (SDP offer/answer over HTTPS + DTLS/SRTP media + a data channel for events) | Same event grammar as the provider's WS shape, carried on the data channel; media on RTP tracks | Opus by default, negotiated by SDP | Server creates the session with the long-lived key and returns SDP/ephemeral credentials; media flows peer-to-provider, **not through the calling server** | Peer-connection close; session expiry |
| SIP / telephony bridge | Twilio Media Streams and similar PSTN bridges | Provider calls your WSS endpoint; μ-law 8 kHz base64 frames in JSON envelopes (`connected`/`start`/`media`/`mark`/`stop`) | Telephony-shaped, not AI-shaped: the bridge knows calls, streams, and marks; the AI provider is a second hop you wire yourself | G.711 μ-law 8 kHz, 20 ms frames — the canonical "custom format" a naive receiver rejects | Telephony-provider signature validation; per-call stream SID | Call hangup ends the stream |
| Provider-proprietary duplex sockets | Hosted voice-agent platforms (e.g. managed conversation agents) | WSS or WebRTC, proprietary | Proprietary; turn-taking, barge-in, and playback semantics are the product | Provider-chosen | Ephemeral session tokens | Platform-defined |

What the inventory actually shows:

1. **There is no converging cross-provider realtime grammar.** The OpenAI-style event model is the most visible, but Deepgram/ElevenLabs streaming is one-way, telephony is call-shaped, and voice-agent platforms are proprietary. The field is divergent in exactly the way #1680 feared.
2. **The one strong convergence is at the edges, not the middle:** server-side session creation with a long-lived key, **ephemeral short-lived credentials for any client-direct connection**, and PCM/G.711-family encodings on WS shapes vs Opus on WebRTC.
3. **WebRTC's media path bypasses the server by design** — a façade in the media path for WebRTC means becoming a media server (SFU/TURN), which is a different product than this fork's server.

## 3. Inventory: the non-live custom-format side

"Custom format" concretely means, from the shapes above and the fleet's orbit:

- **Telephony codecs:** G.711 μ-law/A-law at 8 kHz (narrowband, companded) — sounds nothing like the 16/24/48 kHz PCM most AI APIs default to; sample-rate and companding conversion are mandatory before most providers accept it.
- **Raw PCM variants:** signed 16-bit LE at 8/16/24/44.1/48 kHz, float32, μ-law — same "WAV-like" intuition, five different byte meanings; the container (or its absence) is the only thing that disambiguates.
- **Compressed streams:** Opus (WebRTC/web), MP3/AAC in fragmented containers, AMR (legacy telephony).
- **Container oddities:** headerless raw audio, WAV with non-PCM fmt chunks, WebM with a video track the receiver must ignore.

In-repo, the reception machinery that exists is `Media.Asset` + `detectMediaType` (§1): byte-sniffing for known containers, declared `mediaType` otherwise. Headerless/companded formats are **not detectable reliably by sniffing** — they require the sender to declare encoding + sample rate out of band, as every telephony bridge does. Any custom-format design that pretends detection is enough will mis-decode μ-law as noise.

## 4. Design questions, answered against the inventory

### 4.1 Custom-format reception policy

Three-way policy, decided per declared format at the boundary — this part of the design **is** settled, because it extends the shipped transcription façade design (#1678) rather than the unbuilt realtime one:

1. **Accept-and-pass-through** when the target provider registration declares support for the format (the registry capability model from the #1678 design: accepted media types per registration).
2. **Accept-and-transcode server-side** only for a small, explicit conversion set owned by the façade: G.711 μ-law/A-law ↔ PCM16, and PCM sample-rate conversion between 8/16/24/48 kHz. Transcoding lives in-process (the native direction of #1554), never as a new media service. Every transcode is recorded on the response/attempt metadata (source format, target format) — a silent transcode that changes audio characteristics is a parity failure.
3. **Reject with a precise envelope** otherwise: the §2.4-style error from the #1678 design naming the received format and the accepted set. Never guess-decode.

Sender declaration (`encoding`, `sample_rate`, `channels`) is required for headerless formats; container formats are sniffed and the sniff result must agree with any declaration, or the call is rejected as ambiguous. Limits inherit §1's bounds: the 20 MiB asset cap for bounded submissions; streamed reception is capped by duration (the #1678 design's 600 s default) and bytes-per-second sanity bounds per declared format.

### 4.2 Transport for a realtime façade

| Candidate | Latency/fidelity | Fork-maintenance surface | Verdict |
| --- | --- | --- | --- |
| WebSocket upgrade on the OpenCode server (PTY precedent, §1) | Good enough for PCM/G.711 shapes; JSON+base64 framing costs ~33% size overhead, acceptable at voice bitrates | One isolated handler + one core module, same isolation rule as the other façades | **The only viable façade transport, if one is built** |
| WebRTC terminated at the server | Best media properties | Requires an SFU/media stack the fork does not have; enormous upstream-merge conflict surface | **Out of scope, explicitly deferred** — WebRTC appears only in the relay model below |
| Relay / brokered setup (façade mints ephemeral credentials; media flows client↔provider directly, WS or WebRTC) | Best possible (no façade in media path) | Smallest: session-setup endpoint + credential minting, no media code | **Recommended first step if a consumer appears** (§6) — but it is a tunnel, not a façade: normalization ≈ none |

### 4.3 Normalization boundary

Per capability, never global — the inventory (§2) shows a global grammar would be an OpenAI-shaped fiction imposed on non-OpenAI shapes:

- **Session setup/teardown, auth, accounting events:** normalize. These are façade-shaped already (create, close, usage) and every provider has equivalents.
- **Transcript-shaped events** (partial/final transcripts, where a provider emits them): normalize into the existing `TranscriptionEvent` grammar from `packages/ai` — it already exists and the #1678 design already adopts it for streaming STT.
- **Audio media itself:** pass through byte-for-byte, with at most the §4.1 transcode set applied at ingest. The façade never re-encodes as a side effect of relaying.
- **Conversation-control events** (barge-in/interruption, turn detection, playback markers, tool calls mid-stream): **pass through provider-native, unnormalized.** These semantics differ per provider in ways callers depend on; translating them silently changes behaviour — the provider-quirk-parity concern from #1146, amplified. A façade that normalizes these is making product decisions it has no consumer evidence for.

### 4.4 Session lifecycle

For the tunnel/relay shape (§6.2) and any later WS façade:

- A realtime session is **its own object, not an OpenCode session part**: created by an explicit setup call, identified by a façade session id, bound to one resolved provider/model ref + route, and terminated independently. Attaching live audio to a chat session (as a part or side channel) is a client product decision layered on top, not a façade property.
- Limits, bounded by default (#1127): idle timeout (no media and no control traffic) and a hard max duration per session, both config values with shipped defaults (proposal: 5 min idle, 60 min max), enforced by the façade closing the connection with a typed close reason.
- **Reconnect = restart, not resume.** No inventoried provider offers resumable duplex sessions with replay guarantees; a dropped connection ends the façade session, usage is finalized (§4.6), and the client starts a new session. The design explicitly does not promise resumption semantics no provider underneath can honour.
- Retention: the façade records no audio (the #1678 default-discard posture, extended to streams). Transcript text, if the client keeps it, is the client's/session's business, not the façade's.

### 4.5 Ephemeral credentials and key handling

The façade rule survives contact with realtime, in the exact form the providers already use:

- Long-lived provider keys never leave the server (registration/facade-layer ownership, as in the chat and STT designs).
- For client-direct media (relay model): the façade's setup endpoint authenticates the caller with existing server auth, resolves the route/provider, mints a **short-lived ephemeral credential** from the provider (or a façade-signed token where the provider supports delegated tokens), and returns it with the provider endpoint + session config. TTL is minutes, scope is the single session, and the credential cannot be renewed by the client — renewal is a new setup call.
- For façade-relayed media (WS model): the client holds only its server auth; the façade opens the provider connection with the long-lived key server-side. The client never sees any provider credential, ephemeral or otherwise.

### 4.6 Accounting for long sessions

`route_attempt` discipline, adapted to duration-based work (extending the embeddings/STT convention):

- One `route_attempt` row per realtime session, opened at setup with `session_id` NULL (façade convention) and the resolved route/ref recorded as in the other façade designs.
- The row is **finalized at session end** (clean close, error, or façade-enforced limit) with duration seconds and the provider-reported usage (the `MediaUsage` tagged union already models seconds- and token-billed media). A crashed façade must not leave rows unfinalized forever: a sweeper finalizes rows older than the hard max duration with a `finalized_by_timeout` marker — an honest incomplete record, not a fabricated usage number.
- Mid-session usage snapshots (for quota demotion visibility on very long sessions) are explicitly **not** in the first-step scope; demotion operates at session granularity, as route selection only happens at setup anyway.

### 4.7 Backpressure and errors

- WS relay: bounded per-session queues in both directions; a slow consumer sheds **audio first** (drop oldest media frames, count and surface the drops as a session event) and never sheds control events — blocking a duplex socket on a slow client stalls the provider session and corrupts turn-taking for everyone. Queue overflow on control traffic closes the session with a typed reason.
- Error mapping reuses the façade envelope for setup (HTTP) and a single normalized `error` close/event shape on the socket carrying `{ code, message }` with the §2.4-style codes from the STT design; provider-native error payloads pass through alongside under `provider_error`, never instead of the normalized code.

### 4.8 Client needs — stated honestly

- **OpenChamber** (web/app media stack): the realistic first client. Browser media capture/playback, echo cancellation, and WebRTC are native to the platform; the relay model (§6.2) needs only a setup call + the provider's client SDK pattern.
- **OpenCode TUI:** terminal audio is the least-charted part, as #1680 anticipated. A terminal process has no standard microphone/playback API; capture/playback would depend on OS-level tools or native helpers per platform, barge-in UX in a text UI is unproven, and there is no in-repo precedent beyond attention-sound playback. **The design does not commit the TUI to realtime audio.** If voice conversation ships, it ships OpenChamber-first; the TUI's voice story remains the #1678 composer-draft transcription flow.

## 5. Demand evidence — the deciding input

#1680 instructs the inventory to surface actual demand before the design picks. It did not surface any:

- No in-repo consumer (§1): no issue, PR, integration, or client feature waits on realtime audio.
- The concrete custom-format cases #1680 asks to collect ("what Drew has hit") are not yet collected anywhere in the repo — the telephony/μ-law case is real in the industry inventory (§3) but is not tied to a fleet endpoint today.
- The adjacent, bounded voice need that *does* exist is already covered by the #1678 design (transcription into the composer), which is request/response and ships without any of this machinery.

Building a normalized duplex façade now would mean choosing transports, grammars, and lifecycle semantics for consumers who have not stated requirements — the exact failure the exploratory framing of #1680 exists to prevent.

## 6. Conclusion and recommended path

### 6.1 Conclusion: not-yet (normalized façade), tunnel-only (first step, when triggered)

- **No normalized realtime façade is designed for implementation now.** The provider field is too divergent (§2) and demand is unproven (§5). This section is the evidence-backed `not-yet` outcome #1680 explicitly permits.
- **The trigger to revisit** is concrete: a named consumer (a fleet endpoint emitting custom-format audio, a telephony bridge, or a committed OpenChamber voice-conversation feature) with its format/transport requirements stated. On that trigger, the first implementation step is the tunnel below — not a grammar translation layer.

### 6.2 The tunnel (first step, sketched to the depth the evidence supports)

1. `POST /v1/realtime/sessions` (working name) on the OpenCode server: existing server auth in; body names a concrete `provider/model` ref or route name (chat selection machinery, as in every façade design here) plus requested provider session config passed through opaquely.
2. The façade resolves the registration, mints the ephemeral credential server-side (§4.5), creates the accounting row (§4.6), and returns `{ session_id, provider_endpoint, ephemeral_credential, expires_at, session_config_echo }`.
3. Media flows client↔provider directly (WS or WebRTC per the provider). The façade is not in the media path, applies no normalization beyond setup, and finalizes accounting on expiry/close notification.
4. Custom-format reception (§4.1) is implemented independently of the tunnel, as part of the bounded-audio surfaces (#1678 follow-ups), because its consumers are request/response-shaped and already specified.

### 6.3 What is settled regardless

§4.1 (format policy), §4.5 (key handling), and §4.6 (accounting shape) are designed to be adopted as standing façade policy even while the realtime build is deferred — they constrain the bounded-audio work already in flight and prevent a future realtime implementation from re-litigating them.

## 7. Open questions left open (deliberately)

- Which provider's realtime shape a first consumer needs — unknowable until the consumer exists (§5).
- Whether barge-in semantics can ever survive normalization — deferred with the normalization itself (§4.3).
- Whether live audio ever belongs inside an OpenCode chat session vs as a standalone session object — the design's default is standalone (§4.4); a session-product decision belongs to the consumer's feature design, not this façade inventory.

## 8. Implementation split (only on adoption of a trigger, §6.1)

1. Standing-policy adoption: §4.1/§4.5/§4.6 noted on #1146 (no code).
2. On a named consumer: tunnel setup endpoint + ephemeral minting + accounting finalization (§6.2), one provider only.
3. OpenChamber client integration for that consumer.
4. Only with a second, differently-shaped consumer: revisit per-capability normalization (§4.3) with two real grammars to compare.

#1680 stays open until Drew adopts, amends, or rejects this conclusion; the inventory (§2–§3) remains the reference for the revisit trigger whoever picks it up.
