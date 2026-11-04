import { describe, expect, spyOn, test } from "bun:test"

// @opencode/console-resource is provided by the shared preload fixture (test/preload.ts, #1522).

const { statsProxy, STATS_HTML_MAX_BYTES } = await import("./stats-proxy")

const puts: Array<unknown> = []
const fakeCache = {
  match: async () => undefined,
  put: async (key: unknown, value: unknown) => {
    puts.push([key, value])
  },
}
Object.assign(globalThis, { caches: { default: fakeCache } })

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

function event() {
  return {
    request: new Request("https://opencode.ai/data", { headers: { accept: "text/html" } }),
  } as Parameters<typeof statsProxy>[0]
}

function htmlResponse(body: BodyInit, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } })
}

describe("statsProxy upstream bounds", () => {
  test("settles as 502 when the upstream stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const aborted = () => reject(new DOMException("aborted", "AbortError"))
          // Like real fetch: an already-aborted signal rejects immediately.
          if (init?.signal?.aborted) return aborted()
          init?.signal?.addEventListener("abort", aborted)
        }),
    )
    try {
      const pending = statsProxy(event())
      controller.abort()
      expect((await pending).status).toBe(502)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("settles as 502 and cancels a declared over-cap HTML body before reading it", async () => {
    let cancelled = false
    const fetcher = stubFetch(async () =>
      htmlResponse(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
        { "content-length": String(STATS_HTML_MAX_BYTES + 1) },
      ),
    )
    try {
      puts.length = 0
      expect((await statsProxy(event())).status).toBe(502)
      expect(cancelled).toBe(true)
      expect(puts).toHaveLength(0)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("settles as 502 and cancels a streamed over-cap HTML body", async () => {
    let cancelled = false
    const chunk = new Uint8Array(STATS_HTML_MAX_BYTES)
    const fetcher = stubFetch(async () =>
      htmlResponse(
        new ReadableStream({
          pull(stream) {
            stream.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
    try {
      puts.length = 0
      expect((await statsProxy(event())).status).toBe(502)
      expect(cancelled).toBe(true)
      expect(puts).toHaveLength(0)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("rewrites and caches in-bounds HTML as before", async () => {
    const fetcher = stubFetch(async () => htmlResponse(`<script src="/_build/app.js"></script>`))
    try {
      puts.length = 0
      const response = await statsProxy(event())
      expect(response.status).toBe(200)
      expect(response.headers.get("x-opencode-stats-cache")).toBe("MISS")
      expect(await response.text()).toContain(`"/data/_build/app.js"`)
      expect(puts).toHaveLength(1)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("streams non-HTML responses through untouched", async () => {
    const fetcher = stubFetch(async () =>
      new Response(`{"ok":true}`, { headers: { "content-type": "application/json" } }),
    )
    try {
      const response = await statsProxy(event())
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(`{"ok":true}`)
    } finally {
      fetcher.mockRestore()
    }
  })
})
