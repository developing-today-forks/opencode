import { describe, expect, test } from "bun:test"
import {
  API_REQUEST_TIMEOUT_MS,
  OPENAPI_FETCH_TIMEOUT_MS,
  fetchApi,
  fetchOpenApi,
  rawRequest,
  resolveOperation,
} from "./api"

describe("api request resolution", () => {
  test("resolves an operation ID with path and query parameters", () => {
    expect(
      resolveOperation(
        {
          paths: {
            "/api/session/{sessionID}": {
              get: { operationId: "session.get" },
            },
          },
        },
        "session.get",
        { sessionID: "ses/a", workspace: "work" },
      ),
    ).toEqual({ method: "GET", path: "/api/session/ses%2Fa?workspace=work" })
  })

  test("rejects a missing path parameter", () => {
    expect(() =>
      resolveOperation(
        { paths: { "/api/session/{sessionID}": { get: { operationId: "session.get" } } } },
        "session.get",
        {},
      ),
    ).toThrow("Missing path parameter: sessionID")
  })

  test("resolves curl-like method and path input", () => {
    expect(rawRequest(["post", "/api/foo"])).toEqual({ method: "POST", path: "/api/foo" })
    expect(rawRequest(["session.list"])).toBeUndefined()
  })
})

describe("api fetch deadlines (#1144)", () => {
  test("pins the deadline policy: 30s spec lookup, 10-minute main request", () => {
    expect(OPENAPI_FETCH_TIMEOUT_MS).toBe(30_000)
    expect(API_REQUEST_TIMEOUT_MS).toBe(600_000)
  })

  test("fetchOpenApi cuts a header stall at the deadline with a named timeout error", async () => {
    const stalled = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      await expect(fetchOpenApi({ url: String(stalled.url) }, 100)).rejects.toThrow(
        "Timed out after 100ms loading OpenAPI document",
      )
    } finally {
      stalled.stop(true)
    }
  })

  test("fetchOpenApi cuts a stalled body at the same deadline", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"paths":'))
              // Never enqueues again and never closes: headers arrived, the
              // body stalls far under any size bound.
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      await expect(fetchOpenApi({ url: String(server.url) }, 100)).rejects.toThrow(
        "Timed out after 100ms loading OpenAPI document",
      )
    } finally {
      server.stop(true)
    }
  })

  test("fetchOpenApi returns the spec from a healthy server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ paths: { "/api/session": { get: { operationId: "session.list" } } } }),
    })
    try {
      await expect(fetchOpenApi({ url: String(server.url) }, 5_000)).resolves.toEqual({
        paths: { "/api/session": { get: { operationId: "session.list" } } },
      })
    } finally {
      server.stop(true)
    }
  })

  test("fetchApi cuts a header stall at the deadline with a named timeout error", async () => {
    const stalled = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      await expect(
        fetchApi({ url: String(stalled.url) }, { method: "GET", path: "/api/session" }, new Headers(), undefined, 100),
      ).rejects.toThrow("Timed out after 100ms waiting for GET /api/session")
    } finally {
      stalled.stop(true)
    }
  })

  test("fetchApi cuts a stalled body at the same deadline", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first chunk"))
              // Never enqueues again and never closes.
            },
          }),
        )
      },
    })
    try {
      await expect(
        fetchApi({ url: String(server.url) }, { method: "GET", path: "/api/session" }, new Headers(), undefined, 100),
      ).rejects.toThrow("Timed out after 100ms waiting for GET /api/session")
    } finally {
      server.stop(true)
    }
  })

  test("fetchApi returns the body from a healthy server", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("hello") })
    try {
      const { response, output } = await fetchApi(
        { url: String(server.url) },
        { method: "GET", path: "/api/session" },
        new Headers(),
        undefined,
        5_000,
      )
      expect(response.ok).toBe(true)
      expect(output).toBe("hello")
    } finally {
      server.stop(true)
    }
  })
})
