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
    expect(model.provider).toBe("_antigravity")
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
    // Wire-complete ids (fetchAvailableModels catalog, probed live
    // 2026-11-05): the bare id IS the wire id — an appended effort
    // suffix is a nonexistent entity and upstream answers 404
    // NOT_FOUND. The effort survives for thinkingLevel only.
    expect(resolveModelAndEffort("gemini-2.5-flash")).toEqual({
      base: "gemini-2.5-flash",
      effort: "medium",
      fullName: "gemini-2.5-flash",
    })
    expect(resolveModelAndEffort("gemini-3-flash", "high")).toEqual({
      base: "gemini-3-flash",
      effort: "high",
      fullName: "gemini-3-flash",
    })
    // A caller spelling a wire-complete id with an effort suffix is
    // healed back to the bare wire id.
    expect(resolveModelAndEffort("gemini-2.5-flash-medium").fullName).toBe("gemini-2.5-flash")
    expect(resolveModelAndEffort("gemini-3.8-flash-tiered").fullName).toBe("gemini-3.8-flash-tiered")
    expect(resolveModelAndEffort("gemini-2.5-pro", "low").fullName).toBe("gemini-2.5-pro")
  }),
)

it.effect("Antigravity sends wire-complete model ids bare, effort as thinkingLevel only", () =>
  Effect.gen(function* () {
    const bareModel = Antigravity.configure({ accessToken: "fixture-token" }).model("gemini-2.5-flash")
    const compiled = yield* compileRequest(
      LLM.request({ model: bareModel, prompt: "hi", providerOptions: { reasoning_effort: "high" } }),
    )
    const body = compiled.body as Record<string, never>
    expect(body.model).toBe("gemini-2.5-flash")
    const request = body.request as Record<string, never>
    expect(request.generationConfig).toEqual({
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    })
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

it.effect("convertSchema folds anyOf to oneOf for Anthropic targets (#1550)", () =>
  Effect.sync(() => {
    // The live failure: for Claude models the upstream re-serializes the
    // proto Schema into an Anthropic input_schema whose validator rejects
    // anyOf outright ("tools.N.custom.input_schema: JSON schema is
    // invalid. It must match JSON Schema draft 2020-12"), which 400'd
    // workhorse sessions on antigravity-direct/claude-sonnet-5-5 all day
    // 2026-11-03. With the anthropic flag the same shapes emit oneOf.
    const unioned = {
      type: "object",
      properties: {
        nullable_note: { anyOf: [{ type: "string" }, { type: "null" }] },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        listed: { type: "array", items: { anyOf: [{ type: "string" }, { type: "boolean" }] } },
        pick: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    }
    expect(convertSchema(unioned as never, true)).toEqual({
      type: "OBJECT",
      properties: {
        nullable_note: { oneOf: [{ type: "STRING" }, { type: "NULL" }] },
        either: { oneOf: [{ type: "STRING" }, { type: "NUMBER" }] },
        listed: { type: "ARRAY", items: { oneOf: [{ type: "STRING" }, { type: "BOOLEAN" }] } },
        pick: { oneOf: [{ type: "STRING" }, { type: "NUMBER" }] },
      },
    })
    // The Gemini default keeps anyOf verbatim — the fold is Claude-only.
    expect(convertSchema(unioned as never)).toEqual({
      type: "OBJECT",
      properties: {
        nullable_note: { anyOf: [{ type: "STRING" }, { type: "NULL" }] },
        either: { anyOf: [{ type: "STRING" }, { type: "NUMBER" }] },
        listed: { type: "ARRAY", items: { anyOf: [{ type: "STRING" }, { type: "BOOLEAN" }] } },
        pick: { oneOf: [{ type: "STRING" }, { type: "NUMBER" }] },
      },
    })
    // Invariant sweep: with the anthropic flag, no node anywhere in the
    // converted output carries anyOf — Anthropic rejects it in any
    // position.
    const assertNoAnyOf = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(assertNoAnyOf)
      if (typeof node !== "object" || node === null) return
      const record = node as Record<string, unknown>
      expect("anyOf" in record).toBe(false)
      Object.values(record).forEach(assertNoAnyOf)
    }
    const shapes = [
      unioned,
      { anyOf: [{ type: "string" }] },
      { type: "object", properties: { deep: { not: { anyOf: [{ type: "integer" }, { type: "null" }] } } } },
      { allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }] },
    ]
    for (const shape of shapes) assertNoAnyOf(convertSchema(shape as never, true))
  }),
)

it.effect("convertSchema expands multi-valued type unions into branches (#1556)", () =>
  Effect.sync(() => {
    // A type array with two or more concrete members is a branch set:
    // anyOf for Gemini, oneOf for Anthropic (the #1550 fold), at a
    // property and at the root. Collapsing it to the first member
    // silently narrowed the tool's declared parameter schema.
    const unioned = { type: "object", properties: { mode: { type: ["string", "integer"] } } }
    expect(convertSchema(unioned as never)).toEqual({
      type: "OBJECT",
      properties: { mode: { anyOf: [{ type: "STRING" }, { type: "INTEGER" }] } },
    })
    expect(convertSchema(unioned as never, true)).toEqual({
      type: "OBJECT",
      properties: { mode: { oneOf: [{ type: "STRING" }, { type: "INTEGER" }] } },
    })
    expect(convertSchema({ type: ["string", "integer"] } as never)).toEqual({
      anyOf: [{ type: "STRING" }, { type: "INTEGER" }],
    })
    expect(convertSchema({ type: ["string", "integer"] } as never, true)).toEqual({
      oneOf: [{ type: "STRING" }, { type: "INTEGER" }],
    })
    // "null" still folds to nullable alongside the branches, and the
    // single-concrete cases stay byte-identical to before.
    expect(convertSchema({ type: ["string", "integer", "null"] } as never)).toEqual({
      anyOf: [{ type: "STRING" }, { type: "INTEGER" }],
      nullable: true,
    })
    expect(convertSchema({ type: ["string", "null"] } as never)).toEqual({ type: "STRING", nullable: true })
    expect(convertSchema({ type: ["string"] } as never)).toEqual({ type: "STRING" })
    // The node's other keywords stay on the node and apply to every
    // branch; an ARRAY branch carries items like any ARRAY schema.
    expect(
      convertSchema({
        type: "object",
        properties: {
          choice: { type: ["array", "string"], items: { type: "string" }, description: "list or label" },
          level: { type: ["integer", "number"], minimum: 0, maximum: 10, enum: [1, 2.5] },
        },
      } as never),
    ).toEqual({
      type: "OBJECT",
      properties: {
        choice: {
          description: "list or label",
          items: { type: "STRING" },
          anyOf: [{ type: "ARRAY", items: { type: "STRING" } }, { type: "STRING" }],
        },
        level: { minimum: 0, maximum: 10, enum: [1, 2.5], anyOf: [{ type: "INTEGER" }, { type: "NUMBER" }] },
      },
    })
  }),
)

it.effect("convertSchema keeps prefixItems on the node in type unions, branches carry items (#1820)", () =>
  Effect.sync(() => {
    // prefixItems is a node-level keyword (#1820, triage task 10959): in a
    // multi-valued type union the outer node carries it — byte-identical to
    // the non-union tuple node's shape — and the ARRAY branch carries only
    // items: the synthesised unconstrained items for a prefixItems-only
    // node, the real items when the node declares both.
    const prefixOnly = { type: ["array", "string"], prefixItems: [{ type: "string" }] }
    expect(convertSchema(prefixOnly as never)).toEqual({
      items: {},
      prefixItems: [{ type: "STRING" }],
      anyOf: [{ type: "ARRAY", items: {} }, { type: "STRING" }],
    })
    expect(convertSchema(prefixOnly as never, true)).toEqual({
      items: {},
      prefixItems: [{ type: "STRING" }],
      oneOf: [{ type: "ARRAY", items: {} }, { type: "STRING" }],
    })
    const itemsAndPrefix = {
      type: ["array", "string"],
      items: { type: "number" },
      prefixItems: [{ type: "string" }],
    }
    expect(convertSchema(itemsAndPrefix as never)).toEqual({
      items: { type: "NUMBER" },
      prefixItems: [{ type: "STRING" }],
      anyOf: [{ type: "ARRAY", items: { type: "NUMBER" } }, { type: "STRING" }],
    })
    expect(convertSchema(itemsAndPrefix as never, true)).toEqual({
      items: { type: "NUMBER" },
      prefixItems: [{ type: "STRING" }],
      oneOf: [{ type: "ARRAY", items: { type: "NUMBER" } }, { type: "STRING" }],
    })
  }),
)

it.effect("convertSchema encodes boolean false as { not: {} } instead of inverting it (#1573)", () =>
  Effect.sync(() => {
    // Property, items/prefixItems, and branch positions: false is never,
    // true stays unconstrained {}.
    expect(
      convertSchema({ type: "object", properties: { never: false, any: true } } as never),
    ).toEqual({ type: "OBJECT", properties: { never: { not: {} }, any: {} } })
    expect(convertSchema({ type: "array", items: false } as never)).toEqual({ type: "ARRAY", items: { not: {} } })
    expect(convertSchema({ type: "array", items: true } as never)).toEqual({ type: "ARRAY", items: {} })
    expect(convertSchema({ type: "array", prefixItems: [false, { type: "string" }] } as never)).toEqual({
      type: "ARRAY",
      items: {},
      prefixItems: [{ not: {} }, { type: "STRING" }],
    })
    expect(convertSchema({ anyOf: [false, { type: "string" }] } as never)).toEqual({
      anyOf: [{ not: {} }, { type: "STRING" }],
    })
    expect(convertSchema({ anyOf: [false, { type: "string" }] } as never, true)).toEqual({
      oneOf: [{ not: {} }, { type: "STRING" }],
    })
    expect(convertSchema({ oneOf: [true] } as never)).toEqual({ oneOf: [{}] })
    // (An allOf-only root is self-describing and takes no root OBJECT
    // default — #1667; see the root-composition test below.)
    expect(convertSchema({ allOf: [false] } as never)).toEqual({ allOf: [{ not: {} }] })
    // Root positions: false is { not: {} } with no forced OBJECT; true
    // keeps the historical { type: "OBJECT" }.
    expect(convertSchema(false as never)).toEqual({ not: {} })
    expect(convertSchema(true as never)).toEqual({ type: "OBJECT" })
    // Under `not` itself the booleans flip meaning: not:false is
    // unconstrained (key omitted), not:true is never.
    expect(convertSchema({ type: "string", not: false } as never)).toEqual({ type: "STRING" })
    expect(convertSchema({ type: "string", not: true } as never)).toEqual({ type: "STRING", not: {} })
    // (A not-only root likewise takes no forced OBJECT — #1667.)
    expect(convertSchema({ not: { type: "string" } } as never)).toEqual({ not: { type: "STRING" } })
  }),
)

it.effect("convertSchema leaves allOf/not-only roots self-describing (#1667)", () =>
  Effect.sync(() => {
    // An allOf root composes its branches: forcing type OBJECT onto a
    // string branch makes the conjunction unsatisfiable, and onto an
    // object branch it is at best redundant. Either way no OBJECT is
    // added, for Gemini and Anthropic targets alike.
    expect(convertSchema({ allOf: [{ type: "string", minLength: 2 }] } as never)).toEqual({
      allOf: [{ type: "STRING", minLength: 2 }],
    })
    expect(convertSchema({ allOf: [{ type: "string", minLength: 2 }] } as never, true)).toEqual({
      allOf: [{ type: "STRING", minLength: 2 }],
    })
    expect(
      convertSchema({ allOf: [{ type: "object", properties: { a: { type: "string" } } }] } as never),
    ).toEqual({ allOf: [{ type: "OBJECT", properties: { a: { type: "STRING" } } }] })
    // A not-only root negates against every type: "not a string" must
    // not be narrowed to objects only by a forced OBJECT.
    expect(convertSchema({ not: { type: "string" } } as never)).toEqual({ not: { type: "STRING" } })
    expect(convertSchema({ not: { type: "string" } } as never, true)).toEqual({
      not: { type: "STRING" },
    })
    // Plain roots keep the OBJECT default byte-identically.
    expect(convertSchema({} as never)).toEqual({ type: "OBJECT" })
    expect(convertSchema({ properties: { a: { type: "string" } } } as never)).toEqual({
      type: "OBJECT",
      properties: { a: { type: "STRING" } },
    })
    expect(convertSchema({ description: "a thing" } as never)).toEqual({
      type: "OBJECT",
      description: "a thing",
    })
  }),
)

it.effect("convertSchema leaves enum/items/prefixItems-only roots self-describing (#1901)", () =>
  Effect.sync(() => {
    // An enum root enumerates its values verbatim: forcing type OBJECT
    // onto a non-object enum makes it unsatisfiable (no value is both an
    // object and "a"), for Gemini and Anthropic targets alike.
    expect(convertSchema({ enum: ["a", "b"] } as never)).toEqual({ enum: ["a", "b"] })
    expect(convertSchema({ enum: ["a", "b"] } as never, true)).toEqual({ enum: ["a", "b"] })
    // An object enum is already fully enumerated by the enum itself, so
    // it likewise takes no OBJECT default — the enum is the whole schema.
    expect(convertSchema({ enum: [{ a: 1 }] } as never)).toEqual({ enum: [{ a: 1 }] })
    // An items-only root describes an array: items constrains arrays
    // only, so a forced OBJECT would strand the element constraint.
    expect(convertSchema({ items: { type: "string" } } as never)).toEqual({
      items: { type: "STRING" },
    })
    expect(convertSchema({ items: { type: "string" } } as never, true)).toEqual({
      items: { type: "STRING" },
    })
    // A prefixItems-only root is the same shape (the node synthesises
    // items: {} for the prefixItems carrier, #1820); no OBJECT either.
    expect(convertSchema({ prefixItems: [{ type: "string" }] } as never)).toEqual({
      items: {},
      prefixItems: [{ type: "STRING" }],
    })
    expect(convertSchema({ prefixItems: [{ type: "string" }] } as never, true)).toEqual({
      items: {},
      prefixItems: [{ type: "STRING" }],
    })
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

it.effect("Antigravity recovers chat-carried signatures when replaying tool history after a leaf switch", () =>
  Effect.gen(function* () {
    const history = [
      Message.user("Weather in Paris and Tokyo?"),
      Message.assistant([
        ToolCallPart.make({
          id: "call_1",
          name: "lookup",
          input: { city: "Paris" },
          providerMetadata: { openai: { extraContent: { google: { thought_signature: "sig-paris" } } } },
        }),
        ToolCallPart.make({
          id: "call_2",
          name: "lookup",
          input: { city: "Tokyo" },
          providerMetadata: { openai: { extraContent: { google: { thought_signature: "sig-tokyo" } } } },
        }),
      ]),
      Message.tool({ id: "call_1", name: "lookup", result: "Sunny" }),
      Message.tool({ id: "call_2", name: "lookup", result: "Rainy" }),
      Message.user("And tomorrow?"),
    ]
    const compiled = yield* compileRequest(LLM.request({ model, messages: history }))
    const contents = (compiled.body as Record<string, never>).request as Record<string, never>
    const calls = (contents.contents as ReadonlyArray<Record<string, never>>)
      .flatMap((content) => (content.parts as ReadonlyArray<Record<string, never>>) ?? [])
      .filter((part) => "functionCall" in part)

    expect(calls.map((part) => part.thoughtSignature)).toEqual(["sig-paris", "sig-tokyo"])
  }),
)

it.effect("Antigravity assigns a signature or the skip sentinel to every unsigned tool call", () =>
  Effect.gen(function* () {
    const compiled = yield* compileRequest(
      LLM.request({
        model,
        messages: [
          Message.user("Do these things"),
          Message.assistant([
            ToolCallPart.make({
              id: "call_1",
              name: "lookup",
              input: { city: "Paris" },
              providerMetadata: { antigravity: { thoughtSignature: "sig-signed" } },
            }),
            ToolCallPart.make({ id: "call_2", name: "lookup", input: { city: "Tokyo" } }),
            ToolCallPart.make({ id: "call_3", name: "lookup", input: { city: "Rome" } }),
          ]),
        ],
      }),
    )
    const request = (compiled.body as Record<string, never>).request as Record<string, never>
    const calls = (request.contents as ReadonlyArray<Record<string, never>>)
      .flatMap((content) => (content.parts as ReadonlyArray<Record<string, never>>) ?? [])
      .filter((part) => "functionCall" in part)

    expect(calls.map((part) => part.thoughtSignature)).toEqual([
      "sig-signed",
      "skip_thought_signature_validator",
      "skip_thought_signature_validator",
    ])

    const unsigned = yield* compileRequest(
      LLM.request({
        model,
        messages: [
          Message.user("Do these things"),
          Message.assistant([
            ToolCallPart.make({ id: "call_4", name: "lookup", input: { city: "Paris" } }),
            ToolCallPart.make({ id: "call_5", name: "lookup", input: { city: "Tokyo" } }),
          ]),
        ],
      }),
    )
    const unsignedRequest = (unsigned.body as Record<string, never>).request as Record<string, never>
    const unsignedCalls = (unsignedRequest.contents as ReadonlyArray<Record<string, never>>)
      .flatMap((content) => (content.parts as ReadonlyArray<Record<string, never>>) ?? [])
      .filter((part) => "functionCall" in part)
    expect(unsignedCalls.map((part) => part.thoughtSignature)).toEqual([
      "skip_thought_signature_validator",
      "skip_thought_signature_validator",
    ])
  }),
)

it.effect("Antigravity history tool calls carry their ids for Claude targets only (#1550)", () =>
  Effect.gen(function* () {
    // For Claude models the upstream's v1internal->Anthropic conversion
    // emits a tool_use per history functionCall and a tool_result per
    // functionResponse, and Anthropic requires both ids
    // ("messages.N.content.M.tool_use.id: Field required", then
    // "tool_result.tool_use_id: Field required"), which 400'd every
    // Claude session continuation carrying a tool call. The lowering
    // must carry the parts' ids for Claude targets and stay id-less
    // for Gemini, exactly like the door.
    const history = [
      Message.user("weather?"),
      Message.assistant([ToolCallPart.make({ id: "call_1", name: "get_weather", input: { city: "Oslo" } })]),
      Message.tool({ id: "call_1", name: "get_weather", result: '{"temp": 3}', resultType: "text" }),
      Message.user("thanks"),
    ]
    const partsOf = (body: Record<string, never>) =>
      ((body.request as Record<string, never>).contents as ReadonlyArray<Record<string, never>>).flatMap(
        (content) => (content.parts as ReadonlyArray<Record<string, never>>) ?? [],
      )
    const claudeModel = Antigravity.configure({ accessToken: "fixture-token" }).model("claude-sonnet-5-5")
    const claudeCompiled = yield* compileRequest(LLM.request({ model: claudeModel, messages: history }))
    const claudeParts = partsOf(claudeCompiled.body as Record<string, never>)
    const claudeCall = claudeParts.find((part) => "functionCall" in part) as Record<string, never>
    const claudeResp = claudeParts.find((part) => "functionResponse" in part) as Record<string, never>
    expect((claudeCall.functionCall as Record<string, never>).id).toBe("call_1")
    expect((claudeResp.functionResponse as Record<string, never>).id).toBe("call_1")

    const geminiCompiled = yield* compileRequest(LLM.request({ model, messages: history }))
    const geminiParts = partsOf(geminiCompiled.body as Record<string, never>)
    const geminiCall = geminiParts.find((part) => "functionCall" in part) as Record<string, never>
    const geminiResp = geminiParts.find((part) => "functionResponse" in part) as Record<string, never>
    expect("id" in (geminiCall.functionCall as Record<string, never>)).toBe(false)
    expect("id" in (geminiResp.functionResponse as Record<string, never>)).toBe(false)
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
    expect(call.providerMetadata?.["_antigravity"]).toEqual({ thoughtSignature: "sig-1" })
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
    expect(Antigravity.provider.id).toBe("_antigravity")
    expect(typeof Antigravity.model).toBe("function")
  }),
)
