import { describe, expect, mock, test } from "bun:test"

// Mock the Resource module outright (the stats-proxy.test.ts pattern): the
// INFERENCE binding is a service-binding fetch, stubbed per test below.
let inferenceImpl: (request: Request, init?: RequestInit) => Promise<Response> = async () =>
  new Response(null, { status: 200 })

mock.module("@opencode/console-resource", () => ({
  Resource: {
    ConsoleMigration: { inferenceUrl: "https://inference.example.test" },
    INFERENCE: {
      fetch: (request: Request, init?: RequestInit) => inferenceImpl(request, init),
    },
  },
}))

const { proxyInference, INFERENCE_HEADERS_TIMEOUT_MS, INFERENCE_GENERATION_HEADERS_TIMEOUT_MS } =
  await import("./inference-proxy")

function request() {
  return new Request("https://opencode.ai/zen/v1/models", {
    headers: { authorization: "Bearer test-key" },
  })
}

function abortableRequest(signal: AbortSignal) {
  return new Request("https://opencode.ai/zen/v1/models", {
    headers: { authorization: "Bearer test-key" },
    signal,
  })
}

function generationRequest() {
  return new Request("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  })
}

async function readBody(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

describe("proxyInference headers deadline", () => {
  test(
    "settles as 503 when the upstream stalls before response headers",
    async () => {
      let seenSignal: AbortSignal | null | undefined
      inferenceImpl = async (_request, init) => {
        seenSignal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          const aborted = () => reject(new DOMException("aborted", "AbortError"))
          if (init?.signal?.aborted) return aborted()
          init?.signal?.addEventListener("abort", aborted)
        })
      }
      const started = Date.now()
      const response = await proxyInference(request())
      const elapsed = Date.now() - started
      expect(response.status).toBe(503)
      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect(seenSignal?.aborted).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(INFERENCE_HEADERS_TIMEOUT_MS - 250)
      expect(elapsed).toBeLessThan(INFERENCE_HEADERS_TIMEOUT_MS + 5_000)
      expect(await readBody(response)).toContain("Inference routing is unavailable")
    },
    INFERENCE_HEADERS_TIMEOUT_MS + 10_000,
  )

  test("settles as 503 when the upstream fetch rejects", async () => {
    inferenceImpl = async () => {
      throw new Error("upstream down")
    }
    const response = await proxyInference(request())
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test(
    "aborts the upstream fetch when the incoming request aborts before headers",
    async () => {
      let seenSignal: AbortSignal | null | undefined
      inferenceImpl = async (_request, init) => {
        seenSignal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          const aborted = () => reject(new DOMException("aborted", "AbortError"))
          if (init?.signal?.aborted) return aborted()
          init?.signal?.addEventListener("abort", aborted)
        })
      }
      const client = new AbortController()
      const started = Date.now()
      const pending = proxyInference(abortableRequest(client.signal))
      await new Promise((resolve) => setTimeout(resolve, 50))
      client.abort()
      const response = await pending
      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect(seenSignal?.aborted).toBe(true)
      expect(response.status).toBe(503)
      // The incoming abort, not the 8s headers deadline, settled the fetch.
      expect(Date.now() - started).toBeLessThan(INFERENCE_HEADERS_TIMEOUT_MS - 1_000)
    },
    INFERENCE_HEADERS_TIMEOUT_MS + 5_000,
  )

  test("proxies a healthy upstream response unchanged", async () => {
    inferenceImpl = async () =>
      new Response(`{"ok":true}`, { status: 200, headers: { "content-type": "application/json" } })
    const response = await proxyInference(request())
    expect(response.status).toBe(200)
    expect(await readBody(response)).toBe(`{"ok":true}`)
  })

  test("keeps the 404 to 400 rewrite for a healthy upstream", async () => {
    inferenceImpl = async () => new Response("no such model", { status: 404 })
    const response = await proxyInference(request())
    expect(response.status).toBe(400)
    expect(await readBody(response)).toBe("no such model")
  })

  test(
    "does not abort a non-streaming generation whose headers arrive past the lookup deadline",
    async () => {
      expect(INFERENCE_GENERATION_HEADERS_TIMEOUT_MS).toBeGreaterThan(INFERENCE_HEADERS_TIMEOUT_MS)
      inferenceImpl = async () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(`{"choices":[]}`, {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            INFERENCE_HEADERS_TIMEOUT_MS + 500,
          ),
        )
      const response = await proxyInference(generationRequest())
      expect(response.status).toBe(200)
      expect(await readBody(response)).toBe(`{"choices":[]}`)
    },
    INFERENCE_HEADERS_TIMEOUT_MS + 10_000,
  )

  test(
    "does not cut a streaming body that starts before the deadline",
    async () => {
      let delivered = false
      inferenceImpl = async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              if (delivered) return
              delivered = true
              stream.enqueue(new TextEncoder().encode("first-"))
              return new Promise<void>((resolve) =>
                setTimeout(() => {
                  stream.enqueue(new TextEncoder().encode("second"))
                  stream.close()
                  resolve()
                }, INFERENCE_HEADERS_TIMEOUT_MS + 500),
              )
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      const started = Date.now()
      const response = await proxyInference(request())
      expect(response.status).toBe(200)
      // Headers arrived immediately; the body finishes past the headers
      // deadline and must still arrive whole.
      expect(await readBody(response)).toBe("first-second")
      expect(Date.now() - started).toBeGreaterThanOrEqual(INFERENCE_HEADERS_TIMEOUT_MS)
    },
    INFERENCE_HEADERS_TIMEOUT_MS + 10_000,
  )
})
