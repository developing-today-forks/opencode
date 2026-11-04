import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message, ToolDefinition } from "../../src/index.js"
import { MistralChat } from "../../src/protocols/mistral-chat.js"
import { Vibe } from "../../src/providers/vibe.js"
import { compileRequest } from "../../src/route/client.js"
import { Endpoint } from "../../src/route/endpoint.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse, observe } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = Vibe.configure({ apiKey: "fixture-key" }).model("mistral-vibe-cli-latest")

const chunk = (delta: object, finishReason: string | null = null, usage?: object) => ({
  choices: [{ delta, finish_reason: finishReason }],
  usage,
})

it.effect("Vibe provider stays wired to the Mistral Chat protocol", () =>
  Effect.sync(() => {
    expect(Vibe.id).toBe("vibe")
    expect(Vibe.provider.id).toBe("vibe")
    expect(typeof Vibe.model).toBe("function")
    expect(Vibe.route.id).toBe(MistralChat.route.id)
    expect(model.provider).toBe("vibe")
  }),
)

it.effect("Vibe route points at the binary's endpoint", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model, prompt: "Hello" })
    const compiled = yield* compileRequest(request)
    const url = Endpoint.render(model.route.endpoint, { request, body: compiled.body }).toString()
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions")
  }),
)

it.effect("default model carries the binary's request defaults: temperature 1.0, thinking high, no top_p", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(LLM.request({ model, prompt: "hi" }))
    const body = compiled.body as Record<string, unknown>
    expect(body.model).toBe("mistral-vibe-cli-latest")
    expect(body.temperature).toBe(1.0)
    expect(body.reasoning_effort).toBe("high")
    expect(body.top_p).toBeUndefined()
  }),
)

it.effect("the binary's alias for the default model gets the same defaults", () =>
  Effect.gen(function* () {
    const alias = Vibe.configure({ apiKey: "fixture-key" }).model("mistral-medium-3.5")
    const compiled = yield* compileRequest(LLM.request({ model: alias, prompt: "hi" }))
    const body = compiled.body as Record<string, unknown>
    expect(body.temperature).toBe(1.0)
    expect(body.reasoning_effort).toBe("high")
  }),
)

it.effect("caller-supplied generation and provider options win over the preset defaults", () =>
  Effect.gen(function* () {
    const custom = Vibe.configure({
      apiKey: "fixture-key",
      generation: { temperature: 0.2 },
      providerOptions: { reasoningEffort: "off" },
    }).model("mistral-vibe-cli-latest")
    const compiled = yield* compileRequest(LLM.request({ model: custom, prompt: "hi" }))
    const body = compiled.body as Record<string, unknown>
    expect(body.temperature).toBe(0.2)
    expect(body.reasoning_effort).toBe("off")
  }),
)

it.effect("non-default presets get no invented defaults", () =>
  Effect.gen(function* () {
    const codestral = Vibe.configure({ apiKey: "fixture-key" }).model("codestral-latest")
    const compiled = yield* compileRequest(LLM.request({ model: codestral, prompt: "hi" }))
    const body = compiled.body as Record<string, unknown>
    expect(body.model).toBe("codestral-latest")
    expect(body.temperature).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  }),
)

it.effect("tools lower through the Mistral Chat route; parallel_tool_calls follows the provider option", () =>
  Effect.gen(function* () {
    const tools = [
      ToolDefinition.make({
        name: "get_weather",
        description: "Get weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      }),
    ]
    const compiled = yield* compileRequest(
      LLM.request({ model, messages: [Message.user("weather?")], tools }),
    )
    const body = compiled.body as { tools?: Array<{ function?: { name?: string } }> }
    expect(body.tools?.[0]?.function?.name).toBe("get_weather")

    const parallel = Vibe.configure({ apiKey: "fixture-key", providerOptions: { parallelToolCalls: true } }).model(
      "mistral-vibe-cli-latest",
    )
    const compiledParallel = yield* compileRequest(
      LLM.request({ model: parallel, messages: [Message.user("weather?")], tools }),
    )
    expect((compiledParallel.body as Record<string, unknown>).parallel_tool_calls).toBe(true)
  }),
)

it.effect("stream: SSE chunks become text + usage, and the only auth header is the Bearer key", () =>
  Effect.gen(function* () {
    const calls: Array<{ headers: Headers }> = []
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const { call } = yield* observe([], input)
            calls.push({ headers: call.headers })
            return input.respond(
              sseEvents(
                chunk({ content: "Hello" }),
                chunk({ content: " world" }),
                chunk({}, "stop", {
                  prompt_tokens: 11,
                  completion_tokens: 5,
                  total_tokens: 16,
                  prompt_tokens_details: { cached_tokens: 3 },
                }),
              ),
              { headers: { "content-type": "text/event-stream" } },
            )
          }),
        ),
      ),
    )
    expect(response.text).toBe("Hello world")
    expect(response.usage).toMatchObject({ inputTokens: 11, outputTokens: 5, totalTokens: 16 })
    expect(response.usage?.cacheReadInputTokens).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer fixture-key")
  }),
)

it.effect("credential resolution feeds the auth header (keyring tier, via injected sources)", () =>
  Effect.gen(function* () {
    const keyed = Vibe.configure({
      sources: {
        env: {},
        readFile: () => undefined,
        keyringLookup: async (service) => (service === "ai.mistral.vibe" ? "keyring-key" : undefined),
      },
    }).model("mistral-vibe-cli-latest")
    const calls: Array<{ headers: Headers }> = []
    const response = yield* LLMClient.generate(LLM.request({ model: keyed, prompt: "hi" })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const { call } = yield* observe([], input)
            calls.push({ headers: call.headers })
            return input.respond(sseEvents(chunk({ content: "ok" }, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    )
    expect(response.text).toBe("ok")
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer keyring-key")
  }),
)

it.effect("absent credential fails with the not-signed-in guidance, before any request", () =>
  Effect.gen(function* () {
    const unsigned = Vibe.configure({
      sources: { env: {}, readFile: () => undefined, keyringLookup: async () => undefined },
    }).model("mistral-vibe-cli-latest")
    const result = yield* LLMClient.generate(LLM.request({ model: unsigned, prompt: "hi" })).pipe(
      Effect.provide(fixedResponse(sseEvents(chunk({ content: "unreachable" }, "stop")))),
      Effect.result,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(JSON.stringify(result.failure)).toContain("vibe --setup")
  }),
)
