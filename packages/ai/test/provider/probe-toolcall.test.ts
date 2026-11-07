import { Effect } from "effect"
import { LLM, LLMClient } from "../../src/index.js"
import { Commandcode } from "../../src/providers/commandcode.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"

const model = Commandcode.configure({ apiKey: "user_fixturekey" }).model("deepseek/deepseek-v4-flash")
const ndjson = (...events: ReadonlyArray<Record<string, unknown>>) => events.map((e) => JSON.stringify(e)).join("\n") + "\n"
const run = (events: ReadonlyArray<Record<string, unknown>>) =>
  LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(Effect.provide(fixedResponse(ndjson(...events))), Effect.result)

it.effect("probe tool-call with no toolName", () =>
  Effect.gen(function* () {
    const r = yield* run([{ type: "tool-call", toolCallId: "call_x", input: { a: 1 } }, { type: "finish", finishReason: "tool-calls" }])
    console.log("NONAME:", r._tag, r._tag === "Success" ? `toolCalls=${r.success.toolCalls.length} finish=${r.success.finishReason?.normalized}` : JSON.stringify(r.failure).slice(0, 160))
  }),
)
it.effect("probe two tool-calls with no toolCallId", () =>
  Effect.gen(function* () {
    const r = yield* run([
      { type: "tool-call", toolName: "get_weather", input: { city: "Oslo" } },
      { type: "tool-call", toolName: "get_weather", input: { city: "Bergen" } },
      { type: "finish", finishReason: "tool-calls" },
    ])
    console.log("NOID:", r._tag, r._tag === "Success" ? `toolCalls=${JSON.stringify(r.success.toolCalls.map((c) => [c.id, c.input]))}` : JSON.stringify(r.failure).slice(0, 160))
  }),
)
