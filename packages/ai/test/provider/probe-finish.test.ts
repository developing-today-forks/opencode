import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message } from "../../src/index.js"
import { Commandcode } from "../../src/providers/commandcode.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"

const model = Commandcode.configure({ apiKey: "user_fixturekey" }).model("deepseek/deepseek-v4-flash")
const ndjson = (...events: ReadonlyArray<Record<string, unknown>>) => events.map((e) => JSON.stringify(e)).join("\n") + "\n"

for (const fr of ["content-filter", "error", "stop", "length", "tool_calls"]) {
  it.effect(`probe finishReason=${fr}`, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
        Effect.provide(fixedResponse(ndjson({ type: "text-delta", text: "partial" }, { type: "finish", finishReason: fr, totalUsage: { inputTokens: 3, outputTokens: 2 } }))),
      )
      console.log(`FINISH ${fr} -> normalized=${response.finishReason?.normalized} raw=${response.finishReason?.raw}`)
      expect(response.text).toBe("partial")
    }),
  )
}

it.effect("probe abort then EOF", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(fixedResponse(ndjson({ type: "text-delta", text: "partial" }, { type: "abort" }))),
      Effect.result,
    )
    console.log("ABORT outcome:", result._tag, result._tag === "Success" ? `normalized=${result.success.finishReason?.normalized} raw=${result.success.finishReason?.raw} text=${result.success.text}` : JSON.stringify(result.failure).slice(0, 200))
  }),
)
