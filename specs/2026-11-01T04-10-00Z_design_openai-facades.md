# Generic OpenAI façades on the server — design

- Status: draft
- Date: 2026-11-01T04:10:00Z
- Roadmap item: "Generic OpenAI façades on the server" (Routing, cost and plans)
- Issues: [#1146](https://github.com/developing-today/opencode/issues/1146) (this design); implementation issues are filed per §11 and linked from #1146.

## Intent

Drew's direction (2026-10-31, main chat, issued as #1146): instead of the growing set of
bespoke proxy doors in `developing-today/code` `bin/`, OpenCode itself exposes a generic
OpenAI-compatible API once — both `/v1/chat/completions` and `/v1/responses` — and
translates into its internal provider machinery. External callers then point at OpenCode
like any OpenAI endpoint, and the doors retire behind it.

What callers see today (verified 2026-11-01):

- Routing/selection policy exists twice. The fork's internal resolver
  (`packages/core/src/model-resolver.ts`, `packages/core/src/model-route.ts`) serves
  session traffic, while `bin/opencode-route-proxy.mjs` in developing-today/code
  (port 18750) re-implements the same selection for door traffic: it reads the same
  `opencode.jsonc` (`model_routes` + provider blocks) and the same credential store
  (`opencode.db`), and applies quota demotion read back from the `route_attempt`
  ledger with constants hardcoded in the proxy (`DEMOTE_THRESHOLD = 3`,
  `DEMOTE_WINDOW_MS = 4h`, lines 86–87).
- Around it sit per-program doors on ports 18742–18749 (clef, agy, codex,
  antigravity-ls, design-code, muse, commandcode, claude-code), each a partial
  translator between OpenAI shapes and one program's CLI or API.
- The same doors are also *backends*: the code repo's `.opencode/opencode.jsonc`
  points provider `baseURL`s at `http://127.0.0.1:18743–18749/v1`, so session traffic
  already reaches the programs through them. A door therefore has two faces — a
  caller-facing endpoint and a provider backend — and they retire on different
  schedules (§8). Conflating them is the main migration risk this design exists to
  manage.

## Design

### 1. Placement and isolation (fork-maintenance rule)

All façade code lives in one new module, `packages/core/src/openai-facade/`, with the
HTTP surface declared in one new protocol group and one new handler file under
`packages/server/src/handlers/`. Touch points into existing code are exactly three:

1. Registration in `packages/server/src/routes.ts` / `api.ts` (one group, one handler).
2. The model-call path of §3 (existing services, no changes to their semantics).
3. The demotion config wiring of §6 (one `configure` call at config load).

Nothing in the session runner changes. Upstream merges should conflict, at worst, in
the registration lines.

### 2. Façade surface

Base: the existing OpenCode server (same host/port, same `ServerAuth` —
`packages/server/src/auth.ts`: server password as HTTP Basic or bearer-style API key;
pairing session tokens accepted anywhere the password is). Tailnet/localhost only for
now; per-caller keys are a stretch goal (§12).

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat-completions request in, chat-completions response out. `stream: true` yields `chat.completion.chunk` SSE ending in `data: [DONE]`. |
| `POST /v1/responses` | OpenAI Responses request in, Responses response out. `stream: true` yields the `response.*` event grammar (§5). Supports `previous_response_id` (§4). |
| `GET /v1/models` | The union callers can actually use: every concrete `provider/model` ref the catalog exposes (subject to `disabled_providers`) plus one entry per route, id `opencode-route/<route-id>` — the form route-proxy callers already use. |
| `GET /health` | The server's existing health route; no new endpoint. |

The `model` field accepts both forms:

- A concrete ref `provider/model` (pass-through: catalogs carry every model a provider
  allows; the only gates are config — `disabled_providers`, route windows).
- A route name, either bare (`terra-plan`, as door callers send it today) or in the
  stored ref form `opencode-route/terra-plan`. A bare name that matches a configured
  route id resolves as a route; otherwise it is treated as a model id under the
  default provider rules and fails with the OpenAI-shaped `model_not_found` error if
  nothing matches. Ambiguity (a route id equal to a provider/model tail) resolves to
  the route — that is the behaviour route-proxy callers depend on.

Request translation (both façades): OpenAI message/item arrays become the internal
`Message` list used by `LLM.request` (`@opencode/ai`); generation options
(`temperature`, `top_p`, `max_output_tokens`/`max_tokens`, `stop`, `tools`,
`tool_choice`, `reasoning.effort`) map onto `GenerationOptions` exactly as
`packages/core/src/session/model-request.ts` maps them for sessions, so a façade call
and a session call with the same inputs produce the same provider request. Unknown
fields are ignored, never forwarded blindly; provider-specific pass-through is only
via the existing provider `options` in config, never per-request.

Response translation: internal LLM events become OpenAI shapes, including `usage`
(input/output/total tokens, reasoning tokens where the provider reports them) on the
final chunk/event — callers such as OpenClaw do accounting from these fields, so a
stream that omits usage is a parity failure (§9).

Errors: OpenAI error envelope (`{error: {message, type, code}}`) with the usual status
mapping — 400 invalid request, 401 unauthenticated, 404 unknown model/route/response,
429 quota/rate-limit (with the provider's reset hint preserved in the message),
502/503 upstream failure or no route candidate available. A quota failure must look
like what the doors return today, because caller retry logic keys on it.

### 3. The call path — no session, same machinery

The façade is routing-only, like the route proxy it replaces: no session is created,
no agent loop runs, no tools execute server-side (tool *calls* are translated and
returned to the caller, who owns its loop).

Implementation reuses the stateless precedent that already exists in the codebase:
`packages/core/src/generate.ts` (`Generate.text`) resolves a model through the
resolver and calls `LLMClient.generate(LLM.request({...}))` with a synthetic
`x-opencode-session` header and no stored session. The façade path is the streaming
sibling of that precedent:

1. Resolve: `SessionRunnerModel` / `ModelResolver` resolution of the requested ref or
   route — ordered/weighted/round-robin selection, variant remaps, disabled-provider
   skipping, window gates, quota demotion — unchanged semantics.
2. Call: the resolved model's `LLMRequest` runs through the same LLM client layer the
   session runner uses, wrapped in `ModelRouteLog.observer(...)` exactly as
   `packages/core/src/session/generate.ts` wraps session generation, so rate-limit
   snapshots feed `ModelRoute.observeRateLimit` identically.
3. Failover: on a retryable failure the resolver's next candidate is tried, as the
   route proxy walks its candidate order today; hedging/races keep session semantics
   (the façade does not invent a second policy).

### 4. Responses statefulness — the item store

Chat completions is stateless. Responses is not: clients chain with
`previous_response_id`, omit resending input items, and expect the server to remember
the prior turn's items. Emulation over stateless provider calls:

- **Store.** A new table `openai_facade_response` in the server database (migration in
  the façade module, following the `model-route-log/sql.ts` pattern): `id` (the
  `resp_…` id returned to the caller), `created_at`, `expires_at`, `model` (the
  *requested* ref/route string), `resolved_model` (concrete ref that served it),
  `request_items` and `response_items` (JSON, the full normalized item list after this
  turn), `usage` totals. One row per response; a chain is a linked list via
  `previous_response_id` stored on the row.
- **Chain resolution.** On `previous_response_id`, the façade loads the chain
  (bounded: at most 64 links, then 400 asking the client to resend full input — the
  same failure a real Responses server gives for an expired chain), concatenates the
  stored items with the new input items, and makes one stateless provider call.
  Function-call outputs are matched to their call items by `call_id` during this
  reconstruction; an unmatched output is a 400, not a silent drop.
- **TTL / eviction.** Rows expire 24h after creation (configurable, §6); expired rows
  are deleted opportunistically on read and by the existing database sweep cadence —
  no new daemon. An expired `previous_response_id` returns 404 `response_not_found`,
  matching OpenAI behaviour, so clients fall back to full resend.
- **No session leakage.** Façade responses never appear in session tables; the store
  is façade-private. Session ids and response ids are different namespaces and are
  never interchangeable.

### 5. Streaming grammar

Responses streaming is an event grammar, not chunks. The façade emits, in order:
`response.created` → `response.in_progress` → per output item:
`response.output_item.added`, then content events
(`response.output_text.delta` / `response.reasoning_summary_text.delta` /
`response.function_call_arguments.delta` as applicable), the matching `*.done`
events, `response.output_item.done` → finally `response.completed` carrying the full
response object including usage. Sequence numbers are monotonic per stream.
Chat-completions streaming emits standard chunks with a final usage-bearing chunk
when `stream_options.include_usage` is set (and, for parity with the doors, also when
it is not — door callers already rely on it; see §9 parity tests).

Fidelity rules: reasoning items surface as reasoning items, never flattened into
visible text; tool calls surface as tool calls with arguments assembled from the
provider's deltas, never executed; a mid-stream provider failure terminates the
stream with the façade's error event (`response.failed` / SSE `error`) — never a
clean completion carrying partial output (the agy door's failure semantics, kept).

### 6. Demotion policy becomes config

Today the same policy lives in two places with the same numbers: the route proxy's
hardcoded `DEMOTE_THRESHOLD = 3` / `DEMOTE_WINDOW_MS = 4h`, and the fork's in-process
defaults (`ModelRoute.Settings.quota = { demoteAfter: 3, windowMs: 4 * 3_600_000 }`,
`packages/core/src/model-route.ts`, settable only through `ModelRoute.configure(...)`,
which config loading does not currently call).

Design: one config surface, both consumers.

```jsonc
// opencode.jsonc — under experimental.model_routes, beside the route definitions
"experimental": {
  "model_routes": { "…": "…" },
  "model_route_demotion": {
    "threshold": 3,        // quota failures that demote a target
    "window_ms": 14400000  // rolling window they must fall in (4h)
  }
}
```

- Schema: a new optional `model_route_demotion` block in
  `packages/schema/src/config/experimental.ts` (fields optional; defaults 3 and
  14_400_000 — today's values, so an unconfigured fleet behaves exactly as now).
- Wiring: the model-routes config plugin
  (`packages/core/src/config/plugin/model-routes.ts`) passes the parsed values to
  `ModelRoute.configure({ quota: { demoteAfter: threshold, windowMs: window_ms } })`
  at load, alongside its existing `ModelRouteLog` wiring.
- Source of truth for counts: the `route_attempt` ledger (durable, shared), not the
  proxy's private SQL and not only the in-process map. Session traffic already lands
  there; façade traffic lands there (§7); the resolver's demotion read is backed by
  the ledger counts within the configured window, with the in-process map kept as a
  hot cache. The route proxy's SQL copy is deleted when the proxy retires (§10) —
  until then it reads the same ledger with the same numbers, so the interim state has
  duplicated *code* but not duplicated *policy values*.

### 7. Accounting — one ledger

Every façade attempt (each candidate tried, not just the winner) is written to
`route_attempt` through the same `ModelRouteLog` record/observer path as session
attempts, with `session_id` NULL — the convention the route proxy already uses and
the ledger already permits (`session_id` is a nullable join key in
`packages/core/src/model-route-log/sql.ts`). Quota accounting, demotion, route
review, and cost reporting then see door + façade + session traffic uniformly, which
is acceptance point 3 of #1146. Façade rows carry the requested route id in
`route_id` when a route was named, so route-level reporting does not change shape.

### 8. The doors — two faces, two retirements

Each door is inventoried with both faces. "Front retires" = external callers repoint
to the façade; the door process may still run as a provider backend. "Backend
retires" = a native provider path (or the façade calling the program's API directly)
replaces the CLI bridge — a separate, later decision per door, not implied by this
design.

| Door (code `bin/`) | Port | Front (caller-facing shape) | Backend (what sits behind it) | Quirk summary (§9) |
| --- | --- | --- | --- | --- |
| `opencode-route-proxy.mjs` | 18750 | `/v1/chat/completions`, `/v1/models`; route names as models | The fork resolver re-implemented in JS; credential store reads | Routing-only; demotion from ledger SQL. This door's front *is* the façade's job — it retires first and wholly. |
| `codex-proxy.mjs` | 18744 | `/v1/chat/completions`, `/v1/models` | Muse subprocess; also the `openai-codex` + `chatgpt` providers' baseURL | CLI session semantics; responses upstream shape translated to chat. |
| `clef-proxy.mjs` | 18742 | `/v1/models`, `/v1/systemone` (+ `/systemone`) | Cloudflare AI gateway | Non-standard `/systemone` path shape alongside `/v1`. |
| `agy-proxy.mjs` | 18743 | `/v1/chat/completions`, `/v1/models` | Antigravity CLI, resident warm workers | Server-side conversation state keyed by session hints (§9). |
| `antigravity-ls-proxy.mjs` | 18745 | `/v1/chat/completions`, `/v1/models` | Antigravity language server | LS process lifecycle; design-code chains into it. |
| `design-code-proxy.mjs` | 18746 | `/v1/chat/completions`, `/v1/models` | Virtual design personas routing to codex/antigravity-ls doors + AMR upstream | Invented model ids, injected system prompt (§9). |
| `muse-proxy.mjs` | 18747 | `/v1/chat/completions`, `/v1/responses`, `/v1/models` | Meta Muse: direct Responses API (minted key), warm `muse serve`, CLI exec fallback | Client-attestation behaviour (§9) — the quirk that must not be normalized away. |
| `commandcode-proxy.mjs` | 18748 | `/v1/chat/completions`, `/v1/models` | CommandCode CLI (hosted API rejects the current plan) | CLI-only access; resident ACP sessions (§9). |
| `claude-code-proxy.mjs` | 18749 | `/v1/chat/completions`, `/v1/models` | Claude Code CLI, one persistent stream-json process per conversation | Warm per-conversation processes; newest-turn-only sends. |

Consumers to repoint, per door (migration checklist, §10): (a) the code repo's
`.opencode/opencode.jsonc` provider blocks — these are *backend* uses and do **not**
move in the front migration; (b) OpenClaw's `models.providers` (the route proxy's
named consumer); (c) any direct external caller of a door port (deploy/supervisor
configs in developing-today/code name the doors; each is grepped and listed in the
per-door migration issue before its door is touched).

### 9. Per-door quirk catalog (parity contract)

The façade must preserve, or explicitly re-home, each behaviour callers depend on.
"Preserve" means a parity test (§10) pins it before the door's front retires.

1. **Muse / Meta attestation (muse-proxy).** The direct Meta path rejects requests
   whose tool list contains a tool named `shell` or `bash` with 403
   `client_attestation_denied` (verified live 2026-10-30, muse-proxy lines ~1052,
   ~1370); the proxy detects that 403 and falls back to the CLI door instead of
   surfacing it. Façade rule: translation must not rename, drop, or synthesize tool
   names; an attestation 403 from the muse provider is a provider failure eligible
   for route failover, never silently retried against the same target, and the
   façade must not strip the offending tools to make the call pass — callers
   configured those tools deliberately.
2. **Warm conversation doors (agy, claude-code, commandcode, muse warm path).**
   These doors hold server-side conversation state: callers may send only the newest
   user turn and rely on the door's resident process for history (agy keys workers by
   explicit id / `user:` / first-message hash; commandcode maps conversations to ACP
   threads; claude-code keeps one stream-json process per conversation). Façade rule:
   the façade is stateless per request for chat completions — a caller that relied on
   door-side history must send full history or use `/v1/responses` with
   `previous_response_id` (§4). This is a *documented behaviour change*, called out
   in each affected door's migration issue; it is the one place parity is knowingly
   not preserved, because reproducing per-door session-key heuristics in the façade
   would rebuild the doors inside the server.
3. **Design-code virtual models.** design-code's model ids are invented personas
   (curated primary/fallback recipes + an injected design system prompt), not
   upstream models. Façade rule: personas are expressed as *routes* in
   `model_routes` config (the recipe) plus the system prompt supplied by the caller
   or an agent definition — the façade does not grow a persona concept. The door's
   front retires only after its persona ids exist as route names.
4. **CommandCode plan gate.** The hosted CommandCode API rejects the current plan;
   the CLI is the only working route. Backend retirement for this door is blocked on
   a plan/API change, not on façade work — recorded so nobody schedules it.
5. **Clef `/systemone` shape.** Clef's front serves a non-`/v1` path in addition to
   `/v1/...`. Façade rule: no non-`/v1` aliases are added; clef front callers move to
   `/v1/chat/completions` against the gateway provider directly or via the façade.
6. **Codex responses translation.** The codex door translates between chat
   completions (front) and the Codex responses-shaped upstream/CLI. Façade rule:
   `/v1/responses` callers targeting codex-backed models get the §5 grammar from the
   façade's own translation layer — one implementation, tested once — instead of
   per-door variants.
7. **Route-proxy routing semantics.** Route names as `model`, candidate order
   walking on failure, `session_id` NULL ledger rows, demotion from ledger counts —
   all preserved by construction (§§2, 3, 6, 7) and pinned by parity tests against
   the still-running proxy before it retires.

### 10. Migration order

1. **Façades land** behind the existing server (module of §1, surface of §2, call
   path of §3, item store of §4, config of §6). Parity test-suite: recorded door
   request/response pairs for the main call shapes (chat non-stream, chat stream,
   responses, responses stream, route-name model, concrete model, quota-failure)
   replayed against both the door and the façade; usage fields and error envelopes
   compared.
2. **Route-proxy consumers repoint** (OpenClaw first, per its header comment naming
   it the primary consumer), verified live per consumer; then
   `bin/opencode-route-proxy.mjs` is removed from developing-today/code and the
   demotion constants exist only as config (§6).
3. **Per-door fronts repoint**, one door per issue, in this order: codex (largest
   caller overlap with `/v1/responses`), muse (attestation parity test is the gate),
   agy, antigravity-ls, clef, commandcode, claude-code, design-code (after its
   personas exist as routes). Each step: consumer inventory → parity check → repoint
   → live verification → door front closed (process stops listening for external
   callers; backend use, if any, continues explicitly).
4. **Backend retirements** are *not* scheduled by this design; each needs its own
   issue when a native path exists (commandcode's is plan-blocked, §9.4).

### 11. Implementation issues

Filed from this design and linked from #1146 (one per step, in order):

1. Façade skeleton: protocol group + handlers + auth + `/v1/models`, chat
   completions non-streaming, concrete refs only. — #1147
2. Chat completions streaming + route-name models + failover + ledger rows (§7). — #1148
3. Responses façade: non-streaming + item store + `previous_response_id` (§4). — #1149
4. Responses streaming grammar (§5). — #1150
5. Demotion config: schema + `ModelRoute.configure` wiring + ledger-backed counts (§6). — #1151
6. Parity test-suite against the live doors (§10 step 1). — #1152
7. Route-proxy retirement in developing-today/code (§10 step 2) — cross-repo,
   tracked from #1146 per the fleet's one-issue-per-set rule. — #1153
8. Per-door front migrations (§10 step 3) — filed as one issue per door when its
   turn comes, starting with codex (#1154) and muse (#1155).

## Decisions

- **Façades consume the resolver; they do not re-implement it.** Decided by Drew's
  direction in #1146 (one translation layer, policy in one place). The route proxy's
  JS re-implementation is the thing being retired.
- **No session is created for a façade call.** The route proxy's current
  routing-only semantics (its own header comment, rebuilt per code #2518) are the
  established fleet behaviour; the earlier one-session-per-request shape was already
  removed there and is not reintroduced. Drew's non-goal in #1146: no change to
  session behaviour.
- **Responses state lives in a façade-private store, not in sessions.** Keeps the
  conflict surface and the semantics separate; session ids and response ids never
  mix.
- **Demotion defaults stay 3 / 4h.** They are today's live values in both copies;
  the change is where they live (config), not what they are.
- **Door fronts and door backends retire separately.** Forced by the verified fact
  that the doors are provider backends in the fleet's own opencode config; a
  front-only migration is honest about what the façade replaces.

## Alternatives considered

- **Keep growing the route proxy into a responses proxy too.** Rejected: it deepens
  the duplicated resolver and leaves per-door translation in place — the opposite of
  the stated direction.
- **Façade as a separate process in front of the server.** Rejected: it would need
  its own credential/ledger access (a third copy of the policy inputs) and its own
  auth story; the server already has all three.
- **Implement responses state by creating hidden sessions.** Rejected: pollutes
  session tables and the TUI, couples façade TTLs to session lifecycle, and changes
  session semantics — an explicit non-goal.
- **Preserve warm-door history heuristics in the façade.** Rejected (§9.2): the
  heuristics differ per door and exist to serve CLI process state, not API
  semantics; `previous_response_id` is the standard replacement.

## Consequences

- One translation layer and one demotion policy; the code repo loses
  `opencode-route-proxy.mjs` and, over time, seven caller-facing doors.
- New conflict surface on upstream merges is bounded to the registration lines (§1).
- Callers of warm doors must change how they send history (§9.2) — the migration
  issues carry that explicitly.
- The façade makes the server a quota-bearing public surface for the tailnet:
  rate-limit and abuse behaviour rides on the route machinery's existing gates;
  anything stronger waits for per-caller keys (§12).

## Open questions

- Per-caller API keys (stretch goal in #1146): who issues/revokes, and do façade
  rows in `route_attempt` gain a caller column then? Settled by Drew when the first
  non-tailnet caller appears.
- Item-store TTL (24h proposed): is any real responses caller chaining across
  longer gaps? Settled by the responses implementation issue, from door logs.
- Should `/v1/models` hide routes a caller could not use because every candidate is
  currently demoted? Proposed: no (models lists are capability, not availability);
  settled in the skeleton issue's review.
