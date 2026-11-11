import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import {
  ClaudeCodeRefreshRateLimited,
  ClaudeCodeSignInError,
  ClaudeCodeCredentialWriteError,
  NOT_SIGNED_IN_MESSAGE,
  RENEWAL_LEAD_MS,
  OAUTH_AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  OAUTH_TOKEN_RESPONSE_MAX_BYTES,
  OAUTH_TOKEN_URL,
  beginClaudeCodeSignIn,
  buildCredentialsFileContents,
  claudeCodeAuth,
  expiredMessage,
  parseCredentialsFile,
  resolveCredential,
  writeCredential,
  type ClaudeCodeOAuthBlob,
  type CredentialSources,
  type RenewalEvent,
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
  test("reads the OAuth access token, its expiry, and the refresh token", () => {
    expect(parseCredentialsFile(blob("tok-file", 1893456000000))).toEqual({
      accessToken: "tok-file",
      expiresAt: 1893456000000,
      refreshToken: "fixture-refresh",
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
    const headers = await apply({ readFile: () => blob("tok-live", Date.now() + 4 * 3_600_000), env: {} })
    expect(headers.authorization).toBe("Bearer " + "tok-live")
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("an expired credential with no refresh token fails loudly instead of being sent", async () => {
    const noRefresh = JSON.stringify({ claudeAiOauth: { accessToken: "tok-old", expiresAt: 1_000 } })
    const error = await Effect.runPromise(
      claudeCodeAuth({ sources: { readFile: () => noRefresh, now: () => 2_000, env: {} } }).apply({
        request: {},
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: Headers.empty,
      }),
    ).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("expired")
    expect(JSON.stringify(error)).toContain("in-product sign-in")
    expect(JSON.stringify(error)).not.toContain("Run `claude`")
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
      claudeCodeAuth({ sources: { readFile: () => blob("tok-live", Date.now() + 4 * 3_600_000), env: {} } }).apply({
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

describe("messages — no message instructs running the `claude` binary (#1852)", () => {
  test("the not-signed-in and expired messages name the in-product sign-in", () => {
    expect(NOT_SIGNED_IN_MESSAGE).not.toContain("Run `claude`")
    expect(NOT_SIGNED_IN_MESSAGE).toContain("in-product")
    expect(expiredMessage(1_000)).not.toContain("Run `claude`")
    expect(expiredMessage(1_000)).toContain("in-product sign-in")
    expect(expiredMessage(1_000)).toContain("no refresh token")
    expect(expiredMessage(1_000)).not.toContain("does not refresh")
  })
})

describe("writeCredential — the shared atomic write helper (#1852)", () => {
  test("writes the full blob via temp+rename, preserving unrelated fields", async () => {
    const writes: Array<{ path: string; contents: string }> = []
    const renames: Array<{ from: string; to: string }> = []
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      readFile: () => JSON.stringify({ otherTool: { keep: true }, claudeAiOauth: { stale: "x", accessToken: "old" } }),
      writeFile: async (path, contents) => {
        writes.push({ path, contents })
      },
      renameFile: async (from, to) => {
        renames.push({ from, to })
      },
      randomValues: (length) => new Uint8Array(length).fill(7),
    }
    await writeCredential(sources, { accessToken: "tok-new", refreshToken: "ref-new", expiresAt: 42 })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toStartWith("/fixture/claude-dir/.credentials.json.tmp-")
    expect(renames).toEqual([{ from: writes[0]!.path, to: "/fixture/claude-dir/.credentials.json" }])
    const written = JSON.parse(writes[0]!.contents)
    expect(written.otherTool).toEqual({ keep: true })
    expect(written.claudeAiOauth).toEqual({
      stale: "x",
      accessToken: "tok-new",
      refreshToken: "ref-new",
      expiresAt: 42,
    })
  })

  test("removes the temp file when rename fails and leaves the target untouched", async () => {
    const path = "/fixture/claude-dir/.credentials.json"
    const original = JSON.stringify({ claudeAiOauth: { accessToken: "tok-old" } })
    const files = new Map([[path, original]])
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      readFile: (target) => files.get(target),
      writeFile: async (target, contents) => {
        files.set(target, contents)
      },
      renameFile: async () => {
        throw new Error("EACCES")
      },
      removeFile: async (target) => {
        files.delete(target)
      },
      randomValues: (length) => new Uint8Array(length).fill(7),
    }

    await expect(writeCredential(sources, { accessToken: "tok-new" })).rejects.toThrow("EACCES")
    expect(files.get(path)).toBe(original)
    expect([...files.keys()]).toEqual([path])
  })

  test("preserves the rename error when temp-file cleanup also fails", async () => {
    const renameError = new Error("EACCES")
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      readFile: () => undefined,
      writeFile: async () => {},
      renameFile: async () => {
        throw renameError
      },
      removeFile: async () => {
        throw new Error("EPERM")
      },
      randomValues: (length) => new Uint8Array(length).fill(7),
    }

    const error = await writeCredential(sources, { accessToken: "tok-new" }).catch((cause: unknown) => cause)
    expect(error).toBe(renameError)
  })
})

describe("writeCredential - the write boundary refuses an empty credential (code#7098)", () => {
  const guardHarness = () => {
    const writes: Array<{ path: string; contents: string }> = []
    const renames: Array<{ from: string; to: string }> = []
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      readFile: () => blob("tok-old", 1893456000000),
      writeFile: async (writePath, contents) => {
        writes.push({ path: writePath, contents })
      },
      renameFile: async (from, to) => {
        renames.push({ from, to })
      },
      randomValues: (length) => new Uint8Array(length).fill(7),
    }
    return { sources, writes, renames }
  }

  const refused: Array<[string, ClaudeCodeOAuthBlob]> = [
    ["an empty access token", { accessToken: "" }],
    ["a whitespace-only access token", { accessToken: "   " }],
    ["an empty refresh token", { accessToken: "tok-new", refreshToken: "" }],
    ["a whitespace-only refresh token", { accessToken: "tok-new", refreshToken: " " }],
    ["a zero expiry", { accessToken: "tok-new", refreshToken: "ref-new", expiresAt: 0 }],
  ]
  for (const [label, oauth] of refused) {
    test(`refuses ${label} by name and writes nothing`, async () => {
      const { sources, writes, renames } = guardHarness()
      const error = await writeCredential(sources, oauth).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(ClaudeCodeCredentialWriteError)
      expect(writes).toHaveLength(0)
      expect(renames).toHaveLength(0)
    })
  }

  test("buildCredentialsFileContents refuses an empty blob too", () => {
    expect(() => buildCredentialsFileContents(blob("tok-old"), { accessToken: "" })).toThrow(
      ClaudeCodeCredentialWriteError,
    )
  })
})

describe("claudeCodeAuth - renewal refuses a malformed success response (code#7098)", () => {
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

  const expiredBlob = () =>
    JSON.stringify({
      claudeAiOauth: { accessToken: "tok-old", refreshToken: "ref-old", expiresAt: 1_000, subscriptionType: "pro" },
      otherTool: { keep: true },
    })

  const harness = (response: () => Response) => {
    const store = new Map<string, string>([["/fixture/claude-dir/.credentials.json", expiredBlob()]])
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => 2_000,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (readPath) => store.get(readPath),
      writeFile: async (writePath, contents) => {
        store.set(writePath, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      fetchFn: async () => response(),
    }
    return { sources, store }
  }

  const okJson = (payload: Record<string, unknown>) => () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })

  test("a 200 with an empty refresh_token is discarded and the file stays byte-identical", async () => {
    const { sources, store } = harness(okJson({ access_token: "tok-new", refresh_token: "", expires_in: 3600 }))
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(JSON.stringify(error)).toContain("discarded")
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })

  test("a 200 with expires_in of 0 is discarded and the file stays byte-identical", async () => {
    const { sources, store } = harness(okJson({ access_token: "tok-new", refresh_token: "ref-new", expires_in: 0 }))
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(JSON.stringify(error)).toContain("discarded")
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })

  test("a 200 with a non-JSON body is discarded and the file stays byte-identical", async () => {
    const { sources, store } = harness(() => new Response("not json", { status: 200 }))
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })

  test("a 200 with an empty access_token is discarded and the file stays byte-identical", async () => {
    const { sources, store } = harness(okJson({ access_token: "", refresh_token: "ref-new", expires_in: 3600 }))
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(JSON.stringify(error)).toContain("discarded")
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })
})

describe("beginClaudeCodeSignIn — in-provider OAuth initiation (#1852)", () => {
  const deterministic = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251)
  const stateFrom = (url: string) => new URL(url).searchParams.get("state")!

  const harness = (overrides: Partial<CredentialSources> = {}, fetchImpl?: typeof fetch) => {
    const store = new Map<string, string>()
    const calls: Array<{ url: string; body: string }> = []
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => 1_000_000,
      randomValues: deterministic,
      readFile: (path) => store.get(path),
      writeFile: async (path, contents) => {
        store.set(path, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      fetchFn:
        fetchImpl ??
        (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), body: String(init?.body ?? "") })
          return new Response(
            JSON.stringify({
              access_token: "tok-signed-in",
              refresh_token: "ref-signed-in",
              expires_in: 3600,
              subscription_type: "pro",
              scope: "user:inference user:profile",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }),
      ...overrides,
    }
    return { sources, store, calls }
  }

  test("the authorize URL carries the verified flow constants and a PKCE S256 challenge", async () => {
    const { sources } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    const url = new URL(signIn.url)
    expect(url.origin + url.pathname).toBe(OAUTH_AUTHORIZE_URL)
    expect(url.searchParams.get("code")).toBe("true")
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")!.length).toBeGreaterThan(20)
    expect(url.searchParams.get("state")).toBeTruthy()
    expect(signIn.instructions).toContain("code#state")
  })

  test("callback exchanges the pasted code, persists atomically, and the credential resolves", async () => {
    const { sources, store, calls } = harness()
    store.set("/fixture/claude-dir/.credentials.json", JSON.stringify({ otherTool: { keep: true } }))
    const signIn = await beginClaudeCodeSignIn(sources)
    const credential = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`)
    expect(credential).toEqual({ accessToken: "tok-signed-in", expiresAt: 4_600_000, source: "credentials-file" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(OAUTH_TOKEN_URL)
    const body = new URLSearchParams(calls[0]!.body)
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("auth-code-1")
    expect(body.get("client_id")).toBe(OAUTH_CLIENT_ID)
    expect(body.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI)
    expect(body.get("code_verifier")!.length).toBeGreaterThan(20)
    const written = JSON.parse(store.get("/fixture/claude-dir/.credentials.json")!)
    expect(written.otherTool).toEqual({ keep: true })
    expect(written.claudeAiOauth).toEqual({
      accessToken: "tok-signed-in",
      refreshToken: "ref-signed-in",
      expiresAt: 4_600_000,
      subscriptionType: "pro",
      scopes: ["user:inference", "user:profile"],
    })
    await expect(resolveCredential(sources)).resolves.toMatchObject({ accessToken: "tok-signed-in" })
  })

  test("a malformed paste and a state mismatch fail named, with no exchange", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    await expect(signIn.callback("   ")).rejects.toBeInstanceOf(ClaudeCodeSignInError)
    await expect(signIn.callback("auth-code-1")).rejects.toBeInstanceOf(ClaudeCodeSignInError)
    // The state mismatch is judged on its own paste, on the SAME
    // sign-in: a failed callback does not cache its rejection (#1868).
    await expect(signIn.callback("auth-code-1#wrong-state")).rejects.toThrow("state mismatch")
    expect(calls).toHaveLength(0)
  })

  test("an exchange failure persists nothing", async () => {
    const failing = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    const { sources, store } = harness({}, failing as typeof fetch)
    const signIn = await beginClaudeCodeSignIn(sources)
    const error = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ClaudeCodeSignInError)
    expect(String(error)).toContain("400")
    expect(String(error)).not.toContain("tok-")
    expect(store.size).toBe(0)
  })

  test("a stalled token endpoint times out as a named error and persists nothing", async () => {
    let signal: AbortSignal | null | undefined
    const fetchFn: typeof fetch = async (_input, init) => {
      const requestSignal = init?.signal
      signal = requestSignal
      return await new Promise<Response>((_resolve, reject) => {
        if (!requestSignal) throw new Error("token exchange did not receive a deadline signal")
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true })
      })
    }
    const { sources, store } = harness({ tokenExchangeTimeoutMs: 10 }, fetchFn)
    const signIn = await beginClaudeCodeSignIn(sources)
    const error = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`).catch((cause: unknown) => cause)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(error).toBeInstanceOf(ClaudeCodeSignInError)
    expect(String(error)).not.toContain("tok-")
    expect(store.size).toBe(0)
  })

  test("an oversized success body fails named and persists nothing", async () => {
    const oversizedToken = "x".repeat(OAUTH_TOKEN_RESPONSE_MAX_BYTES)
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: oversizedToken }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    const { sources, store } = harness({}, fetchFn)
    const signIn = await beginClaudeCodeSignIn(sources)
    const error = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ClaudeCodeSignInError)
    expect(String(error)).toContain(`exceeded ${OAUTH_TOKEN_RESPONSE_MAX_BYTES} bytes`)
    expect(String(error)).not.toContain(oversizedToken)
    expect(store.size).toBe(0)
  })

  test.each([
    ["non-JSON", "not json"],
    ["token-less", JSON.stringify({ refresh_token: "ref-only" })],
  ])("a %s success body fails named", async (_label, body) => {
    const fetchFn: typeof fetch = async () => new Response(body, { status: 200 })
    const { sources, store } = harness({}, fetchFn)
    const signIn = await beginClaudeCodeSignIn(sources)
    const error = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ClaudeCodeSignInError)
    expect(String(error)).toContain("no access token")
    expect(store.size).toBe(0)
  })

  test("a write failure after exchange discards the tokens and leaves the file untouched", async () => {
    const { sources, store } = harness({
      writeFile: async () => {
        throw new Error("disk full")
      },
    })
    store.set("/fixture/claude-dir/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "tok-old" } }))
    const signIn = await beginClaudeCodeSignIn(sources)
    const error = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ClaudeCodeSignInError)
    expect(String(error)).toContain("discarded")
    expect(String(error)).not.toContain("tok-signed-in")
    expect(JSON.parse(store.get("/fixture/claude-dir/.credentials.json")!)).toEqual({
      claudeAiOauth: { accessToken: "tok-old" },
    })
  })

  test("a retry after a failed paste succeeds on the same sign-in (#1868)", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    await expect(signIn.callback("   ")).rejects.toBeInstanceOf(ClaudeCodeSignInError)
    await expect(signIn.callback("auth-code-1#wrong-state")).rejects.toThrow("state mismatch")
    const credential = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`)
    expect(credential).toMatchObject({ accessToken: "tok-signed-in" })
    expect(calls).toHaveLength(1)
  })

  test("a retry after a failed exchange runs a fresh exchange (#1868)", async () => {
    let attempts = 0
    const flaky: typeof fetch = async () => {
      attempts++
      if (attempts === 1)
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      return new Response(
        JSON.stringify({ access_token: "tok-second-try", refresh_token: "ref-second", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    const { sources } = harness({}, flaky)
    const signIn = await beginClaudeCodeSignIn(sources)
    const state = stateFrom(signIn.url)
    await expect(signIn.callback(`bad-code#${state}`)).rejects.toBeInstanceOf(ClaudeCodeSignInError)
    const credential = await signIn.callback(`good-code#${state}`)
    expect(credential).toMatchObject({ accessToken: "tok-second-try" })
    expect(attempts).toBe(2)
  })

  test("concurrent callbacks run exactly one token exchange", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    const pasted = `auth-code-1#${stateFrom(signIn.url)}`
    const [first, second] = await Promise.all([signIn.callback(pasted), signIn.callback(pasted)])
    expect(first).toEqual(second)
    expect(calls).toHaveLength(1)
  })

  test("tokens are never logged during sign-in", async () => {
    const logged: Array<string> = []
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    console.log = (...args: Array<unknown>) => logged.push(args.join(" "))
    console.info = console.log
    console.warn = console.log
    console.error = console.log
    try {
      const { sources } = harness()
      const signIn = await beginClaudeCodeSignIn(sources)
      await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`)
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
    }
    expect(logged.join(" ")).not.toContain("tok-signed-in")
    expect(logged.join(" ")).not.toContain("ref-signed-in")
  })
})

describe("claudeCodeAuth — renewal lead, rate-limit wait, and hold (#6120)", () => {
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

  const NOW = 10_000_000_000
  const HOUR = 3_600_000

  // A renewal that exhausts its wait (or fails transiently) retires to
  // the standing retry; with an instant injected sleep that retry spins
  // forever unless the endpoint relents. Tests in this describe whose
  // endpoint never relents park it behind this gate (ambient waits are
  // the marked ones) so it stops spinning between tests; each parked
  // retry stays parked for the life of the process. The sleep
  // registry is reset between tests so one test's waits never leak
  // into the next test's assertions.
  // The gate never resolves: a parked standing retry holds no timer
  // and cannot spin, and a pending promise does not keep the test
  // process alive once the suite finishes. (Resolving it at suite end
  // released the parked retries into instant-resolution waits, and
  // their microtask spin starved every later test in the file.)
  const gate = new Promise<void>(() => {})
  const gatedSleep = async (ms: number, unref?: boolean) => {
    // Ambient (standing-retry) waits park; the request's own waits
    // land in the shared registry the tests assert on.
    if (unref === true) await gate
    else sleeps.push(ms)
  }
  beforeEach(() => {
    sleeps.length = 0
  })

  // Each scenario is an independent credential: a unique refresh
  // token per harness keeps one test's retired standing renewal from
  // being joined by the next test's load (the renewal maps are keyed
  // by refresh token, and a parked retry stays parked — see the gate
  // note above).
  let scenario = 0
  const blobWith = (expiresAt: number) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: `ref-6120-${++scenario}`,
        expiresAt,
        subscriptionType: "max",
      },
    })

  const sleeps: Array<number> = []

  const harness = (
    response: (call: number) => Response | Promise<Response>,
    overrides: Partial<CredentialSources> = {},
    expiresAt = NOW - 1_000,
  ) => {
    const store = new Map<string, string>([["/fixture/claude-dir/.credentials.json", blobWith(expiresAt)]])
    const calls: Array<{ url: string; body: string }> = []
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => NOW,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (path) => store.get(path),
      writeFile: async (path, contents) => {
        store.set(path, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      sleep: gatedSleep,
      fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") })
        return response(calls.length)
      },
      ...overrides,
    }
    return { sources, store, calls, sleeps }
  }

  const rotated = () =>
    new Response(
      JSON.stringify({ access_token: "tok-new", refresh_token: "ref-new", expires_in: 28_800, scope: "user:inference" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )

  test("renews inside the lead window while the current token is still valid", async () => {
    const { sources, store, calls, sleeps } = harness(rotated, {}, NOW + RENEWAL_LEAD_MS - 60_000)
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-new")
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    const persisted = JSON.parse(store.get("/fixture/claude-dir/.credentials.json")!)
    expect(persisted.claudeAiOauth).toMatchObject({ accessToken: "tok-new", refreshToken: "ref-new" })
  })

  test("a valid token outside the lead window is served without any exchange", async () => {
    const { sources, calls } = harness(rotated, {}, NOW + RENEWAL_LEAD_MS + HOUR)
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-old")
    expect(calls).toHaveLength(0)
  })

  test("a 429 with Retry-After is waited out and the renewal then lands", async () => {
    const { sources, store, calls, sleeps } = harness((call) =>
      call < 3
        ? new Response("rate limited", { status: 429, headers: { "Retry-After": "7" } })
        : rotated(),
    )
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-new")
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([7_000, 7_000])
    const persisted = JSON.parse(store.get("/fixture/claude-dir/.credentials.json")!)
    expect(persisted.claudeAiOauth.accessToken).toBe("tok-new")
  })

  test("a 429 with an HTTP-date Retry-After waits until that date", async () => {
    const date = new Date(NOW + 42_000).toUTCString()
    const { sources, calls, sleeps } = harness((call) =>
      call < 2 ? new Response("rate limited", { status: 429, headers: { "Retry-After": date } }) : rotated(),
    )
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-new")
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([42_000])
  })

  test("a 429 without Retry-After backs off exponentially", async () => {
    const { sources, calls, sleeps } = harness((call) =>
      call < 3 ? new Response("rate limited", { status: 429 }) : rotated(),
    )
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-new")
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([5_000, 10_000])
  })

  test("a renewal wait that outlasts its budget surfaces RateLimit — never Authentication", async () => {
    const { sources, calls, sleeps } = harness((call) =>
      call <= 25 ? new Response("rate limited", { status: 429 }) : rotated(),
    )
    const error = await apply(sources).catch((cause: unknown) => cause)
    const text = JSON.stringify(error)
    expect(text).toContain("RateLimit")
    expect(text).toContain("rate limit")
    expect(text).not.toContain("Authentication")
    expect(text).not.toContain("no longer renewable")
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.length).toBeLessThan(25)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15 * 60_000)
  })

  test("a custom wait budget bounds the retries", async () => {
    const { sources, calls } = harness(
      () => new Response("rate limited", { status: 429 }),
      { renewalWaitBudgetMs: 16_000 },
    )
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("RateLimit")
    expect(calls).toHaveLength(3)
  })

  test("a non-429 rejection is not retried and keeps the fail-loud floor", async () => {
    const { sources, store, calls, sleeps } = harness(
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    )
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    const text = JSON.stringify(error)
    expect(text).toContain("HTTP 400")
    expect(text).not.toContain("no longer renewable")
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })

  test("concurrent requests share one waiting renewal", async () => {
    const { sources, calls, sleeps } = harness((call) =>
      call < 3 ? new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } }) : rotated(),
    )
    const results = await Promise.all([apply(sources), apply(sources), apply(sources)])
    expect(results.map((headers) => headers.authorization)).toEqual([
      "Bearer tok-new",
      "Bearer tok-new",
      "Bearer tok-new",
    ])
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([3_000, 3_000])
  })

  test("ClaudeCodeRefreshRateLimited carries the stated wait and no dead-login wording", () => {
    const error = new ClaudeCodeRefreshRateLimited(9_000)
    expect(error.retryAfterMs).toBe(9_000)
    expect(error.message).not.toContain("renewable")
  })
})

describe("claudeCodeAuth — OAuth renewal on an expired file credential (#1818)", () => {
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

  const expiredBlob = (refreshToken = "ref-old") =>
    JSON.stringify({
      claudeAiOauth: { accessToken: "tok-old", refreshToken, expiresAt: 1_000, subscriptionType: "pro" },
      otherTool: { keep: true },
    })

  // Each scenario is an independent credential: a unique refresh
  // token per harness keeps one test's retired standing renewal (the
  // write-failure test's) from being joined by the next test's load —
  // the renewal maps are keyed by refresh token.
  let scenario = 0
  const harness = (response: () => Response | Promise<Response>, overrides: Partial<CredentialSources> = {}) => {
    const refreshToken = `ref-1818-${++scenario}`
    const store = new Map<string, string>([["/fixture/claude-dir/.credentials.json", expiredBlob(refreshToken)]])
    const calls: Array<{ url: string; body: string }> = []
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => 2_000,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (path) => store.get(path),
      writeFile: async (path, contents) => {
        store.set(path, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") })
        return response()
      },
      ...overrides,
    }
    return { sources, store, calls, refreshToken }
  }

  const rotated = () =>
    new Response(
      JSON.stringify({ access_token: "tok-new", refresh_token: "ref-new", expires_in: 3600, scope: "user:inference" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )

  test("refreshes once, persists the rotated pair, and sends the new token", async () => {
    const { sources, store, calls, refreshToken } = harness(rotated)
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-new")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(OAUTH_TOKEN_URL)
    const body = new URLSearchParams(calls[0].body)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("client_id")).toBe(OAUTH_CLIENT_ID)
    expect(body.get("refresh_token")).toBe(refreshToken)
    const persisted = JSON.parse(store.get("/fixture/claude-dir/.credentials.json")!)
    expect(persisted.claudeAiOauth).toMatchObject({
      accessToken: "tok-new",
      refreshToken: "ref-new",
      expiresAt: 2_000 + 3_600_000,
    })
    expect(persisted.otherTool).toEqual({ keep: true })
    // The rotated credential is what the next resolution reads.
    await expect(resolveCredential(sources)).resolves.toMatchObject({ accessToken: "tok-new", refreshToken: "ref-new" })
  })

  test("a write failure discards the rotated tokens, leaves the file byte-identical, and fails named", async () => {
    const { sources, store } = harness(rotated, {
      renameFile: async () => {
        throw new Error("EACCES")
      },
    })
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(JSON.stringify(error)).toContain("tokens were discarded")
    expect(JSON.stringify(error)).not.toContain("tok-new")
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })

  test("invalid_grant keeps the fail-loud floor with a named re-login error and no write", async () => {
    const { sources, store } = harness(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
    const before = store.get("/fixture/claude-dir/.credentials.json")
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("HTTP 400")
    expect(JSON.stringify(error)).toContain("in-product sign-in")
    expect(store.get("/fixture/claude-dir/.credentials.json")).toBe(before)
  })

  test("concurrent expired requests share exactly one refresh exchange", async () => {
    const { sources, calls } = harness(rotated)
    const results = await Promise.all([apply(sources), apply(sources), apply(sources)])
    expect(results.map((headers) => headers.authorization)).toEqual([
      "Bearer tok-new",
      "Bearer tok-new",
      "Bearer tok-new",
    ])
    expect(calls).toHaveLength(1)
  })

  test("an env token is never refreshed and still wins over the expired file (#1752)", async () => {
    const { sources, calls } = harness(rotated)
    const headers = await apply({ ...sources, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-env" } })
    expect(headers.authorization).toBe("Bearer tok-env")
    expect(calls).toHaveLength(0)
  })

  test("tokens are never logged during renewal", async () => {
    const logged: Array<string> = []
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    console.log = (...args: Array<unknown>) => logged.push(args.join(" "))
    console.info = console.log
    console.warn = console.log
    console.error = console.log
    let refreshToken = ""
    try {
      const harnessResult = harness(rotated)
      refreshToken = harnessResult.refreshToken
      await apply(harnessResult.sources)
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
    }
    expect(logged.join(" ")).not.toContain("tok-new")
    expect(logged.join(" ")).not.toContain("ref-new")
    expect(logged.join(" ")).not.toContain(refreshToken)
  })
})

describe("standing renewal retry — the renewal outlives its request (code#8102)", () => {
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

  const NOW = 10_000_000_000

  const blobWith = (expiresAt: number, refreshToken: string) =>
    JSON.stringify({
      claudeAiOauth: { accessToken: "tok-old", refreshToken, expiresAt, subscriptionType: "max" },
    })

  const waitFor = async (condition: () => boolean) => {
    for (let spins = 0; spins < 10_000; spins++) {
      if (condition()) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error("condition never became true")
  }

  const rotated = (accessToken: string, refreshToken: string) =>
    new Response(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 28_800 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

  test("budget exhaustion retires to a standing retry that lands with no intervening request", async () => {
    const path = "/fixture/claude-dir/.credentials.json"
    const store = new Map<string, string>([[path, blobWith(NOW - 1_000, "ref-standing-a")]])
    const events: Array<RenewalEvent> = []
    let exchanges = 0
    let standingSleeps = 0
    let release: (() => void) | undefined
    let standingParked: Promise<void> | undefined
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => NOW,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (readPath) => store.get(readPath),
      writeFile: async (writePath, contents) => {
        store.set(writePath, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      sleep: (ms, unref) => {
        // The request's own waits pass through; standing-round waits
        // carry the unref marker and park behind a gate the test
        // releases one round at a time, so the round count is exact.
        if (!(unref === true)) return Promise.resolve()
        standingSleeps += 1
        if (standingSleeps <= 2) return Promise.resolve()
        return new Promise<void>((resolve) => {
          release = resolve
          standingParked = Promise.resolve()
        })
      },
      renewalWaitBudgetMs: 1_000,
      onRenewalEvent: (event) => {
        events.push(event)
      },
      fetchFn: async () => {
        exchanges += 1
        // 429 through the request's wait AND the first two standing
        // rounds; the endpoint relents on the third.
        return exchanges <= 3 ? new Response("rate limited", { status: 429 }) : rotated("tok-standing", "ref-standing-b")
      },
    }
    // The request itself surfaces the spent wait as RateLimit.
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("RateLimit")
    expect(JSON.stringify(error)).not.toContain("Authentication")
    // The standing retry has run its two free rounds and is parked in
    // the gated wait before round 3; nothing has landed yet.
    await waitFor(() => standingSleeps === 3)
    expect(JSON.parse(store.get(path)!).claudeAiOauth.accessToken).toBe("tok-old")
    // Release the gate: with NO further request, the standing retry
    // lands the renewal and persists the rotated pair itself.
    if (release === undefined) throw new Error("the standing retry never parked")
    release()
    await waitFor(() => JSON.parse(store.get(path)!).claudeAiOauth.accessToken === "tok-standing")
    expect(exchanges).toBe(4)
    expect(JSON.parse(store.get(path)!).claudeAiOauth).toMatchObject({
      accessToken: "tok-standing",
      refreshToken: "ref-standing-b",
    })
    expect(events.map((event) => event.kind)).toEqual([
      "attempt",
      "rate-limited",
      "budget-exhausted",
      "standing-scheduled",
      "attempt",
      "rate-limited",
      "budget-exhausted",
      "attempt",
      "rate-limited",
      "budget-exhausted",
      "attempt",
      "landed",
    ])
    expect(events).toContainEqual({ kind: "landed", at: NOW, expiresAt: NOW + 28_800_000 })
    // A later request serves the rotated credential with no new exchange.
    const headers = await apply(sources)
    expect(headers.authorization).toBe("Bearer tok-standing")
    expect(exchanges).toBe(4)
  })

  test("a genuine rejection stops the standing retry and surfaces the real error", async () => {
    const path = "/fixture/claude-dir/.credentials.json"
    const store = new Map<string, string>([[path, blobWith(NOW - 1_000, "ref-standing-c")]])
    const events: Array<RenewalEvent> = []
    let exchanges = 0
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => NOW,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (readPath) => store.get(readPath),
      writeFile: async (writePath, contents) => {
        store.set(writePath, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      sleep: async () => {},
      renewalWaitBudgetMs: 1_000,
      onRenewalEvent: (event) => {
        events.push(event)
      },
      fetchFn: async () => {
        exchanges += 1
        // One 429 spends the request's (tiny) budget; the standing
        // round then meets the endpoint refusing the grant itself —
        // the standing retry must stop there.
        return exchanges === 1
          ? new Response("rate limited", { status: 429 })
          : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      },
    }
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("RateLimit")
    await waitFor(() => events.some((event) => event.kind === "rejected"))
    expect(events.map((event) => event.kind)).toEqual([
      "attempt",
      "rate-limited",
      "budget-exhausted",
      "standing-scheduled",
      "attempt",
      "rejected",
    ])
    expect(JSON.stringify(events)).toContain("HTTP 400")
    const settled = exchanges
    // The retry has stopped: no further exchanges happen, and a later
    // load surfaces the genuine rejection instead of joining a zombie.
    const later = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(later)).toContain("HTTP 400")
    expect(exchanges).toBe(settled + 1)
    expect(store.get(path)).toBe(blobWith(NOW - 1_000, "ref-standing-c"))
  })

  test("a load during a standing retry adopts its outcome and runs no exchange of its own", async () => {
    const path = "/fixture/claude-dir/.credentials.json"
    const store = new Map<string, string>([[path, blobWith(NOW - 1_000, "ref-join-a")]])
    let exchanges = 0
    let cadenceSleeps = 0
    let renameParked = false
    let releaseCadence: (() => void) | undefined
    let releaseRename: (() => void) | undefined
    const cadenceGate = new Promise<void>((resolve) => (releaseCadence = resolve))
    const renameGate = new Promise<void>((resolve) => (releaseRename = resolve))
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => NOW,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (readPath) => store.get(readPath),
      writeFile: async (writePath, contents) => {
        store.set(writePath, contents)
      },
      renameFile: async (from, to) => {
        // The standing round's persist parks at the rename, so the
        // joining load below provably reads the pre-renewal file and
        // meets a standing entry that is still pending — the landing
        // cannot slip past it through the file, and the entry cannot
        // have settled and been cleaned up.
        if (to === path) {
          renameParked = true
          await renameGate
        }
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      sleep: async (ms, unref) => {
        // The request's own waits pass through; the standing loop's
        // first cadence wait (ambient) parks behind the gate until
        // the test releases the retry.
        if (unref !== true) return
        cadenceSleeps += 1
        if (cadenceSleeps === 1) await cadenceGate
      },
      renewalWaitBudgetMs: 1_000,
      fetchFn: async () => {
        exchanges += 1
        // The first request's exchange is walled (its tiny budget
        // retires the renewal to the standing retry); the standing
        // round's exchange lands the rotation.
        return exchanges === 1
          ? new Response("rate limited", { status: 429 })
          : rotated("tok-joined-a", "ref-join-b")
      },
    }
    // The first request spends its budget and surfaces the wait.
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("RateLimit")
    expect(exchanges).toBe(1)
    // The standing retry is parked at its first cadence wait. One
    // macrotask turn flushes the first request's settled in-flight
    // bookkeeping, so the load below meets exactly one piece of
    // state: the pending standing entry.
    await waitFor(() => cadenceSleeps === 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Release the retry: its round exchanges and parks mid-persist.
    releaseCadence!()
    await waitFor(() => renameParked)
    expect(exchanges).toBe(2)
    expect(JSON.parse(store.get(path)!).claudeAiOauth.accessToken).toBe("tok-old")
    // A second load starts while the renewal is still pending, and
    // the persist is released in the same turn: the landing completes
    // in microtasks, inside the load's join window, so the load
    // adopts the standing outcome as its own.
    const joined = apply(sources)
    releaseRename!()
    const headers = await joined
    expect(headers.authorization).toBe("Bearer tok-joined-a")
    // The single-flight oracle, pinned: exactly two exchanges in the
    // whole episode — the first request's walled attempt and the
    // standing round's landing. The joined load ran none of its own.
    expect(exchanges).toBe(2)
    expect(JSON.parse(store.get(path)!).claudeAiOauth).toMatchObject({
      accessToken: "tok-joined-a",
      refreshToken: "ref-join-b",
    })
    // A later request serves the rotated credential with no new exchange.
    const later = await apply(sources)
    expect(later.authorization).toBe("Bearer tok-joined-a")
    expect(exchanges).toBe(2)
  })

  test("a load during a pending standing retry runs no exchange of its own", async () => {
    const path = "/fixture/claude-dir/.credentials.json"
    const store = new Map<string, string>([[path, blobWith(NOW - 1_000, "ref-join-c")]])
    let exchanges = 0
    let cadenceSleeps = 0
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => NOW,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (readPath) => store.get(readPath),
      writeFile: async (writePath, contents) => {
        store.set(writePath, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      sleep: async (ms, unref) => {
        // The standing loop's cadence waits park behind a gate that
        // never resolves: the retry stays pending for the whole test
        // (the #6120 harness precedent — a parked retry holds no
        // timer and does not keep the test process alive).
        if (unref === true) {
          cadenceSleeps += 1
          await new Promise<void>(() => {})
        }
      },
      renewalWaitBudgetMs: 1_000,
      fetchFn: async () => {
        exchanges += 1
        return new Response("rate limited", { status: 429 })
      },
    }
    // The first request spends its budget and retires the renewal.
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("RateLimit")
    expect(exchanges).toBe(1)
    await waitFor(() => cadenceSleeps === 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A load whose credential has EXPIRED while the renewal is still
    // pending surfaces the renewal-pending rate limit — it is not
    // served the dead credential as a success — and runs no exchange
    // of its own: the count stays pinned at the first request's one.
    const blocked = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(blocked)).toContain("RateLimit")
    expect(JSON.stringify(blocked)).not.toContain("Authentication")
    expect(exchanges).toBe(1)
    // The same pending renewal, met by a load whose credential is
    // still valid inside the lead window, serves that credential —
    // the documented fall-through — still with no exchange of its own.
    store.set(path, blobWith(NOW + 3_600_000, "ref-join-c"))
    const served = await apply(sources)
    expect(served.authorization).toBe("Bearer tok-old")
    expect(exchanges).toBe(1)
  })

  test("a transient exchange failure also retires to the standing retry", async () => {
    const path = "/fixture/claude-dir/.credentials.json"
    const store = new Map<string, string>([[path, blobWith(NOW - 1_000, "ref-standing-f")]])
    const events: Array<RenewalEvent> = []
    let exchanges = 0
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => NOW,
      randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
      readFile: (readPath) => store.get(readPath),
      writeFile: async (writePath, contents) => {
        store.set(writePath, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      sleep: async () => {},
      onRenewalEvent: (event) => {
        events.push(event)
      },
      fetchFn: async () => {
        exchanges += 1
        if (exchanges === 1) throw new Error("connection reset")
        return rotated("tok-transient", "ref-standing-g")
      },
    }
    const error = await apply(sources).catch((cause: unknown) => cause)
    expect(JSON.stringify(error)).toContain("failed to reach the token endpoint")
    await waitFor(() => JSON.parse(store.get(path)!).claudeAiOauth.accessToken === "tok-transient")
    expect(exchanges).toBe(2)
    expect(events.map((event) => event.kind)).toEqual(["attempt", "standing-scheduled", "attempt", "landed"])
  })

  test("the lifecycle is reconstructible from the default log lines alone", async () => {
    const store = new Map<string, string>([
      ["/fixture/claude-dir/.credentials.json", blobWith(NOW - 1_000, "ref-standing-h")],
    ])
    const logged: Array<string> = []
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    console.log = (...args: Array<unknown>) => logged.push(args.join(" "))
    console.info = console.log
    console.warn = console.log
    console.error = console.log
    let exchanges = 0
    try {
      const sources: CredentialSources = {
        env: {},
        configDir: "/fixture/claude-dir",
        now: () => NOW,
        randomValues: (length) => Uint8Array.from({ length }, (_, i) => i % 251),
        readFile: (readPath) => store.get(readPath),
        writeFile: async (writePath, contents) => {
          store.set(writePath, contents)
        },
        renameFile: async (from, to) => {
          store.set(to, store.get(from)!)
          store.delete(from)
        },
        sleep: async () => {},
        renewalWaitBudgetMs: 1_000,
        fetchFn: async () => {
          exchanges += 1
          return exchanges === 1 ? new Response("rate limited", { status: 429 }) : rotated("tok-logged", "ref-standing-i")
        },
      }
      await apply(sources).catch(() => {})
      await waitFor(() => logged.some((line) => line.includes("renewal landed")))
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
    }
    const text = logged.join("\n")
    expect(text).toContain("renewal attempt 1 at")
    expect(text).toContain("rate limited (HTTP 429)")
    expect(text).toContain("budget exhausted")
    expect(text).toContain("standing renewal retry scheduled")
    expect(text).toContain("renewal landed")
    expect(text).not.toContain("tok-logged")
    expect(text).not.toContain("ref-standing-h")
    expect(text).not.toContain("ref-standing-i")
  })
})

describe("renewal single-flight (#1818)", () => {
  test("concurrent resolutions of the same expired credential issue one exchange", async () => {
    const store = new Map<string, string>([
      [
        "/fixture/claude-dir/.credentials.json",
        JSON.stringify({ claudeAiOauth: { accessToken: "tok-old", refreshToken: "ref-sf", expiresAt: 1_000 } }),
      ],
    ])
    let exchanges = 0
    const sources: CredentialSources = {
      env: {},
      configDir: "/fixture/claude-dir",
      now: () => 2_000,
      readFile: (path) => store.get(path),
      writeFile: async (path, contents) => {
        store.set(path, contents)
      },
      renameFile: async (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      fetchFn: async () => {
        exchanges += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Response(
          JSON.stringify({ access_token: "tok-sf-new", refresh_token: "ref-sf-new", expires_in: 3600 }),
          {
            status: 200,
          },
        )
      },
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        Effect.runPromise(
          claudeCodeAuth({ sources }).apply({
            request: {},
            method: "POST",
            url: "https://api.anthropic.com/v1/messages",
            body: "{}",
            headers: Headers.empty,
          }),
        ),
      ),
    )
    expect(exchanges).toBe(1)
    expect(results.every((headers) => headers.authorization === "Bearer tok-sf-new")).toBe(true)
  })
})
