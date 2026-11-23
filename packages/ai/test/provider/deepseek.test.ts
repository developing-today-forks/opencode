import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai, LLMClient, Message, ToolCallPart, ToolDefinition } from "../../src/effect.js"
import { DeepSeek } from "../../src/providers/deepseek.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { deltaChunk, usageChunk } from "../lib/openai-chunks.js"
import { sseEvents } from "../lib/sse.js"

// §11-G1 fixtures for the DeepSeek provider (opencode#2231, decomposed from
// opencode#1707). Oracle: the shared OpenAI Chat behavior in
// openai-chat.test.ts is the baseline — DeepSeek rides that protocol
// (providers/deepseek.ts) with providerMetadataKey "deepseek",
// maxTokensField "max_tokens" and supportsStore false. These fixtures pin
// the DeepSeek-specific deltas on top of that baseline: reasoning_content
// interleaved with tool-call deltas, and DeepSeek's usage placement
// (a trailing empty-choices chunk carrying prompt_cache_hit_tokens /
// prompt_cache_miss_tokens instead of prompt_tokens_details).

const lookup = ToolDefinition.make({
  name: "lookup",
  description: "Lookup data",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
})

const model = DeepSeek.configure({ apiKey: "fixture" }).model("deepseek-reasoner")

const request = ai.request({
  id: "req_deepseek_1",
  model,
  prompt: "Look up the weather.",
  tools: [lookup],
  maxTokens: 64,
})

describe("DeepSeek provider", () => {
  it.effect("compiles the shared OpenAI Chat request shape with max_tokens and no store", () =>
    Effect.gen(function* () {
      expect(model.route.endpoint.baseURL).toBe("https://api.deepseek.com/v1")
      const compiled = yield* compileRequest(request)
      expect(compiled.body).toMatchObject({
        model: "deepseek-reasoner",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 64,
      })
      expect(compiled.body.max_completion_tokens).toBeUndefined()
      expect(compiled.body.store).toBeUndefined()
      expect(compiled.body.tools?.[0]?.function.name).toBe("lookup")
    }),
  )

  it.effect("streams reasoning_content interleaved with tool-call deltas", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              deltaChunk({ role: "assistant", reasoning_content: "Weighing " }),
              deltaChunk({ reasoning_content: "the forecast." }),
              // DeepSeek keeps sending reasoning_content (empty) on the
              // chunk that opens the tool call.
              deltaChunk({
                reasoning_content: "",
                tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }],
              }),
              deltaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }),
              deltaChunk({ tool_calls: [{ index: 0, function: { arguments: '"weather"}' } }] }),
              deltaChunk({}, "tool_calls"),
              usageChunk({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Weighing the forecast.")
      expect(response.text).toBe("")
      expect(response.toolCalls).toMatchObject([{ id: "call_1", name: "lookup", input: { query: "weather" } }])
      expect(response.finishReason.raw).toBe("tool_calls")
      expect(response.message.content.find((part) => part.type === "reasoning")?.providerMetadata).toEqual({
        deepseek: { reasoningField: "reasoning_content" },
      })
      expect(response.usage?.providerMetadata).toEqual({
        deepseek: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })
    }),
  )

  it.effect("reads usage from the trailing chunk with DeepSeek cache-hit placement", () =>
    Effect.gen(function* () {
      const usage = {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 4 },
      }
      const response = yield* LLMClient.generate(
        ai.request({ id: "req_deepseek_2", model, prompt: "Say hello." }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              deltaChunk({ role: "assistant", reasoning_content: "Hi." }),
              deltaChunk({ content: "Hello" }),
              deltaChunk({}, "stop"),
              usageChunk(usage),
            ),
          ),
        ),
      )

      expect(response.text).toBe("Hello")
      expect(response.usage?.inputTokens).toBe(11)
      expect(response.usage?.outputTokens).toBe(7)
      expect(response.usage?.cacheReadInputTokens).toBe(4)
      expect(response.usage?.nonCachedInputTokens).toBe(7)
      expect(response.usage?.reasoningTokens).toBe(4)
      expect(response.usage?.totalTokens).toBe(18)
      expect(response.usage?.providerMetadata).toEqual({ deepseek: usage })
    }),
  )

  it.effect("replays reasoning_content alongside tool calls on the next turn", () =>
    Effect.gen(function* () {
      const compiled = yield* compileRequest(
        ai.request({
          model,
          messages: [
            Message.user("Look up the weather."),
            Message.assistant([
              { type: "reasoning", text: "Weighing the forecast." },
              ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } }),
            ]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      const assistant = compiled.body.messages[1]
      expect(assistant).toMatchObject({
        role: "assistant",
        reasoning_content: "Weighing the forecast.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"weather"}' },
          },
        ],
      })
      expect(compiled.body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" })
    }),
  )
})
