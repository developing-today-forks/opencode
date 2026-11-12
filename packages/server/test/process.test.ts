import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Option } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live("authenticates API requests behind the frontend transform while allowing browser preflight", () =>
  Effect.gen(function* () {
    const fallback = "fallback".repeat(256)
    const server = yield* ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        cors: ["http://192.168.1.10:3001", "https://example.com"],
        app: { version: "test-version" },
        database: { path: ":memory:" },
      },
      undefined,
      (api) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://localhost")
          if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/openapi.json")
            return yield* api
          return HttpServerResponse.raw(fallback, { contentType: "text/plain" })
        }),
    )
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

    const status = yield* Effect.promise(() =>
      fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), {
        headers: {
          authorization: `Basic ${btoa("opencode:secret")}`,
          origin: "http://localhost:3000",
        },
      }),
    )

    expect(status.status).toBe(200)
    expect(status.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ version: "test-version" })

    yield* Effect.forEach(
      ["http://192.168.1.10:3001", "https://example.com", "https://untrusted.example.com"],
      (origin) =>
        Effect.gen(function* () {
          const allowed = origin === "https://untrusted.example.com" ? null : origin
          const preflight = yield* Effect.promise(() =>
            fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), {
              method: "OPTIONS",
              headers: {
                origin,
                "access-control-request-method": "GET",
                "access-control-request-headers": "authorization",
              },
            }),
          )
          expect(preflight.status).toBe(204)
          expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed)

          const status = yield* Effect.promise(() =>
            fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), {
              headers: { origin, authorization: `Basic ${btoa("opencode:secret")}` },
            }),
          )
          expect(status.status).toBe(200)
          expect(status.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => status.arrayBuffer())

          const denied = yield* Effect.promise(() =>
            fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), { headers: { origin } }),
          )
          expect(denied.status).toBe(401)
          expect(denied.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => denied.arrayBuffer())
        }),
    )

    const event = yield* Effect.promise(() =>
      fetch(new URL("/api/event", HttpServer.formatAddress(server.address)), {
        headers: {
          "accept-encoding": "br",
          authorization: `Basic ${btoa("opencode:secret")}`,
        },
      }),
    )
    expect(event.status).toBe(200)
    expect(event.headers.get("content-encoding")).toBeNull()
    const body = event.body
    if (!body) return yield* Effect.die(new Error("Event response has no body"))
    const reader = body.getReader()
    yield* Effect.promise(() => readUntil(reader, "server.connected"))
    yield* server.updateAvailable("2.0.0")
    yield* Effect.promise(() => readUntil(reader, "installation.update-available"))
    yield* server.updated("2.0.0")
    yield* Effect.promise(() => readUntil(reader, "installation.updated"))
    yield* Effect.promise(() => reader.cancel())

    const missing = yield* Effect.promise(() =>
      fetch(new URL("/missing", HttpServer.formatAddress(server.address)), {
        headers: {
          "accept-encoding": "br",
          authorization: `Basic ${btoa("opencode:secret")}`,
        },
      }),
    )
    expect(missing.status).toBe(200)
    expect(missing.headers.get("content-encoding")).toBe("br")
    expect(missing.headers.get("content-type")).toBe("text/plain")
    expect(missing.headers.get("vary")?.toLowerCase()).toContain("accept-encoding")
    expect(yield* Effect.promise(() => missing.text())).toBe(fallback)

    yield* Effect.forEach(["/api", "/api/missing", "/openapi.json"], (pathname) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(new URL(pathname, HttpServer.formatAddress(server.address))))
        expect(response.status).toBe(401)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          _tag: "UnauthorizedError",
          message: "Authentication required",
        })
      }),
    )

    yield* Effect.forEach(["/", "/workspace/example", "/_assets/app.js", "/icons/icon.svg", "/sw.js"], (pathname) =>
      Effect.gen(function* () {
        yield* Effect.forEach(["GET", "HEAD"], (method) =>
          Effect.gen(function* () {
            yield* Effect.forEach([undefined, `Basic ${btoa("opencode:wrong")}`], (authorization) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() =>
                  fetch(new URL(pathname, HttpServer.formatAddress(server.address)), {
                    method,
                    headers: authorization ? { authorization } : undefined,
                  }),
                )
                expect(response.status).toBe(200)
                expect(response.headers.get("www-authenticate")).toBeNull()
                expect(yield* Effect.promise(() => response.text())).toBe(method === "HEAD" ? "" : fallback)
              }),
            )
            const response = yield* Effect.promise(() =>
              fetch(new URL(pathname, HttpServer.formatAddress(server.address)), {
                method,
                headers: { authorization: `Basic ${btoa("opencode:secret")}` },
              }),
            )
            expect(response.status).toBe(200)
            expect(yield* Effect.promise(() => response.text())).toBe(method === "HEAD" ? "" : fallback)
          }),
        )
      }),
    )
  }),
)

it.live("pairing links sign in browsers with a cookie and API clients with a token", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
    })
    const base = HttpServer.formatAddress(server.address)
    const request = (pathname: string, init?: RequestInit) =>
      Effect.promise(() => fetch(new URL(pathname, base), { redirect: "manual", ...init }))
    const pair = Effect.gen(function* () {
      const response = yield* request("/api/pair", {
        method: "POST",
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      })
      expect(response.status).toBe(200)
      return (yield* Effect.promise(() => response.json())) as { code: string; expires_in: number }
    })

    const rejected = yield* request("/api/pair", { method: "POST" })
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
    // A Basic challenge on fetch makes browsers show a native prompt instead of the app's sign-in screen.
    const fetched = yield* request("/api/info", { headers: { "sec-fetch-mode": "cors" } })
    expect(fetched.status).toBe(401)
    expect(fetched.headers.get("www-authenticate")).toBeNull()

    const browser = yield* pair
    expect(browser.expires_in).toBe(300)
    const connectUrl = "/auth/connect/" + browser.code
    // A browser GET is a landing page, never a redemption (#2307): a
    // link preview fetching the URL first must not consume the code.
    const preview = yield* request(connectUrl, { headers: { accept: "text/html" } })
    expect(preview.status).toBe(200)
    expect(yield* Effect.promise(() => preview.text())).toContain("Pair this browser")
    const landing = yield* request(connectUrl, { headers: { accept: "text/html" } })
    expect(landing.status).toBe(200)
    // The intended browser redeems with the explicit confirmation POST.
    const redirect = yield* request(connectUrl, { method: "POST", headers: { accept: "text/html" } })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("/")
    const setCookie = redirect.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("opencode_session_" + new URL(base).port + "=")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    const cookie = setCookie.split(";")[0]

    // Redemption stays single-use: neither a POST replay nor a GET
    // of the spent link signs anyone in again.
    const replayed = yield* request(connectUrl, { method: "POST", headers: { accept: "text/html" } })
    expect(replayed.status).toBe(401)
    const reused = yield* request(connectUrl, { headers: { accept: "text/html" } })
    expect(reused.status).toBe(401)
    expect(yield* Effect.promise(() => reused.text())).toContain("opencode pair")

    expect((yield* request("/api/info", { headers: { cookie } })).status).toBe(200)
    expect((yield* request("/api/info", { headers: { cookie, origin: base } })).status).toBe(200)
    expect((yield* request("/api/info", { headers: { cookie, origin: "http://127.0.0.1:1" } })).status).toBe(401)
    expect((yield* request("/api/info", { headers: { cookie: `${cookie}x` } })).status).toBe(401)

    const client = yield* pair
    const redeemed = yield* request(`/auth/connect/${client.code}`)
    expect(redeemed.status).toBe(200)
    const session = (yield* Effect.promise(() => redeemed.json())) as { token: string }
    expect(
      (yield* request("/api/info", { headers: { authorization: `Basic ${btoa(`opencode:${session.token}`)}` } }))
        .status,
    ).toBe(200)
    expect((yield* request(`/auth/connect/${client.code}`)).status).toBe(401)
    expect((yield* request("/auth/connect/unknown")).status).toBe(401)
  }),
)

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string) {
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error(`Event stream ended before ${expected}`)
    if (new TextDecoder().decode(next.value).includes(expected)) return
  }
}

it.live("server info lists remote URLs alongside local addresses while they are available", () =>
  Effect.gen(function* () {
    const remote = { urls: ["https://example.opentunnel.xyz"] as ReadonlyArray<string> }
    const server = yield* ServerProcess.start<never, never>(
      { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
      undefined,
      undefined,
      () => remote.urls,
    )
    const base = HttpServer.formatAddress(server.address)
    const info = () =>
      Effect.promise(() =>
        fetch(new URL("/api/info", base), { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }).then(
          (response) => response.json() as Promise<{ urls: ReadonlyArray<string> }>,
        ),
      )

    expect((yield* info()).urls).toEqual([base, "https://example.opentunnel.xyz"])
    remote.urls = []
    expect((yield* info()).urls).toEqual([base])
  }),
)

it.live("holds a request that arrives during startup until the server is ready", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const server = yield* startingServer(gate)
    yield* Effect.gen(function* () {
      const request = yield* Effect.forkChild(
        Effect.promise(() =>
          fetch(new URL("/api/location", server.base), {
            headers: { authorization: `Basic ${btoa("opencode:secret")}` },
          }),
        ),
      )
      // Startup is still open, so the request waits rather than receiving a 503.
      expect(Option.isNone(yield* Fiber.join(request).pipe(Effect.timeoutOption("300 millis")))).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(request)).status).toBe(200)
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
    yield* Fiber.join(server.starting)
  }),
)

it.live("cancels a request held for startup when its client disconnects", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const server = yield* startingServer(gate, (app) =>
      app.pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))),
    )
    yield* Effect.gen(function* () {
      const client = new AbortController()
      const request = yield* Effect.forkChild(
        Effect.promise(() =>
          fetch(new URL("/api/location", server.base), {
            headers: { authorization: `Basic ${btoa("opencode:secret")}` },
            signal: client.signal,
          }).catch(() => undefined),
        ),
      )
      yield* Effect.sleep("300 millis")
      client.abort()
      // The held request must end with its client, not when the startup wait runs out.
      yield* Deferred.await(cancelled).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.join(request)
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
    yield* Fiber.join(server.starting)
  }),
)

// Starts a server that listens but stays in startup until `gate` is released, so requests can arrive mid-startup.
const startingServer = Effect.fnUntraced(function* (
  gate: Deferred.Deferred<void>,
  transform?: ServerProcess.Transform,
) {
  const listening = yield* Deferred.make<string>()
  const starting = yield* Effect.forkChild(
    ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        app: { version: "test-version" },
        database: { path: ":memory:" },
        models: { fetch: false },
      },
      {
        onListen: (address) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(listening, HttpServer.formatAddress(address))
            yield* Deferred.await(gate)
            return Effect.void
          }),
      },
      transform,
    ),
  )
  return { base: new URL(yield* Deferred.await(listening)), starting }
})
