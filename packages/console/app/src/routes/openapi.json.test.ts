import { describe, expect, spyOn, test } from "bun:test"
import { GET, OPENAPI_FETCH_TIMEOUT_MS, OPENAPI_MAX_BYTES } from "./openapi.json"

const spec = { openapi: "3.1.0", info: { title: "OpenCode", version: "1.0.0" }, paths: {} }

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

async function errorResponse() {
  const response = await GET()
  if (!(response instanceof Response)) throw new Error("Expected an error response")
  return response
}

describe("openapi.json GET upstream bounds", () => {
  test("parses an in-bounds spec and passes the named timeout signal", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    let seenSignal: AbortSignal | null | undefined
    const fetcher = stubFetch(async (_input, init) => {
      seenSignal = init?.signal
      return Response.json(spec)
    })
    try {
      expect(await GET()).toEqual(spec)
      expect(timeout).toHaveBeenCalledWith(OPENAPI_FETCH_TIMEOUT_MS)
      expect(OPENAPI_FETCH_TIMEOUT_MS).toBe(8_000)
      expect(seenSignal).toBeInstanceOf(AbortSignal)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("returns an upstream error status without serving its body as the spec", async () => {
    const fetcher = stubFetch(async () => new Response("upstream error", { status: 503 }))
    try {
      const response = await errorResponse()
      expect(response).toBeInstanceOf(Response)
      expect(response.status).toBe(503)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("settles as 502 when the upstream fetch never resolves before the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"))
          if (init?.signal?.aborted) return abort()
          init?.signal?.addEventListener("abort", abort, { once: true })
        }),
    )
    try {
      const pending = GET()
      controller.abort()
      const response = await pending
      expect(response).toBeInstanceOf(Response)
      if (!(response instanceof Response)) throw new Error("Expected an error response")
      expect(response.status).toBe(502)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("settles as 502 when the upstream response body stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    let startedReading!: () => void
    const reading = new Promise<void>((resolve) => {
      startedReading = resolve
    })
    const fetcher = stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              startedReading()
              return new Promise<void>(() => {})
            },
          }),
        ),
    )
    try {
      const pending = GET()
      await reading
      controller.abort()
      const response = await pending
      expect(response).toBeInstanceOf(Response)
      if (!(response instanceof Response)) throw new Error("Expected an error response")
      expect(response.status).toBe(502)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("rejects a declared over-cap body before reading it", async () => {
    let cancelled = false
    const fetcher = stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-length": String(OPENAPI_MAX_BYTES + 1) } },
        ),
    )
    try {
      expect((await errorResponse()).status).toBe(502)
      expect(cancelled).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("rejects and cancels a streamed body that exceeds the cap", async () => {
    let cancelled = false
    const fetcher = stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(stream) {
              stream.enqueue(new Uint8Array(OPENAPI_MAX_BYTES + 1))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    try {
      expect((await errorResponse()).status).toBe(502)
      expect(cancelled).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })
})
