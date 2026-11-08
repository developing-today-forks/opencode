import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Duration } from "effect"
import { Status } from "@opencode/server/service-status"
import { isolatedEnv } from "./fixture/environment"
import { closeSocket, datagramReceiver, listenSocket } from "./fixture/systemd-socket"

// Real `serve` processes handing a port from one to the next, on both runtimes: the Node build (dist-node/opencode.mjs)
// and the Bun build (src/index.ts). Each runtime runs the same handover and the same control.

const cliRoot = path.resolve(import.meta.dir, "..")
const entry = path.join(cliRoot, "src", "index.ts")
const bundle = path.join(cliRoot, "dist-node", "opencode.mjs")
const assets = path.join(cliRoot, "dist-node", "assets")
const password = "serve-handover-password"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const posixTest = process.platform === "win32" ? test.skip : test
const linuxTest = process.platform === "linux" ? test : test.skip
// A request that reaches a successor before it is ready is held for up to the startup wait, so this client gives up
// only after that. A timeout here therefore means a hang, not a held request.
const clientTimeoutMs = Duration.toMillis(Status.startupWait) + 5_000

for (const runtime of ["node", "bun"] as const) {
  posixTest(
    `${runtime}: a successor takes over a supervisor's socket with no refused connection and no failed request`,
    async () => {
      if (runtime === "node") await ensureNodeBundle()
      const listener = listenSocket()
      const session = await sessionRoot()
      const base = `http://127.0.0.1:${listener.port}`
      const first = serve({ root: session.root, port: listener.port, listenFd: listener.fd, runtime })
      let second: Server | undefined
      let load: ReturnType<typeof loadTest> | undefined
      try {
        await first.ready()
        load = loadTest(base)
        await Bun.sleep(200)
        const held = heldSession(base, session.root)
        await Bun.sleep(300)

        // The successor reports ready on the same socket before the predecessor is told to stop.
        const successorStarted = Date.now()
        second = serve({ root: session.root, port: listener.port, listenFd: listener.fd, runtime })
        await second.ready()
        const successorReadyMs = Date.now() - successorStarted
        first.child.kill("SIGTERM")
        await Bun.sleep(1_500)
        expect(first.child.exitCode).toBeNull()

        const completed = await held.finish()
        expect(completed.status).toBe(200)
        const drained = await exited(first.child, 30_000)
        expect(drained).not.toBe("timeout")
        await Bun.sleep(1_000)
        const tally = await load.stop()
        load = undefined
        const report = {
          ...summarize(tally),
          heldRequest: completed.status,
          predecessorExit: drained,
          successorReadyMs,
        }
        console.log(`handover ${JSON.stringify(report)}`)

        expect(tally.requests).toBeGreaterThan(100)
        expect(tally.refused).toEqual([])
        expect(tally.failed).toEqual([])
      } finally {
        await load?.stop()
        first.child.kill("SIGKILL")
        second?.child.kill("SIGKILL")
        closeSocket(listener.fd)
        await session.cleanup()
      }
    },
    300_000,
  )

  posixTest(
    `${runtime}: control: without a supervisor's socket, the same restart refuses connections`,
    async () => {
      if (runtime === "node") await ensureNodeBundle()
      const port = freePort()
      const session = await sessionRoot()
      const base = `http://127.0.0.1:${port}`
      const first = serve({ root: session.root, port, runtime })
      let second: Server | undefined
      let load: ReturnType<typeof loadTest> | undefined
      try {
        await first.ready()
        load = loadTest(base)
        await Bun.sleep(200)
        const held = heldSession(base, session.root)
        await Bun.sleep(300)

        first.child.kill("SIGTERM")
        await Bun.sleep(1_500)
        const completed = await held.finish()
        expect(completed.status).toBe(200)
        const drained = await exited(first.child, 30_000)
        expect(drained).not.toBe("timeout")

        // Without a socket the successor can only bind after the predecessor has closed the port.
        second = serve({ root: session.root, port, runtime })
        await second.ready()
        await Bun.sleep(1_000)
        const tally = await load.stop()
        load = undefined
        const report = { ...summarize(tally), heldRequest: completed.status, predecessorExit: drained }
        console.log(`control ${JSON.stringify(report)}`)

        expect(tally.refused.length).toBeGreaterThan(0)
      } finally {
        await load?.stop()
        first.child.kill("SIGKILL")
        second?.child.kill("SIGKILL")
        await session.cleanup()
      }
    },
    300_000,
  )

  posixTest(
    `${runtime}: a drain answers a request on a connection the server accepted before it began`,
    async () => {
      if (runtime === "node") await ensureNodeBundle()
      const listener = listenSocket()
      const session = await sessionRoot()
      const server = serve({ root: session.root, port: listener.port, listenFd: listener.fd, runtime })
      const idle = idleConnection(listener.port)
      try {
        await server.ready()
        await idle.connected
        // Let the server accept the connection, then leave it idle: nothing is in flight, so only
        // tracking accepted connections can keep it alive across the drain.
        await Bun.sleep(250)
        server.child.kill("SIGTERM")
        // The drain has begun. A request that arrives now is on a connection the predecessor accepted.
        await Bun.sleep(200)
        expect(await idle.request()).toBe(200)
        expect(await exited(server.child, 30_000)).not.toBe("timeout")
      } finally {
        idle.close()
        server.child.kill("SIGKILL")
        closeSocket(listener.fd)
        await session.cleanup()
      }
    },
    120_000,
  )
}

posixTest(
  "a second SIGTERM ends a drain that is still waiting on a request",
  async () => {
    await ensureNodeBundle()
    const port = freePort()
    const session = await sessionRoot()
    const base = `http://127.0.0.1:${port}`
    const server = serve({ root: session.root, port })
    try {
      await server.ready()
      // The request is never finished, so the server is still waiting on it when the second SIGTERM arrives.
      heldSession(base, session.root)
      await Bun.sleep(300)

      server.child.kill("SIGTERM")
      await Bun.sleep(500)
      expect(server.child.exitCode).toBeNull()

      server.child.kill("SIGTERM")
      expect(await exited(server.child, 5_000)).not.toBe("timeout")
    } finally {
      server.child.kill("SIGKILL")
      await session.cleanup()
    }
  },
  120_000,
)

linuxTest(
  "a node server reports READY=1 to NOTIFY_SOCKET and prints a ready line once it answers",
  async () => {
    await ensureNodeBundle()
    const session = await sessionRoot()
    const notify = path.join(session.root, "notify.sock")
    const receiver = datagramReceiver(notify)
    const server = serve({ root: session.root, port: freePort(), notify })
    try {
      await server.ready()
      expect(await receiver.next(30_000)).toBe("READY=1")
    } finally {
      receiver.close()
      server.child.kill("SIGKILL")
      await session.cleanup()
    }
  },
  300_000,
)

linuxTest(
  "a bun server reports READY=1 to NOTIFY_SOCKET once it answers",
  async () => {
    const session = await sessionRoot()
    const notify = path.join(session.root, "notify.sock")
    const receiver = datagramReceiver(notify)
    const server = serve({ root: session.root, port: freePort(), notify, runtime: "bun" })
    try {
      await server.ready()
      expect(await receiver.next(30_000)).toBe("READY=1")
    } finally {
      receiver.close()
      server.child.kill("SIGKILL")
      await session.cleanup()
    }
  },
  300_000,
)

type Server = ReturnType<typeof serve>
type Runtime = "node" | "bun"

function serve(options: {
  readonly root: string
  readonly port: number
  readonly listenFd?: number
  readonly notify?: string
  readonly runtime?: Runtime
}) {
  const serveArgs = ["serve", "--hostname", "127.0.0.1", "--port", String(options.port)]
  const command =
    options.runtime === "bun"
      ? [process.execPath, entry, ...serveArgs]
      : [requireNode(), bundle, ...serveArgs]
  // systemd names the process that owns the socket in LISTEN_PID. `exec` keeps the pid, so the name is the server's.
  const launched =
    options.listenFd === undefined ? command : ["/bin/sh", "-c", 'LISTEN_PID=$$ exec "$@"', "sh", ...command]
  const child = Bun.spawn(launched, {
    env: isolatedEnv(options.root, {
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_MODELS_PATH: path.join(options.root, "models.json"),
      OPENCODE_SHUTDOWN_GRACE_MS: "30000",
      OPENCODE_NODE_ASSETS_DIR: assets,
      LISTEN_FDS: options.listenFd === undefined ? undefined : "1",
      NOTIFY_SOCKET: options.notify,
    }),
    stdio:
      options.listenFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", options.listenFd],
  })
  const stdout = capture(child.stdout)
  const stderr = capture(child.stderr)
  return {
    child,
    ready: () => stdout.until(/opencode: ready/, 60_000),
    stderr: async () => {
      await child.exited
      return stderr.text()
    },
  }
}

// Collects a stream in the background so the child never blocks on a full pipe.
function capture(stream: ReadableStream<Uint8Array>) {
  let text = ""
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  void (async () => {
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      text += decoder.decode(value, { stream: true })
    }
  })()
  return {
    text: () => text,
    async until(pattern: RegExp, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs
      while (!pattern.test(text)) {
        if (Date.now() > deadline) throw new Error(`no output matching ${pattern} within ${timeoutMs}ms:\n${text}`)
        await Bun.sleep(50)
      }
    },
  }
}

function exited(child: { exited: Promise<number> }, timeoutMs: number) {
  return Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)])
}

type Tally = {
  requests: number
  ok: number
  refused: string[]
  failed: string[]
}

function summarize(tally: Tally) {
  const counts = (messages: string[]) =>
    messages.reduce<Record<string, number>>((all, message) => ({ ...all, [message]: (all[message] ?? 0) + 1 }), {})
  return { requests: tally.requests, ok: tally.ok, refused: tally.refused.length, failed: counts(tally.failed) }
}

// One request every 10 ms with a short timeout, each on a fresh connection so no keep-alive socket is reused.
function loadTest(base: string) {
  const tally: Tally = { requests: 0, ok: 0, refused: [], failed: [] }
  let running = true
  const loop = (async () => {
    while (running) {
      tally.requests++
      try {
        const response = await fetch(`${base}/api/location`, {
          headers: { authorization, connection: "close" },
          signal: AbortSignal.timeout(clientTimeoutMs),
        })
        await response.arrayBuffer()
        if (response.status === 200) tally.ok++
        else tally.failed.push(`status ${response.status}`)
      } catch (error) {
        const code = (error as { code?: string }).code
        const message = error instanceof Error ? error.message : String(error)
        if (/ECONNREFUSED|ConnectionRefused|refused/i.test(`${code} ${message}`)) tally.refused.push(message)
        else tally.failed.push(code ?? message)
      }
      await Bun.sleep(10)
    }
  })()
  return {
    async stop() {
      running = false
      await loop
      return tally
    },
  }
}

// A session create whose body arrives in two halves: the request is in flight on the server until finish().
function heldSession(base: string, root: string) {
  const body = JSON.stringify({ location: { directory: root } })
  const half = Math.floor(body.length / 2)
  const request = http.request(`${base}/api/session?location[directory]=${encodeURIComponent(root)}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", "content-length": String(body.length) },
  })
  request.write(body.slice(0, half))
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.once("error", reject)
    request.once("response", async (res) => {
      let text = ""
      for await (const chunk of res) text += chunk
      resolve({ status: res.statusCode ?? 0, body: text })
    })
  })
  // A caller that never calls finish() leaves this rejected when the process goes away; nothing awaits it then.
  response.catch(() => undefined)
  return {
    finish() {
      request.end(body.slice(half))
      return response
    },
  }
}

// A TCP connection to the server that has sent no request yet. The server accepts it on connect, so it
// is a connection the predecessor already owns by the time a drain begins.
function idleConnection(port: number) {
  const socket = net.connect({ host: "127.0.0.1", port })
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  return {
    connected,
    request() {
      const response = new Promise<number>((resolve, reject) => {
        let text = ""
        const timer = setTimeout(() => reject(new Error("no response within 5s")), 5_000)
        socket.on("data", (chunk) => {
          text += chunk.toString("latin1")
          const status = text.match(/^HTTP\/1\.[01] (\d{3})/)
          if (!status) return
          clearTimeout(timer)
          resolve(Number(status[1]))
        })
        socket.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        socket.once("close", () => {
          clearTimeout(timer)
          reject(new Error(`connection closed without a response: ${JSON.stringify(text)}`))
        })
      })
      socket.write(
        `GET /api/location HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${authorization}\r\nConnection: close\r\n\r\n`,
      )
      return response
    },
    close() {
      socket.destroy()
    },
  }
}

async function sessionRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-handover-")))
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await Bun.write(path.join(root, "models.json"), "{}")
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

function freePort() {
  const listener = listenSocket()
  closeSocket(listener.fd)
  return listener.port
}

function requireNode() {
  const node = Bun.which("node")
  if (!node) throw new Error("the Node build test needs node on PATH")
  return node
}

// The Node bundle is built from the current sources. It is rebuilt only when a source file is newer than it.
async function ensureNodeBundle() {
  const built = await fs.stat(bundle).then((stat) => stat.mtimeMs, () => 0)
  const newest = await newestSource(path.resolve(cliRoot, "../.."), built)
  if (newest === undefined) return
  const build = Bun.spawn([process.execPath, "run", "script/build-node.ts", "--bundle-only", "--skip-install"], {
    cwd: cliRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, out, err] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  if (code !== 0) throw new Error(`building the Node bundle failed:\n${out}\n${err}`)
}

// Any newer file under packages/*/src, or undefined if the bundle is up to date.
async function newestSource(repo: string, builtAt: number) {
  const packages = await fs.readdir(path.join(repo, "packages"))
  for (const name of packages) {
    const src = path.join(repo, "packages", name, "src")
    const files = await fs.readdir(src, { recursive: true }).catch(() => [] as string[])
    for (const file of files) {
      if (!/\.(ts|tsx|js|md|txt)$/.test(file)) continue
      const stat = await fs.stat(path.join(src, file)).catch(() => undefined)
      if (stat && stat.mtimeMs > builtAt) return file
    }
  }
  return undefined
}
