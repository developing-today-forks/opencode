import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { Commandcode } from "../../src/providers/commandcode.js"
import { CommandCode } from "../../src/protocols/commandcode.js"
import { compileRequest } from "../../src/route/client.js"
import { Endpoint } from "../../src/route/endpoint.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"

const model = Commandcode.configure({ apiKey: "user_fixturekey" }).model("deepseek/deepseek-v4-flash")

const tools = [
  ToolDefinition.make({
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    } as never,
  }),
]

const ndjson = (...events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n"

it.effect("Command Code provider stays wired to the /alpha/generate protocol", () =>
  Effect.sync(() => {
    expect(Commandcode.id).toBe("commandcode")
    expect(Commandcode.provider.id).toBe("commandcode")
    expect(typeof Commandcode.model).toBe("function")
    expect(Commandcode.route.id).toBe(CommandCode.route.id)
    expect(model.provider).toBe("commandcode")
    expect(Commandcode.DEFAULT_MODEL_ID).toBe("deepseek/deepseek-v4-flash")
  }),
)

it.effect("Command Code route points at the CLI's own gateway endpoint, not the Provider API", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model, prompt: "Hello" })
    const compiled = yield* compileRequest(request)
    const url = Endpoint.render(model.route.endpoint, { request, body: compiled.body }).toString()
    expect(url).toBe("https://api.commandcode.ai/alpha/generate")
  }),
)

it.effect("the request body matches the CLI bundle's createModelClient envelope", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        system: "You are a fleet agent.",
        messages: [Message.user("weather in Oslo?")],
        tools,
        generation: { temperature: 0.4 },
        providerOptions: { reasoning_effort: "high" },
      }),
    )
    const body = compiled.body as Record<string, never>
    // The gateway validates all nine buildServerConfig fields (a bare {}
    // is a live-probed 400); the lowering builds the CLI's shape from
    // the server process, with the bundle's non-git fallback values.
    const config = body.config as Record<string, unknown>
    expect(config.workingDir).toBe(process.cwd())
    expect(config.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(config.environment).toBe(process.platform)
    expect(Array.isArray(config.structure)).toBe(true)
    expect(config.isGitRepo).toBe(false)
    expect(config.currentBranch).toBe("")
    expect(config.recentCommits).toEqual([])
    expect(body.memory).toBeNull()
    expect(body.taste).toBeNull()
    expect(body.skills).toBeNull()
    expect(body.permissionMode).toBe("standard")
    const params = body.params as Record<string, never>
    expect(params.model).toBe("deepseek/deepseek-v4-flash")
    expect(params.stream).toBe(true)
    expect(params.max_tokens).toBe(64000)
    expect(params.temperature).toBe(0.4)
    expect(params.reasoning_effort).toBe("high")
    expect(params.system).toEqual([{ type: "text", text: "You are a fleet agent." }])
    expect(params.messages).toEqual([{ role: "user", content: [{ type: "text", text: "weather in Oslo?" }] }])
    // The client's tools are declared on the wire with their full
    // schemas — never reduced to the prose manifest the retired CLI
    // bridge sent (code#6117).
    expect(params.tools).toEqual([
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ])
  }),
)

it.effect("a serverConfig provider option replaces the built server config whole", () =>
  Effect.gen(function* () {
    const serverConfig = {
      workingDir: "/fixture/project",
      date: "2026-11-05",
      environment: "linux",
      structure: ["src", "test"],
      isGitRepo: true,
      currentBranch: "main",
      mainBranch: "main",
      gitStatus: "Working tree clean",
      recentCommits: ["abc1234 fixture"],
    }
    const compiled = yield* compileRequest(LLM.request({ model, prompt: "hi", providerOptions: { serverConfig } }))
    expect((compiled.body as Record<string, never>).config).toEqual(serverConfig)
  }),
)

it.effect("history lowers to the bundle's wire messages: tool-call parts and tool-result outputs keep their ids", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        messages: [
          Message.user("weather in Oslo?"),
          Message.assistant([
            Message.text("checking"),
            ToolCallPart.make({ id: "call_1", name: "get_weather", input: { city: "Oslo" } }),
          ]),
          Message.tool({ id: "call_1", name: "get_weather", result: "sunny", resultType: "text" }),
          Message.user("thanks"),
        ],
        tools,
      }),
    )
    const params = (compiled.body as Record<string, never>).params as Record<string, never>
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather in Oslo?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Oslo" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "get_weather",
            output: { type: "text", value: "sunny" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ])
  }),
)

it.effect("a forced tool choice fails closed: the wire has no tool_choice field to honor it with", () =>
  Effect.gen(function* () {
    for (const toolChoice of [{ type: "required" }, { type: "tool", name: "get_weather" }] as const) {
      const result = yield* compileRequest(
        LLM.request({ model, messages: [Message.user("weather?")], tools, toolChoice }),
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(JSON.stringify(result.failure)).toContain("tool_choice")
    }
    // "none" IS honored faithfully: the tools simply never reach the wire.
    const compiled = yield* compileRequest(
      LLM.request({ model, messages: [Message.user("weather?")], tools, toolChoice: { type: "none" } }),
    )
    const params = (compiled.body as Record<string, never>).params as Record<string, never>
    expect(params.tools).toBeUndefined()
  }),
)

it.effect("Command Code stream: NDJSON deltas, a tool call, and finish become a real client tool call", () =>
  Effect.gen(function* () {
    const tricky = 'A "quoted" line\nsecond line — café ☃ MARKER-ALPHA-731'
    const response = yield* LLMClient.generate(
      LLM.request({ model, messages: [Message.user("weather?")], tools }),
    ).pipe(
      Effect.provide(
        fixedResponse(
          ndjson(
            { type: "reasoning-start" },
            { type: "reasoning-delta", text: "thinking" },
            { type: "reasoning-end" },
            { type: "text-delta", text: "Let me check." },
            { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: tricky } },
            {
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: {
                inputTokens: 11,
                outputTokens: 7,
                inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 1 },
              },
            },
          ),
        ),
      ),
    )
    expect(response.text).toBe("Let me check.")
    expect(response.reasoning).toBe("thinking")
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0].id).toBe("call_1")
    expect(response.toolCalls[0].name).toBe("get_weather")
    // Argument fidelity: quotes, newline, and unicode survive byte-exact.
    expect(response.toolCalls[0].input).toEqual({ city: tricky })
    expect(response.finishReason?.normalized).toBe("tool-calls")
    expect(response.usage?.inputTokens).toBe(11)
    expect(response.usage?.outputTokens).toBe(7)
    expect(response.usage?.cacheReadInputTokens).toBe(3)
    expect(response.usage?.cacheWriteInputTokens).toBe(1)
  }),
)

it.effect("Command Code stream: parallel tool calls in one turn both emit, with distinct ids", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(
      LLM.request({ model, messages: [Message.user("weather in two cities?")], tools }),
    ).pipe(
      Effect.provide(
        fixedResponse(
          ndjson(
            { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Oslo" } },
            { type: "tool-call", toolCallId: "call_2", toolName: "get_weather", input: { city: "Bergen" } },
            { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 5, outputTokens: 2 } },
          ),
        ),
      ),
    )
    expect(response.toolCalls.map((call) => [call.id, call.input])).toEqual([
      ["call_1", { city: "Oslo" }],
      ["call_2", { city: "Bergen" }],
    ])
    expect(response.finishReason?.normalized).toBe("tool-calls")
  }),
)

it.effect("Command Code stream: string-form tool input is parsed, not dropped", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(
      LLM.request({ model, messages: [Message.user("weather?")], tools }),
    ).pipe(
      Effect.provide(
        fixedResponse(
          ndjson(
            { type: "tool-call", toolCallId: "call_9", toolName: "get_weather", input: '{"city":"Oslo"}' },
            { type: "finish", finishReason: "tool-calls" },
          ),
        ),
      ),
    )
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0].input).toEqual({ city: "Oslo" })
  }),
)

it.effect("Command Code stream: gateway-executed calls surface as provider-executed, never as client calls", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "search the web" })).pipe(
      Effect.provide(
        fixedResponse(
          ndjson(
            {
              type: "tool-call",
              toolCallId: "srv_1",
              toolName: "web_search",
              input: { query: "oslo weather" },
              providerExecuted: true,
            },
            { type: "tool-result", toolCallId: "srv_1", toolName: "web_search", output: "sunny in Oslo" },
            { type: "text-delta", text: "It is sunny." },
            { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 2 } },
          ),
        ),
      ),
    )
    // The call is present but flagged providerExecuted — the session
    // layer never executes provider-executed parts — and its result
    // rides as a provider-executed tool-result, not a client execution.
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0].providerExecuted).toBe(true)
    const resultEvent = response.events.find((event) => event.type === "tool-result")
    expect(resultEvent).toMatchObject({ id: "srv_1", name: "web_search", providerExecuted: true })
    expect(response.text).toBe("It is sunny.")
    expect(response.finishReason?.normalized).toBe("stop")
  }),
)

it.effect(
  "Command Code stream: the live-captured event shapes (tool-input-*, finish-step, provider-metadata) parse whole",
  () =>
    Effect.gen(function* () {
      // Trimmed from a real /alpha/generate stream captured live
      // 2026-11-05 (deepseek/deepseek-v4-flash, get_weather for Oslo):
      // the gateway interleaves Vercel-style tool-input-* bookkeeping and
      // a finish-step event around the tool-call — all of it must decode,
      // with the atomic tool-call carrying the assembled input.
      const response = yield* LLMClient.generate(
        LLM.request({ model, messages: [Message.user("weather in Oslo?")], tools }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            ndjson(
              { type: "start" },
              { type: "start-step", request: {}, warnings: [] },
              { type: "reasoning-start", id: "reasoning-0" },
              { type: "reasoning-delta", id: "reasoning-0", text: "The user wants the tool." },
              { type: "reasoning-end", id: "reasoning-0" },
              { type: "tool-input-start", id: "call_00_live", toolName: "get_weather", dynamic: false },
              { type: "tool-input-delta", id: "call_00_live", delta: '{"city": "Os' },
              { type: "tool-input-delta", id: "call_00_live", delta: 'lo"}' },
              { type: "tool-input-end", id: "call_00_live" },
              { type: "tool-call", toolCallId: "call_00_live", toolName: "get_weather", input: { city: "Oslo" } },
              {
                type: "finish-step",
                finishReason: "tool-calls",
                rawFinishReason: "tool_calls",
                usage: { inputTokens: 7860, outputTokens: 60, totalTokens: 7920 },
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                rawFinishReason: "tool_calls",
                totalUsage: {
                  inputTokens: 7860,
                  inputTokenDetails: { noCacheTokens: 1716, cacheReadTokens: 6144 },
                  outputTokens: 60,
                  totalTokens: 7920,
                  reasoningTokens: 20,
                  cachedInputTokens: 6144,
                },
              },
              { type: "provider-metadata", providerMetadata: { novita: { acceptedPredictionTokens: 0 } } },
            ),
          ),
        ),
      )
      expect(response.toolCalls).toHaveLength(1)
      expect(response.toolCalls[0].id).toBe("call_00_live")
      expect(response.toolCalls[0].input).toEqual({ city: "Oslo" })
      expect(response.reasoning).toBe("The user wants the tool.")
      expect(response.finishReason?.normalized).toBe("tool-calls")
      expect(response.usage?.inputTokens).toBe(7860)
      expect(response.usage?.cacheReadInputTokens).toBe(6144)
    }),
)

it.effect("Command Code stream: an in-stream error event fails with the upstream message", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(
        fixedResponse(ndjson({ type: "error", error: { message: "insufficient credits", statusCode: 402 } })),
      ),
      Effect.result,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(JSON.stringify(result.failure)).toContain("insufficient credits")
  }),
)

it.effect("Command Code stream: a stream ending before its finish event fails loudly, never as a silent stop", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(fixedResponse(ndjson({ type: "text-delta", text: "partial" }))),
      Effect.result,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(JSON.stringify(result.failure)).toContain("no finish event")
  }),
)
