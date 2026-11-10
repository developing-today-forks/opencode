import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, LLMRequest, Message, ToolRuntime, toDefinitions } from "../../src/index.js"
import * as OpenAICompatible from "../../src/providers/openai-compatible.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { recordedTests } from "../recorded-test.js"
import { weatherRuntimeTool, weatherToolName } from "../recorded-scenarios.js"

// #1706/#1708 gateway-door coverage: opendesign fronts several model families
// behind one OpenAI Chat baseURL. These cassettes pin what the door actually
// emits per family (delta dialect, parallel tool-call association, and
// thought-signature custody where the family replays one).
const model = (id: string) =>
  OpenAICompatible.configure({
    provider: "opendesign",
    baseURL: "https://amr-link.open-design.ai/v1",
    apiKey: process.env.OPENDESIGN_API_KEY ?? "fixture",
  }).model(id)

const recorded = recordedTests({
  prefix: "openai-compatible-chat",
  provider: "opendesign",
  protocol: "openai-chat",
  requires: ["OPENDESIGN_API_KEY"],
  tags: ["tool", "tool-loop", "continuation"],
})

const parallelRequest = (id: string) => {
  const target = model(id)
  const tools = { [weatherToolName]: weatherRuntimeTool }
  return {
    target,
    tools,
    request: LLM.request({
      model: target,
      system: "Call get_weather for every requested city in parallel, then answer in one short sentence.",
      prompt: "What is the weather in Paris and in Tokyo?",
      tools: toDefinitions(tools),
      cache: "none",
    }),
  }
}

for (const item of [
  { cassette: "opendesign-glm-5.3-flash", model: "glm-5.3-flash" },
  { cassette: "opendesign-glm-5.3-flashx", model: "glm-5.3-flashx" },
  { cassette: "opendesign-kimi-k2.7-code", model: "kimi-k2.7-code" },
]) {
  describe(`OpenDesign ${item.model} recorded`, () => {
    recorded.effect.with("parallel tool calls", { cassette: `${item.cassette}-parallel-tools` }, () => {
      const { tools, request } = parallelRequest(item.model)
      return Effect.gen(function* () {
        const first = yield* LLMClient.generate(request)
        const calls = first.events.filter(LLMEvent.is.toolCall)
        expect(calls.map((call) => call.input)).toEqual([{ city: "Paris" }, { city: "Tokyo" }])

        const results = yield* Effect.forEach(calls, (call) => ToolRuntime.dispatch(tools, call))
        const continuation = LLMRequest.update(request, {
          messages: [
            ...request.messages,
            first.message,
            ...calls.map((call, index) =>
              Message.tool({ id: call.id, name: call.name, result: results[index]!.result }),
            ),
          ],
        })
        const prepared = yield* compileRequest(continuation)
        const assistant = prepared.body.messages.find((message) => message.role === "assistant")
        // Tool-call association must survive the continuation: every recorded
        // id is replayed and the family's extra content (thought signature)
        // stays attached to the same tool call.
        expect(assistant?.role === "assistant" ? assistant.tool_calls?.map((call) => call.id) : undefined).toEqual(
          calls.map((call) => call.id),
        )
        expect(
          assistant?.role === "assistant" ? assistant.tool_calls?.map((call) => call.extra_content) : undefined,
        ).toEqual(calls.map((call) => call.providerMetadata?.opendesign?.extraContent))

        const second = yield* LLMClient.generate(continuation)
        expect(second.events.filter(LLMEvent.is.toolCall)).toHaveLength(0)
        expect(second.text).toMatch(/Paris/)
        expect(second.text).toMatch(/Tokyo/)
      })
    }, 90_000)
  })
}
