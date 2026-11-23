import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "path"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"

// Regression coverage for #2642: ensureDaemon latches once at plugin init,
// but a daemon opencode spawns exits after an idle hour by design (#14), so
// projected tools in a long-lived session failed outright for the rest of
// the process — they have no CLI fallback. callDaemonWithRecovery, the
// caller the projection paths now receive, re-ensures once on
// DaemonUnreachableError (the failure that proves the daemon never received
// the request) and retries the call; recovery is throttled and stays behind
// the same autostart gates as plugin init.

const managed = [
  "MCPX_DAEMON_ENDPOINT",
  "MCPX_ENDPOINT",
  "MCPX_SOCKET",
  "MCPX_STATE_DIR",
  "OPENCODE_TEST_HOME",
  "OPENCODE_MCPX_BIN",
  "OPENCODE_MCPX_DAEMON",
  "FAKE_MCPX_RECORD",
] as const

let saved: Record<string, string | undefined> = {}
let dir: string
let record: string
let stub: { server: http.Server; hits: { health: number; call: number; hang: number }; close: () => Promise<void> } | undefined

beforeEach(async () => {
  saved = Object.fromEntries(managed.map((name) => [name, process.env[name]]))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcpx-recovery-"))
  record = path.join(dir, "record.txt")
  // No socket discovery: endpoint routing only.
  process.env.MCPX_STATE_DIR = path.join(dir, "state")
  delete process.env.MCPX_ENDPOINT
  delete process.env.MCPX_SOCKET
  delete process.env.OPENCODE_MCPX_DAEMON
  McpxTool.resetDaemonEnsured()
})

afterEach(async () => {
  if (stub) {
    await stub.close()
    stub = undefined
  }
  // Kill any fake daemon the recovery path spawned.
  try {
    const text = await fs.readFile(record, "utf-8")
    for (const line of text.split("\n")) {
      const pid = Number(line.replace("spawn:", ""))
      if (line.startsWith("spawn:") && pid > 0) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
      }
    }
  } catch {}
  for (const name of managed) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  McpxTool.resetDaemonEnsured()
  await fs.rm(dir, { recursive: true, force: true })
})

const spawnCount = async (): Promise<number> => {
  try {
    const text = await fs.readFile(record, "utf-8")
    return text.split("\n").filter((line) => line.startsWith("spawn:")).length
  } catch {
    return 0
  }
}

const startStub = async (result: string, port = 0): Promise<{ port: number }> => {
  const hits = { health: 0, call: 0, hang: 0 }
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/health") {
      hits.health++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (req.url === "/v1/call") {
      hits.call++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result }))
      return
    }
    if (req.url === "/hang") {
      hits.hang++
      return // accepts the connection and never answers
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  stub = {
    server,
    hits,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  return { port: (server.address() as AddressInfo).port }
}

const freePort = async (): Promise<number> => {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// A fake mcpx binary: `settings get daemon.autostart` prints the given
// value; a `daemon` spawn records itself and (for the serving variant)
// answers health/call on the endpoint port like a real daemon.
const writeFakeMcpx = async (options: { autostart: boolean; serve: boolean }): Promise<void> => {
  const bin = path.join(dir, "mcpx")
  const lines = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs")',
    "const args = process.argv.slice(2)",
    'if (args[0] === "settings") {',
    `  process.stdout.write("daemon.autostart = ${options.autostart}\\n")`,
    "  process.exit(0)",
    "}",
    'if (args[0] === "daemon") {',
    '  fs.appendFileSync(process.env.FAKE_MCPX_RECORD, "spawn:" + process.pid + "\\n")',
    ...(options.serve
      ? [
          '  const http = require("node:http")',
          "  const port = Number(new URL(process.env.MCPX_DAEMON_ENDPOINT).port)",
          "  const server = http.createServer((req, res) => {",
          '    res.writeHead(200, { "content-type": "application/json" })',
          '    if (req.url === "/v1/health") return res.end(JSON.stringify({ status: "ok" }))',
          '    if (req.url === "/v1/call") return res.end(JSON.stringify({ result: "recovered" }))',
          '    res.end("{}")',
          "  })",
          "  let attempts = 0",
          '  server.on("error", () => {',
          "    if (++attempts <= 20) setTimeout(() => server.listen(port, \"127.0.0.1\"), 100)",
          "  })",
          '  server.listen(port, "127.0.0.1")',
          "  setTimeout(() => process.exit(0), 60000)",
        ]
      : ["  process.exit(0)"]),
    "}",
    "",
  ]
  await fs.writeFile(bin, lines.join("\n"), { mode: 0o755 })
  process.env.OPENCODE_MCPX_BIN = bin
  process.env.FAKE_MCPX_RECORD = record
}

describe("mcpx daemon mid-session recovery", () => {
  test("a projected call recovers when the daemon dies after init", async () => {
    const { port } = await startStub("stub")
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`
    delete process.env.OPENCODE_TEST_HOME
    await writeFakeMcpx({ autostart: true, serve: true })

    await McpxTool.ensureDaemon()
    expect(stub!.hits.health).toBe(1)

    // The daemon exits (idle exit / crash / supervisor restart).
    await stub!.close()
    stub = undefined

    const res = await McpxTool.callDaemonWithRecovery("/v1/call", "POST", { server: "s", tool: "t", arguments: {} })
    expect(res).toEqual({ result: "recovered" })
    expect(await spawnCount()).toBe(1)

    // The latch re-armed behind the new daemon: the next call goes straight
    // through, with no second spawn.
    const again = await McpxTool.callDaemonWithRecovery("/v1/call", "POST", { server: "s", tool: "t", arguments: {} })
    expect(again).toEqual({ result: "recovered" })
    expect(await spawnCount()).toBe(1)
  })

  test("a daemon that stays dead fails promptly and recovery does not stampede", async () => {
    const port = await freePort()
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`
    delete process.env.OPENCODE_TEST_HOME
    await writeFakeMcpx({ autostart: true, serve: false })

    const first = await McpxTool.callDaemonWithRecovery("/v1/call", "POST", {}).catch((caught) => caught)
    expect(first).toBeInstanceOf(McpxTool.McpxSecrets.DaemonUnreachableError)
    expect(await spawnCount()).toBe(1)

    // The throttle keeps the immediate retry from re-running the whole
    // ensure (whose spawn poll alone takes ~1.5s) on every failing call.
    const started = Date.now()
    const second = await McpxTool.callDaemonWithRecovery("/v1/call", "POST", {}).catch((caught) => caught)
    expect(second).toBeInstanceOf(McpxTool.McpxSecrets.DaemonUnreachableError)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(await spawnCount()).toBe(1)
  })

  test("a timeout is never replayed and triggers no recovery", async () => {
    const { port } = await startStub("stub")
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`
    delete process.env.OPENCODE_TEST_HOME
    await writeFakeMcpx({ autostart: true, serve: true })

    const error = await McpxTool.callDaemonWithRecovery("/hang", "GET", undefined, undefined, 200).catch(
      (caught) => caught,
    )
    // The request may already be executing: no re-ensure, no retry, no spawn.
    expect(error).toBeInstanceOf(McpxTool.McpxSecrets.DaemonTimeoutError)
    expect(stub!.hits.hang).toBe(1)
    expect(await spawnCount()).toBe(0)
  })

  test("recovery does not spawn when opencode-side autostart is off", async () => {
    const port = await freePort()
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`
    process.env.OPENCODE_TEST_HOME = dir
    await writeFakeMcpx({ autostart: true, serve: true })

    const error = await McpxTool.callDaemonWithRecovery("/v1/call", "POST", {}).catch((caught) => caught)
    expect(error).toBeInstanceOf(McpxTool.McpxSecrets.DaemonUnreachableError)
    expect(await spawnCount()).toBe(0)
  })

  test("recovery does not spawn when mcpx's daemon.autostart setting is off", async () => {
    const port = await freePort()
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`
    delete process.env.OPENCODE_TEST_HOME
    await writeFakeMcpx({ autostart: false, serve: true })

    const error = await McpxTool.callDaemonWithRecovery("/v1/call", "POST", {}).catch((caught) => caught)
    expect(error).toBeInstanceOf(McpxTool.McpxSecrets.DaemonUnreachableError)
    expect(await spawnCount()).toBe(0)
  })

  test("a healthy daemon is not re-probed on every call", async () => {
    const { port } = await startStub("stub")
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${port}`

    await McpxTool.ensureDaemon()
    expect(stub!.hits.health).toBe(1)

    expect(await McpxTool.callDaemonWithRecovery("/v1/call", "POST", {})).toEqual({ result: "stub" })
    expect(await McpxTool.callDaemonWithRecovery("/v1/call", "POST", {})).toEqual({ result: "stub" })
    expect(stub!.hits.health).toBe(1)
    expect(stub!.hits.call).toBe(2)
  })
})
