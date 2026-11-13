# Search providers behind the façade — design

- Status: draft, parked for user/review
- Date: 2026-11-08T08:40:00Z
- Issues: [#1677](https://github.com/developing-today-forks/opencode/issues/1677) (this design), parent programme [#1146](https://github.com/developing-today-forks/opencode/issues/1146)
- Decision (§6): **not yet** — the build trigger in §6 is not met today. This doc is the
  recorded decision and the inventory the future build starts from; it does not split
  implementation issues.

## Intent

#1677 asks whether the fleet's tools should reach web-search providers through one
common façade endpoint (the search analogue of the #1146 OpenAI façades), or keep
wiring per-provider adapters per tool. The filing-time skim that suggested this fork
"has no web search" was wrong (corrected by the 2026-11-05 triage, task 10121): the
fork already has a complete, app-local web-search subsystem. This design therefore
starts from the real baseline (§1), compares the two architectures against it (§2),
specifies the façade contract if it is built (§3–§5), and ends with the concrete,
observable build trigger that decides when (§6).

## 1. Inventory — who searches, how, today (verified 2026-11-08, fork main 07b0352b45)

### 1.1 This fork (developing-today-forks/opencode)

One adapter set, owned by the core WebSearch service; nothing else in the repo talks
to a search provider directly.

| Layer | Where | Shape |
| --- | --- | --- |
| Schema | `packages/schema/src/websearch.ts` | `Input { query: string, providerID?: ID }`; `Result { url, title?, content?, time: { published? } }`; `Response { providerID, results[] }`; `Provider { id, name }` |
| Registry / selection | `packages/core/src/websearch.ts` | Providers register into a Location-scoped map; selection is a configured provider id, `"random"`, or `false` (disabled), persisted in KV (`websearch:provider`); per-provider cooldowns on failure (Retry-After honoured, clamped — see recent fixes #713-era); session provider affinity |
| Provider adapters | `packages/core/src/plugin/websearch/` (`index.ts` registers all five) | Exa (`https://mcp.exa.ai/mcp`, MCP), Firecrawl (`https://mcp.firecrawl.dev/v2/mcp`, MCP), Parallel (`https://search.parallel.ai/mcp`, MCP), Tavily (`https://api.tavily.com/search`, REST), TinyFish (`https://agent.tinyfish.ai/mcp`, MCP). Four of five ride the shared MCP client (`plugin/websearch/mcp.ts`); each adapter normalises its provider's reply into the schema `Result[]` |
| Key ownership | per-adapter credential declaration | Env-var keys only: `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `PARALLEL_API_KEY`, `TAVILY_API_KEY`, `TINYFISH_API_KEY`. Keys belong to the OpenCode process's environment; no caller ever supplies or sees one |
| Server surface | `packages/protocol/src/groups/websearch.ts`, `packages/server/src/handlers/websearch.ts` | `GET /api/websearch/provider` (list registered providers), `POST /api/websearch` (one query; payload is the schema `Input`). Location-scoped, existing server auth. **No `/v1/search` façade exists** (code search: zero hits) |
| Model tool surface | `packages/core/src/tool/plugin/websearch.ts` | Model-invoked `websearch` tool, input `{ query }` only; permission-gated; if no provider is selected it prompts the user to pick one (form flow in `packages/app/src/session/requests/websearch.ts`) and then runs through the same core service |
| Config surface | `packages/core/src/config/plugin/websearch.ts`, `opencode.json` `websearch` key | `websearch: { provider: "<id>" }` or `websearch: false`; hot-reloaded via the config entry observer |

Errors today (handler mapping, `handlers/websearch.ts`): no provider selected →
`websearch_provider_required` (invalid request); unknown provider id →
`websearch_provider_not_found`; disabled → `websearch_disabled`; provider request
failure → `ServiceUnavailableError` naming the provider. The tool surface additionally
maps HTTP 401/429 from providers to human-readable messages.

### 1.2 Upstream OpenCode (anomalyco/opencode)

The same subsystem: `packages/core/src/websearch.ts` and
`packages/schema/src/websearch.ts` exist upstream with the same shapes (verified by
code search 2026-11-08), so the registry/schema are upstream-shared, not fork-only —
a façade built here should stay an additive server surface, exactly as #1146's
placement rule requires, so upstream merges keep conflicting at most in registration
lines. Upstream additionally exposes provider-hosted search inside the ai package
(`webSearch` hosted tools, e.g. Meta, Alibaba) — model-provider features, out of
scope for this design: they are not fleet-wired adapters.

### 1.3 OpenChamber (developing-today-forks/openchamber)

A **consumer, not an adapter owner**. It implements no provider calls. It configures
and renders OpenCode's search: `packages/web/server/lib/opencode/websearch-config.js`
(the `websearch` config key), the VS Code bridge's `GET/PUT /api/config/websearch`
(`packages/vscode/src/bridge-config-runtime.ts`, `webview/main.tsx`), and UI rendering
of the tool's output (`packages/ui/src/lib/opencode/websearch` —
`parseWebSearchOutput`, `readWebSearchConsent`, used by chat tool renderers). Its
search behaviour changes only by changing OpenCode's subsystem or its config.

### 1.4 Other fleet tools (developing-today/code)

No direct search-provider integration: a 2026-11-08 grep of `bin/`, `infra/`, and
`packages/` for provider endpoints and key names (`api.tavily.com`, `mcp.exa.ai`,
Firecrawl, Brave/Bing/DuckDuckGo search endpoints) returns nothing. The code repo's
doors and proxies are LLM façades (the #1146 subject); fleet agents reach search
only inside OpenCode sessions, through the §1.1 tool. Muse's own hosted search
tools are a vendor surface, not a fleet adapter.

### 1.5 Inventory conclusion

Adapter sets in the fleet: **exactly one** (five providers, one repo, one registry).
Consumers of search: OpenCode sessions (tool + server API) and OpenChamber
(config + rendering over OpenCode). The N×M sprawl #1677 fears — N tools each wiring
M providers — is a *risk shape*, not the current state: N = 1.

## 2. Options compared

**A. One common façade endpoint.** A `/v1/search` surface on the OpenCode server
(§3), backed by the existing core registry. Every fleet tool calls the server;
provider adapters, keys, and accounting live in exactly one place forever.

**B. Per-provider adapters per tool (status quo, generalised).** Each tool that
needs search embeds the §1.1 adapter pattern (or an SDK) and its own copy of every
provider key.

| Criterion | A. Façade | B. Per-tool adapters |
| --- | --- | --- |
| Cost today | New protocol group + handler + client work, for zero current second consumers | Zero — nothing to build |
| Cost at the second consumer | Consumer writes one HTTP client against §3 | Consumer re-implements 5 adapters, or the fleet forks a shared library and versions it per tool |
| Key lifecycle | One registration/renewal point (§4) | One copy of every key per tool; rotation is a fleet-wide sweep |
| Accounting / rate limits | One `route_attempt`-style ledger sees all attempts (§5); cooldown policy is shared | Each tool retries/cools down blind; provider rate limits are hit incoherently |
| Failure surface | Server availability becomes a search dependency for consumers (mitigated: consumers are already OpenCode-dependent — §1.3, §1.4) | No new dependency; failures are per-tool and inconsistent |
| Upstream posture | Additive surface, #1146 placement rule | Nothing added |

Option A is the right architecture **when a second consumer exists**; option B is
the right cost **while N = 1**. The design therefore specifies A fully (§3–§5) and
defers building it behind the §6 trigger.

## 3. Façade contract (if built)

Placement follows the #1146 design: one new protocol group and one handler file
under `packages/server`, delegating to the existing core `WebSearch.Service` — no
changes to the registry, adapters, tool, or config. Same host, same `ServerAuth` as
the #1146 façades.

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/search` | Body: the schema `Input` verbatim — `{ query: string, providerID?: string }`. `providerID` omitted means the configured default / `"random"` policy, exactly as the core service resolves it today. Response: the schema `Response` verbatim — `{ providerID, results: [{ url, title?, content?, time: { published? } }] }`. Pass-through, not reinterpretation: the façade adds no ranking, merging, or summarisation |
| `GET /v1/search/providers` | `[{ id, name }]` for the registered providers (today's `GET /api/websearch/provider` payload), so consumers can offer the same provider choice the app offers |

Errors keep today's kinds, in the server's standard error shapes: `400
websearch_provider_required` (no default and none specified), `400
websearch_provider_not_found`, `400 websearch_disabled`, `503` provider request
failure naming the provider. Provider-native errors are never passed through raw —
they leak provider internals and differ per adapter; the provider id in the 503 is
the diagnostic contract.

Attribution and citations: `url` is mandatory in every result and `providerID` is on
every response — a consumer rendering an answer can always cite the source URL and
name the provider that returned it. `title` and `time.published` pass through when
the provider supplies them; adapters must not fabricate them. Consumers that quote
`content` are responsible for linking the `url` — the contract's citation rule is
that no result is displayable without its `url`.

Tool surface: the model-invoked `websearch` tool (§1.1) is unchanged and stays
in-process; `/v1/search` is the out-of-process door to the same service, for
non-session callers (scripts, other fleet tools, OpenChamber-side features that
ever need to query outside a session).

## 4. Provider key registration and renewal (façade-owned)

- The façade layer owns the key registry: the five env names in §1.1 stay the
  registration mechanism, read by the OpenCode server process only. Callers never
  send keys; a request carrying one is ignored, not honoured.
- Adding a provider = one adapter under `plugin/websearch/` + one env name +
  registry entry; no consumer changes (they see it via `GET /v1/search/providers`).
- Renewal/rotation = change the env value on the one server host and restart /
  reload that process. There is no per-consumer redistribution step to forget —
  that is the operational point of the façade.
- A provider whose key is absent simply does not register (today's behaviour);
  `GET /v1/search/providers` is therefore also the fleet's key-presence audit.

## 5. Accounting

Search attempts join the model-route accounting pattern (#1146 §6): every façade
query (and, for a complete picture, every tool query) writes one `route_attempt`-
style record — timestamp, provider id, caller surface (`tool` / `api` / `v1`),
outcome (`ok`, provider error kind, HTTP status where known), and latency. The
existing per-provider cooldown state (§1.1) stays in the core service; the ledger
is the cross-consumer view the cooldown map cannot give: which surface is burning
which provider's quota, and whether a 429 was one tool's burst or fleet-wide.
No new store: reuse the route-attempt ledger's home and retention.

## 6. Decision and build trigger

**Decision (2026-11-08): do not build yet.** The inventory (§1.5) shows one adapter
set and no consumer that needs search outside OpenCode. Building the façade now
would spend the protocol/handler/client work to serve a hypothetical second
consumer, and an unexercised endpoint rots against the next upstream merge.

**Build trigger — any ONE of these, all greppable or countable at review time:**

1. A second fleet codebase needs programmatic web search outside an OpenCode
   session: concretely, a PR in any fleet repo other than this one references a
   search-provider endpoint or key name (`api.tavily.com`, `mcp.exa.ai`,
   `mcp.firecrawl.dev`, `search.parallel.ai`, `agent.tinyfish.ai`, or the §1.1 env
   names) — that PR is the trigger event, and it should be repointed at this
   design instead of landing a second adapter set.
2. A sixth search provider is adopted, or a provider is dropped fleet-wide: the
   change must land in exactly one adapter set; if §1.5's count is no longer 1 by
   then, the façade is built first so it becomes 1 again.
3. Search accounting becomes a real question: two or more provider rate-limit
   (429) or quota incidents in a rolling 30 days attributable to uncoordinated
   callers, or any request to report fleet search usage by provider — the §5
   ledger only makes sense behind the façade.

**Revisit:** whoever observes a trigger condition reopens the question on #1677
with the evidence (the PR link, the provider change, or the incident count) and
files the implementation split from §3–§5: (a) façade protocol group + handler,
(b) accounting records, (c) consumer repoint. Until then, #1677 stays open at
priority/low as the standing pointer to this decision, and new fleet search needs
route through OpenCode sessions by default.

## 7. Out of scope

- Implementing `/v1/search`, provider adapters, or accounting (deferred per §6).
- Changing the existing websearch subsystem, tool, or `websearch` config key.
- Provider-hosted model search tools (upstream ai-package `webSearch`, §1.2).
- Per-caller API keys or non-local callers for the façade (same stance as #1146).
