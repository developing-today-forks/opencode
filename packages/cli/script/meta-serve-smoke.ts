#!/usr/bin/env bun

// Run from the repository root with `bun packages/cli/script/meta-serve-smoke.ts`.
// The OpenAI provider control uses a local SSE endpoint; only the Meta turn calls a real provider.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const openAIOnly = process.argv.includes("--openai-only")

let mockRequests = 0
const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Not found", { status: 404 })
    mockRequests++
    const chunks = [
      { id: "chatcmpl_smoke", choices: [{ index: 0, delta: { content: "openai-smoke-ok" } }], usage: null },
      { id: "chatcmpl_smoke", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
      {
        id: "chatcmpl_smoke",
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
      "[DONE]",
    ]
    return new Response(
      chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-meta-serve-smoke-")))
const password = "meta-serve-smoke-local"
const serverReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const serverPort = serverReservation.port
serverReservation.stop()
const serverURL = `http://127.0.0.1:${serverPort}`
const modelLimit = { context: 32768, output: 2048 }
const config = {
  providers: {
    ...(openAIOnly
      ? {}
      : {
          meta: {
            package: "@ai-sdk/openai",
            env: ["META_API_KEY"],
            settings: { baseURL: "https://api.meta.ai/v1" },
            models: {
              "muse-wonder-1.0": {
                name: "Muse Wonder smoke",
                package: "@ai-sdk/openai",
                limit: modelLimit,
              },
            },
          },
        }),
    openai: {
      package: "@ai-sdk/openai-compatible",
      settings: { apiKey: "smoke-only", baseURL: `${mock.url}v1` },
      models: {
        "smoke-model": {
          name: "OpenAI local smoke",
          package: "@ai-sdk/openai-compatible",
          limit: modelLimit,
        },
      },
    },
  },
}
const env = {
  ...process.env,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_CLI_CONFIG_CONTENT: undefined,
  OPENCODE_DB: path.join(directory, "opencode.db"),
  OPENCODE_PASSWORD: password,
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_EMBEDDING: "true",
}
const headers = {
  authorization: `Basic ${btoa(`opencode:${password}`)}`,
  "x-opencode-directory": encodeURIComponent(root),
}
const server = Bun.spawn(["bun", "run", "dev", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
  cwd: root,
  env,
  stdout: "ignore",
  stderr: "ignore",
})

try {
  await ready(serverURL, headers, server)
  await turn("openai", "smoke-model", "openai-smoke-ok", serverURL, headers, env)
  if (!openAIOnly) await turn("meta", "muse-wonder-1.0", undefined, serverURL, headers, env)
} finally {
  server.kill()
  await server.exited
  mock.stop()
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

async function ready(url: string, headers: HeadersInit, process: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Standalone serve exited before readiness (${process.exitCode})`)
    const response = await fetch(new URL("/api/model", url), {
      headers,
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    if (response?.ok) return
    await Bun.sleep(100)
  }
  throw new Error("Standalone serve did not become ready")
}

async function turn(
  providerID: string,
  modelID: string,
  expectedText: string | undefined,
  url: string,
  headers: HeadersInit,
  env: Record<string, string | undefined>,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "dev",
      "run",
      "--server",
      url,
      "--model",
      `${providerID}/${modelID}`,
      "--format",
      "json",
      "Reply with a short non-empty answer.",
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe", signal: controller.signal },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (exitCode !== 0)
    throw new Error(
      `${providerID} smoke command failed (exit ${exitCode}, local OpenAI requests: ${mockRequests}): ${stderr.replaceAll("smoke-only", "<REDACTED>").slice(-2000)}`,
    )
  const events = stdout
    .split(/\r?\n/)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
    .filter(isRecord)
  const session = events.find((event) => typeof event.sessionID === "string")
  if (!session || typeof session.sessionID !== "string") throw new Error(`${providerID} smoke emitted no session ID`)
  const sessionID = session.sessionID
  const streamed = events
    .filter((event) => event.type === "text" && isRecord(event.part) && typeof event.part.text === "string")
    .map((event) => (event.part as Record<string, unknown>).text as string)
    .join("")
  if (!streamed.trim()) throw new Error(`${providerID} smoke turn emitted no text tokens`)
  if (expectedText !== undefined && !streamed.includes(expectedText))
    throw new Error(`${providerID} smoke control returned unexpected text`)

  const response = await fetch(new URL(`/api/session/${encodeURIComponent(sessionID)}/message`, url), {
    headers,
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`${providerID} smoke could not read session messages (${response.status})`)
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data))
    throw new Error(`${providerID} smoke returned invalid session data`)
  const assistant = payload.data.find((message) => isRecord(message) && message.type === "assistant")
  if (!isRecord(assistant) || !Array.isArray(assistant.content))
    throw new Error(`${providerID} smoke turn has no completed assistant message`)
  const text = assistant.content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => (part as Record<string, unknown>).text as string)
    .join("")
  if (!text.trim()) throw new Error(`${providerID} smoke turn stored an empty assistant message`)
  if (!isRecord(assistant.tokens) || !(Number(assistant.tokens.input) > 0) || !(Number(assistant.tokens.output) > 0))
    throw new Error(`${providerID} smoke turn did not advance both token counters`)
  console.log(`PASS ${providerID}: streamed text and advanced input/output token counters`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
