// Claude Code credential bridge — the claude-code provider (#6117) emulates
// the Claude Code CLI's wire behavior natively (Anthropic Messages API with
// the subscription OAuth credential); this module mirrors the CLI's own
// credential storage so the provider spends the exact credential the
// one-time `claude` sign-in provisions.
//
// The CLI (verified on the fleet laptop, Claude Code 2.1.306) stores its
// claude.ai OAuth login in ~/.claude/.credentials.json (0600) as
//   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-...",
//                        "refreshToken": "sk-ant-ort01-...",
//                        "expiresAt": <epoch ms>, "subscriptionType": ... } }
// and sends the access token as `Authorization: Bearer <token>` — never
// x-api-key (an API key would bill the pay-as-you-go API instead of the
// subscription; bin/claude-code-proxy.mjs in developing-today/code strips
// ANTHROPIC_API_KEY from the CLI's env for exactly this reason).
//
// Resolution order:
//   0. explicit config: `auth` override, then static `accessToken`
//      (fork-level, for tests/offline — mirrors antigravity-auth's inputs)
//   1. ~/.claude/.credentials.json (CLAUDE_CONFIG_DIR overrides the
//      directory, matching the CLI and the fork's claude quota provider)
//   2. environment CLAUDE_CODE_OAUTH_TOKEN (the CLI's own headless token
//      variable; a bare token carries no expiry metadata)
//
// An EXPIRED credentials-file credential falls through to source 2
// (#1752): an expired token is not a usable credential, so resolution
// continues to the operator's explicitly-set headless env token when
// one exists (the malformed-file fall-through is the precedent). This
// is not a silent degradation — the env token is a credential the
// operator deliberately configured — and when no env token exists the
// expired file credential is still returned, so the loud expired
// failure below fires exactly as before.
//
// The credential is read IN PLACE, fresh per request, never copied into
// the fork's credential store, and never logged. The writes to the file
// are the in-provider OAuth sign-in (#1852) and the OAuth renewal below
// (#1818): both write the FULL claudeAiOauth blob atomically (temp file
// + rename, 0600) through the single write helper, preserving unrelated
// fields, so a provider sign-in and a CLI sign-in stay interchangeable.
//
// An expired credentials-file credential carrying a refresh token is
// renewed in place (#1818): one form-encoded refresh-token exchange with
// the Claude Code client identity, and the rotated pair is written back
// BEFORE the new access token is used — Anthropic rotates the refresh
// token on every exchange, so an unpersisted rotated token would burn the
// login. A failed write discards the rotated pair and leaves the file
// untouched; a failed exchange keeps the fail-loud floor. The env token
// (#1752) and an expired file with no refresh token still fail LOUDLY
// (see claudeCodeAuth) instead of silently degrading.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { deadlineSignal, readBoundedResponseText } from "@opencode/util/http-body"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth } from "../route/auth.js"
import { ClaudeCodeMessages } from "../protocols/claude-code-messages.js"

export const OAUTH_TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"
export const CREDENTIALS_FILE_NAME = ".credentials.json"

export const NOT_SIGNED_IN_MESSAGE =
  "Claude Code is not signed in on this machine: no OAuth credential in ~/.claude/.credentials.json " +
  `and no ${OAUTH_TOKEN_ENV_VAR} in the environment. Use the claude-code provider's in-product ` +
  "sign-in to complete the claude.ai OAuth sign-in."

export const expiredMessage = (expiresAt: number) =>
  "The Claude Code OAuth credential in ~/.claude/.credentials.json expired at " +
  `${new Date(expiresAt).toISOString()} and this provider does not refresh the CLI's login. ` +
  "Renew it with the claude-code provider's in-product sign-in; until then claude-code requests fail closed " +
  "rather than falling back to the CLI or an API key."

// In-provider OAuth sign-in initiation (#1852) — the flow constants are
// the Claude Code client's own, verified against the CLI and public
// implementations of the same client (#1818 triage): the authorize page
// is hosted, displays `code#state` for the user to paste back, and no
// localhost listener is involved.
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
export const OAUTH_TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024

const OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS = 15_000

export const SIGN_IN_INSTRUCTIONS =
  "Open the authorize URL in a browser on any device, complete the claude.ai sign-in, " +
  "and paste the code#state value the hosted page displays back to complete sign-in."

/** A sign-in failure with a named, token-free message. */
export class ClaudeCodeSignInError extends Error {
  override readonly name = "ClaudeCodeSignInError"
}

export interface ClaudeCodeCredential {
  readonly accessToken: string
  /** Epoch milliseconds, when the source carries expiry metadata. */
  readonly expiresAt?: number
  /** The single-use refresh token, present only on a credentials-file credential (#1818). */
  readonly refreshToken?: string
  readonly source: "credentials-file" | "environment"
}

/** Injectable credential sources (tests); every field defaults to the real machine source. */
export interface CredentialSources {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (path: string) => string | undefined | Promise<string | undefined>
  /** Raw file write used by the atomic credential write (tests); defaults to fs writeFile with mode 0600. */
  readonly writeFile?: (path: string, contents: string) => Promise<void>
  /** Rename used by the atomic credential write (tests); defaults to fs rename. */
  readonly renameFile?: (from: string, to: string) => Promise<void>
  /** Fetch used for the OAuth token exchange (tests); defaults to the global fetch. */
  readonly fetchFn?: typeof fetch
  /** Override for the token-exchange deadline (tests); defaults to 15 seconds. */
  readonly tokenExchangeTimeoutMs?: number
  /** Random bytes for PKCE/state/temp names (tests); defaults to crypto.getRandomValues. */
  readonly randomValues?: (length: number) => Uint8Array
  readonly now?: () => number
  /** Directory holding .credentials.json (defaults to $CLAUDE_CONFIG_DIR or ~/.claude). */
  readonly configDir?: string
}

/** Parse the CLI's credentials file; anything malformed reads as "no credential there". */
export const parseCredentialsFile = (contents: string): ClaudeCodeCredential | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth
  if (typeof oauth !== "object" || oauth === null) return undefined
  const { accessToken, expiresAt, refreshToken } = oauth as Record<string, unknown>
  // A blank value is no credential (the vibe-auth rule): trim, and treat
  // whitespace-only as absent, so resolution falls through to the env tier
  // instead of sending a Bearer of spaces.
  const token = typeof accessToken === "string" ? accessToken.trim() : ""
  if (token.length === 0) return undefined
  const refresh = typeof refreshToken === "string" ? refreshToken.trim() : ""
  return {
    accessToken: token,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined,
    ...(refresh.length === 0 ? {} : { refreshToken: refresh }),
    source: "credentials-file",
  }
}

const credentialsFilePath = async (sources: CredentialSources): Promise<string> => {
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  const dir =
    sources.configDir ?? (sources.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))
  return join(dir, CREDENTIALS_FILE_NAME)
}

const defaultReadFile = async (path: string): Promise<string | undefined> => {
  const { readFile } = await import("node:fs/promises")
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** First usable credential a source can produce, in the CLI's priority order. */
export const resolveCredential = async (sources: CredentialSources = {}): Promise<ClaudeCodeCredential | undefined> => {
  const readFile = sources.readFile ?? defaultReadFile
  const contents = await readFile(await credentialsFilePath(sources))
  const fileCredential = contents !== undefined ? parseCredentialsFile(contents) : undefined
  const env = sources.env ?? process.env
  const envToken = env[OAUTH_TOKEN_ENV_VAR]?.trim()
  const envCredential: ClaudeCodeCredential | undefined =
    envToken !== undefined && envToken.length > 0 ? { accessToken: envToken, source: "environment" } : undefined
  if (fileCredential !== undefined) {
    const now = sources.now ? sources.now() : Date.now()
    const expired = fileCredential.expiresAt !== undefined && fileCredential.expiresAt <= now
    // Expired-file fall-through (#1752): an expired token is not a
    // usable credential, so the env source is consulted; with no env
    // token, the expired credential is returned so loadCredentialEffect
    // still fails loudly with the expired message.
    if (!expired) return fileCredential
    return envCredential ?? fileCredential
  }
  return envCredential
}

export interface ClaudeCodeOAuthBlob {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  readonly subscriptionType?: string
  readonly scopes?: ReadonlyArray<string>
}

/** A credential write refused at the boundary: the blob would persist an empty token (code#7098). */
export class ClaudeCodeCredentialWriteError extends Error {
  override readonly name = "ClaudeCodeCredentialWriteError"
}

/**
 * The write-boundary invariant (code#7098): a credential whose access
 * token is empty or whitespace, whose refresh token is present but
 * empty or whitespace, or whose expiry is not a positive timestamp is
 * NEVER persisted. The 2026-11-07 blanking wrote exactly that shape
 * (both tokens empty, expiresAt 0, subscriptionType retained) through
 * an unguarded write path, and an empty refresh token cannot be
 * renewed - every blanking costs a full manual re-sign-in. Any caller
 * handing the write helper such a blob is refused by name before any
 * write, and the existing file stays byte-identical.
 */
const assertPersistableOAuthBlob = (oauth: ClaudeCodeOAuthBlob): void => {
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.trim().length === 0)
    throw new ClaudeCodeCredentialWriteError(
      "Refusing to write ~/.claude/.credentials.json: the access token is empty. The existing file is unchanged.",
    )
  if (oauth.refreshToken !== undefined && oauth.refreshToken.trim().length === 0)
    throw new ClaudeCodeCredentialWriteError(
      "Refusing to write ~/.claude/.credentials.json: the refresh token is empty. The existing file is unchanged.",
    )
  if (oauth.expiresAt !== undefined && (!Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= 0))
    throw new ClaudeCodeCredentialWriteError(
      "Refusing to write ~/.claude/.credentials.json: the expiry is not a positive timestamp. The existing file is unchanged.",
    )
}

/** Serialize the credentials file with `oauth` as its claudeAiOauth blob, preserving unrelated fields. */
export const buildCredentialsFileContents = (existing: string | undefined, oauth: ClaudeCodeOAuthBlob): string => {
  assertPersistableOAuthBlob(oauth)
  let top: Record<string, unknown> = {}
  if (existing !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (typeof parsed === "object" && parsed !== null) top = parsed as Record<string, unknown>
    } catch {
      top = {}
    }
  }
  const prior = top.claudeAiOauth
  const priorBlob: Record<string, unknown> =
    typeof prior === "object" && prior !== null ? (prior as Record<string, unknown>) : {}
  return JSON.stringify({
    ...top,
    claudeAiOauth: {
      ...priorBlob,
      accessToken: oauth.accessToken,
      ...(oauth.refreshToken === undefined ? {} : { refreshToken: oauth.refreshToken }),
      ...(oauth.expiresAt === undefined ? {} : { expiresAt: oauth.expiresAt }),
      ...(oauth.subscriptionType === undefined ? {} : { subscriptionType: oauth.subscriptionType }),
      ...(oauth.scopes === undefined ? {} : { scopes: [...oauth.scopes] }),
    },
  })
}

const randomBytes = (sources: CredentialSources, length: number): Uint8Array =>
  sources.randomValues ? sources.randomValues(length) : crypto.getRandomValues(new Uint8Array(length))

const base64UrlEncode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url")

/**
 * THE write helper for the shared credentials file — shared with the
 * refresh write-back (task 10996): full-blob, atomic temp+rename, 0600.
 * A failure leaves the original file untouched.
 */
export const writeCredential = async (sources: CredentialSources, oauth: ClaudeCodeOAuthBlob): Promise<void> => {
  const path = await credentialsFilePath(sources)
  const existing = await (sources.readFile ?? defaultReadFile)(path)
  const contents = buildCredentialsFileContents(existing, oauth)
  const writeFile =
    sources.writeFile ??
    (async (target: string, data: string) => {
      const { writeFile: fsWriteFile } = await import("node:fs/promises")
      await fsWriteFile(target, data, { encoding: "utf8", mode: 0o600 })
    })
  const renameFile =
    sources.renameFile ??
    (async (from: string, to: string) => {
      const { rename } = await import("node:fs/promises")
      await rename(from, to)
    })
  const suffix = Array.from(randomBytes(sources, 6), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const temp = `${path}.tmp-${process.pid}-${suffix}`
  await writeFile(temp, contents)
  await renameFile(temp, path)
}

/** A refresh failure with a named, token-free message (#1818). */
export class ClaudeCodeRefreshError extends Error {
  override readonly name = "ClaudeCodeRefreshError"
}

/**
 * Exchange the credentials file's single-use refresh token for a new
 * credential set and persist it BEFORE the new access token is used
 * (#1818). Anthropic rotates the refresh token on every exchange, so the
 * exchange and its write-back are one operation: if the write fails the
 * rotated pair is discarded, the file is left untouched, and no
 * in-memory-only credential exists (an unpersisted rotated token is a
 * burned login). Tokens are never logged.
 */
const refreshAndPersist = async (sources: CredentialSources, refreshToken: string): Promise<ClaudeCodeCredential> => {
  const response = await (sources.fetchFn ?? fetch)(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: deadlineSignal(undefined, sources.tokenExchangeTimeoutMs ?? OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  }).catch((cause: unknown) => {
    throw new ClaudeCodeRefreshError(
      `Claude Code OAuth refresh failed to reach the token endpoint: ${cause instanceof Error ? cause.message : "network error"}. ` +
        "Re-run the claude-code provider's in-product sign-in if this persists.",
    )
  })
  if (!response.ok)
    throw new ClaudeCodeRefreshError(
      `Claude Code OAuth refresh was rejected with HTTP ${response.status}: the CLI's login is no longer renewable. ` +
        "Re-run the claude-code provider's in-product sign-in.",
    )
  let data: unknown
  try {
    data = JSON.parse(
      await readBoundedResponseText(
        response,
        OAUTH_TOKEN_RESPONSE_MAX_BYTES,
        () =>
          new ClaudeCodeRefreshError(
            `Claude Code OAuth refresh response exceeded ${OAUTH_TOKEN_RESPONSE_MAX_BYTES} bytes; the tokens were discarded.`,
          ),
      ),
    )
  } catch (cause) {
    if (cause instanceof ClaudeCodeRefreshError) throw cause
    throw new ClaudeCodeRefreshError(
      "Claude Code OAuth refresh returned a malformed response; the tokens were discarded.",
    )
  }
  const tokens = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : ""
  if (accessToken.length === 0)
    throw new ClaudeCodeRefreshError("Claude Code OAuth refresh returned no access token; the tokens were discarded.")
  if ("refresh_token" in tokens && (typeof tokens.refresh_token !== "string" || tokens.refresh_token.trim().length === 0))
    throw new ClaudeCodeRefreshError(
      "Claude Code OAuth refresh returned an empty refresh token; the tokens were discarded.",
    )
  if (
    "expires_in" in tokens &&
    (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
  )
    throw new ClaudeCodeRefreshError("Claude Code OAuth refresh returned an invalid expiry; the tokens were discarded.")
  const now = sources.now ? sources.now() : Date.now()
  const oauth: ClaudeCodeOAuthBlob = {
    accessToken,
    // A refresh response that omits the refresh token leaves the prior
    // one in place (buildCredentialsFileContents merges over the blob).
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : refreshToken,
    expiresAt:
      typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
        ? now + tokens.expires_in * 1000
        : undefined,
    subscriptionType: typeof tokens.subscription_type === "string" ? tokens.subscription_type : undefined,
    scopes: typeof tokens.scope === "string" ? tokens.scope.split(" ").filter(Boolean) : undefined,
  }
  try {
    await writeCredential(sources, oauth)
  } catch {
    throw new ClaudeCodeRefreshError(
      "Claude Code OAuth refresh succeeded but the rotated credential could not be written to ~/.claude/.credentials.json; " +
        "the tokens were discarded and the file is unchanged.",
    )
  }
  return {
    accessToken,
    expiresAt: oauth.expiresAt,
    refreshToken: oauth.refreshToken,
    source: "credentials-file",
  }
}

const generatePKCE = async (sources: CredentialSources) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(randomBytes(sources, 43), (byte) => chars[byte % chars.length]).join("")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) }
}

export interface ClaudeCodeSignIn {
  readonly url: string
  readonly instructions: string
  /** Paste the hosted page's `code#state` value; resolves only after the credential is persisted. */
  readonly callback: (pasted: string) => Promise<ClaudeCodeCredential>
}

/**
 * Begin an in-provider OAuth sign-in (#1852), mirroring the fork's
 * chatgpt.ts authorize() shape — { url, instructions, callback } — with
 * the paste-code variant (no listener), like github-copilot.ts.
 * Tokens are never logged, and a failed write after a successful
 * exchange discards the tokens: no in-memory-only credential exists.
 */
export const beginClaudeCodeSignIn = async (sources: CredentialSources = {}): Promise<ClaudeCodeSignIn> => {
  const pkce = await generatePKCE(sources)
  const state = base64UrlEncode(randomBytes(sources, 32))
  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  })
  let inflight: Promise<ClaudeCodeCredential> | undefined
  const exchangeAndPersist = async (pasted: string): Promise<ClaudeCodeCredential> => {
    const trimmed = pasted.trim()
    const separator = trimmed.indexOf("#")
    const code = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim()
    const pastedState = separator === -1 ? undefined : trimmed.slice(separator + 1).trim()
    if (code.length === 0)
      throw new ClaudeCodeSignInError(
        "Malformed sign-in code: paste the full code#state value from the authorize page.",
      )
    if (pastedState !== undefined && pastedState !== state)
      throw new ClaudeCodeSignInError("OAuth state mismatch: the pasted code was not issued for this sign-in attempt.")
    const response = await (sources.fetchFn ?? fetch)(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: deadlineSignal(undefined, sources.tokenExchangeTimeoutMs ?? OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OAUTH_CLIENT_ID,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: OAUTH_REDIRECT_URI,
        state: pastedState ?? state,
      }).toString(),
    }).catch((cause: unknown) => {
      throw new ClaudeCodeSignInError(
        `Claude Code sign-in token exchange failed to reach the token endpoint: ${cause instanceof Error ? cause.message : "network error"}`,
      )
    })
    if (!response.ok)
      throw new ClaudeCodeSignInError(`Claude Code sign-in token exchange failed with HTTP ${response.status}.`)
    let data: unknown
    try {
      data = JSON.parse(
        await readBoundedResponseText(
          response,
          OAUTH_TOKEN_RESPONSE_MAX_BYTES,
          () =>
            new ClaudeCodeSignInError(
              `Claude Code sign-in token exchange response exceeded ${OAUTH_TOKEN_RESPONSE_MAX_BYTES} bytes.`,
            ),
        ),
      )
    } catch (cause) {
      if (cause instanceof ClaudeCodeSignInError) throw cause
      data = undefined
    }
    const tokens = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : ""
    if (accessToken.length === 0)
      throw new ClaudeCodeSignInError("Claude Code sign-in token exchange returned no access token.")
    if ("refresh_token" in tokens && (typeof tokens.refresh_token !== "string" || tokens.refresh_token.trim().length === 0))
      throw new ClaudeCodeSignInError("Claude Code sign-in token exchange returned an empty refresh token.")
    if (
      "expires_in" in tokens &&
      (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
    )
      throw new ClaudeCodeSignInError("Claude Code sign-in token exchange returned an invalid expiry.")
    const now = sources.now ? sources.now() : Date.now()
    const oauth: ClaudeCodeOAuthBlob = {
      accessToken,
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
      expiresAt:
        typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
          ? now + tokens.expires_in * 1000
          : undefined,
      subscriptionType: typeof tokens.subscription_type === "string" ? tokens.subscription_type : undefined,
      scopes: typeof tokens.scope === "string" ? tokens.scope.split(" ").filter(Boolean) : undefined,
    }
    try {
      await writeCredential(sources, oauth)
    } catch {
      throw new ClaudeCodeSignInError(
        "Claude Code sign-in succeeded but the credential could not be written to ~/.claude/.credentials.json; the tokens were discarded.",
      )
    }
    return { accessToken, expiresAt: oauth.expiresAt, source: "credentials-file" }
  }
  return {
    url: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    instructions: SIGN_IN_INSTRUCTIONS,
    callback: (pasted: string) => {
      if (inflight === undefined) {
        const attempt = exchangeAndPersist(pasted)
        inflight = attempt
        // A failed attempt must not poison the sign-in (#1868): the
        // memo deduplicates concurrent calls, but once an attempt
        // rejects — a bad paste, a state mismatch, a failed exchange —
        // it is cleared, so a later paste runs a fresh exchange on
        // this same sign-in (same PKCE/state) instead of returning
        // the cached rejection forever. Success stays memoized: the
        // authorization code is single-use, and the persisted
        // credential is the result. The sibling bridges clear their
        // inflight the same way (antigravity-auth loadToken,
        // vibe-auth loadApiKey).
        attempt.catch(() => {
          if (inflight === attempt) inflight = undefined
        })
      }
      return inflight
    },
  }
}

/** Concurrent expired requests share exactly one inflight refresh exchange (#1818). */
const inflightRefresh = new Map<string, Promise<ClaudeCodeCredential>>()

const refreshCredential = (sources: CredentialSources, credential: ClaudeCodeCredential) => {
  const key = `${sources.configDir ?? ""}\u0000${credential.refreshToken}`
  const existing = inflightRefresh.get(key)
  if (existing !== undefined) return existing
  const attempt = refreshAndPersist(sources, credential.refreshToken as string)
  inflightRefresh.set(key, attempt)
  // Clear on settle so a later expiry refreshes again; a rejection must
  // not be cached forever.
  attempt
    .catch(() => {})
    .finally(() => {
      if (inflightRefresh.get(key) === attempt) inflightRefresh.delete(key)
    })
  return attempt
}

const loadCredentialEffect = (sources: CredentialSources) =>
  Effect.gen(function* () {
    const credential = yield* Effect.promise(() => resolveCredential(sources))
    if (credential === undefined)
      return yield* new AIError({ reason: new AuthenticationError({ message: NOT_SIGNED_IN_MESSAGE }) })
    const now = sources.now ? sources.now() : Date.now()
    const expired = credential.expiresAt !== undefined && credential.expiresAt <= now
    if (!expired) return credential
    // An expired credentials-file credential with a refresh token renews
    // (#1818); the env tier (#1752) and a file with no refresh token keep
    // the fail-loud floor.
    if (credential.source !== "credentials-file" || credential.refreshToken === undefined)
      return yield* new AIError({
        reason: new AuthenticationError({ message: expiredMessage(credential.expiresAt as number) }),
      })
    return yield* Effect.tryPromise({
      try: () => refreshCredential(sources, credential),
      catch: (cause) =>
        new AIError({
          reason: new AuthenticationError({
            message: cause instanceof ClaudeCodeRefreshError ? cause.message : "Claude Code OAuth refresh failed.",
          }),
        }),
    })
  })

/**
 * The provider's auth: the CLI's OAuth access token as a Bearer header,
 * plus the CLI's User-Agent re-stamped over whatever the caller carried.
 * The load-bearing OAuth beta flags ride on the route's static headers
 * (see protocols/claude-code-messages.ts); this layer owns the credential
 * itself, re-read per request so a renewed sign-in is picked up without
 * a restart.
 *
 * The User-Agent cannot ride on the route's static headers alone:
 * session requests carry the harness's own `opencode/<channel>/<ver>/cli`
 * UA in `request.http.headers`, and the transport merges those OVER the
 * route headers, so the wire would present OpenCode's identity, not the
 * CLI's (verified against the deployed binary's requests, 2026-11-06).
 * Auth runs after that merge, so `Headers.setAll` here is what actually
 * reaches the wire - the same pattern antigravity-auth and
 * commandcode-auth already use for their client identities.
 */
export const claudeCodeAuth = (input: {
  readonly auth?: Auth.Definition
  readonly accessToken?: string
  readonly sources?: CredentialSources
}) => {
  if (input.auth) return input.auth
  if (input.accessToken !== undefined)
    return Auth.custom((authInput) =>
      Effect.succeed(
        Headers.setAll(authInput.headers, {
          authorization: `Bearer ${input.accessToken}`,
          "user-agent": ClaudeCodeMessages.CLI_USER_AGENT,
        }),
      ),
    )
  const sources = input.sources ?? {}
  return Auth.custom((authInput) =>
    loadCredentialEffect(sources).pipe(
      Effect.map((credential) =>
        Headers.setAll(authInput.headers, {
          authorization: `Bearer ${credential.accessToken}`,
          "user-agent": ClaudeCodeMessages.CLI_USER_AGENT,
        }),
      ),
    ),
  )
}

export * as ClaudeCodeAuth from "./claude-code-auth.js"
