import { describe, expect, test } from "bun:test"
import { LanguageModel, LLMEvent, LLMResponse } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { AISDK } from "@opencode/core/aisdk"
import { ChatStreamTranslator, MessagesStreamTranslator, ResponsesStreamTranslator, completionBody, messagesBody, parseChatRequest, parseMessagesRequest, parseResponsesRequest, responsesBody } from "@opencode/core/completions"
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

describe("responses door translation", () => {
  test("string input and instructions become system plus one user message", () => {
    const parsed = parseResponsesRequest({
      model: "opencode-route/workhorse",
      instructions: "Be terse.",
      input: "Say hi",
      reasoning: { effort: "high" },
      max_output_tokens: 64,
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.input.system).toBe("Be terse.")
    expect(parsed.value.input.messages.length).toBe(1)
    expect(String(parsed.value.input.model?.variant)).toBe("high")
    expect(parsed.value.input.generation?.maxTokens).toBe(64)
  })

  test("item input carries function calls and outputs; direct catalog refs pass through", () => {
    const parsed = parseResponsesRequest({
      model: "deepseek/deepseek-chat",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Weather in Austin?" }] },
        { type: "function_call", call_id: "call_9", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_9", output: "sunny" },
        { type: "reasoning", summary: [] },
      ],
      tools: [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object" } }],
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(String(parsed.value.input.model?.providerID)).toBe("deepseek")
    expect(parsed.value.input.messages.length).toBe(3)
    expect(parsed.value.input.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })

  test("previous_response_id is rejected loudly", () => {
    const parsed = parseResponsesRequest({ model: "workhorse", input: "x", previous_response_id: "resp_1" })
    expect(parsed.ok).toBe(false)
  })

  test("responses body carries message output and usage", () => {
    const response = LLMResponse.fromEvents([
      LLMEvent.textDelta({ id: "t1", text: "Hello!" }),
      LLMEvent.finish({ reason: { normalized: "stop" }, usage: { inputTokens: 4, outputTokens: 6 } }),
    ])
    if (!response) throw new Error("expected a completed response")
    const body = responsesBody({
      id: "resp_fixed",
      created: 1700000000,
      model: "opencode-route/workhorse",
      response,
    }) as any
    expect(body.status).toBe("completed")
    expect(body.output[0].content[0].text).toBe("Hello!")
    expect(body.usage.input_tokens).toBe(4)
    expect(body.usage.total_tokens).toBe(10)
  })

  test("responses stream translator emits typed events ending in response.completed", () => {
    const translator = new ResponsesStreamTranslator({ id: "resp_s", created: 1, model: "m" })
    const frames = [
      translator.start(),
      ...translator.push(LLMEvent.textDelta({ id: "block_1", text: "Hi" })),
      ...translator.push(LLMEvent.finish({ reason: { normalized: "stop" } })),
    ].join("")
    expect(frames).toContain("event: response.created")
    expect(frames).toContain("response.output_text.delta")
    expect(frames).toContain('"delta":"Hi"')
    expect(frames).toContain("event: response.completed")
    expect(frames).not.toContain("[DONE]")
  })
})

describe("messages door translation", () => {
  const parsedMessages = (body: unknown) => {
    const result = parseMessagesRequest(body)
    if (!result.ok) throw new Error(`expected parse success, got: ${result.error}`)
    return result.value
  }

  test("route name, system blocks, and generation options become the canonical input", () => {
    const value = parsedMessages({
      model: "workhorse",
      max_tokens: 256,
      system: [{ type: "text", text: "Be terse." }, { type: "text", text: "Be kind." }],
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ["END"],
    })
    expect(String(value.input.model?.providerID)).toBe("opencode-route")
    expect(String(value.input.model?.id)).toBe("workhorse")
    expect(value.input.system).toBe("Be terse.Be kind.")
    expect(value.input.generation).toMatchObject({ maxTokens: 256, temperature: 0.5, topP: 0.9, stop: ["END"] })
    expect(value.stream).toBe(false)
  })

  test("direct catalog refs pass through the messages door too", () => {
    const value = parsedMessages({
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(String(value.input.model?.providerID)).toBe("anthropic")
    expect(String(value.input.model?.id)).toBe("claude-sonnet-4-5")
  })

  test("tool_use and tool_result blocks round-trip through the canonical parts", () => {
    const value = parsedMessages({
      model: "workhorse",
      max_tokens: 128,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { city: "Austin" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }] },
      ],
      tools: [{ name: "lookup", description: "Look up weather", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
    })
    expect(value.input.tools?.[0]).toMatchObject({ name: "lookup", description: "Look up weather" })
    expect(JSON.stringify(value.input.toolChoice)).toContain("lookup")
    const assistant = value.input.messages[1]
    expect(assistant?.role).toBe("assistant")
    expect(JSON.stringify(assistant?.content)).toContain("tool-call")
    expect(JSON.stringify(assistant?.content)).toContain("Austin")
    const tool = value.input.messages[2]
    expect(tool?.role).toBe("tool")
    expect(JSON.stringify(tool?.content)).toContain("tool-result")
    expect(JSON.stringify(tool?.content)).toContain("sunny")
    expect(JSON.stringify(tool?.content)).toContain("lookup")
  })

  test("image blocks become canonical media parts", () => {
    const value = parsedMessages({
      model: "workhorse",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAw==" } },
            { type: "image", source: { type: "url", url: "https://example.test/cat.png" } },
          ],
        },
      ],
    })
    const content = JSON.stringify(value.input.messages[0]?.content)
    expect(content).toContain('"type":"media"')
    expect(content).toContain("image/png")
    expect(content).toContain("example.test/cat.png")
  })

  test("unsupported shapes fail loudly, naming the shape", () => {
    const base = { model: "workhorse", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }
    expect(parseMessagesRequest({ messages: base.messages }).ok).toBe(false) // max_tokens is required
    expect(parseMessagesRequest({ ...base, messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "x" } }] }] })).toMatchObject({ ok: false, error: expect.stringContaining("document") })
    expect(parseMessagesRequest({ ...base, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }] }] })).toMatchObject({ ok: false, error: expect.stringContaining("thinking") })
    expect(parseMessagesRequest({ ...base, tools: [{ type: "web_search_20250305", name: "web_search" }] })).toMatchObject({ ok: false, error: expect.stringContaining("web_search_20250305") })
    expect(parseMessagesRequest({ ...base, thinking: { type: "enabled", budget_tokens: 1024 } })).toMatchObject({ ok: false, error: expect.stringContaining("thinking") })
    expect(parseMessagesRequest({ ...base, messages: [{ role: "system", content: "hi" }] }).ok).toBe(false)
  })

  test("messages body carries text and tool_use blocks, stop_reason, and Anthropic usage", () => {
    const response = LLMResponse.fromEvents([
      LLMEvent.textDelta({ id: "t1", text: "Hello" }),
      LLMEvent.toolCall({ id: "toolu_1", name: "lookup", input: { city: "Austin" } }),
      LLMEvent.finish({
        reason: { normalized: "tool-calls" },
        usage: { inputTokens: 10, outputTokens: 4, nonCachedInputTokens: 6, cacheReadInputTokens: 4 },
      }),
    ])
    if (!response) throw new Error("expected a completed response")
    const body = messagesBody({ id: "msg_x", model: "workhorse", response }) as any
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.content[0]).toEqual({ type: "text", text: "Hello" })
    expect(body.content[1]).toEqual({ type: "tool_use", id: "toolu_1", name: "lookup", input: { city: "Austin" } })
    expect(body.stop_reason).toBe("tool_use")
    expect(body.stop_sequence).toBeNull()
    expect(body.usage).toEqual({ input_tokens: 6, output_tokens: 4, cache_read_input_tokens: 4 })
  })

  test("messages body maps a length finish to max_tokens", () => {
    const response = LLMResponse.fromEvents([
      LLMEvent.textDelta({ id: "t1", text: "partial" }),
      LLMEvent.finish({ reason: { normalized: "length" }, usage: { inputTokens: 3, outputTokens: 64 } }),
    ])
    if (!response) throw new Error("expected a completed response")
    const body = messagesBody({ id: "msg_x", model: "workhorse", response }) as any
    expect(body.stop_reason).toBe("max_tokens")
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 64 })
  })

  test("messages stream translator emits the Anthropic event grammar in order", () => {
    const translator = new MessagesStreamTranslator({ id: "msg_s", model: "workhorse" })
    const frames = [
      translator.start(),
      ...translator.push(LLMEvent.textDelta({ id: "t1", text: "Hello" })),
      ...translator.push(LLMEvent.textDelta({ id: "t1", text: " world" })),
      ...translator.push(LLMEvent.toolCall({ id: "toolu_1", name: "lookup", input: { city: "Austin" } })),
      ...translator.push(LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 5, outputTokens: 2 } })),
    ]
    const text = frames.join("")
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
    expect(text).toContain('"type":"text_delta","text":"Hello"')
    expect(text).toContain('"type":"tool_use","id":"toolu_1","name":"lookup"')
    expect(text).toContain('"type":"input_json_delta","partial_json":"{\\"city\\":\\"Austin\\"}"')
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(text).toContain('"input_tokens":5,"output_tokens":2')
    expect(text).not.toContain("[DONE]")
    expect(translator.failed).toBe(false)
  })

  test("messages stream translator terminates a provider failure with an error event, not message_stop", () => {
    const translator = new MessagesStreamTranslator({ id: "msg_s", model: "workhorse" })
    const frames = [translator.start(), ...translator.push(LLMEvent.providerError({ message: "boom" }))]
    const text = frames.join("")
    expect(text).toContain("event: error")
    expect(text).toContain("boom")
    expect(text).not.toContain("message_stop")
    expect(translator.failed).toBe(true)
  })
})
