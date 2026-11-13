import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { CodeModeWeb } from "@opencode/core/codemode/web"

// The header/size suites below exercise response handling against real loopback servers; the
// outbound-network policy (#2310) denies loopback by default, so those suites opt in through the
// policy's explicit host-operator escape hatch. The policy suite at the bottom removes it again.
process.env[CodeModeWeb.ALLOW_PRIVATE_NETWORK_ENV] = "1"

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

  test("a 304 response is not rejected by the declared-size check", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(304, { "content-length": String(CodeModeWeb.MAX_RESPONSE_BYTES + 1) })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      const response = await webFetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(304)
      expect(response.headers.get("content-length")).toBe(String(CodeModeWeb.MAX_RESPONSE_BYTES + 1))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("CodeModeWeb fetch outbound-network policy (#2310)", () => {
  const withoutOptIn = async (run: () => Promise<void>) => {
    delete process.env[CodeModeWeb.ALLOW_PRIVATE_NETWORK_ENV]
    try {
      await run()
    } finally {
      process.env[CodeModeWeb.ALLOW_PRIVATE_NETWORK_ENV] = "1"
    }
  }

  test("address classification follows the public / special-range boundary", () => {
    // Oracle: the IANA special-purpose registries — only global unicast is public.
    for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(CodeModeWeb.isPublicIPAddress(address)).toBe(true)
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "192.0.2.1",
      "203.0.113.9",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
      "2002:7f00:0001::",
      "not-an-ip",
    ]) {
      expect(CodeModeWeb.isPublicIPAddress(address)).toBe(false)
    }
  })

  test("a direct loopback request is denied before the server is contacted", async () => {
    await withoutOptIn(async () => {
      let hits = 0
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          hits++
          return new Response("secret")
        },
      })
      try {
        await expect(webFetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow("denied")
        expect(hits).toBe(0)
      } finally {
        server.stop(true)
      }
    })
  })

  test("private, link-local and localhost destinations are denied without any request", async () => {
    await withoutOptIn(async () => {
      for (const url of [
        "http://192.168.1.1/",
        "http://10.0.0.5/",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/",
        "http://localhost/",
        "http://service.localhost/",
      ]) {
        await expect(webFetch(url)).rejects.toThrow("denied")
      }
    })
  })

  test("a redirect from a public URL to a private destination is stopped at the hop", async () => {
    await withoutOptIn(async () => {
      const requested: Array<string> = []
      const original = globalThis.fetch
      globalThis.fetch = (async (input: unknown) => {
        requested.push(String(input))
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/secret" } })
      }) as typeof fetch
      try {
        await expect(webFetch("http://93.184.216.34/start")).rejects.toThrow("denied")
        // The public start was requested once; the private hop was never requested.
        expect(requested).toEqual(["http://93.184.216.34/start"])
      } finally {
        globalThis.fetch = original
      }
    })
  })

  test("public destinations and public-to-public redirects still work", async () => {
    await withoutOptIn(async () => {
      const requested: Array<string> = []
      const original = globalThis.fetch
      globalThis.fetch = (async (input: unknown) => {
        requested.push(String(input))
        if (String(input).endsWith("/start")) {
          return new Response(null, { status: 302, headers: { location: "http://93.184.216.34/final" } })
        }
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
      }) as typeof fetch
      try {
        const response = (await webFetch("http://93.184.216.34/start")) as WebResponse & {
          url: string
          redirected: boolean
          text: () => Promise<string>
        }
        expect(response.status).toBe(200)
        expect(response.redirected).toBe(true)
        expect(response.url).toBe("http://93.184.216.34/final")
        expect(await response.text()).toBe("hello")
        expect(requested).toEqual(["http://93.184.216.34/start", "http://93.184.216.34/final"])
      } finally {
        globalThis.fetch = original
      }
    })
  })
})
