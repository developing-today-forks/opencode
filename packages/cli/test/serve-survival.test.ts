import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Real `serve` processes: a parent going away, SIGHUP, and SIGTERM only mean something across processes.

const entry = path.join(import.meta.dir, "../src/index.ts")
const serveTest = process.platform === "win32" ? test.skip : test
const password = "serve-survival-password"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

serveTest(
  "serve keeps answering after its parent closes the output pipes",
  async () => {
    await using server = await serve()
    await ready(server.url)

    await server.detachOutput()
    await Bun.sleep(500)
    await ready(server.url)

    expect(server.child.exitCode).toBeNull()
  },
  120_000,
)

serveTest(
  "SIGHUP refreshes configuration without stopping the server",
  async () => {
    await using server = await serve()
    await ready(server.url)

    server.child.kill("SIGHUP")
    await Bun.sleep(1_000)

    expect(server.child.exitCode).toBeNull()
    await ready(server.url)
  },
  120_000,
)

serveTest(
  "SIGTERM stops an idle server promptly",
  async () => {
    await using server = await serve()
    await ready(server.url)

    server.child.kill("SIGTERM")
    const outcome = await Promise.race([server.child.exited, Bun.sleep(15_000).then(() => "timeout" as const)])

    expect(outcome).not.toBe("timeout")
  },
  120_000,
)

serveTest(
  "SIGTERM closes the listener but finishes a running session and its event stream",
  async () => {
    await using llm = holdingCompletion()
    await using server = await serve({ grace: "30000", llmURL: llm.url })
    await ready(server.url)
    await waitUntil(() => hasModel(server.url, server.root, "test", "test-model"))
    const events = await subscribe(server.url)
    const sessionID = await createSession(server.url, server.root)
    await send(server.url, server.root, `/api/session/${sessionID}/prompt`, { text: "hello" })
    // The first message also asks the same model for a title, so the held requests are not one per prompt.
    await waitUntil(() => llm.requests.some((request) => !isTitleRequest(request)))
    expect(llm.requests.filter((request) => !isTitleRequest(request))).toHaveLength(1)

    server.child.kill("SIGTERM")
    await waitUntil(() => refuses(server.url))
    expect(server.child.exitCode).toBeNull()

    llm.release()
    await events.until((text) => text.includes("session.execution.succeeded"))
    const outcome = await Promise.race([server.child.exited, Bun.sleep(15_000).then(() => "timeout" as const)])

    expect(outcome).not.toBe("timeout")
  },
  120_000,
)

async function serve(options: { readonly grace?: string; readonly llmURL?: string } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-serve-survival-")))
  if (options.llmURL) {
    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await Bun.write(path.join(root, "config", "opencode.json"), providerConfig(options.llmURL))
    await Bun.write(path.join(root, "models.json"), "{}")
  }
  const child = Bun.spawn([process.execPath, entry, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: isolatedEnv(root, {
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_MODELS_PATH: options.llmURL ? path.join(root, "models.json") : undefined,
      OPENCODE_SHUTDOWN_GRACE_MS: options.grace ?? "1000",
    }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = child.stdout.getReader()
  const stderr = child.stderr.getReader()
  void drain(stderr)
  const url = await listeningURL(stdout)
  return {
    child,
    url,
    root,
    detachOutput: () => Promise.all([stdout.cancel(), stderr.cancel()]),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function listeningURL(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`serve exited before listening: ${output}`)
    output += decoder.decode(value, { stream: true })
    const match = /server listening on (http:\/\/\S+)/.exec(output)
    if (match) return match[1]!
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done) continue
}

async function ready(url: string) {
  const deadline = Date.now() + 60_000
  while (true) {
    const status = await fetch(`${url}/api/location`, { headers: { authorization } })
      .then((response) => response.status)
      .catch(() => undefined)
    if (status === 200) return status
    if (Date.now() > deadline) throw new Error(`server at ${url} never became ready`)
    await Bun.sleep(200)
  }
}

function holdingCompletion() {
  const requests: unknown[] = []
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  const llm = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 })
      }
      requests.push(await request.json().catch(() => undefined))
      await released
      return new Response(completion("done"), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${llm.port}/v1`,
    requests,
    release,
    async [Symbol.asyncDispose]() {
      release()
      await llm.stop(true)
    },
  }
}

// Recognised by the title prompt's user message (packages/core/src/session/title.ts); this fork's title system
// prompt differs from upstream's.
function isTitleRequest(request: unknown) {
  const user = (request as { readonly messages?: ReadonlyArray<{ readonly content?: unknown }> } | undefined)?.messages?.[1]
    ?.content
  return (
    typeof user === "string" &&
    (user.startsWith("Here is the first message of the conversation") || user.startsWith("Here is the conversation so far"))
  )
}

function completion(text: string) {
  const chunks = [
    { choices: [{ delta: { role: "assistant" }, finish_reason: null }], usage: null },
    { choices: [{ delta: { content: text }, finish_reason: null }], usage: null },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
}

function providerConfig(llmURL: string) {
  const model = {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: { input: 0, output: 0 },
    limit: { context: 100_000, output: 10_000 },
  }
  return JSON.stringify({
    update: "disable",
    model: "test/test-model",
    providers: {
      test: {
        name: "Test",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "test-key", baseURL: llmURL },
        models: { "test-model": { ...model, name: "Test Model" } },
      },
    },
  })
}

async function subscribe(url: string) {
  const response = await fetch(`${url}/api/event`, { headers: { authorization } })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  void (async () => {
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      text += decoder.decode(value, { stream: true })
    }
  })()
  return {
    text: () => text,
    async until(match: (text: string) => boolean) {
      await waitUntil(() => match(text), 15_000)
    },
    async [Symbol.asyncDispose]() {
      await reader.cancel().catch(() => undefined)
    },
  }
}

async function createSession(url: string, root: string) {
  // session.create takes its location in the body; the query location does not place the session.
  const body = await send(url, root, "/api/session", { location: { directory: root } })
  return (body as { readonly data: { readonly id: string } }).data.id
}

async function send(url: string, root: string, route: string, body: unknown) {
  const location = `location[directory]=${encodeURIComponent(root)}`
  const response = await fetch(`${url}${route}?${location}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${route} failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

async function hasModel(url: string, root: string, providerID: string, modelID: string) {
  const location = `location[directory]=${encodeURIComponent(root)}`
  const response = await fetch(`${url}/api/model?${location}`, { headers: { authorization } })
  if (!response.ok) return false
  const body = (await response.json()) as {
    readonly data: ReadonlyArray<{ readonly providerID: string; readonly modelID: string }>
  }
  return body.data.some((model) => model.providerID === providerID && model.modelID === modelID)
}

function refuses(url: string) {
  const { hostname, port } = new URL(url)
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(true))
  })
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await Bun.sleep(50)
  }
}
