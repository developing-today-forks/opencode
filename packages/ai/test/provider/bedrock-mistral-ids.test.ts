import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { ai, Message, ToolCallPart } from "../../src/effect.js"
import { AmazonBedrock } from "../../src/providers.js"
import { BedrockConverse } from "../../src/protocols/bedrock-converse.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

const bedrock = AmazonBedrock.configure({ baseURL: "https://bedrock.test", apiKey: "test-key" })
const history = (ids: string[]) => [
  Message.user("Read every label"),
  Message.assistant(ids.map((id, index) => ToolCallPart.make({ id, name: "lookup", input: { label: index } }))),
  ...ids.map((id, index) => Message.tool({ id, name: "lookup", result: `value-${index}` })).toReversed(),
]

for (const model of [
  "mistral.mistral-large-2407-v1:0",
  "us.mistral.pixtral-large-2502-v1:0",
  "arn:aws:bedrock:us-east-1::foundation-model/mistral.pixtral-large-2502-v1:0",
]) {
  it.effect(`preserves distinct call/result pairs and history for ${model}`, () =>
    Effect.gen(function* () {
      const request = ai.request({ model: bedrock.model(model), messages: history(["a"]), cache: "none" })
      const first = Schema.decodeUnknownSync(BedrockConverse.protocol.body.schema)(
        (yield* compileRequest(request)).body,
      )
      const reserved = first.messages.flatMap((message) =>
        message.content.flatMap((part) => ("toolUse" in part ? [part.toolUse.toolUseId] : [])),
      )[0]
      if (!reserved) throw new Error("Expected projected tool call")
      // A valid ID distinct from the projection of "a": since #2228 the
      // projection is a pure function of the original ID, so "a" projects to
      // `reserved` in every request (asserted below) — a history containing
      // both as separate calls is the collision case the deterministic
      // derivation accepts, covered by the stability test instead.
      const other = (reserved.startsWith("A") ? "B" : "A") + reserved.slice(1)
      const ids = [
        "a",
        "b",
        "tooluse_GQn7COr2AN8bw2oVKYyYzZ",
        "tooluse_abcdefghi111111111",
        "tooluse_abcdefghi222222222",
        "call_other-provider-id",
        "Ab12Cd34E",
        other,
      ]
      const messages = history(ids)
      const before = structuredClone(messages)
      const input = ai.request({ model: bedrock.model(model), messages, cache: "none" })
      const prepared = yield* compileRequest(input)
      const body = Schema.decodeUnknownSync(BedrockConverse.protocol.body.schema)(prepared.body)
      const calls = body.messages.flatMap((message) =>
        message.content.flatMap((part) => ("toolUse" in part ? [part.toolUse.toolUseId] : [])),
      )
      const results = body.messages.flatMap((message) =>
        message.content.flatMap((part) => ("toolResult" in part ? [part.toolResult.toolUseId] : [])),
      )
      expect(calls).toHaveLength(ids.length)
      expect(new Set(calls).size).toBe(ids.length)
      calls.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9]{9}$/))
      expect(results).toEqual(calls.toReversed())
      expect(calls[0]).toBe(reserved)
      expect(calls.slice(-2)).toEqual(ids.slice(-2))
      expect((yield* compileRequest(input)).body).toEqual(prepared.body)
      expect(structuredClone(messages)).toEqual(before)
    }),
  )
}

it.effect("leaves non-Mistral Bedrock IDs unchanged", () =>
  Effect.gen(function* () {
    const ids = ["a", "tooluse_abcdefghi111111111", "tooluse_abcdefghi222222222", "Ab12Cd34E"]
    const prepared = yield* compileRequest(
      ai.request({
        model: bedrock.model("global.anthropic.claude-haiku-4-5-20251001-v1:0"),
        messages: history(ids),
        cache: "none",
      }),
    )
    const body = Schema.decodeUnknownSync(BedrockConverse.protocol.body.schema)(prepared.body)
    expect(
      body.messages.flatMap((message) =>
        message.content.flatMap((part) => ("toolUse" in part ? [part.toolUse.toolUseId] : [])),
      ),
    ).toEqual(ids)
    expect(
      body.messages.flatMap((message) =>
        message.content.flatMap((part) => ("toolResult" in part ? [part.toolResult.toolUseId] : [])),
      ),
    ).toEqual(ids.toReversed())
  }),
)

it.effect("keeps long-ID projections stable and distinct across sequential requests (#2228)", () =>
  Effect.gen(function* () {
    const model = bedrock.model("mistral.mistral-large-2407-v1:0")
    const project = (ids: string[]) =>
      Effect.gen(function* () {
        const prepared = yield* compileRequest(ai.request({ model, messages: history(ids), cache: "none" }))
        const body = Schema.decodeUnknownSync(BedrockConverse.protocol.body.schema)(prepared.body)
        return body.messages.flatMap((message) =>
          message.content.flatMap((part) => ("toolUse" in part ? [part.toolUse.toolUseId] : [])),
        )
      })
    // Two long IDs sharing a long common prefix: a projection that only
    // looked at a prefix would map them to the same ID. The full-ID hash
    // keeps them distinct, and each keeps its projection as the history
    // grows from one request to the next.
    const longA = "tooluse_abcdefghi111111111"
    const longB = "tooluse_abcdefghi222222222"
    const first = yield* project([longA])
    const projected = first[0]
    if (!projected) throw new Error("Expected projected tool call")
    const second = yield* project([longA, longB])
    expect(second[0]).toBe(projected)
    expect(second[1]).toMatch(/^[A-Za-z0-9]{9}$/)
    expect(second[1]).not.toBe(projected)
    // The first ID's own projection joins the history as a separate literal
    // ID (the shape of a provider-issued ID). The long ID's projection must
    // not move: the pre-#2228 per-request normalizer salted it to a
    // different value in exactly this case, so one tool call carried
    // different IDs in different requests of the same session.
    const third = yield* project([longA, longB, projected])
    expect(third[0]).toBe(projected)
    expect(third[1]).toBe(second[1])
  }),
)
