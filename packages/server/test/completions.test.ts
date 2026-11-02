import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { LLMEvent, LLMResponse } from "@opencode/ai"
import { Generate, type CompletionInput } from "@opencode/core/generate"
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
    { overrides: [Generate.node.replace(fake)] },
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
  }),
)
