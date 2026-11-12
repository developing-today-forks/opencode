import { describe, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClientError } from "effect/http"
import { HttpApi } from "effect/http-api"
import { InvalidRequestError, UnauthorizedError } from "@opencode/protocol/errors"
import { ClientApi } from "../src/contract"
import { ClientError, OpenCode } from "../src/effect"

// A real HTTP server on an ephemeral port, so status, headers, and SSE frames cross the wire as they do in production.
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

function connected(id: string) {
  return JSON.stringify({ id, created: 0, type: "server.connected", data: {} })
}

async function subscribeFailure(baseUrl: string) {
  return Effect.runPromise(
    OpenCode.make({ baseUrl }).pipe(
      Effect.flatMap((client) => client.event.subscribe().pipe(Stream.runCollect, Effect.flip)),
      Effect.provide(FetchHttpClient.layer),
    ),
  )
}

describe("event.subscribe declared errors", () => {
  test("a declared 401 fails with the decoded UnauthorizedError", async () => {
    const server = serve(
      () =>
        new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="Secure Area"' },
        }),
    )
    try {
      const error = await subscribeFailure(server.baseUrl)

      expect(error).toBeInstanceOf(UnauthorizedError)
      expect(error).not.toBeInstanceOf(ClientError)
      expect(error).toMatchObject({ _tag: "UnauthorizedError", message: "Authentication required" })
    } finally {
      server.stop()
    }
  })

  test("a declared 400 fails with the decoded InvalidRequestError fields", async () => {
    const server = serve(
      () =>
        new Response(
          JSON.stringify({
            _tag: "InvalidRequestError",
            message: "last-event-id must be a string",
            kind: "schema",
            field: "last-event-id",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    )
    try {
      const error = await subscribeFailure(server.baseUrl)

      expect(error).toBeInstanceOf(InvalidRequestError)
      expect(error).toMatchObject({
        _tag: "InvalidRequestError",
        message: "last-event-id must be a string",
        kind: "schema",
        field: "last-event-id",
      })
    } finally {
      server.stop()
    }
  })

  test("a declared status whose body does not decode fails as a status error that keeps the response", async () => {
    const server = serve(
      () =>
        new Response(JSON.stringify({ message: "no tag" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    )
    try {
      const error = await subscribeFailure(server.baseUrl)

      expect(error).toBeInstanceOf(ClientError)
      expect(error.cause).toBeInstanceOf(HttpClientError.HttpClientError)
      const reason = (error.cause as HttpClientError.HttpClientError).reason
      expect(reason).toBeInstanceOf(HttpClientError.StatusCodeError)
      expect(reason.response.status).toBe(401)
    } finally {
      server.stop()
    }
  })

  test("the declared statuses are the contract's middleware errors", () => {
    const declared = new Map<number, ReadonlyArray<Schema.Top>>()
    HttpApi.reflect(ClientApi, {
      predicate: ({ group, endpoint }) =>
        group.identifier === "server.event" && endpoint.identifier === "event.subscribe",
      onGroup() {},
      onEndpoint({ errors }) {
        for (const [status, schemas] of errors) declared.set(status, schemas)
      },
    })

    expect([...declared.keys()].sort()).toEqual([400, 401])
    const decodeAt = (status: number, body: unknown) =>
      Schema.decodeUnknownSync(declared.get(status)![0]!)(body) as { readonly _tag: string }
    expect(decodeAt(401, { _tag: "UnauthorizedError", message: "m" })._tag).toBe("UnauthorizedError")
    expect(decodeAt(400, { _tag: "InvalidRequestError", message: "m" })._tag).toBe("InvalidRequestError")
    expect(() => decodeAt(401, { _tag: "InvalidRequestError", message: "m" })).toThrow()
  })
})

describe("event.subscribe undeclared responses", () => {
  test("an undeclared 500 fails with a ClientError that keeps the status and body", async () => {
    const server = serve(() => new Response("boom", { status: 500, headers: { "content-type": "text/plain" } }))
    try {
      const error = await subscribeFailure(server.baseUrl)

      expect(error).toBeInstanceOf(ClientError)
      expect(error.cause).toBeInstanceOf(HttpClientError.HttpClientError)
      const reason = (error.cause as HttpClientError.HttpClientError).reason
      expect(reason).toBeInstanceOf(HttpClientError.DecodeError)
      expect(reason.response.status).toBe(500)
      expect(await Effect.runPromise(reason.response.text)).toBe("boom")
    } finally {
      server.stop()
    }
  })

  test("a 200 response with a non-event-stream content type fails with a typed decode error", async () => {
    const server = serve(
      () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
    )
    try {
      const error = await subscribeFailure(server.baseUrl)

      expect(error).toBeInstanceOf(ClientError)
      const reason = (error.cause as HttpClientError.HttpClientError).reason
      expect(reason).toBeInstanceOf(HttpClientError.DecodeError)
      expect(reason.description).toBe(
        "Unsupported response content-type for status 200: application/json. Expected one of: text/event-stream",
      )
    } finally {
      server.stop()
    }
  })
})

describe("event.subscribe successful stream", () => {
  test("decodes frames and resumes after the last SSE id a consumer took", async () => {
    const lastEventIDs: Array<string | null> = []
    const server = serve((request) => {
      lastEventIDs.push(request.headers.get("last-event-id"))
      const body =
        lastEventIDs.length === 1
          ? `data: ${connected("evt_connected")}\n\n` +
            `id: inst:1\ndata: ${connected("evt_a")}\n\n` +
            `id: inst:2\ndata: ${connected("evt_b")}\n\n`
          : `id: inst:2\ndata: ${connected("evt_b")}\n\n`
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    })
    try {
      const client = await Effect.runPromise(
        OpenCode.make({ baseUrl: server.baseUrl }).pipe(Effect.provide(FetchHttpClient.layer)),
      )

      // One subscription: the first body ends after evt_b, so the subscription
      // reconnects on its own (#2321) and resumes after the last SSE id a
      // consumer took (inst:2); the fake server answers the reconnect with a
      // replay of evt_b, which is why it appears twice.
      const events = await Effect.runPromise(client.event.subscribe().pipe(Stream.take(4), Stream.runCollect))
      expect(events.map((event) => event.id)).toEqual(["evt_connected", "evt_a", "evt_b", "evt_b"])
      expect(lastEventIDs).toEqual([null, "inst:2"])
    } finally {
      server.stop()
    }
  })
})
