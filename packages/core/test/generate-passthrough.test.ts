import { expect, test } from "bun:test"
import { LanguageModel, LLMClient, Message } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { AnthropicMessages, CohereChat, OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { AISDK } from "@opencode/core/aisdk"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { ModelResolver, type Resolved } from "@opencode/core/model-resolver"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { ID, Info, Model, Ref } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const selected = Info.make({
  ...Info.default(Provider.ID.make("test-provider"), ID.make("gemini")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
})
const ref = Ref.make({ providerID: selected.providerID, id: selected.id })

const providers = Layer.mock(Provider.Service, { get: () => Effect.undefined })
const models = Layer.mock(Model.Service, { get: () => Effect.succeed(selected) })
const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: {
    active: () => Effect.undefined,
    resolve: () => Effect.die("unused"),
    key: () => Effect.die("unused"),
    external: () => Effect.die("unused"),
    activate: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
  },
  oauth: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
  command: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
})
const npm = Layer.mock(Npm.Service, {
  add: () => Effect.die("unused"),
  which: () => Effect.die("unused"),
})

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body as { text?: string; body?: Uint8Array }
  if (body.text !== undefined) return body.text
  if (body.body) return new TextDecoder().decode(body.body)
  return ""
}

const chatSSE = (text: string) =>
  new Response(
    `data: ${JSON.stringify({
      id: "completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "gemini",
      choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )

const messagesSSE = (text: string) =>
  new Response(
    [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "gemini", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
    ].join("\n") + "\n",
    { headers: { "content-type": "text/event-stream" } },
  )

/** A Generate service wired to a fake provider endpoint that records every outbound body. */
const setup = (runtime: LanguageModel, respond: (body: string, index: number) => Response) => {
  const bodies: string[] = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const text = bodyTextOf(request)
        bodies.push(text)
        return HttpClientResponse.fromWeb(request, respond(text, bodies.length - 1))
      }),
    ),
  )
  const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
  const aisdk = Layer.mock(AISDK.Service, {
    hook: {
      sdk: () => Effect.die("unused"),
      language: () => Effect.die("unused"),
    },
    model: () => Effect.succeed(runtime),
  })
  const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
  const it = testEffect(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, native))))
  return { it, bodies }
}

const chatRuntime = LanguageModel.make({ id: "gemini", provider: "test-provider", route: OpenAIChat.route })
const messagesRuntime = LanguageModel.make({ id: "gemini", provider: "test-provider", route: AnthropicMessages.route })

/** Runs an effect with the route ledger sink captured, always restoring the previous (unset) sink. */
const capturing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const attempts: ModelRouteLog.Attempt[] = []
    ModelRouteLog.setSink((event) => {
      if (event.kind === "attempt") attempts.push(event.row)
    })
    const value = yield* effect.pipe(
      Effect.ensuring(Effect.sync(() => ModelRouteLog.setSink(undefined))),
    )
    return { value, attempts }
  })

// ------------------------------------------------------------ dialect detection

const resolvedWith = (route: LanguageModel["route"]): Resolved => ({
  model: LanguageModel.make({ id: "gemini", provider: "test-provider", route }),
  ref,
  capabilities: selected.capabilities,
  cost: selected.cost,
  limit: selected.limit,
})

test("passthroughDialect matches only the resolved model's own door dialect", () => {
  expect(Generate.passthroughDialect(resolvedWith(OpenAIChat.route), "chat")).toBe("chat")
  expect(Generate.passthroughDialect(resolvedWith(OpenAIChat.route), "responses")).toBeUndefined()
  expect(Generate.passthroughDialect(resolvedWith(OpenAIChat.route), undefined)).toBeUndefined()
  expect(Generate.passthroughDialect(resolvedWith(OpenAIResponses.route), "responses")).toBe("responses")
  expect(Generate.passthroughDialect(resolvedWith(OpenAIResponses.route), "chat")).toBeUndefined()
  expect(Generate.passthroughDialect(resolvedWith(AnthropicMessages.route), "messages")).toBe("messages")
  // A protocol with its own wire shape declares no door dialect: always translate.
  expect(Generate.passthroughDialect(resolvedWith(CohereChat.route), "chat")).toBeUndefined()
})

// ------------------------------------------------------------ raw body rewriting

test("rewriteRawBody replaces only the model value and preserves every other byte", () => {
  const raw = `{ "model" : "opencode-route/workhorse" , "stream" : true, "vendor_extension" : {"x":  1} }`
  expect(Generate.rewriteRawBody(raw, "gemini")).toBe(
    `{ "model" : "gemini" , "stream" : true, "vendor_extension" : {"x":  1} }`,
  )
})

test("rewriteRawBody is byte-identical when model and stream already match", () => {
  const raw = `{"model":"gemini","stream":true,"messages":[{"role":"user","content":"model stream"}]}`
  expect(Generate.rewriteRawBody(raw, "gemini")).toBe(raw)
})

test("rewriteRawBody forces stream:true in place or by insertion", () => {
  expect(Generate.rewriteRawBody(`{"model":"gemini","stream":false}`, "gemini")).toBe(
    `{"model":"gemini","stream":true}`,
  )
  expect(Generate.rewriteRawBody(`{"model":"gemini"}`, "gemini")).toBe(`{"stream":true,"model":"gemini"}`)
})

test("rewriteRawBody refuses bodies it cannot adapt faithfully", () => {
  expect(Generate.rewriteRawBody(`{"messages":[]}`, "gemini")).toBeUndefined()
  expect(Generate.rewriteRawBody(`{"model":123}`, "gemini")).toBeUndefined()
  expect(Generate.rewriteRawBody(`{"model":"a","model":"b"}`, "gemini")).toBeUndefined()
  expect(Generate.rewriteRawBody(`{"model":"gemini","stream":"yes"}`, "gemini")).toBeUndefined()
  expect(Generate.rewriteRawBody(`["model"]`, "gemini")).toBeUndefined()
  expect(Generate.rewriteRawBody(`not json`, "gemini")).toBeUndefined()
})

// ------------------------------------------------------------ execution

const rawChat = `{"model":"gemini", "stream":true,  "messages":[{"role":"user","content":"hi"}], "vendor_extension":{"deep":[1,2,{"a":"b"}]}, "temperature":0.5}`

{
  const { it, bodies } = setup(chatRuntime, () => chatSSE("OK"))
  it.effect("forwards a dialect-matched chat body byte-identically, extension field intact", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const response = yield* generate.complete({
        model: ref,
        messages: [Message.user("hi")],
        dialect: "chat",
        rawBody: rawChat,
      })
      expect(response.text).toBe("OK")
      expect(bodies).toEqual([rawChat])
    }),
  )

  it.effect("rewrites only the model field when the caller named a route selector", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const raw = rawChat.replace(`"gemini"`, `"opencode-route/workhorse"`)
      yield* generate.complete({ model: ref, messages: [Message.user("hi")], dialect: "chat", rawBody: raw })
      expect(bodies.at(-1)).toBe(rawChat)
    }),
  )

  it.effect("a dialect-mismatched call still goes through translation and drops extensions", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const response = yield* generate.complete({
        model: ref,
        messages: [Message.user("hi")],
        dialect: "responses",
        rawBody: rawChat,
      })
      expect(response.text).toBe("OK")
      const sent = bodies.at(-1) ?? ""
      expect(sent).not.toBe(rawChat)
      expect(sent).not.toContain("vendor_extension")
      const parsed = JSON.parse(sent) as { model: string; stream: boolean }
      expect(parsed.model).toBe("gemini")
      expect(parsed.stream).toBe(true)
    }),
  )

  it.effect("writes a route_attempt row with usage for a pass-through call", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const { attempts } = yield* capturing(
        generate.complete({ model: ref, messages: [Message.user("hi")], dialect: "chat", rawBody: rawChat }),
      )
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({
        provider_id: "test-provider",
        model_id: "gemini",
        route_id: "",
        outcome: "success",
        tokens_input: 5,
        tokens_output: 2,
      })
      expect(attempts[0]?.session_id).toBeUndefined()
    }),
  )

  it.effect("streams a matched call through with the door's event grammar", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const { value: events, attempts } = yield* capturing(
        generate
          .stream({ model: ref, messages: [Message.user("hi")], dialect: "chat", rawBody: rawChat })
          .pipe(Stream.runCollect),
      )
      const list = Array.from(events)
      const text = list
        .filter((event) => event.type === "text-delta")
        .map((event) => (event.type === "text-delta" ? event.text : ""))
        .join("")
      expect(text).toBe("OK")
      expect(list.at(-1)?.type).toBe("finish")
      expect(bodies.at(-1)).toBe(rawChat)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.outcome).toBe("success")
    }),
  )
}

{
  const { it, bodies } = setup(chatRuntime, (body, index) =>
    index === 0
      ? new Response(JSON.stringify({ error: { message: "unknown field: vendor_extension", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      : chatSSE("OK"),
  )
  it.effect("retries once through translation when the provider rejects the verbatim shape", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const { value: response, attempts } = yield* capturing(
        generate.complete({ model: ref, messages: [Message.user("hi")], dialect: "chat", rawBody: rawChat }),
      )
      expect(response.text).toBe("OK")
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toBe(rawChat)
      expect(bodies[1]).not.toContain("vendor_extension")
      expect(attempts.map((row) => row.outcome)).toEqual(["failure", "success"])
    }),
  )
}

{
  const { it, bodies } = setup(messagesRuntime, () => messagesSSE("OK"))
  it.effect("forwards a dialect-matched messages body byte-identically, string content intact", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const raw = `{"model":"gemini","stream":true,"max_tokens":100,"messages":[{"role":"user","content":"hi"}],"anthropic_extension":{"beta":true}}`
      const { value: response, attempts } = yield* capturing(
        generate.complete({ model: ref, messages: [Message.user("hi")], dialect: "messages", rawBody: raw }),
      )
      expect(response.text).toBe("OK")
      expect(bodies).toEqual([raw])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.outcome).toBe("success")
    }),
  )
}
