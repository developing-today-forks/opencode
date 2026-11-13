import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { LLMEvent, LLMResponse } from "@opencode/ai"
import { Generate, type CompletionInput } from "@opencode/core/generate"
import { Embeddings, type EmbedInput } from "@opencode/core/embeddings"
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

const captured: CompletionInput[] = []
/** One-shot responses for `complete`, consumed before the default response. */
const responseQueue: LLMResponse[] = []
const fake = makeLocationNode({
  service: Generate.Service,
  layer: Layer.succeed(
    Generate.Service,
    Generate.Service.of({
      text: () => Effect.die("unused"),
      complete: (input) => {
        captured.push(input)
        return Effect.succeed(responseQueue.shift() ?? response)
      },
      stream: (input) => {
        captured.push(input)
        return Stream.fromIterable(events)
      },
    }),
  ),
  deps: [],
})

const embedded: EmbedInput[] = []
const fakeEmbeddings = makeLocationNode({
  service: Embeddings.Service,
  layer: Layer.succeed(
    Embeddings.Service,
    Embeddings.Service.of({
      embed: (input) => {
        embedded.push(input)
        return Effect.succeed({
          vectors: input.inputs.map((text) => [text.length, 0.5, 0.25]),
          promptTokens: 7,
        })
      },
    }),
  ),
  deps: [],
})

const setup = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-completions-endpoint-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
  yield* Effect.promise(() =>
    fs.writeFile(
      path.join(global, "opencode.json"),
      JSON.stringify({
        model: "base/default",
        // One persona route is disabled in config: it must not be
        // advertised or resolvable through /v1/models (#1413).
        providers: { "opencode-route": { models: { "design-code-pro": { disabled: true } } } },
        experimental: {
          model_routes: {
            workhorse: { targets: ["anthropic/claude-sonnet-4-6"] },
            speed: { targets: ["anthropic/claude-sonnet-4-6"] },
            specialist: { targets: ["anthropic/claude-sonnet-4-6"] },
            summit: { targets: ["anthropic/claude-sonnet-4-6"] },
            scout: { targets: ["anthropic/claude-sonnet-4-6"] },
            "workhorse-weighted": { targets: ["anthropic/claude-sonnet-4-6"] },
            "design-code-flash": { targets: ["anthropic/claude-sonnet-4-6"] },
            "design-code-pro": { targets: ["anthropic/claude-sonnet-4-6"] },
          },
        },
      }),
    ),
  )
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

const post = (handler: (request: Request) => Promise<Response>, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request("http://opencode.local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )

it.live("answers a non-streaming chat completion in the OpenAI wire shape", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* post(handler, {
      model: "workhorse",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", description: "Look up", parameters: { type: "object", properties: {} } },
        },
      ],
    })
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as {
      object: string
      model: string
      choices: Array<{ message: { content: string | null }; finish_reason: string }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(body.object).toBe("chat.completion")
    expect(body.model).toBe("workhorse")
    expect(body.choices[0]?.message.content).toBe("Hello world")
    expect(body.choices[0]?.finish_reason).toBe("stop")
    expect(body.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 })

    const input = captured.at(-1)
    expect(String(input?.model?.providerID)).toBe("opencode-route")
    expect(String(input?.model?.id)).toBe("workhorse")
    expect(input?.system).toBe("Be terse.")
    expect(input?.tools?.[0]).toMatchObject({ name: "lookup" })
  }),
)

it.live("streams SSE chunks terminated by [DONE]", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* post(handler, {
      model: "opencode-route/speed",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = yield* Effect.promise(() => res.text())
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text).toContain('"content":"Hello"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    expect(String(captured.at(-1)?.model?.id)).toBe("speed")
  }),
)

it.live("rejects an unsupported message role with an OpenAI-shaped 400", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* post(handler, { model: "workhorse", messages: [{ role: "developer", content: "hi" }] })
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("developer")
  }),
)

it.live("lists the route models at /v1/models", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* Effect.promise(() => handler(new Request("http://opencode.local/v1/models")))
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as { data: Array<{ id: string; owned_by: string }> }
    expect(body.data.map((m) => m.id)).toContain("workhorse")
    expect(body.data[0]?.owned_by).toBe("opencode-route")
    // The advertised routes are exactly the configured model_routes
    // (in config order), minus the one disabled in config — the six
    // tier routes plus the design-code persona route (#1413).
    expect(body.data.filter((m) => m.owned_by === "opencode-route").map((m) => m.id)).toEqual([
      "workhorse",
      "speed",
      "specialist",
      "summit",
      "scout",
      "workhorse-weighted",
      "design-code-flash",
    ])
    const embedding = body.data.find((m) => m.id === "local-embed/snowflake-arctic-embed-m-v2.0")
    expect(embedding?.owned_by).toBe("local-embed")
  }),
)

const postEmbeddings = (handler: (request: Request) => Promise<Response>, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request("http://opencode.local/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )

it.live("answers embeddings in the OpenAI wire shape through the registered backend", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postEmbeddings(handler, {
      model: "local-embed/snowflake-arctic-embed-m-v2.0",
      input: ["hi", "a longer input"],
    })
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as {
      object: string
      model: string
      data: Array<{ object: string; index: number; embedding: number[] }>
      usage: { prompt_tokens: number; total_tokens: number }
    }
    expect(body.object).toBe("list")
    expect(body.model).toBe("local-embed/snowflake-arctic-embed-m-v2.0")
    expect(body.data.map((entry) => entry.index)).toEqual([0, 1])
    expect(body.data[0]?.embedding).toEqual([2, 0.5, 0.25])
    expect(body.data[1]?.embedding[0]).toBe("a longer input".length)
    expect(body.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 })
    expect(embedded.at(-1)?.model.providerID).toBe("local-embed")
    expect(embedded.at(-1)?.inputs).toEqual(["hi", "a longer input"])
  }),
)

it.live("rejects an unsupported dimensions value with an OpenAI-shaped 400 before the backend", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const before = embedded.length
    const res = yield* postEmbeddings(handler, { model: "snowflake-arctic-embed-m-v2.0", input: "hi", dimensions: 512 })
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("dimensions 512 is not supported")
    expect(embedded.length).toBe(before)
  }),
)

it.live("rejects an unregistered embedding model with an OpenAI-shaped 400", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postEmbeddings(handler, { model: "openai/text-embedding-3-small", input: "hi" })
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
    expect(body.error.message).toContain("not a registered embedding model")
  }),
)

const getModel = (handler: (request: Request) => Promise<Response>, id: string) =>
  Effect.promise(() => handler(new Request(`http://opencode.local/v1/models/${id}`)))

it.live("gets a route model by its opencode-route id at /v1/models/{id}", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    // URL-encoded, as a client addressing a single path segment sends it,
    // and raw, with the slash in the path.
    for (const form of ["opencode-route%2Fworkhorse", "opencode-route/workhorse"]) {
      const res = yield* getModel(handler, form)
      expect(res.status).toBe(200)
      const body = (yield* Effect.promise(() => res.json())) as { id: string; object: string; created: number; owned_by: string }
      expect(body).toEqual({ id: "opencode-route/workhorse", object: "model", created: 0, owned_by: "opencode-route" })
    }
    // The bare id exactly as it appears in the models list works too.
    const bare = yield* getModel(handler, "workhorse")
    expect(bare.status).toBe(200)
    const bareBody = (yield* Effect.promise(() => bare.json())) as { id: string; owned_by: string }
    expect(bareBody.id).toBe("workhorse")
    expect(bareBody.owned_by).toBe("opencode-route")
  }),
)

it.live("advertises persona routes at /v1/models and the single-model lookup agrees (#1413)", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* Effect.promise(() => handler(new Request("http://opencode.local/v1/models")))
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as {
      data: Array<{ id: string; object: string; created: number; owned_by: string }>
    }
    expect(body.data.find((m) => m.id === "design-code-flash")).toEqual({
      id: "design-code-flash",
      object: "model",
      created: 0,
      owned_by: "opencode-route",
    })
    // The single-model endpoint agrees with the list for the same
    // route, in both the bare form the list carries and the prefixed
    // ref callers use as a completion model.
    for (const [form, id] of [
      ["design-code-flash", "design-code-flash"],
      ["opencode-route%2Fdesign-code-flash", "opencode-route/design-code-flash"],
    ] as const) {
      const one = yield* getModel(handler, form)
      expect(one.status).toBe(200)
      const entry = (yield* Effect.promise(() => one.json())) as { id: string; owned_by: string }
      expect(entry.id).toBe(id)
      expect(entry.owned_by).toBe("opencode-route")
    }
    // The persona route disabled in config is neither listed nor
    // resolvable by id.
    expect(body.data.map((m) => m.id)).not.toContain("design-code-pro")
    const disabled = yield* getModel(handler, "opencode-route%2Fdesign-code-pro")
    expect(disabled.status).toBe(404)
  }),
)

it.live("gets a concrete catalog model by provider/model ref at /v1/models/{id}", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    for (const form of ["deepseek%2Fdeepseek-chat", "deepseek/deepseek-chat"]) {
      const res = yield* getModel(handler, form)
      expect(res.status).toBe(200)
      const body = (yield* Effect.promise(() => res.json())) as { id: string; object: string; created: number; owned_by: string }
      expect(body).toEqual({ id: "deepseek/deepseek-chat", object: "model", created: 0, owned_by: "deepseek" })
    }
  }),
)

it.live("answers an OpenAI-shaped 404 for an unknown model id", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    for (const id of ["opencode-route%2Fno-such-route", "no-such-model"]) {
      const res = yield* getModel(handler, id)
      expect(res.status).toBe(404)
      const body = (yield* Effect.promise(() => res.json())) as { error: { message: string; type: string } }
      expect(body.error.type).toBe("invalid_request_error")
      expect(body.error.message).toContain("model not found:")
    }
    const route = yield* getModel(handler, "opencode-route%2Fno-such-route")
    const body = (yield* Effect.promise(() => route.json())) as { error: { message: string } }
    expect(body.error.message).toContain("opencode-route/no-such-route")
  }),
)


const postTo = (handler: (request: Request) => Promise<Response>, url: string, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )

it.live("answers a non-streaming response in the Responses wire shape", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postTo(handler, "http://opencode.local/v1/responses", {
      model: "workhorse",
      instructions: "Be terse.",
      input: "Say hi",
    })
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as {
      object: string
      status: string
      output: Array<{ content: Array<{ text: string }> }>
      usage: { output_tokens: number }
    }
    expect(body.object).toBe("response")
    expect(body.status).toBe("completed")
    expect(body.output[0]?.content[0]?.text).toBe("Hello world")
    expect(body.usage.output_tokens).toBe(2)
    expect(captured.at(-1)?.system).toBe("Be terse.")
  }),
)

it.live("streams typed Responses events with no [DONE] sentinel", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postTo(handler, "http://opencode.local/v1/responses", {
      model: "opencode-route/workhorse",
      input: "Say hi",
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = yield* Effect.promise(() => res.text())
    expect(text).toContain("event: response.created")
    expect(text).toContain("event: response.in_progress")
    expect(text).toContain("response.output_text.delta")
    expect(text).toContain("event: response.completed")
    expect(text).not.toContain("[DONE]")
    // #1442: the full §5 sequence over the wire, monotonic sequence
    // numbers, and response.completed carrying the full output.
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
      status: string
      output: Array<{ content: Array<{ text: string }> }>
      usage: unknown
    }
    expect(completed.status).toBe("completed")
    expect(completed.output[0]?.content[0]?.text).toBe("Hello world")
    expect(completed.usage).toEqual({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  }),
)

it.live("addresses a direct catalog model through the completions door, not just routes", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* post(handler, {
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(String(captured.at(-1)?.model?.providerID)).toBe("deepseek")
    expect(String(captured.at(-1)?.model?.id)).toBe("deepseek-chat")
  }),
)

it.live("answers a non-streaming message in the Anthropic wire shape for a route name", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postTo(handler, "http://opencode.local/v1/messages", {
      model: "workhorse",
      max_tokens: 128,
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (yield* Effect.promise(() => res.json())) as {
      id: string
      type: string
      role: string
      model: string
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.id.startsWith("msg_")).toBe(true)
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.model).toBe("workhorse")
    expect(body.content[0]).toEqual({ type: "text", text: "Hello world" })
    expect(body.stop_reason).toBe("end_turn")
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 2 })

    const input = captured.at(-1)
    expect(String(input?.model?.providerID)).toBe("opencode-route")
    expect(String(input?.model?.id)).toBe("workhorse")
    expect(input?.system).toBe("Be terse.")
    expect(input?.generation?.maxTokens).toBe(128)
  }),
)

it.live("addresses a direct catalog model through the messages door, not just routes", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postTo(handler, "http://opencode.local/v1/messages", {
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(res.status).toBe(200)
    expect(String(captured.at(-1)?.model?.providerID)).toBe("anthropic")
    expect(String(captured.at(-1)?.model?.id)).toBe("claude-sonnet-4-5")
  }),
)

it.live("streams the Anthropic event grammar with no [DONE] sentinel", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postTo(handler, "http://opencode.local/v1/messages", {
      model: "opencode-route/speed",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = yield* Effect.promise(() => res.text())
    const order = [
      "event: message_start",
      "event: ping",
      "event: content_block_start",
      "event: content_block_delta",
      "event: content_block_stop",
      "event: message_delta",
      "event: message_stop",
    ]
    let at = -1
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1)
      expect(next).toBeGreaterThan(at)
      at = next
    }
    expect(text).toContain('"delta":{"type":"text_delta","text":"Hello"}')
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain('"input_tokens":5,"output_tokens":2')
    expect(text).not.toContain("[DONE]")
    expect(String(captured.at(-1)?.model?.id)).toBe("speed")
  }),
)

it.live("rejects an unsupported content block with a 400 naming the shape", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postTo(handler, "http://opencode.local/v1/messages", {
      model: "workhorse",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "x" } }] },
      ],
    })
    expect(res.status).toBe(400)
    const body = (yield* Effect.promise(() => res.json())) as { type: string; error: { message: string; type: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("document")
  }),
)

// ------------------------------------------------------------ responses chaining (#1149)

const postResponses = (handler: (request: Request) => Promise<Response>, body: unknown) =>
  postTo(handler, "http://opencode.local/v1/responses", body)

const responseJson = (res: Response) =>
  Effect.promise(() => res.json()) as Effect.Effect<{
    id: string
    previous_response_id?: string
    output: Array<{ type: string; content?: Array<{ text: string }> }>
    error?: { message: string; type: string; code?: string }
  }>

it.live("chains a second turn from previous_response_id with only the new input", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const first = yield* postResponses(handler, { model: "workhorse", input: "first question" })
    expect(first.status).toBe(200)
    const firstBody = yield* responseJson(first)
    expect(firstBody.id).toStartWith("resp_")

    const second = yield* postResponses(handler, {
      model: "workhorse",
      input: "second question",
      previous_response_id: firstBody.id,
    })
    expect(second.status).toBe(200)
    const secondBody = yield* responseJson(second)
    expect(secondBody.id).not.toBe(firstBody.id)
    expect(secondBody.previous_response_id).toBe(firstBody.id)

    // The second call's effective input is turn 1's stored items plus the
    // new input: the model sees the full prior turn, in order.
    const seen = JSON.stringify(captured.at(-1)?.messages)
    const firstAt = seen.indexOf("first question")
    const answerAt = seen.indexOf("Hello world")
    const secondAt = seen.indexOf("second question")
    expect(firstAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeGreaterThan(firstAt)
    expect(secondAt).toBeGreaterThan(answerAt)
  }),
)

it.live("chains from a streamed response: streamed items are persisted", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const streamed = yield* postResponses(handler, { model: "workhorse", input: "streamed question", stream: true })
    expect(streamed.status).toBe(200)
    const text = yield* Effect.promise(() => streamed.text())
    expect(text).toContain("event: response.completed")
    const id = /"id":"(resp_[^"]+)"/.exec(text)?.[1]
    expect(id).toBeDefined()

    const second = yield* postResponses(handler, { model: "workhorse", input: "follow up", previous_response_id: id })
    expect(second.status).toBe(200)
    const seen = JSON.stringify(captured.at(-1)?.messages)
    expect(seen).toContain("streamed question")
    expect(seen).toContain("Hello world")
    expect(seen).toContain("follow up")
  }),
)

it.live("answers 404 response_not_found for an unknown previous_response_id", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const res = yield* postResponses(handler, {
      model: "workhorse",
      input: "hi",
      previous_response_id: "resp_does_not_exist",
    })
    expect(res.status).toBe(404)
    const body = yield* responseJson(res)
    expect(body.error?.code).toBe("response_not_found")
    expect(body.error?.type).toBe("invalid_request_error")
  }),
)

it.live("rejects an unmatched function_call_output with a 400, chained or not", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const solo = yield* postResponses(handler, {
      model: "workhorse",
      input: [{ type: "function_call_output", call_id: "call_nope", output: "sunny" }],
    })
    expect(solo.status).toBe(400)
    const soloBody = yield* responseJson(solo)
    expect(soloBody.error?.message).toContain("call_nope")

    const first = yield* postResponses(handler, { model: "workhorse", input: "hi" })
    const firstBody = yield* responseJson(first)
    const chained = yield* postResponses(handler, {
      model: "workhorse",
      input: [{ type: "function_call_output", call_id: "call_nope", output: "sunny" }],
      previous_response_id: firstBody.id,
    })
    expect(chained.status).toBe(400)
    const chainedBody = yield* responseJson(chained)
    expect(chainedBody.error?.message).toContain("call_nope")
  }),
)

it.live("a chained function_call_output matches the stored function_call by call_id", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const toolResponse = LLMResponse.fromEvents([
      LLMEvent.toolCall({ id: "call_1", name: "lookup", input: { city: "Austin" } }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 3, outputTokens: 4 } }),
    ])
    if (!toolResponse) throw new Error("expected a completed response")
    responseQueue.push(toolResponse)
    const first = yield* postResponses(handler, {
      model: "workhorse",
      input: "Weather in Austin?",
      tools: [{ type: "function", name: "lookup", description: "Look up", parameters: { type: "object" } }],
    })
    expect(first.status).toBe(200)
    const firstBody = yield* responseJson(first)
    expect(firstBody.output[0]?.type).toBe("function_call")

    const second = yield* postResponses(handler, {
      model: "workhorse",
      input: [{ type: "function_call_output", call_id: "call_1", output: "sunny" }],
      previous_response_id: firstBody.id,
    })
    expect(second.status).toBe(200)
    const seen = JSON.stringify(captured.at(-1)?.messages)
    expect(seen).toContain("lookup")
    expect(seen).toContain("sunny")
    expect(captured.at(-1)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  }),
)

it.live("refuses to extend a chain already 64 links deep", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    let current = yield* postResponses(handler, { model: "workhorse", input: "turn 0" })
    let id = (yield* responseJson(current)).id
    for (let depth = 1; depth <= 64; depth++) {
      current = yield* postResponses(handler, { model: "workhorse", input: `turn ${depth}`, previous_response_id: id })
      expect(current.status).toBe(200)
      id = (yield* responseJson(current)).id
    }
    const refused = yield* postResponses(handler, { model: "workhorse", input: "one too many", previous_response_id: id })
    expect(refused.status).toBe(400)
    const body = yield* responseJson(refused)
    expect(body.error?.message).toContain("64")
  }),
)

it.live("chained façade calls create no sessions", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const first = yield* postResponses(handler, { model: "workhorse", input: "first question" })
    const firstBody = yield* responseJson(first)
    yield* postResponses(handler, { model: "workhorse", input: "second question", previous_response_id: firstBody.id })
    const res = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/session")))
    expect(res.status).toBe(200)
    const sessions = (yield* Effect.promise(() => res.json())) as { data: Array<unknown> }
    expect(sessions.data).toHaveLength(0)
  }),
)
