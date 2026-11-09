# Image and video generation behind the OpenCode façade — design

- Status: draft for adoption review
- Date: 2026-11-08T06:07:32Z
- Issue: [#1679](https://github.com/developing-today-forks/opencode/issues/1679)
- Parent design: [Generic OpenAI façades on the server](./2026-11-01T04-10-00Z_design_openai-facades.md)

## Intent

Extend the existing OpenAI-shaped server façade with image and video generation.
Callers select a concrete provider/model or a configured route, use one stable API,
and receive generated media through OpenCode-owned artifact delivery. The façade
owns provider registration, capability and config gates, credential acquisition and
refresh, job state, provenance, and accounting. Provider-specific request and
response differences stay behind adapters.

This is a design only. It does not add runtime endpoints, provider credentials,
renderers, or OpenChamber UI. It complements the shared authentication, model
selection, and `route_attempt` direction in the parent design; it does not create a
second routing policy or session runner.

## Goals and non-goals

Goals:

- Define image and video endpoint shapes that fit the existing `/v1` façade and its
  `provider/model` and route selectors.
- Give long-running generation a durable, pollable, cancellable job lifecycle, with
  optional streaming status updates.
- Keep provider enablement and credentials under server-side configuration and
  provider adapters; never require a key in a client request.
- Deliver media as durable, authenticated artifacts that can be previewed or
  explicitly attached to a session.
- Specify OpenCode TUI and OpenChamber viewing, supported formats, provenance, and
  accounting behavior before implementation is split into follow-up tasks.

Non-goals:

- Implementing generation providers, routes, storage, or UI in this change.
- Creating hidden sessions for façade requests or adding generated output to a
  transcript without an explicit user action.
- Replacing the existing chat/responses façade or changing its selection policy.
- Accepting arbitrary remote URLs as media input in the first implementation.
- Promising byte-identical outputs across providers or transparent provider-specific
  features that have no common representation.

## Placement and shared policy

Generation is another operation of the existing server façade, not a sidecar process.
Protocol declarations and handlers live beside the current façade endpoints; core
owns the provider adapters, job orchestration, artifact metadata, and accounting
boundary. Reuse the existing server authentication and model resolver. A generation
request does not create a session. Its `route_attempt.session_id` is NULL unless a
future, explicitly defined session-originated operation opts into attribution.

The resolver remains the source of route order, weights, provider disablement,
windows, and failover. The generation registry supplies an additional capability
filter: a candidate must both resolve under the requested model/route and advertise
the operation and options the request needs. If no candidate is usable, return a
normal façade error; do not silently fall back to chat or to an unrelated provider.

## API surface

The initial surface is deliberately a small, documented subset. Unknown fields are
not forwarded to providers. Provider-specific extensions are enabled only through
the server-side adapter/configuration, not arbitrary request pass-through.

| Method and path | Contract |
| --- | --- |
| `POST /v1/images/generations` | Accept an image prompt and return an OpenAI-shaped image result after generation completes. Results reference OpenCode artifact IDs and authenticated content URLs; `b64_json` may be offered for compatibility but is not the large-file path. |
| `POST /v1/videos` | Accept a video-generation request and return a durable job ID with its initial status. Use multipart input for uploaded reference media, or a file ID for an existing OpenCode artifact. |
| `GET /v1/videos/{id}` | Return the normalized video job state and, when complete, its artifact metadata and content URL. |
| `GET /v1/videos/{id}/content` | Stream the completed video bytes with range support. |
| `DELETE /v1/videos/{id}` | Request cancellation. Cancellation is best-effort once the provider has started rendering. |
| `GET /v1/videos/{id}/events` | OpenCode extension: stream ordered status changes as SSE. Polling remains the baseline and works when streaming is unavailable. |
| `GET /v1/files/{id}/content` | Authenticated content delivery for generated or uploaded artifacts, including images and video. |

The video paths follow the familiar asynchronous create/status/content shape. The
events endpoint is an additive OpenCode extension; it must not change polling
semantics. Image generation remains a synchronous façade response for callers that
expect one. Internally it may use the same job and artifact records, but it returns
only after a terminal result or a mapped error. If image providers later need
long-running jobs, add a versioned image job contract rather than returning an
undocumented response shape from the synchronous endpoint.

### Request and selection shape

Both operations take `model` and `prompt`. The image subset includes `n`, `size`,
`quality`, and `output_format`; the video subset includes duration, output size, and
an optional reference artifact. Provider adapters declare supported values and
limits. The façade validates the common schema before resolving a provider, then
validates adapter-specific constraints at the adapter boundary.

`model` accepts the same selectors as the parent façade:

- A concrete `provider/model` reference selects that model, subject to its
  generation capability and configured provider state.
- A configured route name, bare or `opencode-route/<route-id>`, uses the shared
  resolver's candidate order and failover rules. Generation capability is checked
  per candidate, so an incompatible candidate is skipped without inventing a new
  route policy.

The returned provenance distinguishes the requested selector from the resolved
provider/model. Unknown models, disabled providers, unsupported capabilities, and
empty routes produce explicit errors instead of silently selecting a default.

## Provider registry, configuration, and credentials

Add an internal generation-provider registry alongside the façade's existing
provider machinery. Each adapter declares a stable provider ID, supported operation
and media formats, accepted options and limits, whether it supports asynchronous
jobs, status polling, cancellation, idempotency, and usage/cost reporting. Adapters
translate between the normalized request/result and provider APIs; handlers do not
contain provider-specific branches.

Generation has an explicit configuration gate, disabled unless at least one
provider is enabled by server configuration. Each configured provider can be enabled
or disabled independently and advertises only capabilities available to that
installation. Route configuration can name generation-capable models, but a route
does not make an unconfigured provider available. The exact config key and schema
are implementation follow-up decisions; the design requires a location-scoped,
validated configuration surface consistent with the existing resolver.

The façade/provider-adapter layer owns credential registration, lookup, and renewal
for generation calls. It delegates secure persistence to the existing credential
service where possible; providers with a distinct generation credential flow may
register an adapter-owned refresh operation with that service. Credentials are
resolved just in time and passed only to the adapter. They are never accepted in
request bodies, returned in responses, stored in job/artifact metadata, or written
to logs. A failed renewal maps to an authentication/provider error and does not
retry with a stale secret.

## Job lifecycle and persistence

Video generation is asynchronous. The normalized states are:

`queued` → `running` → `finalizing` → `completed`

with terminal alternatives `failed`, `cancelled`, and `expired`; a cancellation
request may first expose `cancelling`. State transitions are monotonic, timestamped,
and persisted before they are sent to pollers or SSE subscribers. Provider-specific
states are retained only as bounded diagnostic metadata and are not the public
contract.

On accepted submission, persist an opaque job ID, operation, requested selector,
resolved provider/model when known, status, timestamps, expiry, optional
idempotency-key hash, provider job reference, and artifact IDs. Store only the
minimum request metadata needed to poll, cancel, reconcile, and explain the result.
Do not persist raw credentials or duplicate the prompt into logs. The provider's
job ID is never exposed as the public ID.

Use a durable job record and an artifact record in the server's existing database
and storage boundary. A process restart resumes polling jobs whose adapters support
safe reconciliation. If submission may have reached a provider but no provider job
reference was durably recorded, mark the job `failed`/`interrupted` with an
ambiguous-submission error; do not blindly resubmit and risk a duplicate charge.
Provider idempotency keys are derived from the durable job ID where supported.

`Idempotency-Key` on submission prevents duplicate job creation for a retry of the
same request within the retention window. A repeated key with a different request
returns a conflict. The key is stored hashed, not as a log field. Provider retry and
failover happen only when the adapter classifies the failure as retryable and the
operation is safe to retry; each actual attempt is accounted for separately.

The proposed default retention is 24 hours for job status and generated artifacts,
configurable by the server owner within a bounded range. Expiry removes both
metadata and bytes, except for minimal accounting/provenance rows required by the
existing retention policy. Cleanup is opportunistic on reads plus the existing
database/storage sweep; generation does not add a perpetual daemon. The exact TTL
and quota/size defaults are open for adoption review.

### Polling, events, and cancellation

`GET /v1/videos/{id}` is authoritative and returns the latest persisted state,
progress when the provider reports it, timestamps, and a result only after
completion. Polling is rate-limited and does not create a new generation attempt.
SSE events carry the same state snapshots with monotonic event IDs, support reconnect
from the last event ID while retained, and terminate on a terminal state. Clients
must tolerate missing progress percentages.

`DELETE` records a cancellation request first, then calls the adapter if the
provider supports cancellation. Return the observed state: `cancelled` only after
confirmation; otherwise keep `cancelling` or report that rendering completed before
the request. Cancellation does not delete already-created artifacts unless the
caller separately deletes them or their retention expires. Polls and cancellation
are job-control events; if a provider bills for them, that charge is still recorded
with the job's accounting correlation.

## Errors

Map validation and façade errors to the parent design's OpenAI error envelope.
Invalid common input is `400`; unsupported media or operation is `400` with a stable
code; unknown model/job is `404`; a conflicting idempotency key is `409`; a provider
quota/rate limit is `429`; credential failure is `401` or `502` according to whether
the credential is rejected locally or upstream; provider unavailability is `502` or
`503`. A failed asynchronous job retains a stable error code and safe message in its
status response. Provider bodies, prompt text, credentials, and local file paths are
not copied into public errors. Preserve provider retry hints when safe, as the
parent design requires.

## Artifacts, delivery, and session attachments

Generated bytes are stored behind an artifact service, not in the job row, route
ledger, or session transcript. Each opaque artifact ID maps to a server-controlled
object and metadata: media type, byte length, digest, dimensions or duration where
known, creation/expiry timestamps, job ID, requested selector, resolved
provider/model, and format. Never expose an arbitrary filesystem path as an
artifact ID. The store validates an allowlist of media types and enforces byte and
duration limits before publishing an artifact.

Content URLs are authenticated routes on the same server. They do not embed API
keys or bearer tokens. Content responses set the verified media type, length,
ETag, and safe disposition; video delivery supports byte ranges for seeking. The
server checks artifact ownership/location and expiry on every read. `url` in an
image response points at this route; optional base64 output is bounded and must not
be used for video or large images.

Generation remains sessionless. To attach an output to a session, the client
performs an explicit attach action using the artifact ID. The server resolves that
ID into the existing file-attachment input model after checking location access and
retention; it does not inject a synthetic message or session reference during
generation. This keeps the current prompt/file attachment semantics and makes the
user-visible action auditable. A generated artifact can be downloaded or attached
without exposing its storage path.

For video reference input, accept a bounded multipart upload or an artifact ID that
the authenticated caller can read. Do not fetch caller-supplied arbitrary URLs in
the first implementation; that would create an SSRF and credential-forwarding
boundary unrelated to the generation provider. Any future URL import must be a
separate, explicitly reviewed feature.

## TUI and OpenChamber viewing

### OpenCode TUI

The TUI downloads or streams the artifact through the authenticated server API and
uses the renderer's terminal capability interface to decide whether to display
images inline with the Kitty graphics protocol. Do not infer graphics support from
one environment variable alone. Capability discovery must be scoped to an
interactive terminal, bounded in time, and must not emit probe/control bytes into
logs or non-terminal output. A user override may disable inline rendering.

When Kitty graphics are unavailable, generation still succeeds: show the prompt,
media type, and a durable local cache path or authenticated download action. Do not
print raw binary or silently drop the output. Video playback is not a Kitty-image
feature; use the supported local viewer/open action and keep the artifact path
available as fallback. Cache cleanup follows artifact expiry and local storage
limits, not the server job lifetime alone.

### OpenChamber

OpenChamber consumes the same artifact metadata and authenticated content route.
Its native viewer supports still images, animated GIF, and video playback with
controls, seeking where byte ranges are available, and a download fallback for
unsupported formats. Load media lazily, enforce size/duration limits, and do not
autoplay video with sound. Display provenance (job, requested route/model, resolved
provider/model, creation time) without exposing prompts or credentials by default.
Viewer availability is a client capability, not a server-side provider-selection
condition.

## Formats and provenance

The initial common read/display set is PNG, JPEG, WebP, GIF, and MP4; each adapter
declares which formats it can produce. The server records the verified content type
and rejects a mismatch between provider metadata, file signature, and allowed
format. Keep original bytes by default; transcoding is a separate capability with
explicit CPU, quality, and provenance costs. An adapter that returns an unsupported
format must fail the job safely rather than publishing mislabeled bytes.

Provenance is attached to the job and artifacts: operation, requested model/route,
resolved provider/model, provider request/job correlation IDs where safe, creation
time, supported generation parameters, output format, and the corresponding
accounting attempt IDs. Store a digest of sensitive prompt input only if needed for
idempotency or audit; do not retain prompt text in provenance by default. Never
store credentials or unfiltered provider response bodies.

## Accounting: one route ledger

Every billable provider generation attempt uses the same `ModelRouteLog` observer
and `route_attempt` ledger as chat, responses, and embeddings. Direct façade calls
have a NULL session ID; route calls retain the requested route ID. A retry or
failover creates a distinct attempt row, including failed attempts, so usage and
cost do not disappear behind the final result.

Generation has units that are not token counts. Extend the ledger/read model with
an operation kind, generation-job correlation, and typed billable units (for
example image count or video seconds) and actual/estimated cost where the provider
reports it. Do not synthesize token counts for image/video work. If provider usage
is unavailable, record the attempt and mark usage/cost unknown rather than zero.
Provider status/cancel calls are persisted as job events; if one is billable, link
its cost to the job and route attempt. Non-billable polls do not create generation
usage rows. Existing usage and cost queries must distinguish operation kinds while
still aggregating their spend and route/provider attribution consistently.

## Delivery sequence after adoption

Split implementation into independently reviewable follow-ups, with the shared job
contract and accounting before provider breadth:

1. Define protocol schemas, config gate, generation registry, job/artifact storage,
   and route-attempt extensions; add contract tests for selectors, state transitions,
   expiry, and error mapping.
2. Add one image provider adapter and synchronous `/v1/images/generations` path;
   prove artifact delivery, provenance, idempotency, and accounting end to end.
3. Add asynchronous video submission, status, content/range delivery, cancellation,
   restart reconciliation, and SSE events; test duplicate submissions and ambiguous
   provider acceptance.
4. Add OpenCode TUI artifact attachment, Kitty capability rendering, and path
   fallback; test both capable and incapable terminals without changing server
   output semantics.
5. Add OpenChamber image/GIF/video viewing and download fallback; test authenticated
   access, expiry, large files, and unsupported formats.
6. Add additional adapters only after each declares capabilities, credential
   refresh behavior, retry/idempotency policy, supported formats, and usage model.

No follow-up should implement all providers and both clients in one PR. Each provider
and client integration is gated on the shared contracts and accounting tests.

## Acceptance and adoption questions

The implementation is ready to split when review accepts these invariants:

- Generation uses the shared resolver and server auth; a route cannot select a
  disabled or generation-incompatible candidate.
- Video jobs survive restart without accidental duplicate submission, expose
  monotonic poll/SSE states, and have a bounded cancellation/expiry story.
- Generated bytes are accessed only through opaque, authenticated, expiring artifact
  IDs; explicit attachment is required to put them into a session.
- TUI capability fallback and OpenChamber viewing are clients of the artifact
  contract, not additional generation/provider logic.
- Every billable generation attempt is represented in the shared route ledger with
  non-token units and traceable job provenance.

Review should settle the exact generation config key, initial provider set, default
job/artifact TTL and quotas, whether image generation ever needs an exposed async
contract, and the precise image/video parameter subset. Those are adoption decisions,
not reasons to begin runtime implementation in this design PR.
