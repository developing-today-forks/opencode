import { expect } from "bun:test"
import { LanguageModel, LLMEvent, LLMResponse } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { AISDK } from "@opencode/core/aisdk"
import { ChatStreamTranslator, completionBody, parseChatRequest } from "@opencode/core/completions"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ID, Info, Model, Ref } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

// ---------------------------------------------------------- translation

const parsed = (body: unknown) => {
  const result = parseChatRequest(body)
  if (!result.ok) throw new Error(`expected parse success, got: ${result.error}`)
  return result.value
}

testEffect(Layer.empty).effect("parses a bare route id as an opencode-route model ref", () =>
  Effect.sync(() => {
    const value = parsed({ model: "workhorse", messages: [{ role: "user", content: "hi" }] })
    expect(value.modelLabel).toBe("workhorse")
    expect(String(value.input.model?.providerID)).toBe("opencode-route")
    expect(String(value.input.model?.id)).toBe("workhorse")
    expect(value.stream).toBe(false)
  }),
)

testEffect(Layer.empty).effect("parses a prefixed ref with a variant and merges system messages", () =>
  Effect.sync(() => {
    const value = parsed({
      model: "opencode-route/workhorse#high",
      stream: true,
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "system", content: "Be kind." },
      ],
    })
    expect(String(value.input.model?.providerID)).toBe("opencode-route")
    expect(String(value.input.model?.id)).toBe("workhorse")
    expect(String(value.input.model?.variant)).toBe("high")
    expect(value.input.system).toBe("Be terse.\nBe kind.")
    expect(value.stream).toBe(true)
    expect(value.input.messages).toHaveLength(1)
  }),
)

testEffect(Layer.empty).effect("translates tools, tool calls, and tool results", () =>
  Effect.sync(() => {
    const value = parsed({
      model: "workhorse",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"city\":\"Austin\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", description: "Look up weather", parameters: { type: "object", properties: {} } },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
      temperature: 0.5,
      max_tokens: 128,
    })
    expect(value.input.tools).toHaveLength(1)
    expect(value.input.tools?.[0]).toMatchObject({ name: "lookup", description: "Look up weather" })
    expect(value.input.toolChoice).toBe("lookup")
    expect(value.input.generation).toMatchObject({ temperature: 0.5, maxTokens: 128 })
    const assistant = value.input.messages[1]
    expect(assistant?.role).toBe("assistant")
    expect(JSON.stringify(assistant?.content)).toContain("tool-call")
    const tool = value.input.messages[2]
    expect(tool?.role).toBe("tool")
    expect(JSON.stringify(tool?.content)).toContain("sunny")
  }),
)

testEffect(Layer.empty).effect("rejects unsupported wire features loudly", () =>
  Effect.sync(() => {
    expect(parseChatRequest({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }).ok).toBe(false)
    expect(parseChatRequest({ messages: [{ role: "developer", content: "hi" }] }).ok).toBe(false)
    expect(parseChatRequest({ messages: "nope" }).ok).toBe(false)
    expect(parseChatRequest({ model: "workhorse", messages: [{ role: "user", content: "hi" }], tools: [{ type: "web" }] }).ok).toBe(false)
  }),
)

testEffect(Layer.empty).effect("renders a completion in the OpenAI wire shape", () =>
  Effect.sync(() => {
    const response = LLMResponse.fromEvents([
      LLMEvent.textDelta({ id: "t1", text: "Hello" }),
      LLMEvent.finish({ reason: { normalized: "stop" }, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
    ])
    if (!response) throw new Error("expected a completed response")
    const body = completionBody({ id: "chatcmpl-x", created: 1, model: "workhorse", response }) as {
      choices: Array<{ message: { content: string | null }; finish_reason: string }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(body.choices[0]?.message.content).toBe("Hello")
    expect(body.choices[0]?.finish_reason).toBe("stop")
    expect(body.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 })
  }),
)

testEffect(Layer.empty).effect("renders tool calls with JSON arguments and a tool_calls finish", () =>
  Effect.sync(() => {
    const response = LLMResponse.fromEvents([
      LLMEvent.toolCall({ id: "call_1", name: "lookup", input: { city: "Austin" } }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 3, outputTokens: 4 } }),
    ])
    if (!response) throw new Error("expected a completed response")
    const body = completionBody({ id: "chatcmpl-x", created: 1, model: "workhorse", response }) as {
      choices: Array<{
        message: { content: string | null; tool_calls: Array<{ function: { name: string; arguments: string } }> }
        finish_reason: string
      }>
    }
    expect(body.choices[0]?.message.content).toBeNull()
    expect(body.choices[0]?.message.tool_calls[0]?.function).toEqual({ name: "lookup", arguments: "{\"city\":\"Austin\"}" })
    expect(body.choices[0]?.finish_reason).toBe("tool_calls")
  }),
)

testEffect(Layer.empty).effect("streams chunks with a role first frame and a finish chunk carrying usage", () =>
  Effect.sync(() => {
    const translator = new ChatStreamTranslator({ id: "chatcmpl-x", created: 1, model: "workhorse" })
    const frames = [
      LLMEvent.textDelta({ id: "t1", text: "Hello" }),
      LLMEvent.textDelta({ id: "t1", text: " world" }),
      LLMEvent.finish({ reason: { normalized: "stop" }, usage: { inputTokens: 5, outputTokens: 2 } }),
    ].flatMap((event) => translator.push(event))
    expect(frames).toHaveLength(3)
    expect(frames[0]).toContain('"role":"assistant"')
    expect(frames[0]).toContain('"content":"Hello"')
    expect(frames[2]).toContain('"finish_reason":"stop"')
    expect(frames[2]).toContain('"prompt_tokens":5')
    expect(translator.failed).toBe(false)
  }),
)

// ---------------------------------------------------------- service

const selected = Info.make({
  ...Info.default(Provider.ID.make("test-provider"), ID.make("gemini")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
})
const runtime = LanguageModel.make({ id: "gemini", provider: "test-provider", route: OpenAIChat.route })

const providers = Layer.mock(Provider.Service, {
  get: () => Effect.undefined,
})
const models = Layer.mock(Model.Service, {
  get: () => Effect.succeed(selected),
})
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
const aisdk = Layer.mock(AISDK.Service, {
  hook: {
    sdk: () => Effect.die("unused"),
    language: () => Effect.die("unused"),
  },
  model: () => Effect.succeed(runtime),
})
const client = TestLLM.testLayer({ fallback: TestLLM.text("OK", "generate") })

const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
const it = testEffect(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, client))))

it.effect("complete runs a stateless chat completion through the resolver", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const response = yield* generate.complete({
      model: Ref.make({ providerID: selected.providerID, id: selected.id }),
      system: "Be terse.",
      messages: [{ role: "user", content: "Return exactly OK" }],
    })
    expect(response.text).toBe("OK")
  }),
)

it.effect("stream emits the completion as LLM events", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const events = yield* Stream.runCollect(
      generate.stream({
        model: Ref.make({ providerID: selected.providerID, id: selected.id }),
        messages: [{ role: "user", content: "Return exactly OK" }],
      }),
    )
    const response = LLMResponse.fromEvents([...events])
    expect(response?.text).toBe("OK")
  }),
)
