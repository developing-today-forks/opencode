import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { MuseDirect } from "../../src/providers/index.js"
import { MuseDirectAuth } from "../../src/providers/muse-direct-auth.js"
import { MuseDirectResponses } from "../../src/protocols/muse-direct-responses.js"
import { MetaResponses } from "../../src/protocols/meta-responses.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, observe, type Call } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const ACCOUNT_TOKEN = "dca:test-account-token"
const MINTED_KEY = "LLM|minted-fixture-key"
const STORED_KEY = "LLM|stored-fixture-key"

// Fixture credential material is assembled from JSON text so the
// fixture values stay readable as data, not as credential-shaped
// code.
const parseJson = (text: string): Record<string, string> => JSON.parse(text)
const authFile = (metaJson: string) => `{"providers":{"meta":${metaJson}}}`
const accountFile = authFile(`{"access_token":"${ACCOUNT_TOKEN}"}`)
const storedKeyFile = authFile(`{"api_key":"${STORED_KEY}"}`)
const keySettings = (key: string): MuseDirect.LanguageModelOptions => JSON.parse(`{"apiKey":${JSON.stringify(key)}}`)

const textStream = (text: string) =>
  sseEvents(
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    },
    { type: "response.completed", response: { id: "resp_1" } },
  )

interface ExchangeCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** A fake /muse-code/key endpoint: records each exchange, answers via `respond`. */
const fakeExchange = (respond: (nth: number) => unknown) => {
  const calls: Array<ExchangeCall> = []
  const fetchFn = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ?? "" })
    return new Response(JSON.stringify(respond(calls.length)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { calls, fetchFn }
}

type Handler = Parameters<typeof dynamicResponse>[0]
type HandlerInput = Parameters<Handler>[0]

const generate = (model: Parameters<typeof LLM.request>[0]["model"], request: Record<string, unknown>, handler: Handler) =>
  LLMClient.generate(LLM.request({ model, ...request } as Parameters<typeof LLM.request>[0]), {}).pipe(
    Effect.provide(dynamicResponse(handler)),
  )

it.effect("MuseDirect composes the native Meta Responses route under its own provider id", () =>
  Effect.gen(function* () {
    const direct = MuseDirect.configure(keySettings(MINTED_KEY))
    const model = direct.model("muse-spark-1.3-contributor")
    expect(model.provider).toBe("muse-direct")
    expect(model.route.providerMetadataKey).toBe("muse-direct")
    expect(model.route.endpoint.baseURL).toBe("https://api.meta.ai/v1")
    expect(model.route.endpoint.path).toBe("/responses")
    expect(MuseDirectResponses.protocol.id).toBe("muse-direct-responses")
    expect(model.route.body).toBe(MuseDirectResponses.protocol.body)
    expect(MuseDirectResponses.protocol.stream.event).toBe(MetaResponses.protocol.stream.event)
    const compiled = yield* compileRequest(LLM.request({ model, prompt: "Hello" }))
    expect(compiled.protocol).toBe("muse-direct-responses")
    expect(compiled.body).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] })
    expect(MuseDirect.MODELS.map((preset) => preset.id)).toEqual([
      "muse-spark-1.3-contributor",
      "muse-wonder-1.0-contributor",
    ])
  }),
)

it.effect("exchanges the account token once and sends the minted key as a bare Bearer credential", () =>
  Effect.gen(function* () {
    MuseDirectAuth.invalidate()
    const exchange = fakeExchange(() => parseJson(`{"api_key":"${MINTED_KEY}"}`))
    const direct = MuseDirect.configure({
      baseURL: "https://meta.test/v1",
      sources: { readFile: () => accountFile, fetchFn: exchange.fetchFn },
    })
    const calls: Array<Call> = []
    const handler = (input: HandlerInput) =>
      observe(calls, input).pipe(
        Effect.map(() => input.respond(textStream("Hello"), { headers: { "content-type": "text/event-stream" } })),
      )
    const model = direct.model("muse-spark-1.3-contributor")
    const first = yield* generate(model, { prompt: "Hello" }, handler)
    expect(first.text).toBe("Hello")
    const second = yield* generate(model, { prompt: "Hello again" }, handler)
    expect(second.text).toBe("Hello")

    expect(exchange.calls).toHaveLength(1)
    const seen = exchange.calls[0]!
    expect(seen.url).toBe("https://api.meta.ai/muse-code/key")
    expect(seen.method).toBe("POST")
    expect(seen.headers.authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`)
    expect(seen.headers["x-api-version"]).toBe("1.0.0")
    expect(JSON.parse(seen.body)).toEqual({ onboard: false })

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toBe("https://meta.test/v1/responses")
      expect(call.headers.get("authorization")).toBe(`Bearer ${MINTED_KEY}`)
    }
  }),
)

it.effect("aliases shell/bash outbound and unaliases the tool call inbound", () =>
  Effect.gen(function* () {
    const direct = MuseDirect.configure({ ...keySettings(MINTED_KEY), baseURL: "https://meta.test/v1" })
    const calls: Array<Call> = []
    const handler = (input: HandlerInput) =>
      observe(calls, input).pipe(
        Effect.map(() =>
          input.respond(
            sseEvents(
              { type: "response.created", response: { id: "resp_1" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "terminal",
                  arguments: "",
                  status: "in_progress",
                },
              },
              {
                type: "response.function_call_arguments.done",
                output_index: 0,
                item_id: "fc_1",
                arguments: '{"command":"ls"}',
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "terminal",
                  arguments: '{"command":"ls"}',
                  status: "completed",
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      )
    const response = yield* generate(
      direct.model("muse-spark-1.3-contributor"),
      {
        messages: [
          Message.user("List the files."),
          Message.assistant([ToolCallPart.make({ id: "call_0", name: "shell", input: { command: "pwd" } })]),
          Message.tool({ id: "call_0", name: "shell", result: "/home/user" }),
        ],
        tools: [
          ToolDefinition.make({ name: "bash", description: "Run a command", inputSchema: { type: "object" } }),
          ToolDefinition.make({ name: "shell", description: "Run a shell command", inputSchema: { type: "object" } }),
          ToolDefinition.make({ name: "lookup", description: "Look something up", inputSchema: { type: "object" } }),
        ],
        toolChoice: "bash",
      },
      handler,
    )
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0]!.body) as {
      tools: Array<{ name: string }>
      tool_choice: { type: string; name: string }
      input: Array<{ type?: string; name?: string }>
    }
    expect(body.tools.map((tool) => tool.name).sort()).toEqual(["lookup", "run_command", "terminal"])
    expect(body.tool_choice).toEqual({ type: "function", name: "terminal" })
    const historyCall = body.input.find((item) => item.type === "function_call")
    expect(historyCall?.name).toBe("run_command")
    const toolCall = response.events.find((event) => event.type === "tool-call")
    expect(toolCall).toMatchObject({ type: "tool-call", name: "bash", input: { command: "ls" } })
    const part = response.message.content.find((item) => item.type === "tool-call")
    expect(part).toMatchObject({ type: "tool-call", name: "bash" })
  }),
)

it.effect("collision guard is per alias target: shell stays when run_command is a genuine tool", () =>
  Effect.gen(function* () {
    const direct = MuseDirect.configure(keySettings(MINTED_KEY))
    const guarded = yield* compileRequest(
      LLM.request({
        model: direct.model("muse-spark-1.3-contributor"),
        prompt: "Hi",
        tools: [
          ToolDefinition.make({ name: "shell", description: "Run a shell command", inputSchema: { type: "object" } }),
          ToolDefinition.make({ name: "run_command", description: "The genuine one", inputSchema: { type: "object" } }),
        ],
      }),
    )
    expect((guarded.body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort()).toEqual([
      "run_command",
      "shell",
    ])
    // bash's own target (terminal) is free, so bash still aliases even
    // though run_command is taken by the genuine tool.
    const partial = yield* compileRequest(
      LLM.request({
        model: direct.model("muse-spark-1.3-contributor"),
        prompt: "Hi",
        tools: [
          ToolDefinition.make({ name: "bash", description: "Run a command", inputSchema: { type: "object" } }),
          ToolDefinition.make({ name: "run_command", description: "The genuine one", inputSchema: { type: "object" } }),
        ],
      }),
    )
    expect((partial.body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort()).toEqual([
      "run_command",
      "terminal",
    ])
  }),
)

it.effect("a 401 invalidates the minted key, re-exchanges, and retries exactly once", () =>
  Effect.gen(function* () {
    MuseDirectAuth.invalidate()
    const keys = ["LLM|minted-one", "LLM|minted-two"]
    const exchange = fakeExchange((nth) => parseJson(`{"api_key":"${keys[nth - 1]}"}`))
    const direct = MuseDirect.configure({
      baseURL: "https://meta.test/v1",
      sources: { readFile: () => accountFile, fetchFn: exchange.fetchFn },
    })
    const calls: Array<Call> = []
    const handler = (input: HandlerInput) =>
      observe(calls, input).pipe(
        Effect.map(({ nth }) =>
          nth === 1
            ? input.respond(JSON.stringify({ error: { message: "unauthorized" } }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            : input.respond(textStream("Recovered"), { headers: { "content-type": "text/event-stream" } }),
        ),
      )
    const response = yield* generate(direct.model("muse-wonder-1.0-contributor"), { prompt: "Hello" }, handler)
    expect(response.text).toBe("Recovered")
    expect(exchange.calls).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer LLM|minted-one")
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer LLM|minted-two")
  }),
)

it.effect("subscription and payment exchange states are hard errors with no inference attempt", () =>
  Effect.gen(function* () {
    const cases = [
      { response: parseJson('{"is_subs_active":false}'), message: "subscription is not active" },
      { response: parseJson('{"require_payment":true}'), message: "requires payment" },
    ]
    for (const item of cases) {
      MuseDirectAuth.invalidate()
      const exchange = fakeExchange(() => item.response)
      const direct = MuseDirect.configure({
        baseURL: "https://meta.test/v1",
        sources: { readFile: () => accountFile, fetchFn: exchange.fetchFn },
      })
      const calls: Array<Call> = []
      const handler = (input: HandlerInput) =>
        observe(calls, input).pipe(Effect.map(() => input.respond(textStream("unreachable"))))
      const error = yield* generate(direct.model("muse-spark-1.3-contributor"), { prompt: "Hello" }, handler).pipe(
        Effect.flip,
      )
      expect(String(error)).toContain(item.message)
      expect(calls).toHaveLength(0)
    }
  }),
)

it.effect("an over-cap key-exchange response is rejected instead of buffered whole (#1893)", () =>
  Effect.gen(function* () {
    const handler = (calls: Array<Call>) => (input: HandlerInput) =>
      observe(calls, input).pipe(Effect.map(() => input.respond(textStream("unreachable"))))

    // Oversized SUCCESS body: valid JSON with a minted key, padded past the 1 MiB cap.
    MuseDirectAuth.invalidate()
    const bigOk = fakeExchange(() => ({ api_key: MINTED_KEY, pad: "x".repeat(2_000_000) }))
    const directOk = MuseDirect.configure({
      baseURL: "https://meta.test/v1",
      sources: { readFile: () => accountFile, fetchFn: bigOk.fetchFn },
    })
    const okCalls: Array<Call> = []
    const okError = yield* generate(directOk.model("muse-spark-1.3-contributor"), { prompt: "Hello" }, handler(okCalls)).pipe(
      Effect.flip,
    )
    expect(String(okError)).toContain("exceeded")
    expect(okCalls).toHaveLength(0)

    // Oversized ERROR body: the bounded read rejects it before the HTTP-error slice.
    MuseDirectAuth.invalidate()
    const bigErrFetch = (async () => new Response("E".repeat(2_000_000), { status: 500 })) as typeof fetch
    const directErr = MuseDirect.configure({
      baseURL: "https://meta.test/v1",
      sources: { readFile: () => accountFile, fetchFn: bigErrFetch },
    })
    const errCalls: Array<Call> = []
    const errError = yield* generate(directErr.model("muse-spark-1.3-contributor"), { prompt: "Hello" }, handler(errCalls)).pipe(
      Effect.flip,
    )
    expect(String(errError)).toContain("exceeded")
    expect(errCalls).toHaveLength(0)
  }),
)

it.effect("an api_key-only auth file is used directly, with no exchange", () =>
  Effect.gen(function* () {
    MuseDirectAuth.invalidate()
    const direct = MuseDirect.configure({
      baseURL: "https://meta.test/v1",
      sources: {
        readFile: () => storedKeyFile,
        fetchFn: (async () => {
          throw new Error("exchange must not run for an api_key-only credential")
        }) as typeof fetch,
      },
    })
    const calls: Array<Call> = []
    const handler = (input: HandlerInput) =>
      observe(calls, input).pipe(
        Effect.map(() => input.respond(textStream("Direct"), { headers: { "content-type": "text/event-stream" } })),
      )
    const response = yield* generate(direct.model("muse-spark-1.3-contributor"), { prompt: "Hello" }, handler)
    expect(response.text).toBe("Direct")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${STORED_KEY}`)
  }),
)

it.effect("a missing credential file fails closed with the named message", () =>
  Effect.gen(function* () {
    MuseDirectAuth.invalidate()
    const direct = MuseDirect.configure({
      baseURL: "https://meta.test/v1",
      sources: { readFile: () => undefined },
    })
    const calls: Array<Call> = []
    const handler = (input: HandlerInput) =>
      observe(calls, input).pipe(Effect.map(() => input.respond(textStream("unreachable"))))
    const error = yield* generate(direct.model("muse-spark-1.3-contributor"), { prompt: "Hello" }, handler).pipe(
      Effect.flip,
    )
    expect(String(error)).toContain("Muse account credential unavailable")
    expect(calls).toHaveLength(0)
  }),
)

it.effect("v1-dialect effort settings normalize to reasoningEffort on the wire", () =>
  Effect.gen(function* () {
    const shapes: Array<MuseDirect.Settings> = [
      JSON.parse('{"options":{"reasoning_effort":"xhigh"}}'),
      JSON.parse('{"options":{"reasoningEffort":"high"}}'),
      JSON.parse('{"reasoning_effort":"low"}'),
      JSON.parse('{"reasoningEffort":"medium"}'),
    ]
    const expected = ["xhigh", "high", "low", "medium"]
    for (const [index, settings] of shapes.entries()) {
      const compiled = yield* compileRequest(
        LLM.request({ model: MuseDirect.model("muse-spark-1.3-contributor", settings), prompt: "Hi" }),
      )
      expect((compiled.body as { reasoning?: { effort?: string } }).reasoning?.effort).toBe(expected[index])
    }
  }),
)

it.effect("parseAuthFile trims values and treats blanks and malformed files as absent", () =>
  Effect.gen(function* () {
    expect(MuseDirectAuth.parseAuthFile(authFile(`{"access_token":"  ${ACCOUNT_TOKEN}  "}`))).toEqual({
      accountToken: ACCOUNT_TOKEN,
    })
    expect(MuseDirectAuth.parseAuthFile(authFile('{"access_token":"   "}'))).toBeUndefined()
    expect(MuseDirectAuth.parseAuthFile(storedKeyFile)).toEqual({ inferenceKey: STORED_KEY })
    expect(MuseDirectAuth.parseAuthFile("not json")).toBeUndefined()
    expect(MuseDirectAuth.parseAuthFile("{}")).toBeUndefined()
  }),
)
