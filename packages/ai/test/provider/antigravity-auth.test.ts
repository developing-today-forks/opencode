import { afterAll, describe, expect } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { refresh, TOKEN_REFRESH_MAX_RESPONSE_BYTES } from "../../src/providers/antigravity-auth.js"
import { handlerLayer, observe } from "../lib/http.js"
import { it } from "../lib/effect.js"

const originalAgyBin = process.env.AGY_BIN

// refresh() extracts the OAuth client secret from the agy binary; point it
// at a fixture binary carrying an embedded GOCSPX blob + UA string.
const fixtureDir = mkdtempSync(join(tmpdir(), "antigravity-auth-test-"))
const fixtureBin = join(fixtureDir, "agy")
writeFileSync(
  fixtureBin,
  `fixture GOCSPX-${"a".repeat(40)} antigravity/cli/1.4.11 (aidev_client; os_type=linux; arch=amd64; cl=1010154931; auth_method=consumer)`,
)
chmodSync(fixtureBin, 0o755)
process.env.AGY_BIN = fixtureBin

afterAll(() => {
  if (originalAgyBin === undefined) delete process.env.AGY_BIN
  else process.env.AGY_BIN = originalAgyBin
})

describe("Antigravity token refresh bounding (#1469)", () => {
  it.effect("refreshes through the Effect HTTP client", () =>
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
      const token = yield* refresh("refresh-fixture").pipe(Effect.provide(layer))

      expect(token.accessToken).toBe("fresh-token")
      expect(token.expiryMs).toBeGreaterThan(Date.now())
      expect(observed?.method).toBe("POST")
      expect(observed?.url).toBe("https://oauth2.googleapis.com/token")
      expect(new URLSearchParams(observed?.body).get("refresh_token")).toBe("refresh-fixture")
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
      const fiber = yield* refresh("refresh-fixture", 50).pipe(
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
