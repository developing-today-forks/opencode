import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { CodeModeNetwork } from "@opencode/core/codemode/network"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { permissionService } from "../lib/permission"

const context = {
  sessionID: Session.ID.make("ses_network"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_network"),
  id: Tool.CallID.make("call_network"),
  progress: () => Effect.void,
}

const allowAll = permissionService({ assert: () => Effect.void, assertNotDenied: () => Effect.void })

// Runs a program through Code Mode's own fetch global and returns what it returned, or the message it threw.
const program = async (code: string) => {
  const codeMode = CodeModeTool.create({ tools: new Map() }, (_, tool, input, ctx) => execute(tool, input, ctx), allowAll)
  const result = await Effect.runPromise(
    codeMode.execute(
      { code: `try { return JSON.stringify(await (async () => { ${code} })()) } catch (e) { return JSON.stringify("error: " + e.message) }` },
      context,
    ),
  )
  // Code Mode returns a string result as is, so the program serializes its own value.
  return JSON.parse(result.output.output) as unknown
}

const withOptIn = () => {
  beforeEach(() => {
    process.env[CodeModeNetwork.ALLOW_PRIVATE_NETWORK_ENV] = "1"
  })
  afterEach(() => {
    delete process.env[CodeModeNetwork.ALLOW_PRIVATE_NETWORK_ENV]
  })
}

describe("Code Mode fetch outbound-network policy (#2310)", () => {
  beforeEach(() => {
    delete process.env[CodeModeNetwork.ALLOW_PRIVATE_NETWORK_ENV]
  })

  test("address classification follows the public / special-range boundary", () => {
    // Oracle: the IANA special-purpose registries — only global unicast is public.
    for (const address of [
      "8.8.8.8",
      "93.184.216.34",
      "1.1.1.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ]) {
      expect(CodeModeNetwork.isPublicIPAddress(address)).toBe(true)
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
      expect(CodeModeNetwork.isPublicIPAddress(address)).toBe(false)
    }
  })

  test("a direct loopback request is denied before the server is contacted", async () => {
    let hits = 0
    await using server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return new Response("secret")
      },
    })
    expect(await program(`return await (await fetch("http://127.0.0.1:${server.port}/")).text()`)).toContain(
      "denied",
    )
    expect(hits).toBe(0)
  })

  test("private, link-local and localhost destinations are denied without any request", async () => {
    for (const url of [
      "http://192.168.1.1/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://localhost/",
      "http://service.localhost/",
    ]) {
      await expect(CodeModeNetwork.assertPublicDestination(new URL(url))).rejects.toThrow("denied")
    }
  })

  test("a redirect from a public URL to a private destination is stopped at the hop", async () => {
    const requested: Array<string> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input))
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/secret" } })
    }) as unknown as typeof fetch
    try {
      expect(await program(`return await (await fetch("http://93.184.216.34/start")).text()`)).toContain("denied")
      // The public start was requested once; the private hop was never requested.
      expect(requested).toEqual(["http://93.184.216.34/start"])
    } finally {
      globalThis.fetch = original
    }
  })

  test("public destinations and public-to-public redirects still work", async () => {
    const requested: Array<string> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input))
      if (String(input).endsWith("/start"))
        return new Response(null, { status: 302, headers: { location: "http://93.184.216.34/final" } })
      return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
    }) as unknown as typeof fetch
    try {
      expect(
        await program(
          `const res = await fetch("http://93.184.216.34/start"); return [res.status, res.redirected, await res.text()]`,
        ),
      ).toEqual([200, true, "hello"])
      expect(requested).toEqual(["http://93.184.216.34/start", "http://93.184.216.34/final"])
    } finally {
      globalThis.fetch = original
    }
  })

  describe("with the host-operator opt-in", () => {
    withOptIn()

    test("loopback destinations are reachable", async () => {
      await using server = Bun.serve({ port: 0, fetch: () => new Response("local") })
      expect(await program(`return await (await fetch("http://127.0.0.1:${server.port}/")).text()`)).toBe("local")
    })
  })
})

describe("Code Mode fetch response size cap (#923)", () => {
  withOptIn()

  test("rejects a declared or streamed body over the cap and serves a normal body unchanged", async () => {
    await using big = Bun.serve({
      port: 0,
      fetch: () => new Response("x".repeat(CodeModeNetwork.MAX_RESPONSE_BYTES + 1)),
    })
    expect(await program(`return (await (await fetch("http://127.0.0.1:${big.port}/")).text()).length`)).toContain(
      "Response too large",
    )

    await using streamed = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(CodeModeNetwork.MAX_RESPONSE_BYTES))
              controller.enqueue(new Uint8Array(1))
              controller.close()
            },
          }),
        ),
    })
    expect(
      await program(`return (await (await fetch("http://127.0.0.1:${streamed.port}/")).bytes()).length`),
    ).toContain("Response too large")

    await using small = Bun.serve({ port: 0, fetch: () => new Response("hello") })
    expect(await program(`return await (await fetch("http://127.0.0.1:${small.port}/")).text()`)).toBe("hello")
  })

  test("a declared over-cap rejection cancels the response body", async () => {
    // A raw HTTP server declares an over-cap length, sends one chunk and never ends, so its response can only close
    // early if the client cancels the download. Bun.serve would rewrite content-length to the real body size.
    let closed = false
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(CodeModeNetwork.MAX_RESPONSE_BYTES + 1),
      })
      response.write(new Uint8Array(1024))
      response.on("close", () => {
        closed = true
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      expect(await program(`return (await fetch("http://127.0.0.1:${port}/large")).status`)).toContain(
        "Response too large",
      )
      const deadline = Date.now() + 2_000
      while (!closed && Date.now() < deadline) await Bun.sleep(10)
      expect(closed).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("HEAD and 304 responses are not rejected by the declared-size check", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.method === "HEAD" ? 200 : 304, {
        "content-length": String(CodeModeNetwork.MAX_RESPONSE_BYTES + 1),
      })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      expect(
        await program(
          `const head = await fetch("http://127.0.0.1:${port}/", { method: "HEAD" }); const cached = await fetch("http://127.0.0.1:${port}/"); return [head.status, cached.status]`,
        ),
      ).toEqual([200, 304])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
