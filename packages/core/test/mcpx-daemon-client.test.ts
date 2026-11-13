import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"

// Regression coverage for #1023: the mcpx daemon client had no timeout and
// no response-body cap. A stub daemon serves a small response, an over-cap
// success body, an over-cap error body, and endpoints that accept the
// connection and never answer; callDaemon must bound all four.

const managed = [
  "MCPX_DAEMON_ENDPOINT",
  "MCPX_ENDPOINT",
  "MCPX_SOCKET",
  "MCPX_STATE_DIR",
  "OPENCODE_TEST_HOME",
] as const

let saved: Record<string, string | undefined> = {}
let server: http.Server
let originalEndpoint: string | undefined

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/small") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ pad: "x".repeat(McpxTool.daemonResponseMaxBytes) }))
      return
    }
    if (req.url === "/err") {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end("e".repeat(McpxTool.daemonErrorBodyMaxBytes * 2))
      return
    }
    // /hang and /v1/health accept the connection and never answer.
  })
  originalEndpoint = process.env.MCPX_DAEMON_ENDPOINT
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  if (originalEndpoint === undefined) delete process.env.MCPX_DAEMON_ENDPOINT
  else process.env.MCPX_DAEMON_ENDPOINT = originalEndpoint
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  saved = Object.fromEntries(managed.map((name) => [name, process.env[name]]))
  delete process.env.MCPX_ENDPOINT
  delete process.env.MCPX_SOCKET
  process.env.MCPX_STATE_DIR = "/nonexistent-mcpx-state"
})

afterEach(() => {
  for (const name of managed) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  McpxTool.resetDaemonEnsured()
})

describe("mcpx daemon client bounds", () => {
  test("small daemon responses are returned unchanged", async () => {
    expect(await McpxTool.callDaemon("/small")).toEqual({ status: "ok" })
  })

  test("an over-cap success body is rejected naming the path and the cap", async () => {
    const error = await McpxTool.callDaemon("/big").catch((caught) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("/big")
    expect(error.message).toContain(String(McpxTool.daemonResponseMaxBytes))
  })

  test("an over-cap error body is truncated instead of embedded whole in DaemonHTTPError", async () => {
    const error = await McpxTool.callDaemon("/err").catch((caught) => caught)
    expect(error).toBeInstanceOf(McpxTool.McpxSecrets.DaemonHTTPError)
    expect(error.status).toBe(500)
    expect(error.message).toContain("truncated")
    expect(error.message.length).toBeLessThan(1024)
  })

  // The injected timeout is 200ms; the elapsed bound is timing-sensitive by
  // design: 20x the injected timeout, yet far below the 120s production
  // default the call would take if the timeout were ignored.
  test("a daemon that never responds fails within the timeout, and not as unreachable", async () => {
    const started = Date.now()
    const error = await McpxTool.callDaemon("/hang", "GET", undefined, undefined, 200).catch((caught) => caught)
    // Not DaemonUnreachableError: the daemon may have received the request,
    // so mcpx_exec must not replay it through the CLI fallback.
    expect(error).toBeInstanceOf(McpxTool.McpxSecrets.DaemonTimeoutError)
    expect(error).not.toBeInstanceOf(McpxTool.McpxSecrets.DaemonUnreachableError)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  // ensureDaemon's health probe must observe its own short bound against a
  // silent daemon instead of blocking on the 120s default: with autostart
  // gated off (test process), ensureDaemon resolves right after the probe.
  test("ensureDaemon returns promptly when the daemon accepts but never answers health", async () => {
    process.env.OPENCODE_TEST_HOME = "/tmp/opencode-mcpx-client-test"
    const started = Date.now()
    await McpxTool.ensureDaemon()
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
