import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import {
  CLI_VERSION,
  NOT_SIGNED_IN_MESSAGE,
  cliHeaders,
  commandCodeAuth,
  parseAuthFile,
  resolveApiKey,
  type CredentialSources,
} from "../../src/providers/commandcode-auth.js"

const authFile = (apiKey: string) =>
  JSON.stringify({
    apiKey,
    userId: "u-1",
    userName: "fixture",
    keyName: "fixture-key",
    authenticatedAt: "2026-10-24T00:00:00Z",
  })

describe("parseAuthFile — the CLI's ~/.commandcode/auth.json shape", () => {
  test("reads the apiKey the CLI login stored", () => {
    expect(parseAuthFile(authFile("user_fixturekey"))).toBe("user_fixturekey")
  })

  test("malformed or foreign content reads as no credential", () => {
    expect(parseAuthFile("not json")).toBeUndefined()
    expect(parseAuthFile("{}")).toBeUndefined()
    expect(parseAuthFile(JSON.stringify({ apiKey: "" }))).toBeUndefined()
  })

  test("a whitespace-only apiKey reads as no credential, and a padded key is trimmed (#1763)", () => {
    expect(parseAuthFile(JSON.stringify({ apiKey: "   " }))).toBeUndefined()
    expect(parseAuthFile(authFile("  user_paddedkey  "))).toBe("user_paddedkey")
  })
})

describe("resolveApiKey — env first, then the CLI's login file", () => {
  test("COMMAND_CODE_API_KEY wins over the file", async () => {
    const sources: CredentialSources = {
      env: { COMMAND_CODE_API_KEY: "user_envkey" },
      readFile: () => authFile("user_filekey"),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("user_envkey")
  })

  test("COMMANDCODE_API_KEY is accepted as the second env spelling", async () => {
    const sources: CredentialSources = { env: { COMMANDCODE_API_KEY: "user_envkey2" }, readFile: () => undefined }
    await expect(resolveApiKey(sources)).resolves.toBe("user_envkey2")
  })

  test("the login file is the fallback, read from ~/.commandcode", async () => {
    let seenPath = ""
    const sources: CredentialSources = {
      env: {},
      authDir: "/fixture/cc-dir",
      readFile: (path) => {
        seenPath = path
        return authFile("user_filekey")
      },
    }
    await expect(resolveApiKey(sources)).resolves.toBe("user_filekey")
    expect(seenPath).toBe("/fixture/cc-dir/auth.json")
  })

  test("nothing anywhere resolves to undefined", async () => {
    await expect(resolveApiKey({ env: {}, readFile: () => undefined })).resolves.toBeUndefined()
  })

  test("a whitespace-only env var does not shadow the login file (#1763)", async () => {
    const sources: CredentialSources = {
      env: { COMMAND_CODE_API_KEY: "   " },
      readFile: () => authFile("user_filekey"),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("user_filekey")
  })

  test("a padded env value resolves to the trimmed key (#1763)", async () => {
    const sources: CredentialSources = { env: { COMMAND_CODE_API_KEY: "  user_envkey  " }, readFile: () => undefined }
    await expect(resolveApiKey(sources)).resolves.toBe("user_envkey")
  })
})

describe("commandCodeAuth — the CLI's headers, fail-closed when signed out", () => {
  test("cliHeaders stamps the CLI's identity headers alongside the key", () => {
    const headers = cliHeaders("user_fixturekey")
    expect(headers.authorization).toBe("Bearer " + "user_fixturekey")
    expect(headers["user-agent"]).toBe("cli")
    expect(headers["x-command-code-version"]).toBe(CLI_VERSION)
    expect(headers["x-cli-environment"]).toBe("production")
  })

  test("a resolved key is applied with the CLI headers", async () => {
    const headers = await Effect.runPromise(
      commandCodeAuth({ sources: { env: { COMMAND_CODE_API_KEY: "user_envkey" } } }).apply({
        request: {},
        method: "POST",
        url: "https://api.commandcode.ai/alpha/generate",
        body: "{}",
        headers: Headers.empty,
      }),
    )
    expect(headers.authorization).toBe("Bearer " + "user_envkey")
    expect(headers["x-command-code-version"]).toBe(CLI_VERSION)
  })

  test("a cliVersion override replaces the tracked version header", async () => {
    const headers = await Effect.runPromise(
      commandCodeAuth({ apiKey: "user_static", cliVersion: "9.9.9" }).apply({
        request: {},
        method: "POST",
        url: "https://api.commandcode.ai/alpha/generate",
        body: "{}",
        headers: Headers.empty,
      }),
    )
    expect(headers["x-command-code-version"]).toBe("9.9.9")
  })

  test("no sign-in anywhere fails loudly with the login instructions", async () => {
    const error = await Effect.runPromise(
      commandCodeAuth({ sources: { env: {}, readFile: () => undefined } }).apply({
        request: {},
        method: "POST",
        url: "https://api.commandcode.ai/alpha/generate",
        body: "{}",
        headers: Headers.empty,
      }),
    ).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain(NOT_SIGNED_IN_MESSAGE.slice(0, 40))
  })
})
