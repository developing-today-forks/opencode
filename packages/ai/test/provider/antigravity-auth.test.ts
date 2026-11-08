import { afterAll, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import {
  CLIENT_SECRET_NOT_FOUND_MESSAGE,
  FALLBACK_UA,
  parseKeyringCreds,
  refresh,
  TOKEN_REFRESH_MAX_RESPONSE_BYTES,
} from "../../src/providers/antigravity-auth.js"
import { handlerLayer, observe } from "../lib/http.js"
import { it } from "../lib/effect.js"

const TEST_CLIENT_SECRET = "test-client-secret"
const originalClientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET
process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = TEST_CLIENT_SECRET

afterAll(() => {
  if (originalClientSecret === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET
  else process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = originalClientSecret
})

describe("Antigravity token refresh bounding (#1469)", () => {
  it.effect("refreshes with the provisioned client secret and no agy executable", () =>
    Effect.gen(function* () {
      let observed: { method: string; url: string; body: string } | undefined
      const layer = handlerLayer((input) =>
        Effect.gen(function* () {
          const { call } = yield* observe([], input)
          observed = { method: call.method, url: call.url, body: call.body }
          return input.respond(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), {
            headers: { "content-type": "application/json" },
          })
        }),
      )
      const originalPath = process.env.PATH
      const originalAgyBin = process.env.AGY_BIN
      process.env.PATH = ""
      delete process.env.AGY_BIN
      try {
        const token = yield* refresh("refresh-fixture").pipe(Effect.provide(layer))
        expect(token.accessToken).toBe("fresh-token")
        expect(token.expiryMs).toBeGreaterThan(Date.now())
        expect(observed?.method).toBe("POST")
        expect(observed?.url).toBe("https://oauth2.googleapis.com/token")
        const body = new URLSearchParams(observed?.body)
        expect(body.get("refresh_token")).toBe("refresh-fixture")
        expect(body.get("client_secret")).toBe(TEST_CLIENT_SECRET)
      } finally {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        if (originalAgyBin === undefined) delete process.env.AGY_BIN
        else process.env.AGY_BIN = originalAgyBin
      }
    }),
  )

  it.effect("fails with provisioning guidance when the client secret is absent", () =>
    Effect.gen(function* () {
      const error = yield* refresh("refresh-fixture", undefined, "").pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.flip,
      )
      expect(error.message).toBe(CLIENT_SECRET_NOT_FOUND_MESSAGE)
      expect(error.message).toContain("ANTIGRAVITY_OAUTH_CLIENT_SECRET")
    }),
  )

  it.effect("rejects a token response body over the cap", () =>
    Effect.gen(function* () {
      const layer = handlerLayer((input) =>
        Effect.succeed(
          input.respond("x".repeat(TOKEN_REFRESH_MAX_RESPONSE_BYTES + 1), {
            headers: {
              "content-type": "application/json",
              "content-length": String(TOKEN_REFRESH_MAX_RESPONSE_BYTES + 1),
            },
          }),
        ),
      )
      const error = yield* refresh("refresh-fixture").pipe(Effect.provide(layer), Effect.flip)

      expect(error.message).toContain("exceeded")
    }),
  )

  it.effect("rejects a stalled token response at the request deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const layer = handlerLayer((input) =>
        Effect.sync(() => {
          Deferred.doneUnsafe(started, Effect.void)
          return input.respond(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"))
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        }),
      )
      const fiber = yield* refresh("refresh-fixture", 50, TEST_CLIENT_SECRET).pipe(
        Effect.provide(layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      const error = yield* Fiber.join(fiber)

      expect(error.message).toContain("timed out")
    }),
  )
})

describe("FALLBACK_UA - the audited agy wire identity", () => {
  test("is the value captured from the installed CLI's wire (agy 1.5.0)", () => {
    expect(FALLBACK_UA).toBe(
      "antigravity/cli/1.5.0 (aidev_client; os_type=linux; arch=amd64; cl=1013440158; auth_method=consumer)",
    )
    expect(FALLBACK_UA).toMatch(
      /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=linux; arch=amd64; cl=\d+; auth_method=consumer\)$/,
    )
  })
})

describe("Antigravity blank-credential rule (#1765)", () => {
  const keyringJson = (token: Record<string, string>) => JSON.stringify({ token })

  test("a whitespace-only keyring refresh_token is unexpected shape, like a missing one", () => {
    expect(() => parseKeyringCreds(keyringJson({ refresh_token: "   ", access_token: "tok" }))).toThrow(
      "keyring credential has unexpected shape",
    )
    expect(() => parseKeyringCreds(keyringJson({ access_token: "tok" }))).toThrow(
      "keyring credential has unexpected shape",
    )
  })

  test("a whitespace-only keyring access_token parses as absent, never cached or sent", () => {
    const creds = parseKeyringCreds(
      keyringJson({ refresh_token: "refresh-fixture", access_token: "   ", expiry: "2999-01-01T00:00:00.000Z" }),
    )
    expect(creds.accessToken).toBeUndefined()
    expect(creds.refreshToken).toBe("refresh-fixture")
  })

  test("padded keyring tokens are trimmed before use (control)", () => {
    const creds = parseKeyringCreds(
      keyringJson({ refresh_token: "  refresh-fixture  ", access_token: "  tok  ", expiry: "2999-01-01T00:00:00.000Z" }),
    )
    expect(creds.refreshToken).toBe("refresh-fixture")
    expect(creds.accessToken).toBe("tok")
  })

  it.effect("refresh() treats a whitespace-only access_token in the token response as no access_token", () =>
    Effect.gen(function* () {
      const layer = handlerLayer((input) =>
        Effect.succeed(
          input.respond(JSON.stringify({ access_token: "   ", expires_in: 3600 }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      )
      const error = yield* refresh("refresh-fixture").pipe(Effect.provide(layer), Effect.flip)
      expect(error.message).toContain("returned no access_token")
    }),
  )

  it.effect("refresh() trims a padded access_token in the token response (control)", () =>
    Effect.gen(function* () {
      const layer = handlerLayer((input) =>
        Effect.succeed(
          input.respond(JSON.stringify({ access_token: "  fresh-token  ", expires_in: 3600 }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      )
      const token = yield* refresh("refresh-fixture").pipe(Effect.provide(layer))
      expect(token.accessToken).toBe("fresh-token")
    }),
  )
})
