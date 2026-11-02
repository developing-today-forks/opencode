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
 * The clef/systemone family (#1410) is appended at the bottom:
 * its recordings come from bin/clef-proxy.mjs + clef-proxy.test.mjs
 * and one live capture against the running door (2026-11-02).
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
import { SystemOne } from "@opencode/core/systemone"
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
type Mode = "ok" | "quota" | "selection" | "failure"
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
        if (mode === "quota") return Effect.fail(new Generate.QuotaError({ message: QUOTA_MESSAGE }))
        if (mode === "failure") return Effect.fail(new Generate.UnavailableError({ message: "upstream exploded" }))
        if (mode === "selection") return Effect.fail(new Generate.ModelSelectionError({ message: "no candidate for model" }))
        return Effect.succeed(response)
      },
      stream: (input) => {
        captured.push(input)
        if (mode === "quota") return Stream.fail(new Generate.QuotaError({ message: QUOTA_MESSAGE }))
        if (mode === "failure") return Stream.fail(new Generate.UnavailableError({ message: "upstream exploded" }))
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

it.live("quota failure, non-streaming: 429 rate_limit_error, reset hint preserved in the message, no Retry-After header (#1441)", () =>
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
    // Façade (this assertion, #1441): the design §2 quota shape —
    // 429 with the reset hint preserved inside the message. This is a
    // spec-conformant divergence from the route-proxy DOOR, which
    // itself still answers 502 for the same failure (recorded above);
    // the door side is not re-recorded, the façade follows the spec.
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeNull()
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("Subscription quota exhausted")
    expect(body.error.message).toContain("resets at 2026-11-03T04:00:00Z")
    mode = "ok"
  }),
)

it.live("quota failure on the responses door, non-streaming: 429 rate_limit_error with the reset hint (#1441)", () =>
  Effect.gen(function* () {
    mode = "quota"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/responses", {
      model: "workhorse",
      input: "hi",
    })
    expect(res.status).toBe(429)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("resets at 2026-11-03T04:00:00Z")
    mode = "ok"
  }),
)

it.live("quota failure on the messages door, non-streaming: 429 rate_limit_error in the Anthropic envelope (#1441)", () =>
  Effect.gen(function* () {
    mode = "quota"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/messages", {
      model: "workhorse",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(429)
    const body = (yield* Effect.promise(() => res.json())) as { type: string; error: { message: string; type: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("resets at 2026-11-03T04:00:00Z")
    mode = "ok"
  }),
)

it.live("non-quota upstream failure, non-streaming: still 502 server_error (#1441)", () =>
  Effect.gen(function* () {
    mode = "failure"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/chat/completions", {
      model: "workhorse",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(502)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("server_error")
    expect(body.error.message).toContain("upstream exploded")
    mode = "ok"
  }),
)

it.live("quota failure, streaming: SSE error frame carries the message typed as a rate-limit failure (#1441)", () =>
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
    // The stream is already open, so the 429 class rides in the
    // frame's error type instead of the HTTP status.
    expect(text).toContain('"error"')
    expect(text).toContain('"type":"rate_limit_error"')
    expect(text).toContain("Subscription quota exhausted")
    expect(text).toContain("resets at 2026-11-03T04:00:00Z")
    expect(text).not.toContain('"finish_reason":"stop"')
    mode = "ok"
  }),
)

it.live("quota failure, responses streaming: response.failed carries the hint and the rate-limit code (#1441)", () =>
  Effect.gen(function* () {
    mode = "quota"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/responses", {
      model: "workhorse",
      input: "hi",
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = yield* Effect.promise(() => res.text())
    expect(text).toContain("event: response.failed")
    expect(text).not.toContain("event: response.completed")
    expect(text).toContain("Subscription quota exhausted")
    expect(text).toContain("resets at 2026-11-03T04:00:00Z")
    expect(text).toContain('"code":"rate_limit_exceeded"')
    mode = "ok"
  }),
)

it.live("quota failure, messages streaming: error event typed as a rate-limit failure (#1441)", () =>
  Effect.gen(function* () {
    mode = "quota"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/messages", {
      model: "workhorse",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const text = yield* Effect.promise(() => res.text())
    expect(text).toContain("event: error")
    expect(text).toContain('"type":"rate_limit_error"')
    expect(text).toContain("resets at 2026-11-03T04:00:00Z")
    expect(text).not.toContain("event: message_stop")
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

it.live("responses streaming: full §5 grammar over HTTP, completed output persists for chaining (#1442/#1149)", () =>
  Effect.gen(function* () {
    mode = "ok"
    const handler = yield* setup
    const res = yield* post(handler, "http://opencode.local/v1/responses", {
      model: "workhorse",
      input: "Say hi",
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = yield* Effect.promise(() => res.text())
    const parsed = text
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<string, unknown>)
    expect(parsed.map((data) => data.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(parsed.map((data) => data.sequence_number)).toEqual(parsed.map((_, index) => index))
    const completed = parsed.at(-1)?.response as {
      id: string
      status: string
      output: Array<{ type: string; content: Array<{ text: string }> }>
      usage: unknown
    }
    expect(completed.status).toBe("completed")
    expect(completed.output).toHaveLength(1)
    expect(completed.output[0]?.content[0]?.text).toBe("Hello world")
    expect(completed.usage).toEqual({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
    // The completed id chains: the persisted items are the items the
    // completed event reported, so a follow-up resolves (not a 404)
    // and generation sees the stored history ahead of the new input.
    const follow = yield* post(handler, "http://opencode.local/v1/responses", {
      model: "workhorse",
      input: "follow up",
      previous_response_id: completed.id,
    })
    expect(follow.status).toBe(200)
    const input = captured.at(-1)
    expect(JSON.stringify(input?.messages)).toContain("Hello world")
    expect(JSON.stringify(input?.messages)).toContain("follow up")
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

// ------------------------------------------------------------ clef (systemone family, #1410)
//
// HTTP-level pairs for the systemone door: the recorded requests are
// OpenChamber's Jev shapes (routing/jev.js buildProbeRequest /
// buildPermissionRequest and the door's own test bodies), replayed
// through the real handler with a fake SystemOne service. The fake's
// failure modes are selected by a marker in `state`, standing in for
// the recorded upstream outcomes in the door's stub fixtures.

const fakeSystemOne = makeLocationNode({
  service: SystemOne.Service,
  layer: Layer.succeed(
    SystemOne.Service,
    SystemOne.Service.of({
      evaluate: (input) => {
        const marker = (input.state as { fake?: string } | undefined)?.fake
        if (marker === "missing-token")
          return Effect.fail(
            new SystemOne.UnavailableError({
              message: "Missing Cloudflare AI inference API token",
              status: 401,
              body: SystemOne.errorBody("Missing Cloudflare AI inference API token"),
            }),
          )
        if (marker === "upstream-502")
          return Effect.fail(
            new SystemOne.UnavailableError({
              message: "Cloudflare Workers AI Clef execution failed",
              status: 502,
              body: SystemOne.upstreamFailureBody(null),
            }),
          )
        if (marker === "timeout")
          return Effect.fail(
            new SystemOne.UnavailableError({
              message: "Cloudflare Workers AI Clef request timed out",
              status: 504,
              body: SystemOne.errorBody("Cloudflare Workers AI Clef request timed out"),
            }),
          )
        return Effect.succeed({
          answers: {
            probe: { type: "choice", choice: "blue", probabilities: { blue: 0.8947, table: 0.1053 }, confidence: 0.6232 },
          },
        })
      },
    }),
  ),
  deps: [],
})

const setupSystemOne = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-facade-parity-systemone-")))
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
    { overrides: [Generate.node.replace(fake), Embeddings.node.replace(fakeEmbeddings), SystemOne.node.replace(fakeSystemOne)] },
  )
})

const probeBody = {
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

it.live("systemone: probe request answers 200 with exactly {answers} (the live door capture shape)", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res = yield* post(handler, "http://opencode.local/v1/systemone", probeBody)
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as { answers: Record<string, unknown> }
    // Door live capture (2026-11-02): {answers:{probe:{type:"choice",
    // choice, probabilities, confidence}}} — nothing else on the wire.
    expect(Object.keys(body)).toEqual(["answers"])
    expect(body.answers.probe).toEqual({
      type: "choice",
      choice: "blue",
      probabilities: { blue: 0.8947, table: 0.1053 },
      confidence: 0.6232,
    })
  }),
)

it.live("systemone: array body is a 400 in the plain {error} envelope and never reaches the service (#2938)", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/v1/systemone", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[1,2]",
        }),
      ),
    )
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: string }
    expect(body).toEqual({ error: "Invalid JSON body: expected an object" })
  }),
)

it.live("systemone: malformed JSON is a 400, not a 500 (#690 discipline)", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/v1/systemone", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json{",
        }),
      ),
    )
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: string }
    expect(body.error).toContain("Invalid JSON body")
  }),
)

it.live("systemone: hostile model is a 400 with the door's refusal message (#2410)", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res = yield* post(handler, "http://opencode.local/v1/systemone", {
      ...probeBody,
      model: "@cf/meta/llama-3.1-8b-instruct",
    })
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: string }
    expect(body.error).toContain("Refused model")
  }),
)

it.live("systemone: missing token answers the door's 401 envelope", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res = yield* post(handler, "http://opencode.local/v1/systemone", { ...probeBody, state: { fake: "missing-token" } })
    expect(res.status).toBe(401)
    const body = (yield* Effect.promise(() => res.json())) as { error: string }
    expect(body).toEqual({ error: "Missing Cloudflare AI inference API token" })
  }),
)

it.live("systemone: upstream failure answers the door's status + envelope; timeout is 504", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res502 = yield* post(handler, "http://opencode.local/v1/systemone", { ...probeBody, state: { fake: "upstream-502" } })
    expect(res502.status).toBe(502)
    const body502 = (yield* Effect.promise(() => res502.json())) as { error: string; details: unknown }
    expect(body502.error).toBe("Cloudflare Workers AI Clef execution failed")
    const res504 = yield* post(handler, "http://opencode.local/v1/systemone", { ...probeBody, state: { fake: "timeout" } })
    expect(res504.status).toBe(504)
    const body504 = (yield* Effect.promise(() => res504.json())) as { error: string }
    expect(body504).toEqual({ error: "Cloudflare Workers AI Clef request timed out" })
  }),
)

it.live("systemone: /v1/models carries the Clef floor alongside the route models", () =>
  Effect.gen(function* () {
    const handler = yield* setupSystemOne
    const res = yield* Effect.promise(() => handler(new Request("http://opencode.local/v1/models")))
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as { data: Array<{ id: string; owned_by: string }> }
    expect(body.data.filter((m) => m.owned_by === "cloudflare-workers-ai").map((m) => m.id)).toEqual([
      "@cf/cloudflare/clef",
      "@cf/cloudflare/clef-flash",
    ])
  }),
)
