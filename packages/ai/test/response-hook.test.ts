import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Headers } from "effect/http"
import { HttpContext, LLM } from "../src/index.js"
import { LLMClient, RequestExecutor, WebSocketTransport } from "../src/route.js"
import { configure } from "../src/providers/openai.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const request = LLM.request({ model, prompt: "Hello" })

const limited = dynamicResponse((input) =>
  Effect.succeed(
    input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), {
      headers: {
        "content-type": "text/event-stream",
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "59",
        "x-ratelimit-reset-requests": "1s",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "6m0s",
      },
    }),
  ),
)

describe("StreamOptions.onResponse", () => {
  it.effect("reports a successful response's headers before its events, with rate-limit details readable", () =>
    Effect.gen(function* () {
      const order: string[] = []
      let http: HttpContext | undefined
      const events = yield* LLMClient.stream(request, {
        onResponse: (value) => {
          order.push("response")
          http = value
        },
      }).pipe(
        Stream.tap(() => Effect.sync(() => order.push("event"))),
        Stream.runCollect,
        Effect.provide(limited),
      )

      expect(events.length).toBeGreaterThan(0)
      expect(order[0]).toBe("response")
      expect(order.filter((entry) => entry === "response")).toHaveLength(1)
      expect(http?.status).toBe(200)
      expect(RequestExecutor.responseRateLimit(http!.headers)).toMatchObject({
        limit: { requests: "60" },
        remaining: { requests: "59", tokens: "0" },
        reset: { requests: "1s", tokens: "6m0s" },
      })
    }),
  )

  it.effect("an observer that throws cannot break the stream it observes", () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(request, {
        onResponse: () => {
          throw new Error("observer failed")
        },
      }).pipe(Stream.runCollect, Effect.provide(limited))
      expect(events.length).toBeGreaterThan(0)
    }),
  )

  it.effect("is optional", () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(limited))
      expect(events.length).toBeGreaterThan(0)
    }),
  )

  it.effect("is not called for a request the provider rejected", () =>
    Effect.gen(function* () {
      let calls = 0
      const rejected = dynamicResponse((input) =>
        Effect.succeed(input.respond("{}", { status: 429, headers: { "retry-after": "5" } })),
      )
      const error = yield* LLMClient.stream(request, { onResponse: () => void calls++ }).pipe(
        Stream.runCollect,
        Effect.provide(rejected),
        Effect.flip,
      )
      expect(calls).toBe(0)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
    }),
  )
})

describe("StreamOptions.onRejected", () => {
  it.effect("reports a rejected request with its failure, including headers and rate limits", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const rejected = dynamicResponse((input) =>
        Effect.succeed(
          input.respond("{}", {
            status: 429,
            headers: { "retry-after": "5", "x-ratelimit-remaining-requests": "0" },
          }),
        ),
      )
      const error = yield* LLMClient.stream(request, {
        onRejected: (failure) => {
          seen.push(failure.reason._tag)
        },
      }).pipe(Stream.runCollect, Effect.provide(rejected), Effect.flip)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
      expect(seen).toEqual(["RateLimit"])
    }),
  )

  it.effect("an observer that throws cannot break the rejection it observes", () =>
    Effect.gen(function* () {
      const rejected = dynamicResponse((input) => Effect.succeed(input.respond("{}", { status: 429 })))
      const error = yield* LLMClient.stream(request, {
        onRejected: () => {
          throw new Error("observer failed")
        },
      }).pipe(Stream.runCollect, Effect.provide(rejected), Effect.flip)
      expect(error.reason._tag).toBe("RateLimit")
    }),
  )

  it.effect("is optional", () =>
    Effect.gen(function* () {
      const rejected = dynamicResponse((input) => Effect.succeed(input.respond("{}", { status: 429 })))
      const error = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(rejected), Effect.flip)
      expect(error.reason._tag).toBe("RateLimit")
    }),
  )
})

describe("StreamOptions.onResponse over the websocket transport", () => {
  it.effect("reports the handshake response's headers, so its rate limits are readable too", () =>
    Effect.gen(function* () {
      const handshake = new HttpContext({
        url: "https://provider.test/responses",
        status: 101,
        headers: {
          upgrade: "websocket",
          "x-ratelimit-limit-requests": "60",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "30s",
        },
      })
      const executor = WebSocketTransport.makeDirect({
        open: () =>
          Effect.succeed({
            http: handshake,
            sendText: () => Effect.void,
            messages: Stream.empty,
            close: Effect.void,
          }),
      })
      const execution = yield* executor.execute({
        id: "exchange",
        connect: { url: "wss://provider.test/responses", headers: Headers.empty },
        fallback: () => Stream.empty,
        driver: {
          create: () => Effect.succeed({ message: "create", mode: "full" }),
          observe: () => Effect.succeed({ type: "frame", frame: "{}" }),
        },
      })

      // The route hands this to StreamOptions.onResponse; without it there is nothing to report.
      expect(execution.http).toBe(handshake)
      expect(RequestExecutor.responseRateLimit(handshake.headers)).toMatchObject({
        limit: { requests: "60" },
        remaining: { requests: "0" },
        reset: { requests: "30s" },
      })
    }),
  )

  it.effect("carries nothing when the handshake exposes no response metadata", () =>
    Effect.gen(function* () {
      const executor = WebSocketTransport.makeDirect({
        open: () => Effect.succeed({ sendText: () => Effect.void, messages: Stream.empty, close: Effect.void }),
      })
      const execution = yield* executor.execute({
        id: "exchange",
        connect: { url: "wss://provider.test/responses", headers: Headers.empty },
        fallback: () => Stream.empty,
        driver: {
          create: () => Effect.succeed({ message: "create", mode: "full" }),
          observe: () => Effect.succeed({ type: "frame", frame: "{}" }),
        },
      })
      expect(execution.http).toBeUndefined()
    }),
  )
})

describe("RequestExecutor.responseRateLimit", () => {
  test("is undefined when a response carries no rate-limit headers", () => {
    expect(RequestExecutor.responseRateLimit({ "content-type": "application/json" })).toBeUndefined()
  })

  test("reads retry-after on its own", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "7" })).toMatchObject({ retryAfterMs: 7_000 })
  })

  test("ignores retry-after spellings that are neither delay-seconds nor HTTP-dates", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "1e3" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after": "0x10" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after": "garbage" })).toBeUndefined()
  })

  test("ignores retry-after-ms spellings outside the decimal grammar", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "1e3" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "0x10" })).toBeUndefined()
  })

  test("falls through a non-decimal retry-after-ms to retry-after", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "1e3", "retry-after": "10" })).toMatchObject({
      retryAfterMs: 10_000,
    })
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "0x10", "retry-after": "10" })).toMatchObject({
      retryAfterMs: 10_000,
    })
  })

  test("keeps plain authored values", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "0" })).toMatchObject({ retryAfterMs: 0 })
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "250" })).toMatchObject({ retryAfterMs: 250 })
    expect(RequestExecutor.responseRateLimit({ "retry-after": "10" })).toMatchObject({ retryAfterMs: 10_000 })
  })

  test("keeps HTTP-date retry-after", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" })).toMatchObject({
      retryAfterMs: 0,
    })
    const details = RequestExecutor.responseRateLimit({
      "retry-after": new Date(Date.now() + 60_000).toUTCString(),
    })
    expect(details?.retryAfterMs).toBeGreaterThan(55_000)
    expect(details?.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  test("ignores calendar-invalid ISO retry-after dates (#713)", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "2026-02-30T00:00:00Z" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after": "2026-13-01T00:00:00Z" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after": "2026-01-01T24:00:00Z" })).toBeUndefined()
  })

  test("ignores calendar-invalid named-form retry-after dates (#1003)", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "Feb 30 2026" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after": "30 Feb 2026" })).toBeUndefined()
    expect(RequestExecutor.responseRateLimit({ "retry-after": "Feb 28 2026 24:00" })).toBeUndefined()
  })

  test("keeps valid named-form retry-after dates (#1003)", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": "Oct 21 2015" })).toMatchObject({ retryAfterMs: 0 })
    expect(RequestExecutor.responseRateLimit({ "retry-after": "21 Oct 2015" })).toMatchObject({ retryAfterMs: 0 })
  })

  test("keeps valid ISO retry-after dates (#713)", () => {
    const details = RequestExecutor.responseRateLimit({
      "retry-after": new Date(Date.now() + 60_000).toISOString(),
    })
    expect(details?.retryAfterMs).toBeGreaterThan(55_000)
    expect(details?.retryAfterMs).toBeLessThanOrEqual(60_000)
    expect(RequestExecutor.responseRateLimit({ "retry-after": "2015-10-21T07:28:00Z" })).toMatchObject({
      retryAfterMs: 0,
    })
  })

  test("treats a blank retry-after-ms as absent and falls through to retry-after", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "", "retry-after": "7" })).toMatchObject({
      retryAfterMs: 7_000,
    })
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "  ", "retry-after": "7" })).toMatchObject({
      retryAfterMs: 7_000,
    })
  })

  test("treats a blank retry-after-ms alone as absent", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "" })).toBeUndefined()
  })

  test("treats a whitespace-only retry-after as absent", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after": " " })).toBeUndefined()
  })

  test("still reads an authored retry-after-ms of 0 as 0", () => {
    expect(RequestExecutor.responseRateLimit({ "retry-after-ms": "0", "retry-after": "7" })).toMatchObject({
      retryAfterMs: 0,
    })
  })
})
