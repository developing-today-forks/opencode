import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import {
  NOT_SIGNED_IN_MESSAGE,
  claudeCodeAuth,
  parseCredentialsFile,
  resolveCredential,
  type CredentialSources,
} from "../../src/providers/claude-code-auth.js"
import { ClaudeCodeMessages } from "../../src/protocols/claude-code-messages.js"

const blob = (accessToken: string, expiresAt?: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "fixture-refresh",
      ...(expiresAt === undefined ? {} : { expiresAt }),
      subscriptionType: "pro",
    },
  })

describe("parseCredentialsFile — the CLI's ~/.claude/.credentials.json shape", () => {
  test("reads the OAuth access token and its expiry", () => {
    expect(parseCredentialsFile(blob("tok-file", 1893456000000))).toEqual({
      accessToken: "tok-file",
      expiresAt: 1893456000000,
      source: "credentials-file",
    })
  })

  test("malformed or foreign content reads as no credential", () => {
    expect(parseCredentialsFile("not json")).toBeUndefined()
    expect(parseCredentialsFile("{}")).toBeUndefined()
    expect(parseCredentialsFile(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeUndefined()
    expect(parseCredentialsFile(JSON.stringify({ other: {} }))).toBeUndefined()
  })

  test("a whitespace-only access token reads as no credential, and a padded token is trimmed (#1763)", () => {
    expect(parseCredentialsFile(blob("   "))).toBeUndefined()
    expect(parseCredentialsFile(blob("  tok-padded  "))).toMatchObject({ accessToken: "tok-padded" })
  })
})

describe("resolveCredential — credentials file first, env second", () => {
  test("the credentials file wins over the environment", async () => {
    const sources: CredentialSources = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" },
      readFile: () => blob("tok-file"),
    }
    await expect(resolveCredential(sources)).resolves.toMatchObject({ accessToken: "tok-file" })
  })

  test("the env token is the fallback when the file has no credential", async () => {
    const sources: CredentialSources = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" },
      readFile: () => undefined,
    }
    await expect(resolveCredential(sources)).resolves.toEqual({ accessToken: "tok-env", source: "environment" })
  })

  test("CLAUDE_CONFIG_DIR selects the credentials directory", async () => {
    let seenPath = ""
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      readFile: (path) => {
        seenPath = path
        return blob("tok-dir")
      },
    }
    await expect(resolveCredential(sources)).resolves.toMatchObject({ accessToken: "tok-dir" })
    expect(seenPath).toBe("/fixture/claude-dir/.credentials.json")
  })

  test("nothing anywhere resolves to undefined", async () => {
    await expect(resolveCredential({ env: {}, readFile: () => undefined })).resolves.toBeUndefined()
  })

  test("a whitespace-only file token falls through to the env token (#1763)", async () => {
    const sources: CredentialSources = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" },
      readFile: () => blob("   "),
    }
    await expect(resolveCredential(sources)).resolves.toEqual({ accessToken: "tok-env", source: "environment" })
  })

  test("an expired file credential falls through to the env token (#1752)", async () => {
    const sources: CredentialSources = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" },
      readFile: () => blob("tok-old", 1_000),
      now: () => 2_000,
    }
    await expect(resolveCredential(sources)).resolves.toEqual({ accessToken: "tok-env", source: "environment" })
  })

  test("an expired file credential with no env token is returned, so the loud failure still fires (#1752)", async () => {
    const sources: CredentialSources = {
      env: {},
      readFile: () => blob("tok-old", 1_000),
      now: () => 2_000,
    }
    await expect(resolveCredential(sources)).resolves.toMatchObject({
      accessToken: "tok-old",
      source: "credentials-file",
    })
  })

  test("an unexpired file credential still wins over the env token (#1752)", async () => {
    const sources: CredentialSources = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" },
      readFile: () => blob("tok-file", 3_000),
      now: () => 2_000,
    }
    await expect(resolveCredential(sources)).resolves.toMatchObject({ accessToken: "tok-file" })
  })

  test("a whitespace-only env token resolves to undefined (#1763)", async () => {
    await expect(
      resolveCredential({ env: { CLAUDE_CODE_OAUTH_TOKEN: "   " }, readFile: () => undefined }),
    ).resolves.toBeUndefined()
  })
})

describe("claudeCodeAuth — fail-closed credential behavior (#6117)", () => {
  const apply = (sources: CredentialSources) =>
    Effect.runPromise(
      claudeCodeAuth({ sources }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: Headers.empty,
      }),
    )

  test("a live credential becomes the Bearer header (never x-api-key)", async () => {
    const headers = await apply({ readFile: () => blob("tok-live", Date.now() + 3_600_000), env: {} })
    expect(headers.authorization).toBe("Bearer " + "tok-live")
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("an expired credential fails loudly instead of being sent or refreshed", async () => {
    const error = await Effect.runPromise(
      claudeCodeAuth({ sources: { readFile: () => blob("tok-old", 1_000), now: () => 2_000, env: {} } }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: Headers.empty,
      }),
    ).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("expired")
    expect(JSON.stringify(error)).toContain("Run `claude`")
  })

  test("an expired file credential with a valid env token sends the env token (#1752)", async () => {
    const headers = await apply({
      readFile: () => blob("tok-old", 1_000),
      now: () => 2_000,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" },
    })
    expect(headers.authorization).toBe("Bearer " + "tok-env")
  })

  test("no sign-in anywhere fails with the sign-in instructions", async () => {
    const error = await Effect.runPromise(
      claudeCodeAuth({ sources: { readFile: () => undefined, env: {} } }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: Headers.empty,
      }),
    ).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain(NOT_SIGNED_IN_MESSAGE.slice(0, 40))
  })

  test("a static access token (tests/offline) bypasses the file entirely", async () => {
    const headers = await Effect.runPromise(
      claudeCodeAuth({ accessToken: "tok-static" }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: Headers.empty,
      }),
    )
    expect(headers.authorization).toBe("Bearer " + "tok-static")
  })
})

describe("claudeCodeAuth - the CLI's User-Agent, re-stamped after the transport merge", () => {
  // Session requests carry the harness's own UA in request.http.headers,
  // and the transport merges those over the route's static headers, so
  // the CLI UA reaches the wire only because auth re-stamps it here.
  const sessionHeaders = () => Headers.fromInput({ "User-Agent": "opencode/prod/test/cli" })

  test("CLI_USER_AGENT is the audited binary's value (claude 2.1.306)", () => {
    expect(ClaudeCodeMessages.CLI_USER_AGENT).toBe("claude-cli/2.1.306 (external, cli)")
  })

  test("the credentials-file path stamps the CLI UA over the session UA", async () => {
    const headers = await Effect.runPromise(
      claudeCodeAuth({ sources: { readFile: () => blob("tok-live", Date.now() + 3_600_000), env: {} } }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: sessionHeaders(),
      }),
    )
    expect(headers["user-agent"]).toBe(ClaudeCodeMessages.CLI_USER_AGENT)
    expect(headers.authorization).toBe("Bearer " + "tok-live")
  })

  test("the static access-token path stamps the CLI UA over the session UA", async () => {
    const headers = await Effect.runPromise(
      claudeCodeAuth({ accessToken: "tok-static" }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: sessionHeaders(),
      }),
    )
    expect(headers["user-agent"]).toBe(ClaudeCodeMessages.CLI_USER_AGENT)
    expect(headers.authorization).toBe("Bearer " + "tok-static")
  })
})
