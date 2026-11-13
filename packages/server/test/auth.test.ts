import { expect, test } from "bun:test"
import { ServerAuth } from "@opencode/server/auth"
import { Effect, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { authorizedRequest } from "../src/middleware/authorization"

test("accepts only the fixed opencode username", () => {
  const config = { password: Option.some("secret"), username: "opencode" }
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
})

test("session tokens expire, resist tampering, and are revoked by changing the password", () => {
  const config = { password: Option.some("secret"), username: "opencode" }
  const now = Date.now()
  const token = ServerAuth.issueSession(config, now)
  if (!token) throw new Error("Expected a session token")
  expect(ServerAuth.verifySession(token, config, now)).toBe(true)
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make(token) }, config)).toBe(true)
  expect(ServerAuth.verifySession(token, config, now + ServerAuth.SESSION_TTL_SECONDS * 1000)).toBe(false)
  expect(ServerAuth.verifySession(`${token}x`, config, now)).toBe(false)
  const parts = token.split(".")
  expect(ServerAuth.verifySession(`${Number(parts[0]) + 1}.${parts[1]}`, config, now)).toBe(false)
  expect(ServerAuth.verifySession(token, { ...config, password: Option.some("rotated") }, now)).toBe(false)
  expect(ServerAuth.issueSession({ ...config, password: Option.none() })).toBeUndefined()
})

test("session cookies require a same-scheme same-authority Origin", async () => {
  const config = { password: Option.some("secret"), username: "opencode" }
  const token = ServerAuth.issueSession(config)
  if (!token) throw new Error("Expected a session token")
  const request = (url: string, origin?: string, headers: Record<string, string> = {}) =>
    ({
      url,
      source: new Request(new URL(url, "http://localhost:3000")),
      headers: { host: "localhost:3000", ...headers, ...(origin === undefined ? {} : { origin }) },
      cookies: { [ServerAuth.sessionCookieName("localhost:3000")]: token },
    }) as unknown as HttpServerRequest.HttpServerRequest
  const authorized = (url: string, origin?: string, headers?: Record<string, string>) =>
    Effect.runPromise(authorizedRequest(request(url, origin, headers), config))

  expect(await authorized("/api/info", "http://localhost:3000")).toBe(true)
  expect(await authorized("/api/info", "https://localhost:3000")).toBe(false)
  expect(await authorized("https://localhost:3000/api/info", "http://localhost:3000")).toBe(false)
  expect(
    await authorized("/api/info", "https://localhost:3000", { "x-forwarded-proto": "https" }),
  ).toBe(false)
  expect(await authorized("/api/info")).toBe(true)
  expect(await authorized("/api/info", "not an origin")).toBe(false)
})
