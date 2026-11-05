import { expect } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import { LLM, LLMClient, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { ClaudeCode } from "../../src/providers/claude-code.js"
import {
  ClaudeCodeMessages,
  IDENTITY_SYSTEM_TEXT,
  OAUTH_BETA_HEADER,
} from "../../src/protocols/claude-code-messages.js"
import { compileRequest } from "../../src/route/client.js"
import { Endpoint } from "../../src/route/endpoint.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = ClaudeCode.configure({ accessToken: "fixture-oauth-token" }).model("claude-haiku-5-5")

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

it.effect("Claude Code provider stays wired to the Claude Code Messages protocol", () =>
  Effect.sync(() => {
    expect(ClaudeCode.id).toBe("claude-code")
    expect(ClaudeCode.provider.id).toBe("claude-code")
    expect(typeof ClaudeCode.model).toBe("function")
    expect(ClaudeCode.route.id).toBe(ClaudeCodeMessages.route.id)
    expect(model.provider).toBe("claude-code")
    expect(ClaudeCode.MODELS.map((preset) => preset.id)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ])
    expect(ClaudeCode.DEFAULT_MODEL_ID).toBe("claude-haiku-5-5")
  }),
)

it.effect("Claude Code route points at the Anthropic Messages endpoint the CLI calls", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model, prompt: "Hello" })
    const compiled = yield* compileRequest(request)
    const url = Endpoint.render(model.route.endpoint, { request, body: compiled.body }).toString()
    expect(url).toBe("https://api.anthropic.com/v1/messages")
  }),
)

it.effect("Claude Code route carries the OAuth beta flags and the CLI's client headers", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model, prompt: "Hello" })
    const headers = model.route.headers?.({ request }) ?? {}
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["anthropic-beta"]).toBe(OAUTH_BETA_HEADER)
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219")
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20")
    expect(headers["x-app"]).toBe("cli")
    expect(headers["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/)
    // The OAuth credential is a Bearer token, never an API key.
    const authHeaders = yield* model.route.auth.apply({
      request,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      body: "{}",
      headers: Headers.empty,
    })
    expect(authHeaders.authorization).toBe("Bearer " + "fixture-oauth-token")
    expect(authHeaders["x-api-key"]).toBeUndefined()
  }),
)

it.effect("the Claude Code identity block leads the system array, ahead of the caller's system prompt", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(LLM.request({ model, system: "You are a fleet agent.", prompt: "hi" }))
    const body = compiled.body as Record<string, never>
    const system = body.system as Array<Record<string, unknown>>
    expect(system[0]).toMatchObject({ type: "text", text: IDENTITY_SYSTEM_TEXT })
    expect(system[1]).toMatchObject({ type: "text", text: "You are a fleet agent." })
    // No caller system at all still yields exactly the identity block:
    // an OAuth request without it is rejected upstream.
    const bare = yield* compileRequest(LLM.request({ model, prompt: "hi" }))
    const bareSystem = (bare.body as Record<string, never>).system as Array<Record<string, unknown>>
    expect(bareSystem).toHaveLength(1)
    expect(bareSystem[0]).toMatchObject({ type: "text", text: IDENTITY_SYSTEM_TEXT })
  }),
)

it.effect("tools lower to real Anthropic tool_use shapes — the #6117 defect, inverted", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        messages: [Message.user("weather?")],
        tools,
        toolChoice: { type: "tool", name: "get_weather" },
      }),
    )
    const body = compiled.body as Record<string, never>
    const loweredTools = body.tools as Array<Record<string, unknown>>
    expect(loweredTools).toHaveLength(1)
    expect(loweredTools[0].name).toBe("get_weather")
    expect(loweredTools[0].description).toBe("Get weather")
    expect(loweredTools[0].input_schema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    })
    expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" })
  }),
)

it.effect("history tool calls and results replay as tool_use / tool_result blocks with their ids intact", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        messages: [
          Message.user("weather in Oslo?"),
          Message.assistant([
            Message.text("checking"),
            ToolCallPart.make({ id: "toolu_1", name: "get_weather", input: { city: "Oslo" } }),
          ]),
          Message.tool({ id: "toolu_1", name: "get_weather", result: "sunny", resultType: "text" }),
          Message.user("thanks"),
        ],
        tools,
      }),
    )
    const body = compiled.body as Record<string, never>
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const assistant = messages.find((message) => message.role === "assistant")
    expect(assistant?.content).toContainEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: { city: "Oslo" },
    })
    const resultMessage = messages.find((message) => message.content.some((block) => block.type === "tool_result"))
    expect(resultMessage?.content).toContainEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "sunny",
    })
  }),
)

it.effect("Claude Code stream: a streamed tool_use block becomes a real client tool call", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(
      LLM.request({ model, messages: [Message.user("weather in Oslo?")], tools }),
    ).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents(
            { type: "message_start", message: { usage: { input_tokens: 9 } } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"city": "Oslo"}' },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 4 },
            },
            { type: "message_stop" },
          ),
        ),
      ),
    )
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0].name).toBe("get_weather")
    expect(response.toolCalls[0].id).toBe("toolu_1")
    expect(response.toolCalls[0].input).toEqual({ city: "Oslo" })
    expect(response.finishReason?.normalized).toBe("tool-calls")
    expect(response.usage?.inputTokens).toBe(9)
    expect(response.usage?.outputTokens).toBe(4)
  }),
)
