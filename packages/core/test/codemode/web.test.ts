import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { CodeModeWeb } from "@opencode/core/codemode/web"

type WebResponse = {
  readonly status: number
  readonly headers: {
    get: (name: string) => string | null
    has: (name: string) => boolean
    entries: () => Array<[string, string]>
  }
}

const webFetch = CodeModeWeb.extension.globals.fetch as (input: string) => Promise<WebResponse>
const webFetchWithInit = CodeModeWeb.extension.globals.fetch as (
  input: string,
  init: { method: string },
) => Promise<WebResponse>

const serve = (headers: Record<string, string>) => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("hello", { headers }) })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

describe("CodeModeWeb fetch response headers (#805)", () => {
  test("absent prototype-named headers read as null / false, not inherited members", async () => {
    const server = serve({ "content-type": "text/plain", "x-real": "yes" })
    try {
      const response = await webFetch(server.url)
      expect(response.status).toBe(200)
      // Regression: the headers record is a plain object, so a bare index / `in`
      // resolved "constructor" to the Object function and "__proto__" to
      // Object.prototype even though the server never sent them.
      expect(response.headers.get("constructor")).toBeNull()
      expect(response.headers.has("constructor")).toBe(false)
      expect(response.headers.get("__proto__")).toBeNull()
      expect(response.headers.has("__proto__")).toBe(false)
      // Present and ordinary absent headers behave as before.
      expect(response.headers.get("x-real")).toBe("yes")
      expect(response.headers.has("X-Real")).toBe(true)
      expect(response.headers.get("content-type")).toContain("text/plain")
      expect(response.headers.get("x-absent")).toBeNull()
      expect(response.headers.has("x-absent")).toBe(false)
      expect(response.headers.entries()).toContainEqual(["x-real", "yes"])
    } finally {
      server.stop()
    }
  })

  test("a header actually sent under a prototype name still resolves", async () => {
    const server = serve({ constructor: "sent-value" })
    try {
      const response = await webFetch(server.url)
      expect(response.headers.get("constructor")).toBe("sent-value")
      expect(response.headers.has("constructor")).toBe(true)
    } finally {
      server.stop()
    }
  })
})

describe("CodeModeWeb fetch response size cap (#923)", () => {
  test("rejects a body over the cap and serves a normal body unchanged", async () => {
    const big = Bun.serve({
      port: 0,
      fetch: () => new Response("x".repeat(CodeModeWeb.MAX_RESPONSE_BYTES + 1)),
    })
    try {
      await expect(webFetch(`http://127.0.0.1:${big.port}/`)).rejects.toThrow("Response too large")
    } finally {
      big.stop(true)
    }

    const streamed = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(CodeModeWeb.MAX_RESPONSE_BYTES + 1))
              controller.close()
            },
          }),
        ),
    })
    try {
      await expect(webFetch(`http://127.0.0.1:${streamed.port}/`)).rejects.toThrow("Response too large")
    } finally {
      streamed.stop(true)
    }

    const server = serve({ "content-type": "text/plain" })
    try {
      const response = await webFetch(server.url)
      expect(response.status).toBe(200)
    } finally {
      server.stop()
    }
  })

  test("a declared over-cap rejection cancels the response body", async () => {
    // Regression (Codex review on #926): rejecting on the declared size without cancelling
    // left the oversized download running in the background until completion/timeout.
    // Exercised against a real local server (no global fetch replacement): the server
    // declares an over-cap length, sends one chunk, and never ends, so its response can
    // only close early if the client cancels the download. A raw HTTP server is used
    // because Bun.serve rewrites content-length to the real body size.
    let closed = false
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(CodeModeWeb.MAX_RESPONSE_BYTES + 1),
      })
      response.write(new Uint8Array(1024))
      response.on("close", () => {
        closed = true
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      await expect(webFetch(`http://127.0.0.1:${port}/large`)).rejects.toThrow("Response too large")
      const deadline = Date.now() + 2_000
      while (!closed && Date.now() < deadline) await Bun.sleep(10)
      expect(closed).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("a HEAD response is not rejected by the declared-size check", async () => {
    // HEAD carries the GET representation's content-length but no body, so the declared-size
    // pre-check must not reject a HEAD for a resource larger than the cap.
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        request.method === "HEAD"
          ? new Response(null, { headers: { "content-length": String(CodeModeWeb.MAX_RESPONSE_BYTES + 1) } })
          : new Response("x".repeat(CodeModeWeb.MAX_RESPONSE_BYTES + 1)),
    })
    try {
      const response = await webFetchWithInit(`http://127.0.0.1:${server.port}/`, { method: "HEAD" })
      expect(response.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })
})
