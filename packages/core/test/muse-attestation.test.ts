/**
 * Muse attestation aliasing (#1443) — the façade's reproduction of the
 * muse door's direct-path behaviour, scoped to the muse backend.
 *
 * The pure transforms are pinned against the door's own recorded
 * semantics (developing-today/code bin/muse-proxy.mjs:
 * DIRECT_TOOL_ALIASES, buildResponsesRequest, aliasResponsesRequestBody,
 * extractResponsesOutput, tryDirectChat; bin/muse-proxy.test.mjs tests
 * "the shell tool is aliased upstream and its calls translate back",
 * "/v1/responses aliases the shell tool…", "an attestation denial falls
 * back to the CLI door"). The Generate-level tests replay a request
 * through the real resolver + Meta Responses protocol against a fake
 * upstream that records every outbound body — no live provider is
 * contacted.
 *
 * RE-RUN (laptop): cd packages/core && bun run test test/muse-attestation.test.ts
 */
import { describe, expect, test } from "bun:test"
import { AIError, LLMEvent, LLMResponse, Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { LLMClient } from "@opencode/ai"
import { Meta } from "@opencode/ai/providers/meta"
import { AISDK } from "@opencode/core/aisdk"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { MuseAttestation } from "@opencode/core/muse-attestation"
import { ID, Info, Model, Ref } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

// ------------------------------------------------------------ pure transforms

describe("MuseAttestation.plan", () => {
  test("aliases shell and bash when their targets are free", () => {
    const plan = MuseAttestation.plan(["shell", "bash", "get_weather"])
    expect(plan?.forward.get("shell")).toBe("run_command")
    expect(plan?.forward.get("bash")).toBe("terminal")
    expect(plan?.backward.get("run_command")).toBe("shell")
    expect(plan?.backward.get("terminal")).toBe("bash")
    expect(plan?.forward.has("get_weather")).toBe(false)
  })

  test("no shell/bash names: no plan", () => {
    expect(MuseAttestation.plan(["get_weather"])).toBeUndefined()
    expect(MuseAttestation.plan([])).toBeUndefined()
  })

  test("prototype-named tools are left unaliased (#1476)", () => {
    // Tool names come from the caller's request, so a bare ALIASES[name]
    // read walked the prototype chain and produced function-valued
    // "aliases" for these names; the own-property read must not.
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(MuseAttestation.plan([name])).toBeUndefined()
    }
    // Mixed with a genuine alias, only the genuine one is planned.
    const mixed = MuseAttestation.plan(["toString", "shell"])
    expect(mixed?.forward.get("shell")).toBe("run_command")
    expect(mixed?.forward.has("toString")).toBe(false)
  })

  test("collision guard: a genuine run_command keeps shell verbatim (the door's taken check)", () => {
    const plan = MuseAttestation.plan(["shell", "run_command"])
    expect(plan).toBeUndefined()
    const partial = MuseAttestation.plan(["shell", "bash", "terminal"])
    expect(partial?.forward.get("shell")).toBe("run_command")
    expect(partial?.forward.has("bash")).toBe(false)
  })
})

describe("MuseAttestation.aliasInput / unalias", () => {
  const plan = MuseAttestation.plan(["shell", "bash"])!
  const input = {
    messages: [
      Message.user("run echo hi"),
      Message.assistant([ToolCallPart.make({ id: "call_0", name: "shell", input: { command: "echo hi" } })]),
      Message.tool(ToolResultPart.make({ id: "call_0", name: "shell", result: "hi", resultType: "text" as const })),
      Message.user("what did it print?"),
    ],
    tools: [
      { name: "shell", description: "Run a shell command", inputSchema: { type: "object" } },
      { name: "bash", description: "Run a bash command", inputSchema: { type: "object" } },
    ],
    toolChoice: "shell",
  }

  test("tool definitions, history calls and tool_choice are aliased; text is untouched", () => {
    const aliased = MuseAttestation.aliasInput(input, plan)
    expect(aliased.tools?.map((tool) => ("name" in tool ? tool.name : undefined))).toEqual(["run_command", "terminal"])
    const choice = aliased.toolChoice
    expect(typeof choice === "object" && choice !== null && "name" in choice ? choice.name : choice).toBe("run_command")
    const parts = aliased.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    expect(parts.filter((part) => part.type === "tool-call").map((part) => (part.type === "tool-call" ? part.name : ""))).toEqual([
      "run_command",
    ])
    expect(parts.filter((part) => part.type === "tool-result").map((part) => (part.type === "tool-result" ? part.name : ""))).toEqual([
      "run_command",
    ])
    // The caller's own input object is never mutated.
    expect(input.tools.map((tool) => tool.name)).toEqual(["shell", "bash"])
  })

  test("returned calls translate back under the caller's names", () => {
    const events = [
      LLMEvent.toolInputStart({ id: "call_9", name: "run_command" }),
      LLMEvent.toolCall({ id: "call_9", name: "run_command", input: { command: "echo hi" } }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
    ]
    expect(MuseAttestation.unaliasEvent(events[0]!, plan)).toMatchObject({ type: "tool-input-start", name: "shell" })
    const response = LLMResponse.fromEvents(events)
    if (!response) throw new Error("expected a completed response")
    const unaliased = MuseAttestation.unaliasResponse(response, plan)
    expect(unaliased.toolCalls.map((call) => call.name)).toEqual(["shell"])
    expect(
      unaliased.message.content.filter((part) => part.type === "tool-call").map((part) => (part.type === "tool-call" ? part.name : "")),
    ).toEqual(["shell"])
  })

  test("back-translation keys off the request's own plan (door deviation, recorded on #1443)", () => {
    // The door's reverse map is unconditional: a genuine `run_command`
    // call is renamed to `shell` on the way out even when the request
    // never contained `shell`. The façade builds the reverse map from
    // the names THIS request aliased — a bash-only plan renames
    // `terminal` back and leaves `run_command` exactly as the model
    // emitted it.
    const bashPlan = MuseAttestation.plan(["bash"])!
    expect(bashPlan.backward.get("terminal")).toBe("bash")
    expect(bashPlan.backward.has("run_command")).toBe(false)
    const event = LLMEvent.toolCall({ id: "call_1", name: "run_command", input: {} })
    expect(MuseAttestation.unaliasEvent(event, bashPlan)).toBe(event)
    // And a request with no shell/bash at all produces no plan, so
    // Generate never renames anything for it.
    expect(MuseAttestation.plan(["get_weather"])).toBeUndefined()
  })
})

describe("MuseAttestation.aliasRawBody", () => {
  const plan = MuseAttestation.plan(["shell", "bash"])!

  test("responses shape: tools, history function_call items and tool_choice are aliased", () => {
    const raw = JSON.stringify({
      model: "opencode-route/workhorse",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] },
        { type: "function_call", call_id: "call_0", name: "shell", arguments: '{"command":"echo hi"}' },
        { type: "function_call_output", call_id: "call_0", output: "hi" },
      ],
      tools: [{ type: "function", name: "shell", description: "d", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "bash" },
    })
    const out = JSON.parse(MuseAttestation.aliasRawBody(raw, "responses", plan)!) as {
      tools: Array<{ name: string }>
      input: Array<{ name?: string }>
      tool_choice: { name: string }
    }
    expect(out.tools[0]?.name).toBe("run_command")
    expect(out.input[1]?.name).toBe("run_command")
    expect(out.tool_choice.name).toBe("terminal")
  })

  test("chat shape: nested function names are aliased", () => {
    const raw = JSON.stringify({
      model: "opencode-route/workhorse",
      messages: [
        { role: "user", content: "run echo hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "bash", arguments: "{}" } }] },
      ],
      tools: [{ type: "function", function: { name: "shell", description: "d", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "shell" } },
    })
    const out = JSON.parse(MuseAttestation.aliasRawBody(raw, "chat", plan)!) as {
      tools: Array<{ function: { name: string } }>
      messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>
      tool_choice: { function: { name: string } }
    }
    expect(out.tools[0]?.function.name).toBe("run_command")
    expect(out.messages[1]?.tool_calls?.[0]?.function.name).toBe("terminal")
    expect(out.tool_choice.function.name).toBe("run_command")
  })

  test("nothing to alias, or an unparseable body, returns undefined (forward the original)", () => {
    expect(MuseAttestation.aliasRawBody(JSON.stringify({ model: "m", tools: [] }), "responses", plan)).toBeUndefined()
    expect(MuseAttestation.aliasRawBody("not json", "responses", plan)).toBeUndefined()
  })
})

describe("MuseAttestation.isAttestationDenial", () => {
  const fake = (status: number, body: string) =>
    ({ reason: { http: { status }, body, message: body } }) as unknown as AIError

  test("matches the recorded 403 body only", () => {
    expect(
      MuseAttestation.isAttestationDenial(
        fake(403, '{"error":{"code":"client_attestation_denied","message":"This API key is billed to a Muse Code subscription.","type":"permission_error"}}'),
      ),
    ).toBe(true)
    expect(MuseAttestation.isAttestationDenial(fake(403, '{"error":{"message":"forbidden"}}'))).toBe(false)
    expect(MuseAttestation.isAttestationDenial(fake(429, '{"error":{"code":"client_attestation_denied"}}'))).toBe(false)
  })
})

// ------------------------------------------------------------ Generate integration

const metaModel = Meta.configure({ apiKey: "fixture" }).responses("muse-spark-1.3")

const providers = Layer.mock(Provider.Service, { get: () => Effect.undefined })
const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: {
    active: () => Effect.undefined,
    resolve: () => Effect.die("unused"),
    key: () => Effect.die("unused"),
    external: () => Effect.die("unused"),
    activate: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
  },
  oauth: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
  command: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
})
const npm = Layer.mock(Npm.Service, {
  add: () => Effect.die("unused"),
  which: () => Effect.die("unused"),
})

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body as { text?: string; body?: Uint8Array }
  if (body.text !== undefined) return body.text
  if (body.body) return new TextDecoder().decode(body.body)
  return ""
}

/** A Generate service whose provider endpoint is a recording fake. */
const setup = (providerID: string, modelID: string, runtime: typeof metaModel, respond: (body: string) => Response) => {
  const selected = Info.make({
    ...Info.default(Provider.ID.make(providerID), ID.make(modelID)),
    package: Provider.aisdk("@ai-sdk/openai"),
  })
  const ref = Ref.make({ providerID: selected.providerID, id: selected.id })
  const bodies: string[] = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const text = bodyTextOf(request)
        bodies.push(text)
        return HttpClientResponse.fromWeb(request, respond(text))
      }),
    ),
  )
  const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
  const aisdk = Layer.mock(AISDK.Service, {
    hook: {
      sdk: () => Effect.die("unused"),
      language: () => Effect.die("unused"),
    },
    model: () => Effect.succeed(runtime),
  })
  const models = Layer.mock(Model.Service, { get: () => Effect.succeed(selected) })
  const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
  const it = testEffect(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, native))))
  return { it, bodies, ref }
}

/** Runs an effect with the route ledger sink captured, always restoring the previous (unset) sink. */
const capturing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const attempts: ModelRouteLog.Attempt[] = []
    ModelRouteLog.setSink((event) => {
      if (event.kind === "attempt") attempts.push(event.row)
    })
    const value = yield* effect.pipe(Effect.ensuring(Effect.sync(() => ModelRouteLog.setSink(undefined))))
    return { value, attempts }
  })

/** Upstream Responses SSE answering with a function_call to `name`. */
const responsesSSE = (name: string) =>
  new Response(
    [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_fake", object: "response", created_at: 1, status: "in_progress", model: "muse-spark-1.3", output: [], parallel_tool_calls: true, tool_choice: "auto", tools: [] } })}\n`,
      `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", sequence_number: 1, response: { id: "resp_fake", object: "response", created_at: 1, status: "in_progress", model: "muse-spark-1.3", output: [], parallel_tool_calls: true, tool_choice: "auto", tools: [] } })}\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "", status: "in_progress" } })}\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", sequence_number: 3, item_id: "fc_1", output_index: 0, delta: '{"command":"echo hi"}' })}\n`,
      `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", sequence_number: 4, item_id: "fc_1", output_index: 0, name, arguments: '{"command":"echo hi"}' })}\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 5, output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: '{"command":"echo hi"}', status: "completed" } })}\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 6, response: { id: "resp_fake", object: "response", created_at: 1, status: "completed", model: "muse-spark-1.3", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: '{"command":"echo hi"}', status: "completed" }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })}\n`,
    ].join("\n") + "\n",
    { headers: { "content-type": "text/event-stream" } },
  )

const ATTESTATION_BODY =
  '{"error":{"code":"client_attestation_denied","message":"This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only.","type":"permission_error"}}'

const shellInput = {
  messages: [
    Message.user("run echo hi"),
    Message.assistant([ToolCallPart.make({ id: "call_0", name: "shell", input: { command: "echo hi" } })]),
    Message.tool(ToolResultPart.make({ id: "call_0", name: "shell", result: "hi", resultType: "text" as const })),
    Message.user("what did it print?"),
  ],
  tools: [{ name: "shell", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
  toolChoice: "shell",
}

{
  const { it, bodies, ref } = setup("meta", "muse-spark-1.3", metaModel, () => responsesSSE("run_command"))

  it.effect("translated path: shell is aliased upstream and the returned call is translated back", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const response = yield* generate.complete({ model: ref, ...shellInput, dialect: "chat" })
      const sent = JSON.parse(bodies.at(-1)!) as {
        tools: Array<{ name: string }>
        input: Array<{ type: string; name?: string }>
        tool_choice: { name?: string }
      }
      expect(sent.tools.map((tool) => tool.name)).toEqual(["run_command"])
      expect(sent.input.filter((item) => item.type === "function_call").map((item) => item.name)).toEqual(["run_command"])
      expect(sent.tool_choice.name).toBe("run_command")
      expect(response.toolCalls.map((call) => call.name)).toEqual(["shell"])
    }),
  )

  it.effect("streaming path: streamed tool events carry the caller's name", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const events = yield* generate.stream({ model: ref, ...shellInput, dialect: "chat" }).pipe(Stream.runCollect)
      const names = Array.from(events)
        .filter((event) => event.type === "tool-call" || event.type === "tool-input-start")
        .map((event) => ("name" in event ? event.name : ""))
      expect(names.length).toBeGreaterThan(0)
      expect(names.every((name) => name === "shell")).toBe(true)
    }),
  )

  it.effect("pass-through path: the raw responses body is aliased before forwarding, answers translated back", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const rawBody = JSON.stringify({
        model: "opencode-route/workhorse",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] },
          { type: "function_call", call_id: "call_0", name: "shell", arguments: '{"command":"echo hi"}' },
          { type: "function_call_output", call_id: "call_0", output: "hi" },
        ],
        tools: [{ type: "function", name: "shell", description: "Run a shell command", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "shell" },
      })
      const response = yield* generate.complete({ model: ref, ...shellInput, dialect: "responses", rawBody })
      const sent = JSON.parse(bodies.at(-1)!) as {
        model: string
        tools: Array<{ name: string }>
        input: Array<{ type: string; name?: string }>
        tool_choice: { name?: string }
      }
      expect(sent.model).toBe("muse-spark-1.3")
      expect(sent.tools.map((tool) => tool.name)).toEqual(["run_command"])
      expect(sent.input.filter((item) => item.type === "function_call").map((item) => item.name)).toEqual(["run_command"])
      expect(sent.tool_choice.name).toBe("run_command")
      expect(response.toolCalls.map((call) => call.name)).toEqual(["shell"])
    }),
  )

  it.effect("collision guard end-to-end: shell beside a genuine run_command goes upstream verbatim", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      yield* generate.complete({
        model: ref,
        messages: [Message.user("hi")],
        tools: [
          { name: "shell", description: "d", inputSchema: { type: "object" } },
          { name: "run_command", description: "d", inputSchema: { type: "object" } },
        ],
        dialect: "chat",
      })
      const sent = JSON.parse(bodies.at(-1)!) as { tools: Array<{ name: string }> }
      expect(sent.tools.map((tool) => tool.name)).toEqual(["shell", "run_command"])
    }),
  )
}

{
  const { it, bodies, ref } = setup("meta", "muse-spark-1.3", metaModel, () =>
    new Response(ATTESTATION_BODY, { status: 403, headers: { "content-type": "application/json" } }),
  )

  it.effect("residual attestation 403: a distinct AttestationError, ledgered as a failure, never quota", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const { value: result, attempts } = yield* capturing(
        Effect.result(generate.complete({ model: ref, ...shellInput, dialect: "chat" })),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("Generate.AttestationError")
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.outcome).toBe("failure")
      expect(bodies.length).toBeGreaterThan(0)
    }),
  )
}

{
  // Scope proof: the same request against a non-muse provider keeps
  // shell verbatim in both directions (design §9.1 for everyone else).
  // The wire protocol is the same Meta Responses shape; only the
  // resolved provider id differs, which is what the scope keys on.
  const { it, bodies, ref } = setup("test-provider", "muse-spark-1.3", metaModel, () => responsesSSE("shell"))

  it.effect("non-muse target: tool names are preserved verbatim upstream and back", () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const response = yield* generate.complete({ model: ref, ...shellInput, dialect: "chat" })
      const sent = JSON.parse(bodies.at(-1)!) as { tools: Array<{ name: string }> }
      expect(sent.tools.map((tool) => tool.name)).toEqual(["shell"])
      expect(response.toolCalls.map((call) => call.name)).toEqual(["shell"])
    }),
  )
}
