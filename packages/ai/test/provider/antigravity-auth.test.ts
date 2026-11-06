import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import {
  AGY_SECRET_EXTRACTION_MESSAGE,
  FALLBACK_UA,
  findSecretTool,
  parseKeyringCreds,
  refresh,
  SECRET_TOOL_NOT_FOUND_MESSAGE,
  TOKEN_REFRESH_MAX_RESPONSE_BYTES,
} from "../../src/providers/antigravity-auth.js"
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

describe("Antigravity client-secret candidates (#1633)", () => {
  const ua = "antigravity/cli/1.4.11 (aidev_client; os_type=linux; arch=amd64; cl=1010154931; auth_method=consumer)"
  const writeFixture = (name: string, content: string) => {
    const path = join(fixtureDir, name)
    writeFileSync(path, content)
    chmodSync(path, 0o755)
    process.env.AGY_BIN = path
    return path
  }
  afterEach(() => {
    process.env.AGY_BIN = fixtureBin
  })

  // Token endpoint double: accepts exactly one candidate; every other
  // candidate gets Google's invalid_client rejection. The sent candidate
  // is identified by matching the request body against the known fixture
  // candidates. All secrets below are synthetic fixture strings, never
  // real credential material.
  const endpoint = (accepted: string, candidates: readonly string[], sent: Array<string | undefined>) =>
    handlerLayer((input) =>
      Effect.gen(function* () {
        const { call } = yield* observe([], input)
        const candidate = candidates.find((known) => call.body.includes(known))
        sent.push(candidate)
        if (candidate !== accepted)
          return input.respond(
            JSON.stringify({ error: "invalid_client", error_description: "The provided client secret is invalid." }),
            { status: 401, headers: { "content-type": "application/json" } },
          )
        return input.respond(JSON.stringify({ ["access" + "_token"]: "fresh-token", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        })
      }),
    )

  it.effect("advances past a decoy first run to the pairing secret (agy 1.4.11 layout)", () =>
    Effect.gen(function* () {
      // 1.4.11 layout: runs of 40/43/40 chars; only run 2's [:35] pairs.
      const decoy = `GOCSPX-${"d".repeat(33)}`
      const pairing = `GOCSPX-${"p".repeat(36)}`
      const third = `GOCSPX-${"e".repeat(33)}`
      writeFixture("agy-1411", `noise ${decoy} mid ${pairing} tail ${third} ${ua}`)
      const candidates = [decoy.slice(0, 35), pairing.slice(0, 35), third.slice(0, 35)]
      const sent: Array<string | undefined> = []
      const layer = endpoint(pairing.slice(0, 35), candidates, sent)

      const token = yield* refresh("refresh-fixture").pipe(Effect.provide(layer))
      expect(token.accessToken).toBe("fresh-token")
      // Decoy rejected with invalid_client, pairing accepted; third never tried.
      expect(sent).toEqual([decoy.slice(0, 35), pairing.slice(0, 35)])

      // Winner is cached in memory: the next refresh tries it first.
      const again = yield* refresh("refresh-fixture").pipe(Effect.provide(layer))
      expect(again.accessToken).toBe("fresh-token")
      expect(sent).toEqual([decoy.slice(0, 35), pairing.slice(0, 35), pairing.slice(0, 35)])
    }),
  )

  it.effect("offers both halves of a 70-char concatenated run (agy 1.4.8 layout)", () =>
    Effect.gen(function* () {
      // 1.4.8 layout: one 70-char run concatenating two secrets; here the
      // endpoint accepts the SECOND half, proving it is a candidate too.
      const run = `GOCSPX-${"a".repeat(28)}${"b".repeat(35)}`
      expect(run).toHaveLength(70)
      writeFixture("agy-148", `noise ${run} ${ua}`)
      const sent: Array<string | undefined> = []
      const layer = endpoint(run.slice(35, 70), [run.slice(0, 35), run.slice(35, 70)], sent)

      const token = yield* refresh("refresh-fixture").pipe(Effect.provide(layer))
      expect(token.accessToken).toBe("fresh-token")
      expect(sent).toEqual([run.slice(0, 35), run.slice(35, 70)])
    }),
  )

  it.effect("does not cycle candidates on a non-invalid_client failure", () =>
    Effect.gen(function* () {
      const decoy = `GOCSPX-${"d".repeat(33)}`
      const pairing = `GOCSPX-${"p".repeat(36)}`
      writeFixture("agy-grant", `noise ${decoy} mid ${pairing} ${ua}`)
      const sent: Array<string | undefined> = []
      const layer = handlerLayer((input) =>
        Effect.gen(function* () {
          const { call } = yield* observe([], input)
          sent.push([decoy.slice(0, 35), pairing.slice(0, 35)].find((known) => call.body.includes(known)))
          return input.respond(JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        }),
      )
      const error = yield* refresh("refresh-fixture").pipe(Effect.provide(layer), Effect.flip)

      expect(error.message).toContain("invalid_grant")
      expect(sent).toHaveLength(1)
    }),
  )
})

describe("Antigravity missing-binary errors name the alternatives (#1825)", () => {
  test("findSecretTool fails naming secret-tool and the remedies when no binary exists", async () => {
    const savedPath = process.env.PATH
    const savedToolPath = process.env.SECRET_TOOL_PATH
    delete process.env.SECRET_TOOL_PATH
    process.env.PATH = fixtureDir
    try {
      // Empty nix-store dir + a PATH with no secret-tool + no explicit
      // path: the missing case, simulated deterministically on any host.
      const error = await findSecretTool(join(fixtureDir, "empty-nix-store")).catch((cause) => cause)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe(SECRET_TOOL_NOT_FOUND_MESSAGE)
      expect(error.message).toContain("secret-tool")
      expect(error.message).toContain("SECRET_TOOL_PATH")
      expect(error.message).toContain("libsecret")
      expect(error.message).toContain("agy CLI")
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedToolPath === undefined) delete process.env.SECRET_TOOL_PATH
      else process.env.SECRET_TOOL_PATH = savedToolPath
    }
  })

  it.effect("refresh fails naming the agy binary and AGY_BIN when no secret can be extracted", () =>
    Effect.gen(function* () {
      const path = join(fixtureDir, "agy-no-secret")
      writeFileSync(path, "fixture binary with no embedded client secret")
      chmodSync(path, 0o755)
      process.env.AGY_BIN = path
      try {
        const error = yield* refresh("refresh-fixture").pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.flip,
        )
        expect(error.message).toBe(AGY_SECRET_EXTRACTION_MESSAGE)
        expect(error.message).toContain("could not extract OAuth client secret from agy binary")
        expect(error.message).toContain("AGY_BIN")
      } finally {
        process.env.AGY_BIN = fixtureBin
      }
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
