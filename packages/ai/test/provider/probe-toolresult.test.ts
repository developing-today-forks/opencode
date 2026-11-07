import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message, ToolDefinition } from "../../src/index.js"
import { Commandcode } from "../../src/providers/commandcode.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
const model = Commandcode.configure({ apiKey: "user_fixturekey" }).model("deepseek/deepseek-v4-flash")
const tools = [ToolDefinition.make({ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } as never })]
const ndjson = (...events: ReadonlyArray<Record<string, unknown>>) => events.map((e) => JSON.stringify(e)).join("\n") + "\n"
it.effect("probe: id-less tool-result", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, messages: [Message.user("weather?")], tools })).pipe(
      Effect.provide(fixedResponse(ndjson({ type: "tool-result", toolName: "web_search", output: "sunny" }, { type: "finish", finishReason: "stop" }))),
      Effect.result,
    )
    console.log("IDLESS_TOOL_RESULT_TAG", result._tag)
    if (result._tag === "Success") console.log("IDLESS_EVENTS", JSON.stringify(result.success.events))
  }),
)
it.effect("probe: nameless tool-result", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, messages: [Message.user("weather?")], tools })).pipe(
      Effect.provide(fixedResponse(ndjson({ type: "tool-result", toolCallId: "srv_1", output: "sunny" }, { type: "finish", finishReason: "stop" }))),
      Effect.result,
    )
    console.log("NAMELESS_TOOL_RESULT_TAG", result._tag)
    if (result._tag === "Success") console.log("NAMELESS_EVENTS", JSON.stringify(result.success.events))
  }),
)
it.effect("probe: valid tool-result control", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, messages: [Message.user("weather?")], tools })).pipe(
      Effect.provide(fixedResponse(ndjson({ type: "tool-result", toolCallId: "srv_1", toolName: "web_search", output: "sunny" }, { type: "finish", finishReason: "stop" }))),
      Effect.result,
    )
    console.log("VALID_TOOL_RESULT_TAG", result._tag)
    if (result._tag === "Success") console.log("VALID_EVENTS", JSON.stringify(result.success.events))
    expect(result._tag).toBe("Success")
  }),
)
