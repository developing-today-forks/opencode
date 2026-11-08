import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { ServerProcess } from "@opencode/server/process"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { WebUi } from "../src/services/web-ui"
import { it } from "../../core/test/lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-"))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("web UI", () => {
  it.live("serves the web shell and assets before server authentication", () =>
    Effect.gen(function* () {
      const transform = yield* WebUi.handler({
        assets: {
          "index.html": "<html><body>connect</body></html>",
          "_assets/app.js": "console.log('connect')",
          "_assets/app.css": "body { color: black; }",
          "icons/icon.svg": "<svg></svg>",
          "font.woff2": new Uint8Array([0, 1, 2, 255]),
          "sw.js": "service worker",
        },
      })
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" }, models: { fetch: false } },
        undefined,
        transform,
      )
      const origin = HttpServer.formatAddress(server.address)
      yield* Effect.forEach(
        [
          "/",
          "/settings",
          "/workspace/example",
          "/_assets/app.js",
          "/_assets/app.css",
          "/icons/icon.svg",
          "/font.woff2",
          "/sw.js",
        ],
        (pathname) =>
          Effect.gen(function* () {
            yield* Effect.forEach(["GET", "HEAD"], (method) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(new URL(pathname, origin), { method }))
                expect(response.status).toBe(200)
                expect(response.headers.get("www-authenticate")).toBeNull()
                yield* Effect.promise(() => response.arrayBuffer())
              }),
            )
          }),
      )
      yield* Effect.forEach(
        ["/api", "/api/info", "/api/event", "/api/missing", "/openapi.json", "/v1/models", "/v1/missing"],
        (pathname) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() => fetch(new URL(pathname, origin)))
            expect(response.status).toBe(401)
            expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
            yield* Effect.promise(() => response.arrayBuffer())
          }),
      )
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", origin), { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toHaveProperty("pid")

      // The facade doors (#1627): /v1/* belongs to the API router, so an authenticated
      // request gets the facade's JSON — never the SPA shell (GET) or the shell's 405 (POST).
      const authHeaders = { authorization: `Basic ${btoa("opencode:secret")}`, "content-type": "application/json" }
      const models = yield* Effect.promise(() => fetch(new URL("/v1/models", origin), { headers: authHeaders }))
      expect(models.status).toBe(200)
      expect(models.headers.get("content-type")).toContain("application/json")
      const modelsBody = (yield* Effect.promise(() => models.json())) as { object?: unknown; data?: unknown }
      expect(modelsBody.object).toBe("list")
      expect(Array.isArray(modelsBody.data)).toBe(true)

      const chat = yield* Effect.promise(() =>
        fetch(new URL("/v1/chat/completions", origin), {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hello" }] }),
        }),
      )
      expect(chat.status).toBe(400)
      expect(chat.headers.get("content-type")).toContain("application/json")
      const chatBody = (yield* Effect.promise(() => chat.json())) as { error?: { type?: unknown } }
      expect(chatBody.error?.type).toBe("invalid_request_error")

      const systemone = yield* Effect.promise(() =>
        fetch(new URL("/v1/systemone", origin), {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ model: "not-a-clef-model", state: {}, questions: {} }),
        }),
      )
      expect(systemone.status).toBe(400)
      expect(systemone.headers.get("content-type")).toContain("application/json")
      const systemoneBody = (yield* Effect.promise(() => systemone.json())) as Record<string, unknown>
      expect(typeof systemoneBody.error).toBe("string")

      const embeddings = yield* Effect.promise(() =>
        fetch(new URL("/v1/embeddings", origin), {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ model: "no-such-model", input: "hello" }),
        }),
      )
      expect(embeddings.status).not.toBe(405)
      expect(embeddings.headers.get("content-type")).toContain("application/json")
      const embeddingsBody = (yield* Effect.promise(() => embeddings.json())) as Record<string, unknown>
      expect("error" in embeddingsBody || "data" in embeddingsBody).toBe(true)

      const pairing = yield* Effect.promise(() =>
        fetch(new URL("/api/pair", origin), {
          method: "POST",
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }).then((response) => response.json() as Promise<{ code: string }>),
      )
      const redirect = yield* Effect.promise(() =>
        fetch(new URL(`/auth/connect/${pairing.code}`, origin), {
          redirect: "manual",
          headers: { accept: "text/html" },
        }),
      )
      expect(redirect.status).toBe(302)
      const cookie = (redirect.headers.get("set-cookie") ?? "").split(";")[0]
      const authorized = yield* Effect.promise(() => fetch(new URL("/api/info", origin), { headers: { cookie } }))
      expect(authorized.status).toBe(200)
      yield* Effect.promise(() => authorized.arrayBuffer())
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  test("serves no web UI when OPENCODE_DISABLE_EMBEDDED_WEB_UI is set, while API routes still pass through", async () => {
    const previous = process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI
    const assets = { "index.html": "<html><body>embedded</body></html>", "_assets/app.js": "console.log('embedded')" }
    const probe = (disabled: boolean, pathnames: ReadonlyArray<string>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            if (disabled) process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"
            else delete process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI
            const transform = yield* WebUi.handler({ assets })
            const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
            yield* http.serve(
              transform(
                Effect.gen(function* () {
                  const request = yield* HttpServerRequest.HttpServerRequest
                  const pathname = new URL(request.url, "http://localhost").pathname
                  if (
                    pathname === "/api/info" ||
                    pathname === "/openapi.json" ||
                    pathname.startsWith("/auth/") ||
                    pathname.startsWith("/v1/")
                  )
                    return HttpServerResponse.jsonUnsafe({ via: "api" })
                  return yield* Effect.fail(
                    new HttpServerError.HttpServerError({
                      reason: new HttpServerError.RouteNotFound({ request }),
                    }),
                  )
                }),
              ),
            )
            const origin = HttpServer.formatAddress(http.address)
            return yield* Effect.forEach(pathnames, (pathname) =>
              Effect.promise(async () => {
                const response = await fetch(`${origin}${pathname}`)
                return { pathname, status: response.status, body: await response.text() }
              }),
            )
          }),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      )
    try {
      const disabled = await probe(true, [
        "/",
        "/workspace/example",
        "/_assets/app.js",
        "/index.html",
        "/api/info",
        "/openapi.json",
        "/auth/connect/example",
        "/api/missing",
        "/v1/models",
      ])
      for (const result of disabled.slice(0, 4)) expect(result).toMatchObject({ status: 404, body: "" })
      for (const result of disabled.slice(4, 7))
        expect(result).toEqual({ pathname: result.pathname, status: 200, body: '{"via":"api"}' })
      expect(disabled[7]).toMatchObject({ status: 404, body: "" })
      expect(disabled[8]).toEqual({ pathname: "/v1/models", status: 200, body: '{"via":"api"}' })

      const enabled = await probe(false, ["/", "/_assets/app.js"])
      expect(enabled[0]?.status).toBe(200)
      expect(enabled[0]?.body).toContain("embedded")
      expect(enabled[1]).toEqual({ pathname: "/_assets/app.js", status: 200, body: "console.log('embedded')" })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI
      else process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = previous
    }
  })

  test("sends embedded brotli bytes as they are to browsers that accept them", async () => {
    const script = "console.log('compressed')".repeat(50)
    const html = "<html><body>compressed</body></html>"
    const brotli = { "_assets/app.js": brotliCompressSync(script), "index.html": brotliCompressSync(html) }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: { "_assets/app.js": script, "index.html": html }, brotli })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)
          const get = (pathname: string, encoding: string) =>
            Effect.promise(async () => {
              const response = await fetch(`${origin}${pathname}`, {
                headers: { "accept-encoding": encoding },
                decompress: false,
              })
              return { headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) }
            })

          const encoded = yield* get("/_assets/app.js", "gzip, deflate, br")
          expect(encoded.headers.get("content-encoding")).toBe("br")
          expect(encoded.headers.get("vary")).toBe("accept-encoding")
          expect(encoded.headers.get("content-type")).toContain("javascript")
          expect(encoded.body).toEqual(new Uint8Array(brotli["_assets/app.js"]))

          yield* Effect.forEach(["gzip", "br;q=0"], (encoding) =>
            Effect.gen(function* () {
              const plain = yield* get("/_assets/app.js", encoding)
              expect(plain.headers.get("content-encoding")).toBeNull()
              expect(plain.headers.get("vary")).toBe("accept-encoding")
              expect(new TextDecoder().decode(plain.body)).toBe(script)
            }),
          )

          const page = yield* get("/", "br")
          expect(page.headers.get("content-encoding")).toBeNull()
          expect(new TextDecoder().decode(page.body)).toBe(html)
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("falls back from API routes to assets and the SPA index", async () => {
    const index = path.join(root, "index.html")
    const asset = path.join(root, "app.js")
    await writeFile(index, "<html><body>embedded</body></html>")
    await writeFile(asset, "console.log('embedded')")
    const assets = {
      "index.html": await Bun.file(index).text(),
      "_assets/app.js": await Bun.file(asset).text(),
      "sw.js": "service worker",
      "registerSW.js": "registration",
      "font.woff2": new Uint8Array([0, 1, 2, 255]),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const pathname = new URL(request.url, "http://localhost").pathname
                if (pathname === "/api/info")
                  return HttpServerResponse.jsonUnsafe({
                    version: "test",
                    pid: 1,
                    urls: [origin],
                    paths: { tmp: "/tmp/opencode" },
                  })
                return yield* Effect.fail(
                  new HttpServerError.HttpServerError({
                    reason: new HttpServerError.RouteNotFound({ request }),
                  }),
                )
              }),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)

          const status = yield* Effect.promise(() => fetch(`${origin}/api/info`))
          expect(yield* Effect.promise(() => status.json())).toEqual({
            version: "test",
            pid: 1,
            urls: [origin],
            paths: { tmp: "/tmp/opencode" },
          })

          const missing = yield* Effect.promise(() => fetch(`${origin}/api/missing`))
          expect(missing.status).toBe(404)
          expect(yield* Effect.promise(() => missing.text())).toBe("")

          const missingFacade = yield* Effect.promise(() => fetch(`${origin}/v1/missing`))
          expect(missingFacade.status).toBe(404)
          expect(yield* Effect.promise(() => missingFacade.text())).toBe("")

          yield* Effect.forEach(["/_assets/old.js", "/_assets/old.css", "/_assets/missing"], (pathname) =>
            Effect.gen(function* () {
              const missing = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(missing.status).toBe(404)
              expect(missing.headers.get("cache-control")).toBe("no-store")
              expect(yield* Effect.promise(() => missing.text())).toBe("")
            }),
          )

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('embedded')")
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

          const worker = yield* Effect.promise(() => fetch(`${origin}/sw.js`))
          expect(worker.headers.get("cache-control")).toBe("no-cache")

          const registration = yield* Effect.promise(() => fetch(`${origin}/registerSW.js`))
          expect(registration.headers.get("cache-control")).toBe("no-cache")

          const font = yield* Effect.promise(() => fetch(`${origin}/font.woff2`))
          expect(font.headers.get("content-type")).toBe("font/woff2")
          expect(new Uint8Array(yield* Effect.promise(() => font.arrayBuffer()))).toEqual(
            new Uint8Array([0, 1, 2, 255]),
          )

          const fallback = yield* Effect.promise(() => fetch(`${origin}/workspace/example`))
          expect(yield* Effect.promise(() => fallback.text())).toContain("embedded")
          expect(fallback.headers.get("content-security-policy")).toContain("default-src 'self'")
          expect(fallback.headers.get("content-security-policy")).toContain("connect-src * data: blob:")
          expect(fallback.headers.get("content-security-policy")).toContain("worker-src 'self' blob:")

          const dotted = yield* Effect.promise(() => fetch(`${origin}/workspace/example.js`))
          expect(dotted.status).toBe(200)
          expect(yield* Effect.promise(() => dotted.text())).toContain("embedded")

          const legacy = yield* Effect.promise(() => fetch(`${origin}/assets/missing.js`))
          expect(legacy.status).toBe(200)
          expect(yield* Effect.promise(() => legacy.text())).toContain("embedded")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })
})
