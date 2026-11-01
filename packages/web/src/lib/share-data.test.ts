import { describe, expect, test } from "bun:test"
import { loadShareData, readBoundedShareDataText, SHARE_DATA_MAX_BYTES, SHARE_DATA_TIMEOUT_MS } from "./share-data"

const encode = (text: string) => new TextEncoder().encode(text)

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } })

describe("share-data bounds (#1179)", () => {
  test("constants are the triage-sized deadline and cap", () => {
    expect(SHARE_DATA_TIMEOUT_MS).toBe(8_000)
    expect(SHARE_DATA_MAX_BYTES).toBe(32 * 1024 * 1024)
  })

  test("a well-formed payload parses", async () => {
    const stub = serve(() => json({ info: { title: "t" }, messages: {} }))
    try {
      const result = await loadShareData(stub.url, "abc")
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.data.info as { title: string }).title).toBe("t")
    } finally {
      stub.stop()
    }
  })

  test("a real-shaped payload at p90 measured size (2,526,732 B) parses under the real cap", async () => {
    const filler = "x".repeat(2_526_732)
    const stub = serve(() => json({ info: { title: "t" }, messages: { m1: { role: "assistant", text: filler } } }))
    try {
      const result = await loadShareData(stub.url, "abc")
      expect(result.ok).toBe(true)
    } finally {
      stub.stop()
    }
  })

  test("stall before headers is cut by the deadline with a controlled 502", async () => {
    const stub = serve(() => new Promise<Response>(() => {}))
    try {
      const start = Date.now()
      const result = await loadShareData(stub.url, "abc", { timeoutMs: 300 })
      expect(Date.now() - start).toBeLessThan(5_000)
      expect(result).toMatchObject({ ok: false, status: 502 })
      if (!result.ok) expect(result.message).toContain("deadline")
    } finally {
      stub.stop()
    }
  })

  test("slow-drip body is cut by the deadline with a controlled 502", async () => {
    const stub = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encode('{"info":'))
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )
    try {
      const start = Date.now()
      const result = await loadShareData(stub.url, "abc", { timeoutMs: 300 })
      expect(Date.now() - start).toBeLessThan(5_000)
      expect(result).toMatchObject({ ok: false, status: 502 })
      if (!result.ok) expect(result.message).toContain("deadline")
    } finally {
      stub.stop()
    }
  })

  test("declared content-length over the cap refuses with a controlled 502 naming the cap", async () => {
    // A body whose real (hence declared) length is over the cap: the reader's
    // declared-length pre-check refuses it before any JSON parse is attempted.
    const stub = serve(
      () =>
        new Response("x".repeat(2048), {
          headers: { "content-type": "application/json" },
        }),
    )
    try {
      const result = await loadShareData(stub.url, "abc", { maxBytes: 1024 })
      expect(result).toMatchObject({ ok: false, status: 502 })
      if (!result.ok) expect(result.message).toContain("SHARE_DATA_MAX_BYTES")
    } finally {
      stub.stop()
    }
  })

  test("reader declared-length pre-check refuses before pulling any chunk and cancels", async () => {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(encode("small"))
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const response = {
      headers: new Headers({ "content-length": "2048" }),
      body: stream,
      text: async () => "",
    } as unknown as Response
    await expect(readBoundedShareDataText(response, 1024)).rejects.toThrow("SHARE_DATA_MAX_BYTES")
    expect(pulls).toBe(0)
    expect(cancelled).toBe(true)
  })

  test("chunked body over the cap refuses in flight with a controlled 502 naming the cap", async () => {
    const chunk = new Uint8Array(512).fill(97)
    const stub = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk)
              controller.enqueue(chunk)
              controller.enqueue(chunk)
              controller.close()
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )
    try {
      const result = await loadShareData(stub.url, "abc", { maxBytes: 1024 })
      expect(result).toMatchObject({ ok: false, status: 502 })
      if (!result.ok) expect(result.message).toContain("SHARE_DATA_MAX_BYTES")
    } finally {
      stub.stop()
    }
  })

  test("non-JSON body is a controlled 502, not a throw", async () => {
    const stub = serve(() => new Response("not json", { headers: { "content-type": "application/json" } }))
    try {
      const result = await loadShareData(stub.url, "abc")
      expect(result).toMatchObject({ ok: false, status: 502 })
      if (!result.ok) expect(result.message).toContain("non-JSON")
    } finally {
      stub.stop()
    }
  })

  test("non-OK upstream status is a controlled 502 naming the status", async () => {
    const stub = serve(() => new Response("boom", { status: 500 }))
    try {
      const result = await loadShareData(stub.url, "abc")
      expect(result).toMatchObject({ ok: false, status: 502 })
      if (!result.ok) expect(result.message).toContain("500")
    } finally {
      stub.stop()
    }
  })

  test("upstream 404 keeps the existing 404 semantic", async () => {
    const stub = serve(() => new Response("missing", { status: 404 }))
    try {
      const result = await loadShareData(stub.url, "abc")
      expect(result).toMatchObject({ ok: false, status: 404 })
    } finally {
      stub.stop()
    }
  })
})
