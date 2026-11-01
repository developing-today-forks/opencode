import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { readBoundedResponseBody } from "../src/util/io"
import { OPENCODE_VERSION } from "../src/version"

const info = {
  id: "ses_export_test",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Exported session",
  location: { directory: "/project" },
}
const transfer = {
  info,
  messages: [
    { id: "msg_first", type: "user", text: "First", time: { created: 1 } },
    { id: "msg_second", type: "user", text: "Second", time: { created: 2 } },
  ],
}
const sanitizedTransfer = {
  info: {
    ...info,
    title: "[redacted:session-title:ses_export_test]",
    location: { directory: "/[redacted:session-directory:ses_export_test]" },
  },
  messages: [
    {
      id: "msg_first",
      type: "user",
      text: "[redacted:text:msg_first]",
      time: { created: 1 },
    },
    {
      id: "msg_second",
      type: "user",
      text: "[redacted:text:msg_second]",
      time: { created: 2 },
    },
  ],
}

const status = () =>
  Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp/opencode" } })

function run(args: string[], stdin?: string) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    stdin: stdin === undefined ? undefined : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
}

test("export is raw by default and supports explicit sanitization", async () => {
  const sanitization: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") return status()
      if (url.pathname === `/api/session/${info.id}`) return Response.json({ data: info })
      if (url.pathname === `/api/experimental/session/${info.id}/export`) {
        sanitization.push(url.searchParams.get("sanitize") ?? "")
        return Response.json({ data: url.searchParams.get("sanitize") === "true" ? sanitizedTransfer : transfer })
      }
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, , exitCode] = await run(["session", "export", info.id, "--server", server.url.toString()])
    const exported = JSON.parse(stdout)

    expect(exitCode).toBe(0)
    expect(exported).toEqual(transfer)

    const [sanitized, , sanitizedExitCode] = await run([
      "session",
      "export",
      info.id,
      "--sanitize",
      "--server",
      server.url.toString(),
    ])
    expect(sanitizedExitCode).toBe(0)
    expect(JSON.parse(sanitized)).toEqual(sanitizedTransfer)
    expect(sanitization).toEqual(["false", "true"])
  } finally {
    await server.stop(true)
  }
}, 15_000)

test("export requires a session outside an interactive terminal", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") return status()
      if (url.pathname === "/api/location") {
        return Response.json({
          directory: "/project",
          project: { id: "global", directory: "/project", canonical: "/project" },
        })
      }
      if (url.pathname === "/api/session") return Response.json({ data: [], cursor: {} })
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, stderr, exitCode] = await run(["session", "export", "--server", server.url.toString()])

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toBe(`Pass a session ID when running without an interactive terminal${os.EOL}`)
  } finally {
    await server.stop(true)
  }
})

test("export reports a missing session without a stack trace", async () => {
  const sessionID = "ses_missing"
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") return status()
      if (url.pathname === `/api/experimental/session/${sessionID}/export`) {
        return Response.json(
          { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` },
          { status: 404 },
        )
      }
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, stderr, exitCode] = await run(["session", "export", sessionID, "--server", server.url.toString()])

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toBe(`Session not found: ${sessionID}${os.EOL}`)
  } finally {
    await server.stop(true)
  }
})

test("import validates a file and sends it to the resolved location", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-import-"))
  const file = path.join(root, "session.json")
  await fs.writeFile(file, JSON.stringify(transfer))
  let imported: unknown
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") return status()
      if (url.pathname === "/api/location") {
        return Response.json({
          directory: root,
          project: { id: "global", directory: root, canonical: root },
        })
      }
      if (url.pathname === "/api/experimental/session/import") {
        imported = await request.json()
        return Response.json({ data: { ...info, location: { directory: root } } })
      }
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, , exitCode] = await run([
      "session",
      "import",
      file,
      "--directory",
      root,
      "--server",
      server.url.toString(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBe(`Imported session: ${info.id}${os.EOL}`)
    expect(imported).toEqual({ ...transfer, location: { directory: root } })
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("import reports an existing session without a stack trace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-import-conflict-"))
  const file = path.join(root, "session.json")
  await fs.writeFile(file, JSON.stringify(transfer))
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") return status()
      if (url.pathname === "/api/location") {
        return Response.json({
          directory: root,
          project: { id: "global", directory: root, canonical: root },
        })
      }
      if (url.pathname === "/api/experimental/session/import") return new Response("Conflict", { status: 409 })
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, stderr, exitCode] = await run(["session", "import", file, "--server", server.url.toString()])

    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe(`Session already exists${os.EOL}`)
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("readBoundedResponseBody returns a body under the cap and cuts a chunked body over it", async () => {
  const encoder = new TextEncoder()
  const chunked = (chunks: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
    )

  await expect(readBoundedResponseBody(chunked(["hello ", "world"]), 1024)).resolves.toBe("hello world")
  // A UTF-8 BOM is stripped, matching the previous response.text() behaviour.
  await expect(readBoundedResponseBody(chunked(["\uFEFFhello"]), 1024)).resolves.toBe("hello")
  await expect(readBoundedResponseBody(chunked(["12345", "67890"]), 8)).rejects.toThrow(
    "Session data too large: response body exceeds the 8-byte limit",
  )
})

test("import rejects a remote body whose declared content-length is over the cap without reading it", async () => {
  // A raw HTTP stub, because Bun.serve rewrites content-length to the real
  // body size: this declares far over the cap and never sends a body, so
  // the import can only fail via the pre-read content-length check.
  const maximumBytes = 256 * 1024 * 1024
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(maximumBytes + 1),
    })
    response.flushHeaders()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  try {
    const [stdout, stderr, exitCode] = await run([
      "session",
      "import",
      `http://127.0.0.1:${port}/session.json`,
      "--server",
      `http://127.0.0.1:${port}`,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain(
      `Failed to read session data: Session data too large: response body exceeds the ${maximumBytes}-byte limit`,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15_000)
