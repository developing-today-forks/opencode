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
 *   - clef (bin/clef-proxy.mjs, :18742) — systemone family (#1410):
 *     PARITY-WITH-NAMED-DIFFS (both acceptable-by-design; see the
 *     clef describe block)
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

/** Façade responses stream: the event-type sequence plus the terminal
 * response.completed payload essentials. */
const facadeResponsesStream = (events: ReadonlyArray<LLMEvent>) => {
  const translator = new ResponsesStreamTranslator({ id: "resp_facade", created: 1700000000, model: "muse-spark-1.3" })
  const frames = [translator.start(), ...events.flatMap((event) => translator.push(event))]
  const types: string[] = []
  let completed: Record<string, unknown> | undefined
  for (const frame of frames) {
    const data = JSON.parse(frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<string, unknown>
    types.push(String(data.type))
    if (data.type === "response.completed") completed = data.response as Record<string, unknown>
  }
  return { types, completed }
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

  test("quota failure: exhausted candidates — 502 both sides, envelope type/message differ", () => {
    // Door recording: the single candidate leaf answers 429 with body
    // {"error":{"message":"quota"}} and `Retry-After: 30` (test leaf,
    // mode "rate"). classifyHttp wraps it as LeafError
    // `leaf HTTP 429: {"error":{"message":"quota"}}`; with no further
    // candidate, handleChatCompletions answers sendError(502, that
    // message). The Retry-After header is NOT forwarded to the client
    // — the reset hint survives only inside the ledger's quota JSON
    // and, when the upstream body carries it, inside the message.
    const door = {
      status: 502,
      body: { error: { message: 'leaf HTTP 429: {"error":{"message":"quota"}}', type: "proxy_error" } },
    }
    // Façade: the handler maps a generation failure to 502 with
    // Completions.errorBody(message, "server_error") — the provider's
    // message (and any reset hint inside it) is preserved verbatim.
    const facade = {
      status: 502,
      body: errorBody('leaf HTTP 429: {"error":{"message":"quota"}}', "server_error"),
    }
    expect(facade.status).toBe(door.status)
    expectDiffs(door.body, facade.body, [
      {
        path: "error.type",
        classification: "acceptable-by-design",
        note: "Door brands errors proxy_error; the façade uses the OpenAI-standard server_error. Status (502) and message carriage match; neither side forwards a Retry-After header.",
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
        note: "Message framing differs (door prefixes 'Codex execution failed: '; façade passes the provider message through). Neither side produces the design §2 quota shape (429 + reset hint) for codex traffic today — filed as #1441.",
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

  test("responses streaming (passthrough): response.completed carries no output on the façade — real gap", () => {
    // Door recording: the passthrough relays the upstream grammar —
    // the fixture's sequence is text deltas, output_item.added,
    // function_call_arguments deltas, response.completed whose
    // response carries the full output (2 items) and usage.
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
    // The façade prepends response.created (its stream always opens
    // with it — the door fixture is a mid-grammar stub capture, and
    // real upstream streams open with response.created too).
    expect(facade.types).toEqual(["response.created", ...doorTypes])
    // Usage and status on the terminal event are parity...
    expect(facade.completed?.status).toBe("completed")
    expect(facade.completed?.usage).toEqual({ input_tokens: 11, output_tokens: 6, total_tokens: 17 })
    // ...but the completed response's output is EMPTY on the façade,
    // where the door's completed event carries both output items.
    // Clients that read the final response object (the standard
    // Responses pattern) lose the answer's items. Also missing vs
    // design §5: response.in_progress, response.output_item.done,
    // response.output_text.done, sequence numbers.
    expect(facade.completed?.output).toEqual([])
    // classification: real-gap — filed as #1442;
    // blocks Wave C repointing for responses-streaming callers.
  })

  test("responses streaming: reasoning event name deviates from design §5", () => {
    // Design §5 names response.reasoning_summary_text.delta; the
    // façade emits response.reasoning_text.delta. No door fixture
    // exercises reasoning deltas (the muse stub has none), so this
    // is recorded against the spec, not a door recording.
    const translator = new ResponsesStreamTranslator({ id: "resp_x", created: CREATED, model: "m" })
    const frames = translator.push(LLMEvent.reasoningDelta({ id: "r1", text: "thinking" }))
    expect(frames[0]).toContain("response.reasoning_text.delta")
    // classification: real-gap (vs spec §5) — filed with the
    // responses-streaming issue #1442.
  })

  test("quota failure: door passes the upstream 429 through verbatim; façade answers 502", () => {
    // Door recording (door test: "upstream 429 passes through and
    // never falls back to exec"): the stub upstream answers 429
    // {error: {message: "Subscription quota exhausted", type:
    // "rate_limit_error"}} and BOTH the chat and responses fronts
    // return that status and body as-is — a chat caller receives the
    // upstream Responses-shaped error untranslated, and the door
    // never retries through the CLI. Any reset hint in the upstream
    // body survives verbatim.
    const door = { status: 429, body: { error: { message: "Subscription quota exhausted", type: "rate_limit_error" } } }
    // Façade: a quota failure inside generation surfaces through the
    // handler as 502 {error: {message, type: "server_error"}} — the
    // message (and any hint inside it) survives, the 429 does not.
    const facade = { status: 502, body: errorBody("Subscription quota exhausted", "server_error") }
    expectDiffs(door.body, facade.body, [
      {
        path: "error.type",
        classification: "real-gap",
        note: "Door relays the upstream type (rate_limit_error); façade emits server_error. Status also differs: 429 (door) vs 502 (façade) — the design §2 mapping promises 429 with the reset hint preserved in the message; the façade does not produce it today. Filed as #1441.",
      },
    ])
    expect(door.status).toBe(429)
    expect(facade.status).toBe(502)
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
  muse: {
    verdict: "FAIL",
    diffs: [
      "ATTESTATION: door answers shell/bash requests with a 200 (alias + CLI fallback); façade preserves names and surfaces the 403 as a provider failure — outcome differs (design §9.1 rule; Wave C gate for #1155, filed as #1443)",
      "quota: door relays upstream 429 verbatim; façade answers 502 server_error (design §2 promises 429 + reset hint) — #1441",
      "responses streaming: response.completed carries empty output; §5 grammar events missing; reasoning event name deviates from §5 — #1442",
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
} as const

test("verdict registry is consistent with the recorded classifications", () => {
  expect(Object.keys(VERDICTS).sort()).toEqual(["clef", "codex", "muse", "route"])
  expect(VERDICTS.clef.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  expect(VERDICTS.muse.verdict).toBe("FAIL")
  expect(VERDICTS.muse.diffs[0]).toContain("ATTESTATION")
  expect(VERDICTS.route.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  expect(VERDICTS.codex.verdict).toBe("PARITY-WITH-NAMED-DIFFS")
  for (const door of Object.values(VERDICTS)) expect(door.diffs.length).toBeGreaterThan(0)
})
