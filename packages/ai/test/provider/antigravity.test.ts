import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { Antigravity } from "../../src/providers/antigravity.js"
import { Antigravity as AntigravityProtocol, convertSchema, resolveModelAndEffort } from "../../src/protocols/antigravity.js"
import { compileRequest } from "../../src/route/client.js"
import { Endpoint } from "../../src/route/endpoint.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = Antigravity.configure({ accessToken: "fixture-token" }).model("gemini-3.8-flash")

const event = (parts: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  response: {
    candidates: [{ content: { role: "model", parts }, ...extra }],
    ...(extra.usageMetadata ? { usageMetadata: extra.usageMetadata } : {}),
  },
})

it.effect("Antigravity route points at the v1internal stream endpoint", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model, prompt: "Hello" })
    const compiled = yield* compileRequest(request)
    const url = Endpoint.render(model.route.endpoint, { request, body: compiled.body }).toString()
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")
    expect(model.provider).toBe("antigravity")
  }),
)

it.effect("Antigravity envelope matches the door's buildV1Request shape", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        system: "You are helpful.",
        messages: [Message.user("weather?")],
        tools: [
          ToolDefinition.make({
            name: "get_weather",
            description: "Get weather",
            inputSchema: {
              type: "object",
              $schema: "https://json-schema.org/draft/2020-12/schema",
              properties: {
                city: { type: "string", minLength: 1 },
                days: { type: "integer", exclusiveMinimum: 0 },
                unit: { type: ["string", "null"], enum: ["c", "f", null] },
              },
              required: ["city", "missing"],
              additionalProperties: false,
            } as never,
          }),
        ],
        toolChoice: { type: "tool", name: "get_weather" },
        providerOptions: { reasoning_effort: "low" },
        generation: { maxTokens: 1024, temperature: 0.5 },
      }),
    )
    const body = compiled.body as Record<string, never>
    expect(body.project).toBe("aicode-consumers")
    expect(body.userAgent).toBe("antigravity")
    expect(body.requestType).toBe("agent")
    expect(body.model).toBe("gemini-3.8-flash-low")
    expect(String(body.requestId)).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/)
    const request = body.request as Record<string, never>
    expect(request.systemInstruction).toEqual({ role: "user", parts: [{ text: "You are helpful." }] })
    expect(request.contents).toEqual([{ role: "user", parts: [{ text: "weather?" }] }])
    expect(request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "OBJECT",
              properties: {
                city: { type: "STRING", minLength: 1 },
                days: { type: "INTEGER", minimum: 0 },
                unit: { type: "STRING", nullable: true, enum: ["c", "f", null] },
              },
              required: ["city"],
            },
          },
        ],
      },
    ])
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } })
    expect(request.generationConfig).toEqual({
      maxOutputTokens: 1024,
      temperature: 0.5,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
    })
    expect(String(request.sessionId)).toMatch(/^-\d+$/)
  }),
)

it.effect("Antigravity defaults mirror the door: 65536 output cap, medium effort", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(LLM.request({ model, prompt: "hi" }))
    const body = compiled.body as Record<string, never>
    expect(body.model).toBe("gemini-3.8-flash-medium")
    const request = body.request as Record<string, never>
    expect(request.generationConfig).toEqual({
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    })
    expect(request.tools).toBeUndefined()
    expect(request.toolConfig).toBeUndefined()
    expect(request.systemInstruction).toBeUndefined()
  }),
)

it.effect("resolveModelAndEffort ports the door's suffix + effort rules", () =>
  Effect.sync(() => {
    expect(resolveModelAndEffort("gemini-3.8-flash")).toEqual({
      base: "gemini-3.8-flash",
      effort: "medium",
      fullName: "gemini-3.8-flash-medium",
    })
    expect(resolveModelAndEffort("gemini-3.8-flash-high")).toEqual({
      base: "gemini-3.8-flash",
      effort: "high",
      fullName: "gemini-3.8-flash-high",
    })
    expect(resolveModelAndEffort("gemini-4-argon", "xhigh").fullName).toBe("gemini-4-argon-high")
    expect(resolveModelAndEffort("claude-opus-5-5-low", "high").fullName).toBe("claude-opus-5-5-high")
    expect(resolveModelAndEffort("gpt-oss-120b", "bogus").fullName).toBe("gpt-oss-120b-medium")
  }),
)

it.effect("convertSchema ports the door's proto-schema rules", () =>
  Effect.sync(() => {
    // Tuple items become prefixItems plus an unconstrained items (probed rule).
    expect(convertSchema({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toEqual({
      type: "ARRAY",
      prefixItems: [{ type: "STRING" }, { type: "NUMBER" }],
      items: {},
    })
    // Boolean schema and root object rule.
    expect(convertSchema(true as never)).toEqual({ type: "OBJECT" })
    // $ref inlining with a loop cut.
    expect(
      convertSchema({
        type: "object",
        $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
        properties: { root: { $ref: "#/$defs/node" } },
      } as never),
    ).toEqual({
      type: "OBJECT",
      properties: { root: { type: "OBJECT", properties: { child: {} } } },
    })
  }),
)

it.effect("convertSchema synthesizes items for bare array schemas (#1548)", () =>
  Effect.sync(() => {
    // The live failure: a tool property declared {type: "array"} with no
    // items (legal JSON Schema — unconstrained elements). The proto
    // validator rejects an ARRAY schema without items
    // ("properties[paths].items: missing field"), so conversion
    // synthesizes an unconstrained items.
    expect(
      convertSchema({
        type: "object",
        properties: { paths: { type: "array", description: "paths to collect" } },
        required: ["paths"],
      } as never),
    ).toEqual({
      type: "OBJECT",
      properties: { paths: { type: "ARRAY", description: "paths to collect", items: {} } },
      required: ["paths"],
    })
    // A nullable array union collapses to ARRAY + nullable and still
    // gets its items.
    expect(convertSchema({ type: ["array", "null"] } as never)).toEqual({
      type: "ARRAY",
      nullable: true,
      items: {},
    })
    // Nested positions are covered by the same recursion: an array
    // inside anyOf, and an array of arrays.
    expect(
      convertSchema({
        type: "object",
        properties: {
          choice: { anyOf: [{ type: "array" }, { type: "string" }] },
          matrix: { type: "array", items: { type: "array" } },
        },
      } as never),
    ).toEqual({
      type: "OBJECT",
      properties: {
        choice: { anyOf: [{ type: "ARRAY", items: {} }, { type: "STRING" }] },
        matrix: { type: "ARRAY", items: { type: "ARRAY", items: {} } },
      },
    })
    // An explicit items schema is never overwritten.
    expect(convertSchema({ type: "array", items: { type: "string" } })).toEqual({
      type: "ARRAY",
      items: { type: "STRING" },
    })
    // Invariant sweep over the tricky shapes real tool sets carry:
    // after conversion no ARRAY node anywhere lacks both items and
    // prefixItems — the proto rejects that shape.
    const assertArraysCarryItems = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(assertArraysCarryItems)
      if (typeof node !== "object" || node === null) return
      const record = node as Record<string, unknown>
      if (record.type === "ARRAY")
        expect(record.items !== undefined || record.prefixItems !== undefined).toBe(true)
      Object.values(record).forEach(assertArraysCarryItems)
    }
    const shapes = [
      { type: "object", properties: { paths: { type: "array" } } },
      { type: "array", items: [{ type: "string" }, { type: "number" }] },
      { type: "array", items: { type: "array", items: { type: "array" } } },
      { type: "object", additionalProperties: { type: "string" } },
      { anyOf: [{ type: "array" }, { type: "object", properties: { xs: { type: "array" } } }] },
      {
        type: "object",
        $defs: { row: { type: "array" } },
        properties: { rows: { type: "array", items: { $ref: "#/$defs/row" } } },
      },
    ]
    for (const shape of shapes) assertArraysCarryItems(convertSchema(shape as never))
  }),
)

it.effect("Antigravity lowers tool results as proto Structs, exactly like the door", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        messages: [
          Message.user("weather?"),
          Message.assistant([ToolCallPart.make({ id: "call_1", name: "get_weather", input: { city: "Oslo" } })]),
          Message.tool({ id: "call_1", name: "get_weather", result: '["sunny","cold"]', resultType: "text" }),
          Message.assistant([ToolCallPart.make({ id: "call_2", name: "get_weather", input: { city: "Oslo" } })]),
          Message.tool({ id: "call_2", name: "get_weather", result: '{"temp": 3}', resultType: "text" }),
          Message.assistant([ToolCallPart.make({ id: "call_3", name: "get_weather", input: { city: "Oslo" } })]),
          Message.tool({ id: "call_3", name: "get_weather", result: "plain text", resultType: "text" }),
        ],
      }),
    )
    const request = (compiled.body as Record<string, never>).request as Record<string, never>
    const contents = request.contents as ReadonlyArray<Record<string, never>>
    const responses = contents
      .flatMap((content) => (content.parts as ReadonlyArray<Record<string, never>>) ?? [])
      .filter((part) => "functionResponse" in part)
      .map((part) => (part.functionResponse as Record<string, never>).response)
    expect(responses).toEqual([{ result: ["sunny", "cold"] }, { temp: 3 }, { result: "plain text" }])
    // Assistant tool calls replay their signature from providerMetadata.
    const firstCall = contents
      .flatMap((content) => (content.parts as ReadonlyArray<Record<string, never>>) ?? [])
      .find((part) => "functionCall" in part) as Record<string, never>
    expect(firstCall.thoughtSignature).toBe("skip_thought_signature_validator")
  }),
)

it.effect("Antigravity stream: wrapped SSE events become text, reasoning, tool calls, usage", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "weather?" })).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents(
            event([{ text: "thinking", thought: true }]),
            event([{ text: "Let me check.", thoughtSignature: "sig-1" }]),
            event([{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }]),
            event([], {
              finishReason: "STOP",
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 21 },
            }),
          ),
        ),
      ),
    )
    expect(response.text).toBe("Let me check.")
    expect(response.reasoning).toBe("thinking")
    expect(response.toolCalls).toHaveLength(1)
    const call = response.toolCalls[0]
    expect(call.name).toBe("get_weather")
    expect(call.input).toEqual({ city: "Oslo" })
    expect(call.id).toMatch(/^call_[0-9a-f]{32}$/)
    expect(call.providerMetadata?.antigravity).toEqual({ thoughtSignature: "sig-1" })
    expect(response.usage?.inputTokens).toBe(11)
    expect(response.usage?.outputTokens).toBe(10)
    expect(response.usage?.reasoningTokens).toBe(3)
    expect(response.usage?.totalTokens).toBe(21)
    expect(response.finishReason?.normalized).toBe("tool-calls")
  }),
)

it.effect("Antigravity stream: finish reasons map like the door's finishReasonMap", () =>
  Effect.gen(function* () {
    for (const [wire, expected] of [
      ["STOP", "stop"],
      ["MAX_TOKENS", "length"],
      ["SAFETY", "content-filter"],
    ] as const) {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
        Effect.provide(fixedResponse(sseEvents(event([{ text: "x" }], { finishReason: wire })))),
      )
      expect(response.finishReason?.normalized).toBe(expected)
    }
  }),
)

it.effect("Antigravity upstream 429 with quota body classifies as a quota failure", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.succeed(
            input.respond(
              JSON.stringify({
                error: { code: 429, message: "Quota exceeded for model gemini-3.8-flash", status: "RESOURCE_EXHAUSTED" },
              }),
              { status: 429, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
      Effect.result,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const error = result.failure
      expect(["QuotaExceeded", "RateLimit"]).toContain((error as { reason?: { _tag?: string } }).reason?._tag)
    }
  }),
)

it.effect("Antigravity in-stream error event fails with the upstream message", () =>
  Effect.gen(function* () {
    const result = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(fixedResponse(sseEvents({ error: { code: 403, message: "permission denied for project", status: "PERMISSION_DENIED" } }))),
      Effect.result,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(JSON.stringify(result.failure)).toContain("permission denied")
    }
  }),
)

it.effect("Antigravity retries exactly once on a 401 with a refreshed credential", () =>
  Effect.gen(function* () {
    let calls = 0
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.sync(() => {
            calls += 1
            if (calls === 1)
              return input.respond(JSON.stringify({ error: { message: "unauthorized" } }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            return input.respond(sseEvents(event([{ text: "ok" }], { finishReason: "STOP" })), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    )
    expect(response.text).toBe("ok")
    expect(calls).toBe(2)
  }),
)


it.effect("Antigravity tool_choice: string forms keep the door's bare modes", () =>
  Effect.gen(function* () {
    const tools = [ToolDefinition.make({ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: {} } })]
    for (const [choice, mode] of [
      ["none", "NONE"],
      ["auto", "AUTO"],
      ["required", "ANY"],
    ] as const) {
      const compiled = yield* compileRequest(
        LLM.request({ model, messages: [Message.user("weather?")], tools, toolChoice: choice }),
      )
      const request = (compiled.body as Record<string, never>).request as Record<string, never>
      expect(request.toolConfig).toEqual({ functionCallingConfig: { mode } })
    }
    const noChoice = yield* compileRequest(
      LLM.request({ model, messages: [Message.user("weather?")], tools }),
    )
    expect(((noChoice.body as Record<string, never>).request as Record<string, never>).toolConfig).toBeUndefined()
  }),
)

it.effect("Antigravity tool_choice naming an undeclared function fails closed before any request", () =>
  Effect.gen(function* () {
    const tools = [ToolDefinition.make({ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: {} } })]
    for (const withTools of [true, false]) {
      const result = yield* compileRequest(
        LLM.request({
          model,
          messages: [Message.user("weather?")],
          ...(withTools ? { tools } : {}),
          toolChoice: { type: "tool", name: "delete_everything" },
        }),
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(JSON.stringify(result.failure)).toContain("delete_everything")
    }
  }),
)

it.effect("Antigravity protocol exports stay wired to the provider package", () =>
  Effect.sync(() => {
    expect(AntigravityProtocol.protocol.id).toBe("antigravity")
    expect(Antigravity.provider.id).toBe("antigravity")
    expect(typeof Antigravity.model).toBe("function")
  }),
)
