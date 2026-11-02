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
const fake = makeLocationNode({
  service: Generate.Service,
  layer: Layer.succeed(
    Generate.Service,
    Generate.Service.of({
      text: () => Effect.die("unused"),
      complete: (input) => {
        captured.push(input)
        return Effect.succeed(response)
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
    fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ model: "base/default" })),
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
    expect(text).toContain("response.output_text.delta")
    expect(text).toContain("event: response.completed")
    expect(text).not.toContain("[DONE]")
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
