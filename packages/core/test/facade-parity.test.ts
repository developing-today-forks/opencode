/**
 * Façade parity suite (#1152, parent #1146) — recorded replay pairs:
 * the standalone doors in developing-today/code `bin/` vs the fork
 * server façade (`packages/core/src/completions.ts` +
 * `packages/server/src/handlers/completions.ts`).
 *
 * HOW THIS WORKS
 * Each case carries a DOOR recording: the exact request a caller sends
 * and the exact wire outcome the door produces, transcribed from the
 * door's own code and test fixtures (provenance is cited per case —
 * file + the behaviour it pins). No live door, provider, or paid
 * endpoint is contacted: the doors' own stub fixtures are the capture.
 * The same request is then replayed through the façade's translation
 * layer, fed with the canonical internal result that corresponds to
 * the door fixture's upstream answer, and the two wire outcomes are
 * structurally diffed (response shape, streaming grammar, usage
 * fields, error envelopes). Volatile values (ids, timestamps) are
 * compared for presence only.
 *
 * Every diff a case produces must be DECLARED in that case, with a
 * classification:
 *   - "acceptable-by-design": the design spec
 *     (specs/2026-11-01T04-10-00Z_design_openai-facades.md) sanctions
 *     the façade behaviour, or the diff is purely additive.
 *   - "real-gap": the façade's observable behaviour differs from the
 *     door's in a way a caller can detect and the spec does not
 *     sanction. Real gaps are filed as issues and linked from #1152.
 *   - "fail": the caller-visible outcome class differs (the door
 *     succeeds where the façade cannot, or vice versa).
 * An undeclared diff — or a declared diff that disappears — fails the
 * test, so the verdicts below cannot silently drift from reality.
 *
 * PER-DOOR VERDICTS (kept in sync by the registry test at the bottom;
 * the same table is recorded on issue #1152):
 *   - route proxy (bin/opencode-route-proxy.mjs, :18750):
 *     PARITY-WITH-NAMED-DIFFS
 *   - codex (bin/codex-proxy.mjs, :18744): PARITY-WITH-NAMED-DIFFS
 *   - design-code (bin/design-code-proxy.mjs, :18746):
 *     PARITY-WITH-NAMED-DIFFS — persona prompt composition, recipe
 *     order/failover, non-stream/stream shapes and error classes all
 *     match (the failover walk + prompt application are pinned in
 *     generate-persona-route.test.ts); named diffs below, including
 *     one real-gap: persona routes are not advertised in the façade's
 *     /v1/models list (ADVERTISED_MODELS is the six tier routes).
 *   - clef (bin/clef-proxy.mjs, :18742) — systemone family (#1410):
 *     PARITY-WITH-NAMED-DIFFS (both acceptable-by-design; see the
 *     clef describe block)
 *   - claude-code (bin/claude-code-proxy.mjs, :18749):
 *     PARITY-WITH-NAMED-DIFFS — recorded on #1412 (Wave C). The
 *     door has no live front callers (provider disabled fleet-wide
 *     2026-10-27, free-tier pause) and the door process stays as
 *     the provider backend, so the resident-CLI session semantics
 *     (§9.2) survive behind the façade by construction.
 *   - muse (bin/muse-proxy.mjs, :18747): FAIL — the attestation case:
 *     the door answers shell/bash-tool requests with a 200 (tool names
 *     aliased upstream, calls translated back; a residual 403 falls
 *     back to the CLI door), while the façade — by the design §9.1
 *     rule — preserves the names verbatim and surfaces an attestation
 *     403 as a provider failure. The caller-visible outcome differs;
 *     per #1152 that is a parity failure, recorded, not papered over.
 *
 * RE-RUN (on the laptop, in this worktree):
 *   cd packages/core && bun run test test/facade-parity.test.ts
 *   cd packages/server && bun run test test/facade-parity.test.ts
 * The server file replays the HTTP-level pairs (status codes and
 * error envelopes through the real handler); this file replays the
 * translation-level pairs. Per door: filter with `bun run test
 * test/facade-parity.test.ts -t "route proxy"` (or "codex" / "muse").
 */
import { describe, expect, test } from "bun:test"
import { LLMEvent, LLMResponse } from "@opencode/ai"
import { applyRouteSystem } from "@opencode/core/generate"
import {
  ChatStreamTranslator,
  ResponsesStreamTranslator,
  completionBody,
  errorBody,
  modelBody,
  modelsBody,
  parseChatRequest,
  parseResponsesRequest,
  responsesBody,
} from "@opencode/core/completions"
import {
  answersBody,
  errorBody as systemOneErrorBody,
  parseSystemOneRequest,
  resolveModel,
  upstreamFailureBody,
} from "@opencode/core/systemone"

// ------------------------------------------------------------ diff engine

/** Keys whose VALUES are volatile (ids, timestamps): presence is
 * compared, values are not. `call_id` is deliberately NOT volatile —
 * tool-call correlation ids are part of the contract. */
const VOLATILE = new Set(["id", "created", "created_at"])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Structural diff of two wire values; returns differing paths. */
export const diffPaths = (door: unknown, facade: unknown, path = ""): string[] => {
  const key = path.split(".").pop()?.replace(/\[\d+\]$/, "") ?? ""
  if (VOLATILE.has(key)) return []
  if (Array.isArray(door) || Array.isArray(facade)) {
    if (!Array.isArray(door) || !Array.isArray(facade)) return [path]
    const out: string[] = []
    if (door.length !== facade.length) out.push(`${path}.length`)
    for (let i = 0; i < Math.min(door.length, facade.length); i++) out.push(...diffPaths(door[i], facade[i], `${path}[${i}]`))
    return out
  }
  if (isRecord(door) || isRecord(facade)) {
    if (!isRecord(door) || !isRecord(facade)) return [path]
    const out: string[] = []
    for (const k of new Set([...Object.keys(door), ...Object.keys(facade)])) {
      const p = path ? `${path}.${k}` : k
      if (!(k in door) || !(k in facade)) {
        out.push(p)
        continue
      }
      out.push(...diffPaths(door[k], facade[k], p))
    }
    return out
  }
  return door === facade ? [] : [path]
}

type Classification = "acceptable-by-design" | "real-gap" | "fail"
interface DeclaredDiff {
  readonly path: string
  readonly classification: Classification
  readonly note: string
}

/** Assert the actual diff set equals the declared set, exactly. */
const expectDiffs = (door: unknown, facade: unknown, declared: ReadonlyArray<DeclaredDiff>) => {
  const actual = diffPaths(door, facade).sort()
  expect(actual).toEqual(declared.map((d) => d.path).sort())
  return declared
}

// ------------------------------------------------------------ replay helpers

const responseOf = (events: ReadonlyArray<LLMEvent>) => {
  const response = LLMResponse.fromEvents([...events])
  if (!response) throw new Error("expected a completed canonical response")
  return response
}

/** Parse SSE frames into projected chunk objects: the grammar a chat
 * client observes (delta, finish_reason, usage) plus the [DONE]
 * sentinel as a literal element. Ids/created/model are projected out
 * here — model echo is diffed in the non-streaming cases. */
const chatFramesOf = (frames: ReadonlyArray<string>) =>
  frames.map((frame) => {
    const data = frame.replace(/^data: /, "").trim()
    if (data === "[DONE]") return "[DONE]"
    const chunk = JSON.parse(data) as {
      object?: string
      choices?: Array<{ delta: unknown; finish_reason: unknown }>
      usage?: unknown
      error?: unknown
    }
    if (chunk.error) return { error: chunk.error }
    return {
      object: chunk.object,
      delta: chunk.choices?.[0]?.delta,
      finish_reason: chunk.choices?.[0]?.finish_reason,
      ...(chunk.usage ? { usage: chunk.usage } : {}),
    }
  })

/** Façade chat stream for a canonical event sequence. The handler
 * appends Completions.DONE_FRAME after a non-failed stream
 * (packages/server/src/handlers/completions.ts), so it is part of the
 * recorded façade grammar here. */
const facadeChatFrames = (events: ReadonlyArray<LLMEvent>, model = "workhorse") => {
  const translator = new ChatStreamTranslator({ id: "chatcmpl-facade", created: 1700000000, model })
  const frames = events.flatMap((event) => translator.push(event))
  if (!translator.failed) frames.push("data: [DONE]\n\n")
  return chatFramesOf(frames)
}

/** Façade responses stream: the event-type sequence, the sequence
 * numbers, the terminal response.completed payload essentials, and
 * the translator output items the #1149 store persists. */
const facadeResponsesStream = (events: ReadonlyArray<LLMEvent>) => {
  const translator = new ResponsesStreamTranslator({ id: "resp_facade", created: 1700000000, model: "muse-spark-1.3" })
  const frames = [translator.start(), ...events.flatMap((event) => translator.push(event))]
  const parsed = frames.flatMap((frame) =>
    frame
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<string, unknown>),
  )
  const types = parsed.map((data) => String(data.type))
  const seqs = parsed.map((data) => data.sequence_number)
  const completed = parsed.find((data) => data.type === "response.completed")?.response as
    | Record<string, unknown>
    | undefined
  return { types, seqs, completed, parsed, items: translator.outputItems() }
}

const CREATED = 1700000000

// ------------------------------------------------------------ route proxy
//
// Door: bin/opencode-route-proxy.mjs (:18750) in developing-today/code.
// Recordings transcribed from that file and bin/opencode-route-proxy.test.mjs:
// the door resolves a route name to leaf providers and relays the
// leaf's OpenAI wire shapes — non-stream JSON verbatim except `model`
// rewritten to `opencode-route/<routeId>` (handleChatCompletions),
// stream SSE verbatim (relayStream), errors as
// `{error: {message, type: "proxy_error"}}` (sendError).

describe("door: route proxy (bin/opencode-route-proxy.mjs :18750)", () => {
  const MSGS = [{ role: "user", content: "hi" }]
  // The door test's fake leaf answer (opencode-route-proxy.test.mjs,
  // makeLeaf): content is the leaf name, usage 5/2/7.
  const leafEvents = [
    LLMEvent.textDelta({ id: "t1", text: "LEAF-A" }),
    LLMEvent.finish({ reason: { normalized: "stop" }, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
  ]

  test("models list: identical advertised route set", () => {
    // Door: GET /v1/models serves ADVERTISED_MODELS (route proxy lines
    // ~106-113) as {id, object: "model", created: 0, owned_by:
    // "opencode-route"} — the same six ids the façade advertises.
    const door = {
      object: "list",
      data: ["workhorse", "speed", "specialist", "summit", "scout", "workhorse-weighted"].map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "opencode-route",
      })),
    }
    // Since #1410 the façade's shared list also carries the
    // systemone family's Clef floor (a façade-only superset, like the
    // embeddings entries the handler adds): the route set itself is
    // unchanged, the list is longer by exactly those entries.
    expectDiffs(door, modelsBody(), [
      {
        path: "data.length",
        classification: "acceptable-by-design",
        note: "façade-only superset: the systemone Clef models (#1410) share the /v1/models list",
      },
    ])
    expect(modelBody("workhorse")).toEqual(door.data[0])
  })

  test("chat non-streaming, route-name model (prefixed form): parity", () => {
    // Door recording: the leaf's completion verbatim, model rewritten
    // to the prefixed route ref. Caller form `opencode-route/workhorse`
    // is what OpenClaw-style callers send (design §2).
    const door = {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "opencode-route/workhorse",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "LEAF-A" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }
    const parsed = parseChatRequest({ model: "opencode-route/workhorse", messages: MSGS })
    if (!parsed.ok) throw new Error(parsed.error)
    const facade = completionBody({ id: "chatcmpl-facade", created: CREATED, model: parsed.value.modelLabel, response: responseOf(leafEvents) })
    expectDiffs(door, facade, [])
  })

  test("chat non-streaming, bare route name: model echo differs", () => {
    // Door rewrites `model` to `opencode-route/<routeId>` even when the
    // caller sent the bare name; the façade echoes the caller's label.
    const door = {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "opencode-route/workhorse",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "LEAF-A" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }
    const parsed = parseChatRequest({ model: "workhorse", messages: MSGS })
    if (!parsed.ok) throw new Error(parsed.error)
    const facade = completionBody({ id: "chatcmpl-facade", created: CREATED, model: parsed.value.modelLabel, response: responseOf(leafEvents) })
    expectDiffs(door, facade, [
      {
        path: "model",
        classification: "acceptable-by-design",
        note: "Façade echoes the caller's model label; the door rewrites bare names to the prefixed ref. Sending the prefixed form (previous case) is exact parity.",
      },
    ])
  })

  test("chat streaming, route-name model: relayed grammar parity", () => {
    // Door recording: relayStream passes leaf frames through verbatim.
    // The test leaf emits a role+content chunk, then a usage-bearing
    // finish chunk, then [DONE]. (The leaf's own model id rides in the
    // streamed chunks unrewritten — a door quirk; the façade labels
    // chunks with the caller's model. Model echo is diffed in the
    // non-streaming cases; the grammar projection excludes it.)
    const door = [
      { object: "chat.completion.chunk", delta: { role: "assistant", content: "LEAF-A" }, finish_reason: null },
      { object: "chat.completion.chunk", delta: {}, finish_reason: "stop", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      "[DONE]",
    ]
    expectDiffs(door, facadeChatFrames(leafEvents), [])
  })

  test("concrete provider/model ref: façade pass-through the door never had", () => {
    // Door recording: parseRouteModel treats any model string as a
    // route id, so a concrete ref is an unknown route — runCompletion
    // throws `unknown route: leafA/m-a` and handleChatCompletions
    // answers 502 proxy_error (route test: "unknown route and
    // malformed bodies are rejected" pins status 502 + /unknown route/).
    const door = { status: 502, body: { error: { message: "unknown route: leafA/m-a", type: "proxy_error" } } }
    expect(door.status).toBe(502)
    // Façade: the same ref parses as a concrete catalog ref (design
    // §2 pass-through) and proceeds to resolution/generation.
    const parsed = parseChatRequest({ model: "leafA/m-a", messages: MSGS })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(String(parsed.value.input.model?.providerID)).toBe("leafA")
    expect(String(parsed.value.input.model?.id)).toBe("m-a")
    // classification: acceptable-by-design — the façade is a superset;
    // the door's front is exactly the surface §2 replaces.
  })

  test("responses non-streaming + streaming: door has no /v1/responses", () => {
    // Door recording: the server's fallthrough answers any other path
    // with sendError(404, `no route for POST /v1/responses`).
    const door = { status: 404, body: { error: { message: "no route for POST /v1/responses", type: "proxy_error" } } }
    expect(door.status).toBe(404)
    const parsed = parseResponsesRequest({ model: "workhorse", input: "hi" })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.stream).toBe(false)
    // classification: acceptable-by-design — façade superset (design
    // §2); route-proxy callers gain /v1/responses by repointing.
  })

  test("quota failure: exhausted candidates — door 502, façade 429 per design §2 (#1441)", () => {
    // Door recording: the single candidate leaf answers 429 with body
    // {"error":{"message":"quota"}} and `Retry-After: 30` (test leaf,
    // mode "rate"). classifyHttp wraps it as LeafError
    // `leaf HTTP 429: {"error":{"message":"quota"}}`; with no further
    // candidate, handleChatCompletions answers sendError(502, that
    // message). The Retry-After header is NOT forwarded to the client
    // — the reset hint survives only inside the ledger's quota JSON
    // and, when the upstream body carries it, inside the message.
    // The DOOR side stays exactly as recorded: the route proxy itself
    // returns 502 on quota exhaustion.
    const door = {
      status: 502,
      body: { error: { message: 'leaf HTTP 429: {"error":{"message":"quota"}}', type: "proxy_error" } },
    }
    // Façade (#1441): a quota-classified generation failure is a
    // distinguishable Generate.QuotaError and the handler maps it to
    // 429 with Completions.errorBody(message, "rate_limit_error") —
    // the provider's message (and any reset hint inside it) is
    // preserved verbatim. This is a spec-conformant divergence from
    // the route-proxy door: design §2 promises 429 for quota /
    // rate-limit failures, so the façade follows the spec, not the
    // door's accidental 502.
    const facade = {
      status: 429,
      body: errorBody('leaf HTTP 429: {"error":{"message":"quota"}}', "rate_limit_error"),
    }
    expect(door.status).toBe(502)
    expect(facade.status).toBe(429)
    expectDiffs(door.body, facade.body, [
      {
        path: "error.type",
        classification: "acceptable-by-design",
        note: "Door brands its 502 as proxy_error; the façade answers the design §2 quota shape — 429 rate_limit_error — with the same message carriage. Neither side forwards a Retry-After header; the hint rides in the message.",
      },
    ])
  })

  test("non-text content: door relays verbatim, façade rejects 400", () => {
    // Door recording: handleChatCompletions validates only shape
    // (object/messages array) and relays the body to the leaf, which
    // decides. Façade translation supports text content only and
    // fails loudly at parse (design §2 translated path).
    const parsed = parseChatRequest({
      model: "workhorse",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/x.png" } }] }],
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("only text user content is supported")
    // classification: acceptable-by-design for the translated path —
    // with the caveat that the verbatim pass-through fast path (the
    // sibling #1146 work) is the sanctioned route for such payloads
    // when the resolved provider's dialect matches.
  })
})

// ------------------------------------------------------------ codex
//
// Door: bin/codex-proxy.mjs (:18744) in developing-today/code.
// Recordings transcribed from that file and bin/codex-proxy.test.mjs:
// the front is chat-completions only, backed by the Muse; success
// bodies are built in sendSuccess, failures in sendFailure
// (`{error: {message}}` — codex errors never carry a `type`), unknown
// models are a 400 naming the live Codex catalog.

describe("door: codex (bin/codex-proxy.mjs :18744)", () => {
  // Canonical CLI turn: text "Hello world", usage with cached tokens
  // (codex test: cached_input_tokens 93 surfaces as
  // prompt_tokens_details.cached_tokens, #3114).
  const turnEvents = [
    LLMEvent.textDelta({ id: "t1", text: "Hello world" }),
    LLMEvent.finish({
      reason: { normalized: "stop" },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 93 },
    }),
  ]
  const doorUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 93 } }

  test("chat non-streaming, concrete catalog model: parity incl. cached-token usage", () => {
    // Door recording (sendSuccess, non-stream): message carries no
    // tool_calls for a text answer, finish_reason is "stop", usage is
    // prompt/completion/total plus cached detail when > 0.
    const door = {
      id: "chatcmpl-codex-00000000-0000-0000-0000-000000000000",
      object: "chat.completion",
      created: CREATED,
      model: "gpt-5.6-luna-low",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
      usage: doorUsage,
    }
    const facade = completionBody({ id: "chatcmpl-facade", created: CREATED, model: "gpt-5.6-luna-low", response: responseOf(turnEvents) })
    expectDiffs(door, facade, [])
    // Cache-absent variant: both sides omit prompt_tokens_details
    // entirely rather than emitting 0 (door test #3114, resumed turn).
    const noCache = responseOf([
      LLMEvent.textDelta({ id: "t1", text: "Hello world" }),
      LLMEvent.finish({ reason: { normalized: "stop" }, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
    ])
    const facadeNoCache = completionBody({ id: "chatcmpl-facade", created: CREATED, model: "gpt-5.6-luna-low", response: noCache })
    expect(facadeNoCache.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
  })

  test("chat streaming: façade adds role to the first delta; rest of grammar parity", () => {
    // Door recording (writeChunk + sendSuccess stream path): content
    // chunks carry delta {content} with NO role field; the end chunk
    // carries delta {}, finish_reason "stop" and usage; then [DONE].
    // (Codex test: "successful run is unchanged in both modes".)
    const door = [
      { object: "chat.completion.chunk", delta: { content: "Hello world" }, finish_reason: null },
      { object: "chat.completion.chunk", delta: {}, finish_reason: "stop", usage: doorUsage },
      "[DONE]",
    ]
    expectDiffs(door, facadeChatFrames(turnEvents, "gpt-5.6-luna-low"), [
      {
        path: "[0].delta.role",
        classification: "acceptable-by-design",
        note: "The façade follows the OpenAI convention of role:\"assistant\" on the first chunk; the codex door omits it. Content, finish and usage chunks are identical.",
      },
    ])
  })

  test("responses non-streaming + streaming: door front has no /v1/responses", () => {
    // Door recording: the fallthrough answers 404
    // `{error: {message: "Route not found: POST /v1/responses"}}`.
    const door = { status: 404, body: { error: { message: "Route not found: POST /v1/responses" } } }
    expect(door.status).toBe(404)
    expect("type" in door.body.error).toBe(false)
    const parsed = parseResponsesRequest({ model: "openai-codex/gpt-5.6-luna-low", input: "hi", stream: true })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.stream).toBe(true)
    // classification: acceptable-by-design — design §9.6: responses
    // callers targeting codex-backed models get the façade's own
    // grammar instead of a per-door variant.
  })

  test("route-name model: door 400s (not in Codex catalog), façade resolves it as a route", () => {
    // Door recording (chat handler): resolveModelAndEffort misses, so
    // 400 `{error: {message: "Unknown model \"workhorse\": not in the
    // live Codex catalog (see GET /v1/models)"}}`.
    const door = {
      status: 400,
      body: { error: { message: 'Unknown model "workhorse": not in the live Codex catalog (see GET /v1/models)' } },
    }
    expect(door.status).toBe(400)
    const parsed = parseChatRequest({ model: "workhorse", messages: [{ role: "user", content: "hi" }] })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(String(parsed.value.input.model?.providerID)).toBe("opencode-route")
    // classification: acceptable-by-design — different model
    // namespaces by design; the façade IS the route layer the door
    // callers repoint to (#1154).
  })

  test("bare catalog id: door resolves it, façade reads bare names as routes", () => {
    // Door recording: `gpt-5.6-luna-low` is a live catalog id and
    // resolves. Façade: a bare name is a route id (design §2), so the
    // same string lands in the opencode-route namespace and fails at
    // resolution unless a route bears that name; concrete access
    // needs the provider/model form.
    const parsed = parseChatRequest({ model: "gpt-5.6-luna-low", messages: [{ role: "user", content: "hi" }] })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(String(parsed.value.input.model?.providerID)).toBe("opencode-route")
    expect(String(parsed.value.input.model?.id)).toBe("gpt-5.6-luna-low")
    const concrete = parseChatRequest({ model: "openai-codex/gpt-5.6-luna-low", messages: [{ role: "user", content: "hi" }] })
    if (!concrete.ok) throw new Error(concrete.error)
    expect(String(concrete.value.input.model?.providerID)).toBe("openai-codex")
    // classification: acceptable-by-design (design §2 ambiguity rule:
    // bare names resolve to routes).
  })

  test("quota failure: door has no quota shape — generic 500 vs façade 502", () => {
    // Door recording: the codex door surfaces EVERY CLI failure,
    // including a usage-limit/quota failure of the CLI, through
    // sendFailure: non-stream 500 `{error: {message: "Codex execution
    // failed: <detail>"}}`; streaming frames the same body as an SSE
    // data event followed by [DONE], with no stop chunk (door tests
    // #676/#680 pin this failure grammar). No 429, no reset hint
    // exists in the door's envelope.
    const door = { status: 500, body: { error: { message: "Codex execution failed: stub codex: model overloaded" } } }
    const facade = { status: 502, body: errorBody("stub codex: model overloaded", "server_error") }
    expectDiffs(door.body, facade.body, [
      {
        path: "error.message",
        classification: "real-gap",
        note: "Message framing differs (door prefixes 'Codex execution failed: '; façade passes the provider message through). This fixture is an unclassified CLI execution failure — no quota/rate-limit signal (no 429, no quota tag) reaches the façade, so the §2 502 mapping is correct here; a quota-classified failure answers 429 instead (#1441, pinned in the muse quota case and the server suite).",
      },
      {
        path: "error.type",
        classification: "real-gap",
        note: "Codex door errors carry no type at all; the façade always emits one (server_error). Also: door status for an execution failure is 500, façade 502 (diffed on status below).",
      },
    ])
    expect(door.status).toBe(500)
    expect(facade.status).toBe(502)
  })

  test("models list: door serves the live Codex catalog, façade serves routes + concrete refs", () => {
    // Door recording: GET /v1/models enumerates the live catalog plus
    // one entry per reasoning effort, {id, object: "model", created:
    // <now>, owned_by: "openai-codex"}. The façade list is the route
    // set (route case above); concrete codex refs are instead served
    // by the single-model lookup, echoed with the provider as owner.
    expect(modelBody("openai-codex/gpt-5.6-luna-low")).toEqual({
      id: "openai-codex/gpt-5.6-luna-low",
      object: "model",
      created: 0,
      owned_by: "openai-codex",
    })
    // classification: acceptable-by-design — different catalogs by
    // design (façade §2: capability list = routes + pass-through refs).
  })
})

// ------------------------------------------------------------ muse
//
// Door: bin/muse-proxy.mjs (:18747) in developing-today/code.
// Recordings transcribed from that file and bin/muse-proxy.test.mjs.
// The direct path speaks the Meta Responses API upstream and
// translates to/from chat completions (buildResponsesRequest /
// responsesToChatCompletion / streamResponsesAsChat); /v1/responses
// is passed through verbatim (only Authorization swapped, plus the
// attestation tool-name aliasing below). The door test's stub
// upstream fixtures (RESPONSES_FIXTURE / RESPONSES_SSE_FIXTURE) are
// the recorded upstream answers used here.

describe("door: muse (bin/muse-proxy.mjs :18747)", () => {
  // The door test's RESPONSES_FIXTURE: the upstream Responses answer
  // behind the muse chat cases (text + a get_weather call, usage
  // 13/9/22 with 4 cached input tokens).
  const upstreamResponse = {
    id: "resp_stub",
    object: "response",
    status: "completed",
    model: "muse-spark-1.3",
    output: [
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello direct" }] },
      { type: "function_call", id: "fc_1", call_id: "call_123", name: "get_weather", arguments: '{"city":"Osseo"}', status: "completed" },
    ],
    usage: { input_tokens: 13, output_tokens: 9, total_tokens: 22, input_tokens_details: { cached_tokens: 4 } },
  }
  const canonicalEvents = [
    LLMEvent.textDelta({ id: "t1", text: "Hello direct" }),
    LLMEvent.toolCall({ id: "call_123", name: "get_weather", input: { city: "Osseo" } }),
    LLMEvent.finish({
      reason: { normalized: "tool-calls" },
      usage: { inputTokens: 13, outputTokens: 9, totalTokens: 22, cacheReadInputTokens: 4 },
    }),
  ]

  test("chat non-streaming (direct path translation): parity", () => {
    // Door recording: responsesToChatCompletion(RESPONSES_FIXTURE)
    // with fullName muse-spark-1.3-max (the door test's request
    // carries reasoning_effort max; the test asserts model, content,
    // tool_calls, finish_reason tool_calls and all usage fields).
    const door = {
      id: "chatcmpl-muse-stub",
      object: "chat.completion",
      created: CREATED,
      model: "muse-spark-1.3-max",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello direct",
            tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: '{"city":"Osseo"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22, prompt_tokens_details: { cached_tokens: 4 } },
    }
    const facade = completionBody({ id: "chatcmpl-facade", created: CREATED, model: "muse-spark-1.3-max", response: responseOf(canonicalEvents) })
    expectDiffs(door, facade, [])
  })

  test("chat non-streaming, tool-call-only answer: content null vs empty string", () => {
    // Door recording: extractResponsesOutput starts content at ""
    // and responsesToChatCompletion emits it verbatim, so a
    // tool-only answer carries content "". The façade emits the
    // OpenAI-canonical null for a tool-only message.
    const toolOnly = responseOf([
      LLMEvent.toolCall({ id: "call_123", name: "get_weather", input: { city: "Osseo" } }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 13, outputTokens: 9, totalTokens: 22 } }),
    ])
    const facade = completionBody({ id: "chatcmpl-facade", created: CREATED, model: "muse-spark-1.3", response: toolOnly })
    const door = {
      id: "chatcmpl-muse-stub",
      object: "chat.completion",
      created: CREATED,
      model: "muse-spark-1.3",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: '{"city":"Osseo"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 },
    }
    expectDiffs(door, facade, [
      {
        path: "choices[0].message.content",
        classification: "real-gap",
        note: "Minor but observable: door emits content \"\" for tool-only answers; façade emits null (the OpenAI-canonical form). Strict-equality clients see a difference; tool_calls, finish_reason and usage are identical.",
      },
    ])
  })

  test("chat streaming (direct path translation): first-delta role is the only grammar diff", () => {
    // Door recording: streamResponsesAsChat over the door test's
    // RESPONSES_SSE_FIXTURE — content deltas, a tool head chunk
    // (arguments ""), argument delta chunks, then a finish chunk
    // carrying usage {11,6,17} and finish_reason tool_calls, then
    // [DONE] (door test asserts content, tool head/args, final usage).
    const door = [
      { object: "chat.completion.chunk", delta: { content: "Hello " }, finish_reason: null },
      { object: "chat.completion.chunk", delta: { content: "stream" }, finish_reason: null },
      {
        object: "chat.completion.chunk",
        delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_weather", arguments: "" } }] },
        finish_reason: null,
      },
      { object: "chat.completion.chunk", delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null },
      { object: "chat.completion.chunk", delta: { tool_calls: [{ index: 0, function: { arguments: '"Osseo"}' } }] }, finish_reason: null },
      { object: "chat.completion.chunk", delta: {}, finish_reason: "tool_calls", usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } },
      "[DONE]",
    ]
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "Hello " }),
      LLMEvent.textDelta({ id: "t1", text: "stream" }),
      LLMEvent.toolInputStart({ id: "call_9", name: "get_weather" }),
      LLMEvent.toolInputDelta({ id: "call_9", name: "get_weather", text: '{"city":' }),
      LLMEvent.toolInputDelta({ id: "call_9", name: "get_weather", text: '"Osseo"}' }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 11, outputTokens: 6, totalTokens: 17 } }),
    ]
    expectDiffs(door, facadeChatFrames(events, "muse-spark-1.3"), [
      {
        path: "[0].delta.role",
        classification: "acceptable-by-design",
        note: "Façade adds role:\"assistant\" to the first chunk (OpenAI convention); the muse translator never emits it. All other chunks — tool head, argument deltas, usage-bearing finish, [DONE] — are identical.",
      },
    ])
  })

  test("responses non-streaming (passthrough): façade body is the door body plus additive fields", () => {
    // Door recording: /v1/responses passes the upstream body through
    // verbatim, so the door outcome IS the upstream fixture above.
    // (The stub fixture omits created_at and the message item's
    // status/annotations that real Responses answers carry; the
    // façade emits them, as does the real upstream.)
    const facade = responsesBody({ id: "resp_facade", created: CREATED, model: "muse-spark-1.3", response: responseOf(canonicalEvents) })
    expectDiffs(upstreamResponse, facade, [
      { path: "created_at", classification: "acceptable-by-design", note: "Façade stamps created_at; the door's stub fixture omits it (real upstream answers carry it). Additive." },
      { path: "output[0].content[0].annotations", classification: "acceptable-by-design", note: "Façade emits annotations: [] on output_text parts, as the real Responses API does. Additive." },
      { path: "output[0].status", classification: "acceptable-by-design", note: "Façade marks the message item completed. Additive." },
      { path: "parallel_tool_calls", classification: "acceptable-by-design", note: "Façade emits the OpenAI default fields (parallel_tool_calls, tool_choice, tools). Additive." },
      { path: "tool_choice", classification: "acceptable-by-design", note: "See parallel_tool_calls." },
      { path: "tools", classification: "acceptable-by-design", note: "See parallel_tool_calls. Usage (incl. cached tokens), output items, call ids and arguments are exact parity." },
    ])
  })

  test("responses streaming (passthrough): façade emits the full §5 grammar, completed carries the output — #1442 closed", () => {
    // Door recording: the passthrough relays the upstream grammar —
    // the fixture's sequence is text deltas, output_item.added,
    // function_call_arguments deltas, response.completed whose
    // response carries the full output (2 items) and usage. The stub
    // fixture is an abbreviated mid-grammar capture: it omits the
    // lifecycle frames (created / in_progress / per-item added+done,
    // *.done) and sequence numbers that real upstream streams — and
    // design §5 — carry. Before #1442 the façade matched the stub by
    // ALSO omitting them and, worse, sent output: [] on completed.
    const doorTypes = [
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.completed",
    ]
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "Hello " }),
      LLMEvent.textDelta({ id: "t1", text: "stream" }),
      LLMEvent.toolInputStart({ id: "call_9", name: "get_weather" }),
      LLMEvent.toolInputDelta({ id: "call_9", name: "get_weather", text: '{"city":' }),
      LLMEvent.toolInputDelta({ id: "call_9", name: "get_weather", text: '"Osseo"}' }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 11, outputTokens: 6, totalTokens: 17 } }),
    ]
    const facade = facadeResponsesStream(events)
    // The full §5 sequence, in order.
    expect(facade.types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ])
    // Every door-recorded event still occurs, in the recorded order
    // (a subsequence of the façade sequence).
    let at = 0
    for (const type of facade.types) if (type === doorTypes[at]) at++
    expect(at).toBe(doorTypes.length)
    // Monotonic sequence numbers on every event, from 0.
    expect(facade.seqs).toEqual(facade.types.map((_, index) => index))
    // The terminal event carries usage, status, and the FULL output —
    // both items, matching the door completed payload (modulo the
    // façade item ids, which embed the response id).
    expect(facade.completed?.status).toBe("completed")
    expect(facade.completed?.usage).toEqual({ input_tokens: 11, output_tokens: 6, total_tokens: 17 })
    expect(facade.completed?.output).toEqual([
      {
        type: "message",
        id: "msg_resp_facade",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello stream", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_call_9",
        call_id: "call_9",
        name: "get_weather",
        arguments: '{"city":"Osseo"}',
        status: "completed",
      },
    ])
    // #1149 agreement: the item store persists exactly these items.
    expect(facade.items).toEqual(facade.completed?.output as Array<Record<string, unknown>>)
    // classification: the §5 streaming diff recorded here is CLOSED
    // by #1442. The only remaining delta vs the door recording is the
    // stub fixture's own abbreviation (no lifecycle frames / sequence
    // numbers in the capture) — acceptable-by-design, since §5 and
    // real upstream streams carry them.
  })

  test("responses streaming: reasoning events use the §5 name — #1442 closed", () => {
    // Design §5 names response.reasoning_summary_text.delta. Before
    // #1442 the façade emitted response.reasoning_text.delta and no
    // reasoning item lifecycle at all. No door fixture exercises
    // reasoning deltas (the muse stub has none), so this is recorded
    // against the spec, not a door recording.
    const translator = new ResponsesStreamTranslator({ id: "resp_x", created: CREATED, model: "m" })
    const raw = [
      translator.start(),
      ...translator.push(LLMEvent.reasoningDelta({ id: "r1", text: "thinking" })),
      ...translator.push(LLMEvent.finish({ reason: { normalized: "stop" } })),
    ]
    const parsed = raw.flatMap((frame) =>
      frame
        .split("\n\n")
        .filter(Boolean)
        .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<string, unknown>),
    )
    expect(parsed.map((data) => data.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(raw.join("")).not.toContain("response.reasoning_text.delta")
    expect(parsed.map((data) => data.sequence_number)).toEqual(parsed.map((_, index) => index))
    const delta = parsed.find((data) => data.type === "response.reasoning_summary_text.delta")
    expect(delta).toMatchObject({ item_id: "rs_resp_x", output_index: 0, summary_index: 0, delta: "thinking" })
    // Reasoning surfaces as a reasoning item on the completed
    // response — never flattened into visible text (§5 fidelity).
    const completed = parsed.find((data) => data.type === "response.completed")?.response as Record<string, unknown>
    expect(completed.output).toEqual([
      { type: "reasoning", id: "rs_resp_x", status: "completed", summary: [{ type: "summary_text", text: "thinking" }] },
    ])
    expect(translator.outputItems()).toEqual(completed.output as Array<Record<string, unknown>>)
    // classification: the §5 reasoning-name diff recorded here is
    // CLOSED by #1442.
  })

  test("quota failure: door passes the upstream 429 through verbatim; façade answers 429 too (#1441)", () => {
    // Door recording (door test: "upstream 429 passes through and
    // never falls back to exec"): the stub upstream answers 429
    // {error: {message: "Subscription quota exhausted", type:
    // "rate_limit_error"}} and BOTH the chat and responses fronts
    // return that status and body as-is — a chat caller receives the
    // upstream Responses-shaped error untranslated, and the door
    // never retries through the CLI. Any reset hint in the upstream
    // body survives verbatim.
    const door = { status: 429, body: { error: { message: "Subscription quota exhausted", type: "rate_limit_error" } } }
    // Façade (#1441): a quota-classified generation failure surfaces
    // through the handler as 429 {error: {message, type:
    // "rate_limit_error"}} — status, type and message (reset hint
    // included) all match the door. Exact parity; no diffs declared.
    const facade = { status: 429, body: errorBody("Subscription quota exhausted", "rate_limit_error") }
    expectDiffs(door.body, facade.body, [])
    expect(door.status).toBe(429)
    expect(facade.status).toBe(429)
  })

  test("models list: door serves the Muse catalog, façade serves routes + concrete refs", () => {
    // Door recording: entries {id, object: "model", created: <now>,
    // owned_by: "meta-muse"} for each Muse model plus one per
    // effort suffix. The façade's single-model lookup echoes a
    // concrete muse ref with the provider as owner.
    expect(modelBody("meta-muse/muse-spark-1.3")).toEqual({
      id: "meta-muse/muse-spark-1.3",
      object: "model",
      created: 0,
      owned_by: "meta-muse",
    })
    // classification: acceptable-by-design — different catalogs by
    // design (façade §2); per-model shape fields agree.
  })
})

// ------------------------------------------------------------ muse attestation (MANDATORY)
//
// Design §9.1 + #1152 scope: a request whose tool list names `shell`
// or `bash`. Recorded door behaviour (bin/muse-proxy.mjs,
// DIRECT_TOOL_ALIASES and tryDirectChat; bin/muse-proxy.test.mjs
// tests "the shell tool is aliased upstream and its calls translate
// back", "/v1/responses aliases the shell tool…", and "an attestation
// denial falls back to the CLI door"):
//
//   1. The door RENAMES shell→run_command and bash→terminal in the
//      upstream request (tool definitions, history function_call
//      items, tool_choice) and translates returned calls back, so the
//      caller sees its own names and a normal 200 answer.
//   2. If the upstream still answers 403 with the recorded body
//      {error: {code: "client_attestation_denied", message: "This API
//      key is billed to a Muse Code subscription. Muse Code
//      subscriptions cover requests from the Muse Code client
//      only.", type: "permission_error"}}, the chat front falls back
//      to the CLI door and the caller STILL gets a 200 completion
//      (the door test's exec stub answers "Hello world").
//   3. The /v1/responses front passes a 403 through only when no
//      aliasing was needed; with aliasing it relays the (successful)
//      upstream answer with names translated back.
//
// Façade behaviour (design §9.1 rule): tool names are NEVER renamed,
// dropped, or synthesized, and there is no CLI door behind the
// façade — an attestation 403 from the muse provider is a provider
// failure (eligible for route failover to a DIFFERENT candidate),
// not a successful answer from the same target.

describe("door: muse — attestation case (shell/bash tools)", () => {
  const shellChatRequest = {
    model: "muse-spark-1.3",
    messages: [
      { role: "user", content: "run echo hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_0", type: "function", function: { name: "shell", arguments: '{"command":"echo hi"}' } }],
      },
      { role: "tool", tool_call_id: "call_0", content: "hi" },
      { role: "user", content: "what did it print?" },
    ],
    tools: [{ type: "function", function: { name: "shell", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
  }

  test("door recording: shell is aliased upstream and translated back; 403 falls back to CLI", () => {
    // Transcribed assertions from the door's own tests (see header):
    const doorUpstreamToolNames = ["run_command"] // upstream sees the alias
    const doorCallerToolName = "shell" // caller sees its own name back
    const doorAttestationFallback = { status: 200, content: "Hello world", via: "cli-exec-fallback" }
    expect(doorUpstreamToolNames).toEqual(["run_command"])
    expect(doorCallerToolName).toBe("shell")
    expect(doorAttestationFallback.status).toBe(200)
  })

  test("façade: shell/bash tool names are preserved verbatim — never aliased, never dropped", () => {
    const chat = parseChatRequest({
      ...shellChatRequest,
      tools: [
        ...shellChatRequest.tools,
        { type: "function", function: { name: "bash", description: "Run a bash command", parameters: { type: "object", properties: {} } } },
      ],
    })
    if (!chat.ok) throw new Error(chat.error)
    expect(chat.value.input.tools?.map((t) => t.name)).toEqual(["shell", "bash"])

    const responses = parseResponsesRequest({
      model: "muse-spark-1.3",
      input: [
        { type: "function_call", call_id: "call_0", name: "shell", arguments: '{"command":"echo hi"}' },
        { type: "function_call_output", call_id: "call_0", output: "hi" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "what did it print?" }] },
      ],
      tools: [{ type: "function", name: "bash", description: "Run a bash command", parameters: { type: "object", properties: {} } }],
    })
    if (!responses.ok) throw new Error(responses.error)
    expect(responses.value.input.tools?.map((t) => t.name)).toEqual(["bash"])
    expect(responses.value.items[0]).toMatchObject({ type: "function_call", name: "shell" })

    // And a model call to `shell` renders back out under that exact
    // name on both façade dialects — no alias ever leaks or applies.
    const callEvents = [
      LLMEvent.toolCall({ id: "call_9", name: "shell", input: { command: "echo hi" } }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
    ]
    const chatBody = completionBody({ id: "chatcmpl-facade", created: CREATED, model: "muse-spark-1.3", response: responseOf(callEvents) })
    expect(chatBody.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("shell")
    const respBody = responsesBody({ id: "resp_facade", created: CREATED, model: "muse-spark-1.3", response: responseOf(callEvents) })
    expect(respBody.output.find((item) => item.type === "function_call")).toMatchObject({ name: "shell" })
  })

  test("verdict: attestation outcome is a parity FAIL, recorded not papered over", () => {
    // The caller-visible outcomes differ in kind:
    //   door:   200 completion (aliasing, or CLI fallback on a 403)
    //   façade: the same request, sent verbatim to the muse provider,
    //           draws the recorded 403 client_attestation_denied and
    //           surfaces as a provider failure (failover to another
    //           route candidate, or the 502 error envelope) — there
    //           is no alias and no CLI door to rescue it.
    // Design §9.1 sanctions the façade rule (never rename/strip; a
    // 403 is failover-eligible), so this is a deliberate divergence —
    // but #1152's acceptance rule is that the merged proxy be THE
    // SAME, and by that rule this case FAILS. It gates the muse
    // front's retirement in Wave C (#1155) until Drew accepts the
    // §9.1 rule as the replacement behaviour or the muse provider
    // gains door-side aliasing. Filed as #1443.
    const outcome = {
      door: "200 via alias (run_command/terminal) or CLI fallback",
      facade: "403 surfaces as provider failure / failover; no 200 from the muse target",
      classification: "fail" as Classification,
    }
    expect(outcome.classification).toBe("fail")
  })
})


// ------------------------------------------------------------ clef (systemone)

describe("door: clef (bin/clef-proxy.mjs :18742) — systemone family (#1410)", () => {
  // Recordings transcribed from developing-today/code
  // bin/clef-proxy.mjs + bin/clef-proxy.test.mjs (the door's own stub
  // fixtures, #690/#692/#2410/#2938 cases) and one live capture against
  // the running door on 2026-11-02 (the probe below). The façade side
  // is @opencode/core/systemone's translation layer; the HTTP-level
  // pairs (status codes through the real handler, stub upstream) live
  // in packages/server/test/facade-parity.test.ts.

  const probeRequest = {
    state: { request: "Which of these is a colour: blue or table?" },
    questions: {
      probe: {
        type: "choice",
        instructions: "Pick the word that names a colour.",
        criteria: { blue: "A colour.", table: "A piece of furniture." },
      },
    },
    model: "@cf/cloudflare/clef-flash",
  }
  // Live door capture (2026-11-02, no Authorization header — the
  // door's file token served it): the typed probability answer shape.
  const probeDoorAnswers = {
    probe: { type: "choice", choice: "blue", probabilities: { blue: 0.8947, table: 0.1053 }, confidence: 0.6232 },
  }

  test("classification request parses and forwards only {state, questions} upstream", () => {
    const parsed = parseSystemOneRequest(probeRequest)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.model).toBe("@cf/cloudflare/clef-flash")
    expect(parsed.value.state).toEqual(probeRequest.state)
    expect(parsed.value.questions).toEqual(probeRequest.questions)
    // The upstream payload the service builds is exactly {state,
    // questions} (systemone.ts evaluate) — the door drops every other
    // body field the same way.
    expect(Object.keys({ state: parsed.value.state, questions: parsed.value.questions })).toEqual(["state", "questions"])
  })

  test("success shape is exactly {answers} — no diff from the door", () => {
    // Door (stub fixture, clef-proxy.test.mjs happy path): 200
    // {answers: <upstream result.answers>}. Façade: answersBody of the
    // same upstream answers. The live capture's answer values are the
    // canonical pair here.
    expectDiffs({ answers: probeDoorAnswers }, answersBody(probeDoorAnswers), [])
  })

  test("noul (permission) question shape passes through verbatim", () => {
    // OpenChamber's Jev permission request (routing/jev.js
    // buildPermissionRequest): a noul question plus a choice question.
    const body = {
      state: { permission: { type: "bash", patterns: ["rm -rf /tmp/x"], metadata: {} } },
      questions: {
        ask: { type: "noul", instructions: "Should the agent stop and ask the user first?" },
        kind: { type: "choice", instructions: "What is the most significant effect?", criteria: { deletes_data: "Deletes files." } },
      },
    }
    const parsed = parseSystemOneRequest(body)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.questions).toEqual(body.questions)
    expect(parsed.value.model).toBe("@cf/cloudflare/clef-flash")
  })

  test("array and non-object bodies are a 400 with the door's exact message, before upstream (#2938)", () => {
    // Door fixture: [] and [1,2] → 400 {error:"Invalid JSON body:
    // expected an object"} and the stub upstream is never hit.
    for (const raw of [[], [1, 2], null, "text", 42]) {
      const parsed = parseSystemOneRequest(raw)
      if (parsed.ok) throw new Error(`expected refusal for ${JSON.stringify(raw)}`)
      expect(parsed.error).toBe("Invalid JSON body: expected an object")
      expect(systemOneErrorBody(parsed.error)).toEqual({ error: "Invalid JSON body: expected an object" })
    }
  })

  test("missing state/questions default to {} exactly as the door forwards them", () => {
    const parsed = parseSystemOneRequest({})
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.state).toEqual({})
    expect(parsed.value.questions).toEqual({})
  })

  test("model resolution matches the door's table, hostile models refused with the door's message (#2410)", () => {
    const controls: Array<[unknown, string]> = [
      [undefined, "@cf/cloudflare/clef-flash"],
      ["clef", "@cf/cloudflare/clef"],
      ["clef-flash", "@cf/cloudflare/clef-flash"],
      ["@cf/cloudflare/clef", "@cf/cloudflare/clef"],
      ["@cf/cloudflare/clef-omni", "@cf/cloudflare/clef-omni"],
    ]
    for (const [input, resolved] of controls) expect(resolveModel(input)).toBe(resolved)
    const hostile = [
      "@cf/meta/llama-3.1-8b-instruct",
      "@cf/cloudflare/../../ai/models/search",
      "clef/../../../../client/v4/accounts/OTHER/ai/run/x",
      "@cf/cloudflare/clef?per_page=1#frag",
      "my-clef-thing",
    ]
    for (const model of hostile) {
      const parsed = parseSystemOneRequest({ state: {}, questions: {}, model })
      if (parsed.ok) throw new Error(`expected refusal for ${model}`)
      expect(parsed.error).toContain("Refused model")
      expect(parsed.error).toContain("only Clef-family models (@cf/cloudflare/clef*) are served by this proxy")
    }
  })

  test("error envelopes are the door's plain {error} shape, not the OpenAI shape", () => {
    // Door: 401 {error:"Missing Cloudflare AI inference API token"};
    // upstream failure {error:"Cloudflare Workers AI Clef execution
    // failed", details:<upstream body>}; timeout 504 {error:"…
    // timed out"}. The façade reproduces all three verbatim
    // (systemone.ts); the OpenAI doors' {error:{message,type}} shape
    // is NOT used here — that is the systemone standard's own envelope.
    expect(systemOneErrorBody("Missing Cloudflare AI inference API token")).toEqual({ error: "Missing Cloudflare AI inference API token" })
    expect(upstreamFailureBody({ success: false })).toEqual({ error: "Cloudflare Workers AI Clef execution failed", details: { success: false } })
    expect(systemOneErrorBody("Cloudflare Workers AI Clef request timed out")).toEqual({ error: "Cloudflare Workers AI Clef request timed out" })
  })

  test("models floor: the door's static floor is advertised with the door's owned_by", () => {
    const listed = modelsBody().data.filter((m) => m.owned_by === "cloudflare-workers-ai")
    expect(listed.map((m) => m.id)).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"])
  })

  test("verdict: clef systemone family is PARITY with two named acceptable-by-design diffs", () => {
    // Named diffs (both acceptable-by-design under Drew's rulings —
    // neither changes a caller-visible contract for systemone
    // clients):
    //  1. /v1/models: the door serves the LIVE Cloudflare catalog
    //     subset (5-min TTL + last-known-good); the façade advertises
    //     the door's static floor in the shared models list. Callers
    //     addressing a live-only model (clef-omni) still resolve —
    //     model lookup passes provider/model refs through and the
    //     systemone grammar accepts the whole Clef family.
    //  2. GET /v1/systemone and /systemone// health aliases and the
    //     door's non-/v1 /systemone POST alias are not reproduced:
    //     the standard endpoint is POST /v1/systemone (Drew's §9.5
    //     supersession for this family names /v1/systemone; the Jev
    //     client only ever POSTs the configured /v1/systemone URL).
    const outcome = {
      door: "POST /v1/systemone (+ /systemone, / aliases), live /v1/models",
      facade: "POST /v1/systemone, static-floor Clef entries in /v1/models",
      classification: "acceptable-by-design" as Classification,
    }
    expect(outcome.classification).toBe("acceptable-by-design")
  })
})

// ------------------------------------------------------------ claude-code
//
// Door: bin/claude-code-proxy.mjs (:18749) in developing-today/code.
// Recordings transcribed from that file and
// bin/claude-code-proxy.test.mjs: the front is chat-completions +
// models only, backed by the Claude Code CLI — ONE persistent
// stream-json process per conversation (`claude -p --input-format
// stream-json --output-format stream-json --verbose
// --include-partial-messages`), keyed like commandcode-proxy keys
// its ACP threads (explicit session headers / body ids, else
// `user:`, else `turn0:<sha256(first user message)>`). Callers send
// FULL history every request; the door hash-verifies the prefix
// against its stored mapping and sends only the newest user turn to
// the resident process (delta decision in trySessionChat). A
// diverged prefix re-bootstraps a fresh session whose first turn is
// the full flattened transcript; the key -> CLI session map
// persists to the shared CLI-proxy state root so a proxy restart
// re-attaches with `--resume`. Auth is the CLI's own claude.ai
// OAuth login (~/.claude, read in place; ANTHROPIC_API_KEY is
// stripped from the child env) — Gate 1 credential story recorded
// on #1412: the fork runs as the same user/HOME, so the façade ->
// provider -> door chain inherits the login by construction and
// the CLI keeps owning refresh. The provider is DISABLED in the
// deployed fleet config (Drew, 2026-10-27, free-tier pause) and the
// inventory on #1412 found NO live front callers, so the door
// process stays as the provider backend in this wave (#1412) —
// the façade chain is façade -> `claude-code` provider -> door ->
// CLI, and the cases below diff the caller-facing wire shapes.

describe("door: claude-code (bin/claude-code-proxy.mjs :18749)", () => {
  const MODEL = "claude-code/claude-haiku-5-5"
  const CLI_MODEL = "claude-haiku-5-5"
  const modelEchoDiff = {
    path: "model",
    classification: "acceptable-by-design",
    note: "The door's resolveModel strips any provider prefix (everything up to the last /) and echoes the bare CLI id; the façade echoes the caller's full provider/model ref (design §2 label rule, same pattern as the codex/commandcode cases). Behind the façade the provider call sends the same bare CLI id to the door, so the resolved model is identical.",
  } as const
  // The door test stub's result usage: input_tokens 100,
  // output_tokens 5, cache_read_input_tokens 80. The door FOLDS
  // cache tokens into prompt_tokens (100 + 80 = 180, total 185) and
  // never emits prompt_tokens_details; the façade reports the
  // non-cached input as prompt_tokens and surfaces the cache read
  // as prompt_tokens_details.cached_tokens (OpenAI convention, the
  // §3114 shape the codex/commandcode doors also use). The total
  // input (180) and total_tokens (185) agree; only the split moves.
  const usageDiffs = [
    {
      path: "usage.prompt_tokens",
      classification: "real-gap",
      note: "Accounting split differs: door prompt_tokens folds cache-read in (180 = 100 input + 80 cache read); façade prompt_tokens is the non-cached input (100) with the 80 carried in prompt_tokens_details.cached_tokens. A caller summing prompt_tokens + cached_tokens recovers the door's number exactly; a caller reading prompt_tokens alone sees a smaller figure. Total input and total_tokens are identical.",
    },
    {
      path: "usage.prompt_tokens_details",
      classification: "acceptable-by-design",
      note: "Additive: the façade emits prompt_tokens_details {cached_tokens} (the OpenAI-convention detail, present in the codex/commandcode door shapes); the claude-code door omits the field and folds the value into prompt_tokens instead.",
    },
  ] as const
  const stubUsage = { inputTokens: 100, outputTokens: 5, totalTokens: 185, cacheReadInputTokens: 80 }

  test("chat non-streaming, stub fixture: parity except model echo and the cache-token usage split", () => {
    // Door recording (claude-code-proxy.test.mjs, "two turns" test):
    // the stub CLI's result text is "ECHO:remember BANANA rest"
    // with the usage above; the door builds the body inline —
    // message content, finish_reason "stop", usage 180/5/185, id
    // prefix chatcmpl-claude-code-. The door test pins
    // prompt_tokens === 180 (100 input + 80 cache read).
    const door = {
      id: "chatcmpl-claude-code-00000000-0000-0000-0000-000000000000",
      object: "chat.completion",
      created: CREATED,
      model: CLI_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ECHO:remember BANANA rest" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 180, completion_tokens: 5, total_tokens: 185 },
    }
    const parsed = parseChatRequest({ model: MODEL, messages: [{ role: "user", content: "remember BANANA" }] })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(String(parsed.value.input.model?.providerID)).toBe("claude-code")
    expect(String(parsed.value.input.model?.id)).toBe(CLI_MODEL)
    const facade = completionBody({
      id: "chatcmpl-facade",
      created: CREATED,
      model: parsed.value.modelLabel,
      response: responseOf([
        LLMEvent.textDelta({ id: "t1", text: "ECHO:remember BANANA rest" }),
        LLMEvent.finish({ reason: { normalized: "stop" }, usage: stubUsage }),
      ]),
    })
    expectDiffs(door, facade, [modelEchoDiff, ...usageDiffs])
  })

  test("chat streaming, stub fixture: façade adds role to the first delta; usage split as non-streaming", () => {
    // Door recording (claude-code-proxy.test.mjs, "streaming emits
    // SSE deltas and a finish chunk"): content chunks carry delta
    // {content} with NO role; the terminal chunk carries delta {},
    // finish_reason "stop" and the usage; then [DONE].
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "ECHO:stre" }),
      LLMEvent.textDelta({ id: "t1", text: " rest" }),
      LLMEvent.finish({ reason: { normalized: "stop" }, usage: stubUsage }),
    ]
    const door = [
      { object: "chat.completion.chunk", delta: { content: "ECHO:stre" }, finish_reason: null },
      { object: "chat.completion.chunk", delta: { content: " rest" }, finish_reason: null },
      {
        object: "chat.completion.chunk",
        delta: {},
        finish_reason: "stop",
        usage: { prompt_tokens: 180, completion_tokens: 5, total_tokens: 185 },
      },
      "[DONE]",
    ]
    expectDiffs(door, facadeChatFrames(events, MODEL), [
      {
        path: "[0].delta.role",
        classification: "acceptable-by-design",
        note: "The façade follows the OpenAI convention of role:\"assistant\" on the first chunk; the claude-code door omits it (same diff as the codex/commandcode doors). Content, finish and [DONE] are identical.",
      },
      {
        path: "[2].usage.prompt_tokens",
        classification: "real-gap",
        note: "Same cache-token split as the non-streaming case: door folds cache read into prompt_tokens (180); façade reports 100 plus prompt_tokens_details.cached_tokens 80.",
      },
      {
        path: "[2].usage.prompt_tokens_details",
        classification: "acceptable-by-design",
        note: "Additive OpenAI-convention detail; the door omits the field (see the non-streaming case).",
      },
    ])
  })

  test("session continuity: door sends delta-only turns to a resident CLI process; façade carries full history (§9.2)", () => {
    // Door recording (claude-code-proxy.mjs getSessionKey +
    // trySessionChat delta decision; claude-code-proxy.test.mjs
    // "two turns: second turn sends only the newest user message"):
    // the conversation key comes from an explicit id header/body
    // field, else `user:<user>`, else `turn0:<sha256(first user
    // message)>`. A request whose stored prefix hashes match and
    // whose only new content is one trailing user message sends
    // ONLY that message to the resident process — the door test's
    // stub log proves turn 2's line contains "what was it?" and
    // NOT "BANANA". A diverged prefix kills the process and
    // re-bootstraps a fresh session with the full flattened
    // transcript (door test "diverged history re-bootstraps…").
    const doorTurn2 = {
      keyDerivation: ["explicit id", "user:", "turn0:first-user-hash"],
      resumedSend: "latest user turn only",
      freshSend: "full flattened transcript",
      engine: "resident stream-json CLI process per conversation key",
    }
    expect(doorTurn2.resumedSend).toBe("latest user turn only")
    // Façade (§9.2 documented change): stateless per request — the
    // SAME turn-2 request arrives with the full history and the
    // façade carries ALL of it into generation; nothing is keyed,
    // retained, or delta-compressed at the façade.
    const turn2 = parseChatRequest({
      model: MODEL,
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "remember BANANA" },
        { role: "assistant", content: "ECHO:remember BANANA rest" },
        { role: "user", content: "what was it?" },
      ],
    })
    if (!turn2.ok) throw new Error(turn2.error)
    // The parser lifts the system message out of the message list
    // (it rides as generation instructions); all three conversation
    // messages are carried verbatim.
    expect(turn2.value.input.messages.length).toBe(3)
    expect(JSON.stringify(turn2.value.input)).toContain("You are terse.")
    expect(JSON.stringify(turn2.value.input.messages)).toContain("BANANA")
    expect(JSON.stringify(turn2.value.input.messages)).toContain("what was it?")
    // classification: acceptable-by-design — design §9.2 names this
    // the one knowingly-unpreserved behaviour. Mitigations recorded
    // on #1412: (a) the inventory found NO delta-only caller — the
    // door's delta logic itself REQUIRES full-history requests
    // (it hash-verifies the caller's prefix), and the only caller
    // class, OpenCode sessions via the AI SDK, always sends full
    // history; (b) in the deployed chain the door remains the
    // backend, keyed by the first user message — stable across a
    // conversation's full-history requests — so the resident-
    // process delta optimization still applies behind the façade;
    // (c) the door's own stub suite proves the delta mechanics
    // end-to-end (its stub log shows turn 2 arriving delta-only;
    // run on the laptop 2026-11-02, 7/7 pass). A LIVE two-turn
    // attempt against the running door the same day did NOT
    // complete: door-spawned CLI children inherit the door's
    // default sandbox egress proxy (hatch-egress-proxy), which
    // does not resolve on the laptop, and a direct CLI probe
    // answered that the organization has disabled Claude
    // subscription access for Claude Code — so no live recall is
    // claimed; the correction is recorded on #1412. A caller that wants
    // façade-side state instead uses /v1/responses +
    // previous_response_id (§4).
  })

  test("process death mid-conversation: door masks it with one fresh full-transcript retry; façade has no resident state to lose", () => {
    // Door recording (claude-code-proxy.mjs ClaudeSession._onExit +
    // trySessionChat catch + the chat handler's retry): when the
    // resident process dies (or a turn fails) before any content is
    // committed, the door drops the live + stored mapping and the
    // handler retries ONCE with a fresh session whose first turn is
    // the full flattened transcript — the caller sees a normal 200.
    // The mapping is also re-attached across proxy restarts with
    // --resume from the persisted sessions.json. If content was
    // already streamed, no retry: an SSE error frame + [DONE]
    // (streaming failure case below).
    const doorDeath = {
      beforeContent: "drop mapping, retry once, fresh session, full transcript",
      callerSees: 200,
      acrossRestart: "--resume from persisted key -> sessionId map",
    }
    expect(doorDeath.callerSees).toBe(200)
    // Façade: there is no per-conversation process, so there is
    // nothing to die mid-conversation and nothing to mask — a
    // provider failure surfaces as 502 (failure cases below) and
    // the NEXT request is a fresh, self-contained generation from
    // the caller's full history. In the deployed chain the door
    // sits behind the façade as the provider backend, so its
    // death-masking retry still applies to real traffic.
    // classification: acceptable-by-design — outcome class differs
    // only for a hypothetical direct caller of the door's front
    // (the inventory found none, #1412); behind the façade the
    // behaviour is preserved by construction.
    const retryShape = parseChatRequest({
      model: MODEL,
      messages: [
        { role: "user", content: "remember BANANA" },
        { role: "assistant", content: "ECHO:remember BANANA rest" },
        { role: "user", content: "what was it?" },
      ],
    })
    if (!retryShape.ok) throw new Error(retryShape.error)
    expect(retryShape.value.input.messages.length).toBe(3)
  })

  test("tools in the request: the CLI consumes them itself; façade forwards them verbatim", () => {
    // Door recording (claude-code-proxy.mjs ClaudeSession
    // ._onMessage): tool approvals arrive as can_use_tool control
    // requests and are answered allow — the CLI runs its OWN tools
    // in the per-conversation workdir and the bridge returns its
    // final text. The wire answer is a plain text completion with
    // NO tool_calls, whatever tools the caller named; the door's
    // output builder only ever reads text deltas / result text.
    const door = {
      id: "chatcmpl-claude-code-00000000-0000-0000-0000-000000000000",
      object: "chat.completion",
      created: CREATED,
      model: CLI_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 180, completion_tokens: 5, total_tokens: 185 },
    }
    // Façade: the caller's tools are parsed and forwarded to the
    // provider verbatim (never renamed, dropped, or synthesized —
    // the §9.1 rule), and the text answer this backend returns
    // renders in the identical wire shape.
    const parsed = parseChatRequest({
      model: MODEL,
      messages: [{ role: "user", content: "write it" }],
      tools: [{ type: "function", function: { name: "write_file", description: "write a file", parameters: { type: "object", properties: {} } } }],
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.input.tools?.map((t) => t.name)).toEqual(["write_file"])
    const facade = completionBody({
      id: "chatcmpl-facade",
      created: CREATED,
      model: parsed.value.modelLabel,
      response: responseOf([
        LLMEvent.textDelta({ id: "t1", text: "done" }),
        LLMEvent.finish({ reason: { normalized: "stop" }, usage: stubUsage }),
      ]),
    })
    expectDiffs(door, facade, [modelEchoDiff, ...usageDiffs])
    // classification: acceptable-by-design — in the deployed chain
    // the provider behind the façade IS this door, so the CLI's
    // tool agency is preserved by construction. (If the backend is
    // ever replaced by a native provider, agency semantics change
    // with it — a backend-wave decision, §8.)
  })

  test("CLI failure, non-streaming: door answers a bare 500 after its one retry; façade 502 with the detail preserved", () => {
    // Door recording (claude-code-proxy.test.mjs "failed turn
    // surfaces an error and the session is retryable"): the stub
    // answers FAILME with result subtype error_during_execution /
    // "stub failure" on both the primary session and the fresh
    // retry, so the handler's final fallback answers 500
    // `{error: {message: "Claude Code execution failed"}}` — the
    // detail is DROPPED on this path, and there is no `type`.
    const door = { status: 500, body: { error: { message: "Claude Code execution failed" } } }
    expect("type" in door.body.error).toBe(false)
    // Façade: the handler maps a generation failure to 502 with
    // Completions.errorBody(message, "server_error") — the
    // provider's message is preserved verbatim.
    const facade = { status: 502, body: errorBody("claude turn failed: stub failure", "server_error") }
    expectDiffs(door.body, facade.body, [
      {
        path: "error.message",
        classification: "real-gap",
        note: "Framing AND content differ: after its one fresh-session retry the door answers the bare fixed string 'Claude Code execution failed' (the CLI detail survives only in the door's log); the façade passes the provider detail through. Direction favours the façade, but a caller string-matching the door's bare message sees a different body.",
      },
      {
        path: "error.type",
        classification: "real-gap",
        note: "Claude-code door errors carry no type at all; the façade always emits one (server_error). Also: door status for an execution failure is 500, façade 502 (asserted below).",
      },
    ])
    expect(door.status).toBe(500)
    expect(facade.status).toBe(502)
  })

  test("CLI failure, streaming after first content: door frames the error then [DONE]; façade ends without [DONE]", () => {
    // Door recording (trySessionChat catch, headed branch): once
    // deltas are on the wire the turn cannot be retried, so the
    // door writes one `data: {error: {message: "Claude Code
    // execution failed: <detail>"}}` event, then `data: [DONE]`.
    const door = { frames: [{ error: { message: "Claude Code execution failed: claude turn failed: stub failure" } }, "[DONE]"] }
    // Façade: a provider-error event becomes the same-shaped error
    // frame (with the façade's type), and the handler appends NO
    // [DONE] after a failed stream (translator.failed rule).
    const translator = new ChatStreamTranslator({ id: "chatcmpl-facade", created: CREATED, model: MODEL })
    const frames = translator.push(LLMEvent.providerError({ message: "claude turn failed: stub failure" }))
    if (!translator.failed) throw new Error("expected the translator to mark the stream failed")
    const facade = { frames: chatFramesOf(frames) }
    expectDiffs(door, facade, [
      {
        path: "frames.length",
        classification: "real-gap",
        note: "On the mid-stream provider-error path the door closes with [DONE] after the error frame while the façade translator marks the stream failed and the handler appends no [DONE] (minor: a client reading to close sees the error either way). A whole-stream failure — the Generate stream failing before any event — is error frame + [DONE] on BOTH sides; the server suite pins that case.",
      },
      {
        path: "frames[0].error.message",
        classification: "real-gap",
        note: "Same framing diff as the non-streaming failure: door prefixes 'Claude Code execution failed: ', façade passes the provider message through.",
      },
      {
        path: "frames[0].error.type",
        classification: "real-gap",
        note: "Door error frames carry no type; the façade's carries server_error.",
      },
    ])
  })

  test("empty + malformed bodies: door 400s both; façade 400s malformed, accepts empty messages at parse", () => {
    // Door recordings: an empty messages array is 400
    // `{error: {message: "Messages cannot be empty"}}`; a
    // non-object JSON body is 400 `{error: {message: "Invalid JSON
    // body: expected an object"}}` and invalid JSON is 400
    // `Invalid JSON body: <parse error>` (door test #2816 pins
    // null / [1,2] / "x" / 42 → 400 and the proxy staying alive).
    // Neither carries a `type`.
    const doorEmpty = { status: 400, body: { error: { message: "Messages cannot be empty" } } }
    expect(doorEmpty.status).toBe(400)
    // Façade: a non-object body fails parse ("request body must be
    // a JSON object") and the handler answers 400
    // invalid_request_error — status parity, typed envelope
    // (acceptable-by-design: the façade's validation envelopes are
    // the OpenAI-standard typed form on every door).
    const bad = parseChatRequest(null)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBe("request body must be a JSON object")
    // But an EMPTY messages array parses clean on the façade and
    // proceeds to generation, where the door rejects it up front.
    const empty = parseChatRequest({ model: MODEL, messages: [] })
    expect(empty.ok).toBe(true)
    // classification: real-gap (minor) — a caller-visible strictness
    // difference on an edge input; valid requests are unaffected.
    // Recorded on #1412; no issue filed (no live caller sends empty
    // message lists — the inventory found no front callers at all).
  })

  test("responses non-streaming + streaming: door has no /v1/responses", () => {
    // Door recording: the fallthrough answers any other route with
    // 404 `{error: {message: "Route not found: POST /v1/responses"}}`
    // (no type).
    const door = { status: 404, body: { error: { message: "Route not found: POST /v1/responses" } } }
    expect(door.status).toBe(404)
    expect("type" in door.body.error).toBe(false)
    const parsed = parseResponsesRequest({ model: MODEL, input: "hi" })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.stream).toBe(false)
    // classification: acceptable-by-design — façade superset
    // (design §2/§9.6); claude-code callers gain /v1/responses —
    // including previous_response_id chains, the §9.2-sanctioned
    // stateful alternative to the door's resident processes — by
    // repointing.
  })

  test("models list: door serves the verified floor ∪ CLI-observed ids; façade serves routes + concrete refs", () => {
    // Door recording (claude-code-proxy.mjs MODELS +
    // getServedModels): GET /v1/models serves the verified static
    // floor (claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5)
    // UNION every model id found in the CLI's own recent session
    // records (~/.claude/projects/**/*.jsonl, rescanned on a 60s
    // TTL) — a documented exception to the live-catalog rule: the
    // CLI exposes no list command and Anthropic's GET /v1/models
    // rejects this account's OAuth token (403
    // oauth_not_allowed_for_organization, verified 2026-10-28).
    // Entries are {id, object: "model", created: <now>, owned_by:
    // "anthropic-claude-code"} with BARE ids. Any other requested
    // id is passed through to the CLI untouched (resolveModel only
    // strips a provider prefix; empty → the haiku default).
    // The façade list is the route set (route case above); a
    // concrete claude-code ref is instead served by the single-
    // model lookup, echoed with the provider as owner — the
    // per-model entry shape agrees except owned_by (the door's
    // "anthropic-claude-code" vs the façade's provider id) and the
    // created stamp (door: now; façade: 0).
    expect(modelBody(MODEL)).toEqual({ id: MODEL, object: "model", created: 0, owned_by: "claude-code" })
    // Unknown concrete ids pass through on BOTH sides (door: to
    // the CLI; façade: as a provider/model ref).
    const unknown = parseChatRequest({ model: "claude-code/claude-sonnet-9-9", messages: [{ role: "user", content: "hi" }] })
    if (!unknown.ok) throw new Error(unknown.error)
    expect(String(unknown.value.input.model?.providerID)).toBe("claude-code")
    expect(String(unknown.value.input.model?.id)).toBe("claude-sonnet-9-9")
    // Repointing trap, pinned deliberately: the door's BARE id
    // (claude-haiku-5-5) sent to the façade parses as a ROUTE name
    // (design §2 grammar: bare names resolve to routes), not as
    // this provider's model. Front callers must use the full
    // claude-code/… ref; recorded on #1412 as the migration note
    // for this door.
    const bare = parseChatRequest({ model: CLI_MODEL, messages: [{ role: "user", content: "hi" }] })
    if (!bare.ok) throw new Error(bare.error)
    expect(String(bare.value.input.model?.providerID)).toBe("opencode-route")
    // classification: acceptable-by-design — design §2's grammar
    // applied uniformly; the provider-prefixed form is the
    // documented caller form for every concrete ref.
  })
})

// ------------------------------------------------------------ verdict registry

/** The per-door verdicts recorded on #1152 (and cross-referenced
 * from #1146). Rule: any "fail" case ⇒ FAIL; else any declared diff
 * ⇒ PARITY-WITH-NAMED-DIFFS; else PARITY. No door is UNPROVEN: every
 * door's wire behaviour is exercised here from its own recorded
 * fixtures (live backends were not needed — the doors' stub fixtures
 * are the captures, per the no-paid-traffic constraint). */
export const VERDICTS = {
  route: {
    verdict: "PARITY-WITH-NAMED-DIFFS",
    diffs: ["model echo for bare route names", "error type proxy_error vs server_error", "responses + concrete refs are façade-only supersets", "non-text content rejected on the translated path"],
  },
  codex: {
    verdict: "PARITY-WITH-NAMED-DIFFS",
    diffs: ["first streaming chunk gains role:\"assistant\"", "error envelope: door has no type and uses 500, façade has server_error and 502", "responses front is a façade-only superset", "bare catalog ids read as route names"],
  },
  designCode: {
    verdict: "PARITY-WITH-NAMED-DIFFS",
    diffs: [
      "REAL-GAP models list: door lists the 11 persona ids (owned_by design-code); façade /v1/models advertises only the six tier routes — persona routes resolve/complete but are not listed (#1413)",
      "streaming: door relays the backend's empty initial role frame; façade emits role with first text (one-frame shift)",
      "error envelopes: door bodies have no type field; façade adds OpenAI type (additive, §2)",
      "AMR caller-Bearer verbatim bypass does not carry over (façade Bearer is the server credential; raw AMR is the opendesign provider) — Gate 1 on #1413",
    ],
  },
  muse: {
    verdict: "FAIL",
    diffs: [
      "ATTESTATION: door answers shell/bash requests with a 200 (alias + CLI fallback); façade preserves names and surfaces the 403 as a provider failure — outcome differs (design §9.1 rule; Wave C gate for #1155, filed as #1443)",
      "responses streaming: §5 grammar closed by #1442 — façade emits response.in_progress, per-item added/done + matching *.done events and monotonic sequence_numbers, reasoning uses response.reasoning_summary_text.delta, and response.completed carries the full output (door stub fixture is an abbreviated mid-grammar capture)",
      "tool-only chat answers: content null (façade) vs \"\" (door)",
      "responses non-streaming: façade adds created_at/annotations/status/default fields (additive)",
      "chat streaming: façade adds role:\"assistant\" to the first chunk",
    ],
  },
  clef: {
    verdict: "PARITY-WITH-NAMED-DIFFS",
    diffs: [
      "/v1/models: door serves the live Cloudflare catalog subset; façade advertises the door's static floor (live-only models still resolve via pass-through + grammar)",
      "health and non-/v1 aliases (GET /v1/systemone, /systemone, /) not reproduced — the standard endpoint is POST /v1/systemone",
    ],
  },
  "claude-code": {
    verdict: "PARITY-WITH-NAMED-DIFFS",
    diffs: [
      "model echo: door echoes the resolved bare CLI id (provider prefix stripped); façade echoes the caller's full provider/model ref",
      "usage split: door folds cache-read tokens into prompt_tokens (180 = 100 + 80 in the stub fixture); façade reports prompt_tokens 100 plus prompt_tokens_details.cached_tokens 80 — totals identical",
      "chat streaming: façade adds role:\"assistant\" to the first chunk",
      "CLI-failure envelope: door answers a bare 500 'Claude Code execution failed' (detail dropped after its one retry) with no error type; façade answers 502 with type server_error and the provider detail preserved; streaming failure: door appends [DONE] after the error frame, façade matches on whole-stream failures but ends a mid-stream provider-error without [DONE]",
      "session continuity: door keeps one resident stream-json CLI process per conversation and sends delta-only turns (§9.2); façade is stateless — callers send full history or use responses chains (documented change; behind the façade the door-as-backend still applies its delta optimization, and its process-death retry is preserved by the same construction)",
      "empty messages array: door 400s 'Messages cannot be empty'; façade parser accepts it and the request fails later in generation",
      "models list: door serves the verified floor ∪ CLI-observed ids (bare ids, owned_by anthropic-claude-code, created=now); façade serves routes + concrete refs (owned_by claude-code, created 0) — per-model entry shape agrees via the single-model lookup except owned_by; bare CLI ids read as route names at the façade, so repointing callers must use the claude-code/… ref",
      "responses front is a façade-only superset (door 404s /v1/responses)",
    ],
  },
} as const

test("verdict registry is consistent with the recorded classifications", () => {
  expect(Object.keys(VERDICTS).sort()).toEqual(["claude-code", "clef", "codex", "designCode", "muse", "route"])
  expect(VERDICTS.designCode.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  expect(VERDICTS.designCode.diffs[0]).toContain("REAL-GAP")
  expect(VERDICTS.clef.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  expect(VERDICTS["claude-code"].verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  expect(VERDICTS.muse.verdict).toBe("FAIL")
  expect(VERDICTS.muse.diffs[0]).toContain("ATTESTATION")
  expect(VERDICTS.route.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  expect(VERDICTS.codex.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  for (const door of Object.values(VERDICTS)) expect(door.diffs.length).toBeGreaterThan(0)
})

// ------------------------------------------------------------ design-code
//
// Door: bin/design-code-proxy.mjs (:18746) in developing-today/code.
// Recordings transcribed from that file (MODELS recipe table,
// dispatchWithFallback, hasUpstreamKey) and its stub fixtures
// (bin/design-code-proxy.test.mjs), plus live recordings taken on the
// laptop 2026-11-02 against the running door and its repointed
// successor (design-code-flash / design-code-pro calls, see #1413).
// The persona migration target: each persona id becomes a model_routes
// route carrying the door's design system prompt in the route's
// `system` field (#1413); primary/fallback recipe order becomes the
// route's ordered targets, walked by Generate on failure
// (generate-persona-route.test.ts pins the walk + prompt application
// through the real resolver).

const DESIGN_SYSTEM_PROMPT =
  "You are an elite Code & Systems Design Architect.\nYour core expertise is in software architecture, clean code design, UI/UX design engineering, design tokens, component abstractions, domain-driven design, and maintainable systems patterns. Provide elegant, production-grade architectures and idiomatic design implementations."

describe("door: design-code (bin/design-code-proxy.mjs :18746)", () => {
  // The door's 11 virtual personas and their recipes, transcribed from
  // the MODELS table AFTER the #1409 repoint (code PR #4626): port
  // 18751 = antigravity-direct, 18744 = codex. Persona routes in the
  // tracked config carry exactly these targets, in this order.
  const RECIPES = [
    { id: "claude-haiku-5.5", primary: "antigravity-direct/claude-sonnet-5-5", fallback: "antigravity-direct/gemini-3.8-flash" },
    { id: "gpt-6-luna", primary: "openai-codex/gpt-6-luna", fallback: "antigravity-direct/gemini-3.8-flash" },
    { id: "gpt-6.1-sol", primary: "openai-codex/gpt-6.1-sol", fallback: "antigravity-direct/gemini-3.8-flash" },
    { id: "deepseek-v4.1-flash", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-5.6-luna" },
    { id: "glm-5.3-flash", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-5.6-luna" },
    { id: "glm-5.3-flashx", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-5.6-luna" },
    { id: "mimo-v2.6-flash", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-5.6-luna" },
    { id: "mimo-v2.6-pro", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-6.1-sol" },
    { id: "design-code-pro", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-6.1-sol" },
    { id: "design-code-flash", primary: "antigravity-direct/gemini-3.8-flash", fallback: "openai-codex/gpt-5.6-luna" },
    { id: "open-design-pro", primary: "openai-codex/gpt-6.1-sol", fallback: "antigravity-direct/gemini-3.8-flash" },
  ] as const

  test("persona inventory: 11 recipes, every leg on a live door (no :18745)", () => {
    expect(RECIPES.length).toBe(11)
    for (const recipe of RECIPES) {
      expect(recipe.primary).not.toContain("18745")
      expect(recipe.fallback).not.toContain("18745")
      expect(recipe.primary.startsWith("antigravity-direct/") || recipe.primary.startsWith("openai-codex/")).toBe(true)
      expect(recipe.fallback.startsWith("antigravity-direct/") || recipe.fallback.startsWith("openai-codex/")).toBe(true)
    }
  })

  test("models list: door lists personas; façade does not advertise persona routes (real-gap)", () => {
    // Door recording: GET /v1/models serves the 11 persona ids as
    // {id, object: "model", created: <now>, owned_by: "design-code"}.
    const door = {
      object: "list",
      data: RECIPES.map((recipe) => ({ id: recipe.id, object: "model", created: 1793658533, owned_by: "design-code" })),
    }
    expect(door.data.length).toBe(11)
    // Façade today: /v1/models advertises the concrete catalog plus
    // ADVERTISED_MODELS (the six tier routes) only — a persona route
    // resolves and completes by name but is NOT listed, and modelBody
    // does not know it. Recorded as a real-gap on #1413: callers that
    // enumerate personas (the OpenClaw heartbeat lifeline probe reads
    // this list) cannot discover them from the façade yet. This test
    // pins the gap so fixing advertisement fails it loudly.
    expect(modelBody("design-code-flash")).toBeUndefined()
    expect(modelBody("opencode-route/design-code-flash")).toBeUndefined()
    // classification: real-gap — see VERDICTS.designCode.
  })

  test("chat non-streaming, persona model: parity (stub recording)", () => {
    // Door recording (design-code-proxy.test.mjs, stub mode "ok"): the
    // backend's completion is re-serialized with `model` rewritten to
    // the persona id; no usage in the stub body, none in the façade's.
    const door = {
      id: "chatcmpl-stub",
      object: "chat.completion",
      created: 0,
      model: "design-code-flash",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello from primary" }, finish_reason: "stop" },
      ],
    }
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "hello from primary" }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    ]
    const parsed = parseChatRequest({ model: "design-code-flash", messages: [{ role: "user", content: "hi" }] })
    if (!parsed.ok) throw new Error(parsed.error)
    const facade = completionBody({
      id: "chatcmpl-facade",
      created: CREATED,
      model: parsed.value.modelLabel,
      response: responseOf(events),
    })
    expectDiffs(door, facade, [])
  })

  test("chat non-streaming with usage: parity (live recording 2026-11-02)", () => {
    // Door recording: live design-code-flash call through the deployed
    // door after the :18751 repoint — usage carried through verbatim.
    const door = {
      id: "chatcmpl-live",
      object: "chat.completion",
      created: 1793658805,
      model: "design-code-flash",
      choices: [
        { index: 0, message: { role: "assistant", content: "DEPLOYED-REPOINT-OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 73, completion_tokens: 112, total_tokens: 185 },
    }
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "DEPLOYED-REPOINT-OK" }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
        usage: { inputTokens: 73, outputTokens: 112, totalTokens: 185 },
      }),
    ]
    const parsed = parseChatRequest({ model: "design-code-flash", messages: [{ role: "user", content: "hi" }] })
    if (!parsed.ok) throw new Error(parsed.error)
    const facade = completionBody({
      id: "chatcmpl-facade",
      created: CREATED,
      model: parsed.value.modelLabel,
      response: responseOf(events),
    })
    expectDiffs(door, facade, [])
  })

  test("chat streaming, persona model: relayed grammar parity (live recording)", () => {
    // Door recording: live design-code-pro stream — role+content chunk,
    // content chunk, usage-bearing finish chunk, [DONE]. The door
    // rewrites each chunk's model to the persona id; the grammar
    // projection (which excludes model) matches the façade's exactly.
    const door = [
      { object: "chat.completion.chunk", delta: { role: "assistant", content: "" }, finish_reason: null },
      { object: "chat.completion.chunk", delta: { content: "STREAM-OK" }, finish_reason: null },
      {
        object: "chat.completion.chunk",
        delta: {},
        finish_reason: "stop",
        usage: { prompt_tokens: 65, completion_tokens: 121, total_tokens: 186 },
      },
      "[DONE]",
    ]
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "STREAM-OK" }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
        usage: { inputTokens: 65, outputTokens: 121, totalTokens: 186 },
      }),
    ]
    expectDiffs(door, facadeChatFrames(events, "design-code-pro"), [
      {
        path: ".length",
        classification: "acceptable-by-design",
        note: "Frame count differs by the door's relayed empty initial frame only: the door passes the backend's role-only first chunk through, the façade emits role with the first text.",
      },
      {
        path: "[0].delta.content",
        classification: "acceptable-by-design",
        note: "The façade's first chunk carries the text; the door's first (relayed) chunk carries an empty content with the role. Role itself matches.",
      },
      {
        path: "[1].delta.content",
        classification: "acceptable-by-design",
        note: "Index shift from the door's extra initial frame: this position is the façade's finish chunk (empty delta) against the door's content chunk.",
      },
      {
        path: "[1].finish_reason",
        classification: "acceptable-by-design",
        note: "Index shift: finish_reason stop lands one frame earlier on the façade.",
      },
      {
        path: "[1].usage",
        classification: "acceptable-by-design",
        note: "Index shift: usage rides the façade's finish chunk with identical fields (prompt/completion/total).",
      },
      {
        path: "[2]",
        classification: "acceptable-by-design",
        note: "Index shift: the façade's [DONE] against the door's finish chunk; [DONE] terminates both streams.",
      },
    ])
  })

  test("persona system prompt: door composition equals route composition", () => {
    // Door recording (dispatchWithFallback): the design prompt is
    // PREPENDED to an existing system message
    // (`${DESIGN_SYSTEM_PROMPT}\n\n${existing}`) or unshifted as the
    // system message when the caller sent none.
    // Façade: parseChatRequest lifts the caller's system text into
    // input.system, and Generate.applyRouteSystem composes the route's
    // carried prompt with it — the same composition, pinned here; the
    // end-to-end application to the provider request (both candidates)
    // is pinned in generate-persona-route.test.ts.
    const withCaller = parseChatRequest({
      model: "opencode-route/design-code-flash",
      messages: [
        { role: "system", content: "Caller system text." },
        { role: "user", content: "hi" },
      ],
    })
    if (!withCaller.ok) throw new Error(withCaller.error)
    expect(applyRouteSystem(DESIGN_SYSTEM_PROMPT, withCaller.value.input.system)).toBe(
      `${DESIGN_SYSTEM_PROMPT}\n\nCaller system text.`,
    )
    const bare = parseChatRequest({
      model: "opencode-route/design-code-flash",
      messages: [{ role: "user", content: "hi" }],
    })
    if (!bare.ok) throw new Error(bare.error)
    expect(applyRouteSystem(DESIGN_SYSTEM_PROMPT, bare.value.input.system)).toBe(DESIGN_SYSTEM_PROMPT)
    expect(applyRouteSystem(undefined, "Caller system text.")).toBe("Caller system text.")
  })

  test("unknown model: 400 both sides, envelope type + message differ", () => {
    // Door recording: resolveModelConfig refuses unknown ids with 400
    // and a bare {error:{message}} body (no type field).
    const door = {
      status: 400,
      body: { error: { message: 'Unknown model "no-such-persona": not a design-code model (see GET /v1/models)' } },
    }
    // Façade: an unknown route/model fails selection; the handler maps
    // ModelSelectionError to 400 with the OpenAI envelope (design §2).
    const facade = { status: 400, body: errorBody('Model unavailable: opencode-route/no-such-persona', "invalid_request_error") }
    expect(facade.status).toBe(door.status)
    expectDiffs(door.body, facade.body, [
      {
        path: "error.message",
        classification: "acceptable-by-design",
        note: "Message text is implementation wording on both sides; the §2 contract is the 400 + invalid_request_error envelope, which the façade supplies and the door lacks.",
      },
      {
        path: "error.type",
        classification: "acceptable-by-design",
        note: "Door error bodies carry no type; the façade adds the OpenAI-standard type (purely additive).",
      },
    ])
  })

  test("all backends fail: 502 both sides, envelope type + message differ", () => {
    // Door recording: primary and fallback both fail →
    // 502 {error:{message:"All design code backends failed: <err>"}}.
    // Façade (with #1413): Generate walks the route's candidates in
    // order (generate-persona-route.test.ts) and the handler maps the
    // final failure to 502 server_error — the door's outcome class.
    const door = {
      status: 502,
      body: { error: { message: "All design code backends failed: connect ECONNREFUSED" } },
    }
    const facade = { status: 502, body: errorBody("primary backend down", "server_error") }
    expect(facade.status).toBe(door.status)
    expectDiffs(door.body, facade.body, [
      {
        path: "error.message",
        classification: "acceptable-by-design",
        note: "The façade surfaces the failing candidate's provider message (with any quota reset hint preserved, §2); the door wraps its last backend error in its own sentence. Status and outcome class match.",
      },
      {
        path: "error.type",
        classification: "acceptable-by-design",
        note: "Door error bodies carry no type; the façade adds server_error (purely additive).",
      },
    ])
  })

  test("AMR caller-key bypass: door forwards verbatim, façade has no such path", () => {
    // Door recording (hasUpstreamKey + chat handler): a request whose
    // Authorization Bearer token is not a placeholder (or with
    // OPEN_DESIGN_API_KEY/AMR_API_KEY in the door's env) is forwarded
    // VERBATIM to https://amr-link.open-design.ai/v1 — no persona
    // prompt, no recipe routing. The live unit sets neither env var
    // (Gate 1, #1413 comment 6590151807), so today only caller keys
    // trigger it.
    const door = { upstream: "https://amr-link.open-design.ai/v1/chat/completions", personaApplied: false, recipeApplied: false }
    expect(door.personaApplied).toBe(false)
    // Façade: a Bearer token is the server credential, never an
    // upstream key; raw AMR is addressed through the `opendesign`
    // provider directly, as the deployed config already seats it.
    // classification: acceptable-by-design — the façade does not grow
    // per-request upstream-key passthrough (design §2: provider
    // pass-through is via provider options in config, never
    // per-request); recorded in the Gate 1 credential story on #1413.
  })
})
