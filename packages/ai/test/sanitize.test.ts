import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ai, type LLMRequest, Message, ToolCallPart, ToolDefinition } from "../src/effect.js"
import { OpenAIChat } from "../src/protocols.js"
import { Auth } from "../src/route.js"
import { sanitizeSurrogates } from "../src/utils/sanitize.js"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const tool = new ToolDefinition({
  name: "lookup",
  description: "Look something up",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
})

// Mirrors request preparation: sanitize everything but the model, then normalize the copies back into classes.
const sanitizeRequest = (request: LLMRequest) =>
  ai.request({ ...request, ...sanitizeSurrogates({ ...request, model: undefined }), model: request.model })

describe("sanitizeSurrogates", () => {
  test("replaces lone surrogates in nested message text, tool input, and tool output", () => {
    const sanitized = sanitizeRequest(
      ai.request({
        model,
        system: "system \uD800",
        tools: [tool],
        messages: [
          Message.user("user \uDC00 \u{1F600}"),
          Message.assistant([
            ToolCallPart.make({ id: "call_1", name: "lookup", input: { "q\uD800": "input \uDC00" } }),
          ]),
          Message.tool({ id: "call_1", name: "lookup", result: { output: ["result \uD800", "valid"] } }),
        ],
      }),
    )

    expect(sanitized.messages.every((message) => Schema.is(Message)(message))).toBe(true)
    expect(sanitized.tools[0]).toBe(tool)
    expect(sanitized.system).toEqual([{ type: "text", text: "system \uFFFD" }])
    expect(sanitized.messages).toEqual([
      Message.user("user \uFFFD \u{1F600}"),
      Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { "q\uFFFD": "input \uFFFD" } })]),
      Message.tool({ id: "call_1", name: "lookup", result: { output: ["result \uFFFD", "valid"] } }),
    ])
  })

  test("keeps clean requests equal and shares unchanged nested values", () => {
    const messages = [Message.user("hello \u{1F600}"), Message.assistant("hi")]
    const request = ai.request({
      model,
      system: "system",
      tools: [tool],
      messages: [...messages, Message.user("bad \uD800")],
      maxTokens: 10,
      providerOptions: { nested: { list: ["a", "b"] } },
    })
    const sanitized = sanitizeRequest(request)

    expect(sanitized.messages.slice(0, 2)).toEqual(request.messages.slice(0, 2))
    expect(sanitized.messages[0]).toBe(request.messages[0])
    expect(sanitized.messages[1]).toBe(request.messages[1])
    expect(sanitized.messages[2]).not.toBe(request.messages[2])
    expect(sanitized.messages[2]).toEqual(Message.user("bad \uFFFD"))
    expect(sanitized.tools[0]).toBe(request.tools[0])
    expect(sanitized.maxTokens).toBe(10)

    const input = request
    const output = sanitizeSurrogates(input)
    expect(output.system).toBe(input.system)
    expect(output.tools).toBe(input.tools)
    expect(output.providerOptions).toBe(input.providerOptions)
    expect(output.messages).not.toBe(input.messages)

    const clean = ai.request({ model, system: "system", tools: [tool], messages })
    expect(sanitizeRequest(clean)).toEqual(clean)
    expect(sanitizeSurrogates(clean).messages).toBe(clean.messages)
  })
})

describe("sanitizeSurrogates key collisions", () => {
  test("preserves every entry when malformed keys sanitize to the same key", () => {
    const input = {
      ["\uD800a"]: 1,
      ["\uDC00a"]: 2,
      ["\uFFFDa"]: 3,
    }

    const result = sanitizeSurrogates(input)

    expect(Object.entries(result)).toEqual([
      ["\uFFFDa", 1],
      ["\uFFFDa~2", 2],
      ["\uFFFDa~3", 3],
    ])
  })

  test("does not rename well-formed keys or steal a later key for a collision suffix", () => {
    const wellFormed = { alpha: 1, nested: { beta: 2 }, gamma: 3 }
    expect(sanitizeSurrogates(wellFormed)).toEqual(wellFormed)
    expect(Object.keys(sanitizeSurrogates(wellFormed))).toEqual(Object.keys(wellFormed))

    const input = {
      ["\uD800a"]: 1,
      ["\uDC00a"]: 2,
      ["\uFFFDa~2"]: 3,
    }
    expect(Object.entries(sanitizeSurrogates(input))).toEqual([
      ["\uFFFDa", 1],
      ["\uFFFDa~3", 2],
      ["\uFFFDa~2", 3],
    ])
  })

  test("applies collision handling recursively through records and arrays", () => {
    const input = {
      nested: {
        ["\uD800k"]: "first\uD800",
        ["\uDC00k"]: "second\uDC00",
      },
      list: [
        {
          ["\uD800x"]: 1,
          ["\uDC00x"]: 2,
        },
        "value\uD800",
      ],
    }

    expect(sanitizeSurrogates(input)).toEqual({
      nested: { ["\uFFFDk"]: "first\uFFFD", ["\uFFFDk~2"]: "second\uFFFD" },
      list: [{ ["\uFFFDx"]: 1, ["\uFFFDx~2"]: 2 }, "value\uFFFD"],
    })
  })
})
