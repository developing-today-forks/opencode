/**
 * SystemOne service tests (#1410) — the façade side of the clef door's
 * own stub fixtures (developing-today/code bin/clef-proxy.test.mjs,
 * #690/#692/#782/#2410): the service is driven against a stub gateway
 * via the OPENCODE_SYSTEMONE_GATEWAY_BASE seam, mirroring the door's
 * CLEF_PROXY_GATEWAY_BASE seam, and must reproduce the door's upstream
 * guard, timeout, credential precedence and ledger behaviour.
 *
 * RE-RUN (laptop): cd packages/core && bun run test test/systemone.test.ts
 */
import { afterAll, expect } from "bun:test"
import { SystemOne } from "@opencode/core/systemone"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testEffect } from "./lib/effect"

type StubBehavior = (request: Request) => Promise<Response> | Response
let behavior: StubBehavior = () =>
  Response.json({ success: true, result: { answers: { q1: { type: "choice", choice: "blue", probabilities: { blue: 0.9, table: 0.1 } } } } })
const seenPaths: string[] = []
const seenAuth: Array<string | null> = []
const seenBodies: Array<Record<string, unknown>> = []
const stub = Bun.serve({
  port: 0,
  fetch: async (request) => {
    seenPaths.push(new URL(request.url).pathname)
    seenAuth.push(request.headers.get("authorization"))
    seenBodies.push((await request.json()) as Record<string, unknown>)
    return behavior(request)
  },
})
afterAll(() => stub.stop(true))

const savedEnv = { ...process.env }
process.env.OPENCODE_SYSTEMONE_GATEWAY_BASE = `http://127.0.0.1:${stub.port}/v1`
process.env.CLOUDFLARE_API_TOKEN = "env-token"
process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1"
process.env.CLOUDFLARE_GATEWAY_ID = "gw-1"
process.env.NO_PROXY = "127.0.0.1,localhost"
process.env.no_proxy = "127.0.0.1,localhost"
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

const attempts: ModelRouteLog.Attempt[] = []
ModelRouteLog.setSink((event) => {
  if (event.kind === "attempt") attempts.push(event.row)
})

const it = testEffect(SystemOne.layer.pipe(Layer.provide(FetchHttpClient.layer)))

const ask = { model: "@cf/cloudflare/clef-flash", state: { request: "hi" }, questions: { q1: { type: "choice", instructions: "pick", criteria: { blue: "colour" } } } }

it.live("happy path: answers verbatim, run URL + payload + env token reach the stub, ledger row recorded", () =>
  Effect.gen(function* () {
    behavior = () => Response.json({ success: true, result: { answers: { q1: "answer one" } } })
    const systemone = yield* SystemOne.Service
    const result = yield* systemone.evaluate(ask)
    expect(result.answers).toEqual({ q1: "answer one" })
    expect(seenPaths.at(-1)).toBe("/v1/acct-1/gw-1/workers-ai/run/@cf/cloudflare/clef-flash")
    expect(seenAuth.at(-1)).toBe("Bearer env-token")
    expect(seenBodies.at(-1)).toEqual({ state: ask.state, questions: ask.questions })
    const row = attempts.at(-1)
    expect(row?.provider_id).toBe("cloudflare-ai-gateway")
    expect(row?.model_id).toBe("@cf/cloudflare/clef-flash")
    expect(row?.session_id).toBeUndefined()
    expect(row?.outcome).toBe("success")
  }),
)

it.live("caller Bearer wins over the env token (the door's passthrough precedence)", () =>
  Effect.gen(function* () {
    behavior = () => Response.json({ success: true, result: { answers: { q1: "ok" } } })
    const systemone = yield* SystemOne.Service
    yield* systemone.evaluate({ ...ask, authHeader: "Bearer caller-token" })
    expect(seenAuth.at(-1)).toBe("Bearer caller-token")
  }),
)

it.live("non-JSON upstream 502 stays a 502 upstream-failure, not a 500 (#690)", () =>
  Effect.gen(function* () {
    behavior = () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
    const systemone = yield* SystemOne.Service
    const error = yield* Effect.flip(systemone.evaluate(ask))
    expect(error.status).toBe(502)
    expect(error.body).toEqual({ error: "Cloudflare Workers AI Clef execution failed", details: null })
  }),
)

it.live("JSON null and scalar upstream 200s are 502s (#690)", () =>
  Effect.gen(function* () {
    const systemone = yield* SystemOne.Service
    behavior = () => new Response("null", { headers: { "content-type": "application/json" } })
    expect((yield* Effect.flip(systemone.evaluate(ask))).status).toBe(502)
    behavior = () => new Response('"just a string"', { headers: { "content-type": "application/json" } })
    expect((yield* Effect.flip(systemone.evaluate(ask))).status).toBe(502)
  }),
)

it.live("upstream that never answers returns the door's 504 timeout envelope", () =>
  Effect.gen(function* () {
    process.env.CLEF_PROXY_DATA_PATH_TIMEOUT_MS = "300"
    behavior = () => new Promise<Response>(() => {})
    const systemone = yield* SystemOne.Service
    const error = yield* Effect.flip(systemone.evaluate(ask))
    expect(error.status).toBe(504)
    expect(error.body).toEqual({ error: "Cloudflare Workers AI Clef request timed out" })
    delete process.env.CLEF_PROXY_DATA_PATH_TIMEOUT_MS
    behavior = () => Response.json({ success: true, result: { answers: { q1: "ok" } } })
  }),
)

it.live("token file is read in place when no env or caller token exists; missing everywhere is the door's 401", () =>
  Effect.gen(function* () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "systemone-home-"))
    const cfg = path.join(home, ".config", "cloudflare")
    fs.mkdirSync(cfg, { recursive: true })
    fs.writeFileSync(path.join(cfg, "ai-inference-token"), "file-token\n")
    const savedHome = process.env.HOME
    process.env.HOME = home
    delete process.env.CLOUDFLARE_API_TOKEN
    const systemone = yield* SystemOne.Service
    behavior = () => Response.json({ success: true, result: { answers: { q1: "ok" } } })
    yield* systemone.evaluate(ask)
    expect(seenAuth.at(-1)).toBe("Bearer file-token")
    // Rotation picked up without restart: replace the file, next call uses it.
    fs.writeFileSync(path.join(cfg, "ai-inference-token"), "rotated-token\n")
    yield* systemone.evaluate(ask)
    expect(seenAuth.at(-1)).toBe("Bearer rotated-token")
    // Missing everywhere: 401, upstream never called.
    fs.unlinkSync(path.join(cfg, "ai-inference-token"))
    const callsBefore = seenPaths.length
    const error = yield* Effect.flip(systemone.evaluate(ask))
    expect(error.status).toBe(401)
    expect(error.body).toEqual({ error: "Missing Cloudflare AI inference API token" })
    expect(seenPaths.length).toBe(callsBefore)
    process.env.HOME = savedHome
    process.env.CLOUDFLARE_API_TOKEN = "env-token"
  }),
)
