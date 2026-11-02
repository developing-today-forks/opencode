/**
 * Façade parity suite (#1152) — HTTP-level replay pairs.
 *
 * The translation-level pairs live in
 * packages/core/test/facade-parity.test.ts (recorded door wire
 * shapes diffed against the façade's translators). This file replays
 * the same recorded requests through the REAL server handler with a
 * fake Generate service, pinning the parts only the handler decides:
 * status codes, error envelopes, SSE framing, and that tool names
 * reach generation verbatim (the muse attestation case, §9.1).
 *
 * Door recordings cited per test are transcribed from
 * developing-today/code bin/ (opencode-route-proxy.mjs,
 * codex-proxy.mjs, muse-proxy.mjs) and their test files — see the
 * core suite's header for provenance and per-door verdicts.
 *
 * RE-RUN (laptop): cd packages/server && bun run test test/facade-parity.test.ts
 */
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { LLMEvent, LLMResponse } from "@opencode/ai"
import { Generate, type CompletionInput } from "@opencode/core/generate"
import { Embeddings } from "@opencode/core/embeddings"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Stream } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const events = [
  LLMEvent.textDelta({ id: "t1", text: "Hello" }),
  LLMEvent.textDelta({ id: "t1", text: " world" }),
  LLMEvent.finish({ reason: { normalized: "stop" }, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
]
const response = LLMResponse.fromEvents(events)
if (!response) throw new Error("expected a completed response")

const QUOTA_MESSAGE = "Subscription quota exhausted; resets at 2026-11-03T04:00:00Z"
type Mode = "ok" | "quota" | "selection"
let mode: Mode = "ok"
const captured: CompletionInput[] = []
const fake = makeLocationNode({
  service: Generate.Service,
  layer: Layer.succeed(
    Generate.Service,
    Generate.Service.of({
      text: () => Effect.die("unused"),
      complete: (input) => {
        captured.push(input)
        if (mode === "quota") return Effect.fail(new Generate.UnavailableError({ message: QUOTA_MESSAGE }))
        if (mode === "selection") return Effect.fail(new Generate.ModelSelectionError({ message: "no candidate for model" }))
        return Effect.succeed(response)
      },
      stream: (input) => {
        captured.push(input)
        if (mode === "quota") return Stream.fail(new Generate.UnavailableError({ message: QUOTA_MESSAGE }))
        if (mode === "selection") return Stream.fail(new Generate.ModelSelectionError({ message: "no candidate for model" }))
        return Stream.fromIterable(events)
      },
    }),
  ),
  deps: [],
})

const fakeEmbeddings = makeLocationNode({
  service: Embeddings.Service,
  layer: Layer.succeed(
    Embeddings.Service,
    Embeddings.Service.of({
      embed: (input) =>
        Effect.succeed({
          vectors: input.inputs.map((text) => [text.length, 0.5, 0.25]),
          promptTokens: 7,
        }),
    }),
  ),
  deps: [],
})

const setup = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-facade-parity-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ model: "base/default" })))
  return yield* ServerFetch.make(
    {
      database: { path: ":memory:" },
      config: { directory: global },
      fs: { filewatcher: false },
      models: { fetch: false },
    },
    { overrides: [Generate.node.replace(fake), Embeddings.node.replace(fakeEmbeddings)] },
  )
})

const post = (handler: (request: Request) => Promise<Response>, url: string, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )

it.live("chat non-streaming: 200 with the shared door contract (object, usage, finish_reason)", () =>
  Effect.gen(function* () {
    mode = "ok"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as {
      object: string
      choices: Array<{ message: { content: string | null }; finish_reason: string }>
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }
    // All three doors answer this shape on success (route: leaf
    // verbatim; codex: sendSuccess; muse: responsesToChatCompletion).
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]?.message.content).toBe("Hello world")
    expect(body.choices[0]?.finish_reason).toBe("stop")
    expect(body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
  }),
)

it.live("chat streaming: role chunk, usage-bearing finish chunk, [DONE]", () =>
  Effect.gen(function* () {
    mode = "ok"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = yield* Effect.promise(() => res.text())
    // Grammar shared with the route door's relayed leaf stream and
    // the muse door's translated stream; the codex door matches
    // except it omits role on the first chunk (core suite, codex
    // streaming case).
    expect(text).toContain('"role":"assistant"')
    expect(text).toContain('"prompt_tokens":5')
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
  }),
)

it.live("quota failure, non-streaming: 502 server_error, reset hint preserved in the message, no Retry-After header", () =>
  Effect.gen(function* () {
    mode = "quota"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "hi" }],
    })
    // Door recordings for the same upstream quota failure:
    //   route proxy: 502 {error:{message:"leaf HTTP 429: …", type:"proxy_error"}}
    //   muse:        429, upstream error body verbatim (rate_limit_error)
    //   codex:       500 {error:{message:"Codex execution failed: …"}} (no type)
    // Façade (this assertion): status parity with the route door
    // only; the design §2 quota shape (429 + hint) is NOT produced —
    // the hint survives only because it rides inside the message.
    expect(res.status).toBe(502)
    expect(res.headers.get("retry-after")).toBeNull()
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("server_error")
    expect(body.error.message).toContain("Subscription quota exhausted")
    expect(body.error.message).toContain("resets at 2026-11-03T04:00:00Z")
    mode = "ok"
  }),
)

it.live("quota failure, streaming: SSE error frame carries the message", () =>
  Effect.gen(function* () {
    mode = "quota"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = yield* Effect.promise(() => res.text())
    // Door recordings: codex and muse frame a stream failure as
    // `data: {error:{message}}` then [DONE]; the route door writes
    // the same error frame (with type proxy_error) and just ends.
    expect(text).toContain('"error"')
    expect(text).toContain("Subscription quota exhausted")
    expect(text).not.toContain('"finish_reason":"stop"')
    mode = "ok"
  }),
)

it.live("attestation case over HTTP: shell/bash tools reach generation verbatim", () =>
  Effect.gen(function* () {
    mode = "ok"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "run echo hi" }],
      tools: [
        { type: "function", function: { name: "shell", description: "Run a shell command", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "bash", description: "Run a bash command", parameters: { type: "object", properties: {} } } },
      ],
    })
    expect(res.status).toBe(200)
    // Design §9.1: the façade must not rename (no run_command /
    // terminal aliases as the muse door applies upstream), drop, or
    // synthesize tool names. What generation receives is the proof.
    const input = captured.at(-1)
    expect(input?.tools?.map((t) => t.name)).toEqual(["shell", "bash"])
  }),
)

it.live("unknown previous_response_id: 404 with code response_not_found", () =>
  Effect.gen(function* () {
    mode = "ok"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/responses", {
      model: "workhorse",
      input: "follow up",
      previous_response_id: "resp_does_not_exist",
    })
    // Façade (§4): OpenAI's expired-chain shape. Door contrast: the
    // route door 404s the whole /v1/responses path (proxy_error, no
    // code); the muse door relays whatever its upstream answers.
    expect(res.status).toBe(404)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string; code?: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.code).toBe("response_not_found")
  }),
)

it.live("model selection failure: 400 invalid_request_error", () =>
  Effect.gen(function* () {
    mode = "selection"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "hi" }],
    })
    // Door contrast: route door answers an unknown route with 502
    // proxy_error; codex answers an unknown model with 400 and no
    // type. The façade's 400 matches codex's status, neither type.
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("invalid_request_error")
    mode = "ok"
  }),
)
