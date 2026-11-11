// Claude Code credential bridge — the claude-code provider (#6117) emulates
// the Claude Code CLI's wire behavior natively (Anthropic Messages API with
// the subscription OAuth credential); this module mirrors the CLI's own
// credential storage so the provider spends the exact credential the
// one-time `claude` sign-in provisions.
//
// The CLI (verified on the fleet laptop, Claude Code 2.1.306) stores its
// claude.ai OAuth login in ~/.claude/.credentials.json (0600) as
//   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…",
//                        "refreshToken": "sk-ant-ort01-…",
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
// A credentials-file credential carrying a refresh token is renewed in
// place BY THE SERVER ITSELF (#1818, #6120) — never by invoking the CLI:
// renewal starts WELL BEFORE expiry, inside the renewal lead window
// (RENEWAL_LEAD_MS), and the rotated pair is written back through the
// write helper BEFORE the new access token is used — Anthropic rotates
// the refresh token on every exchange, so an unpersisted rotated token
// would burn the login. A failed write discards the rotated pair and
// leaves the file untouched. A rate-limited exchange (HTTP 429) is
// waited out — the response's Retry-After when it states one, otherwise
// the capped backoff — and retried until the renewal lands; while it
// waits, the door's requests fail as rate limits (the router's
// rate-limit hold), never as authentication failures. If one request's
// wait budget ends first, the renewal retires to a standing,
// timer-driven retry (see scheduleStandingRenewal) that keeps working
// with no request pending — a rate limit is a wait, not an outcome,
// and the retry must not depend on the door's own traffic arriving:
// on 2026-11-10 the door was quota-walled, the re-triggering traffic
// was suppressed, and the pair never rotated (code#8102). The env token
// (#1752) and a file credential with no refresh token still fail LOUDLY
// once expired (see claudeCodeAuth) instead of silently degrading.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { deadlineSignal, readBoundedResponseText } from "@opencode/util/http-body"
import { AIError, AuthenticationError, RateLimitError } from "../schema/index.js"
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
  `${new Date(expiresAt).toISOString()} and carries no refresh token the server can renew with. ` +
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
  /** Remove a failed atomic-write temp file (tests); defaults to fs rm with force. */
  readonly removeFile?: (path: string) => Promise<void>
  /** Fetch used for the OAuth token exchange (tests); defaults to the global fetch. */
  readonly fetchFn?: typeof fetch
  /** Override for the token-exchange deadline (tests); defaults to 15 seconds. */
  readonly tokenExchangeTimeoutMs?: number
  /** Sleep used between rate-limited renewal attempts (tests); defaults to a real timer. */
  readonly sleep?: (ms: number, unref?: boolean) => Promise<void>
  /** Renewal lifecycle observer (tests); defaults to a console.warn line per event (vibe-auth precedent). */
  readonly onRenewalEvent?: (event: RenewalEvent) => void
  /** Total wait budget for one renewal's rate-limit retries (tests); defaults to RENEWAL_WAIT_BUDGET_MS. */
  readonly renewalWaitBudgetMs?: number
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
  const removeFile =
    sources.removeFile ??
    (async (target: string) => {
      const { rm } = await import("node:fs/promises")
      await rm(target, { force: true })
    })
  const suffix = Array.from(randomBytes(sources, 6), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const temp = `${path}.tmp-${process.pid}-${suffix}`
  try {
    await writeFile(temp, contents)
    await renameFile(temp, path)
  } catch (cause) {
    try {
      await removeFile(temp)
    } catch {}
    throw cause
  }
}

// Renewal timing (#6120). The access token this door spends lives ~8
// hours; renewal starts when less than RENEWAL_LEAD_MS of it remains —
// a quarter of the lifetime, two hours — instead of at expiry. The
// incident this fixes: on 2026-11-10 the first refresh attempt ran 22
// seconds AFTER the token expired, met the token endpoint's rate limit
// from the first try, and the failure was misreported as a dead login.
// Renewing inside a two-hour lead leaves room to wait a rate limit out
// while the current token still serves.
export const RENEWAL_LEAD_MS = 2 * 60 * 60 * 1000
/** One request's renewal waits out rate limiting for at most this long
 * before the request surfaces the wait as a rate-limit failure. The
 * wait itself does NOT end there: exhausting the budget against a
 * rate limit (or another transient failure) hands the renewal to a
 * standing, timer-driven retry (see scheduleStandingRenewal) that keeps
 * retrying until the renewal lands or the refresh token is genuinely
 * rejected — it never waits for the next request to re-trigger it.
 * The 2026-11-10 failure: the door was quota-walled, so the traffic
 * that would have re-triggered the wait was exactly the traffic the
 * quota plant suppressed, and the pair never rotated (code#8102). */
export const RENEWAL_WAIT_BUDGET_MS = 15 * 60 * 1000
const RENEWAL_BACKOFF_BASE_MS = 5_000
const RENEWAL_BACKOFF_CAP_MS = 5 * 60 * 1000

/**
 * One step of the renewal lifecycle, emitted through
 * CredentialSources.onRenewalEvent (default: console.warn, the
 * vibe-auth diagnostic precedent). Events carry timestamps and waits,
 * never token values: a renewal incident must be fully reconstructible
 * from these lines alone — the 2026-11-10 diagnosis had to be rebuilt
 * from request-failover side effects because the wait loop logged
 * nothing, not even its own budget exhaustion.
 */
export type RenewalEvent =
  | { readonly kind: "attempt"; readonly at: number; readonly attempt: number; readonly standing: boolean }
  | { readonly kind: "rate-limited"; readonly at: number; readonly attempt: number; readonly waitMs: number }
  | { readonly kind: "budget-exhausted"; readonly at: number; readonly waitedMs: number }
  | { readonly kind: "standing-scheduled"; readonly at: number }
  | { readonly kind: "transient-failure"; readonly at: number; readonly attempt: number; readonly message: string }
  | { readonly kind: "landed"; readonly at: number; readonly expiresAt: number | undefined }
  | { readonly kind: "rejected"; readonly at: number; readonly message: string }

const defaultRenewalEvent = (event: RenewalEvent): void => {
  const stamp = new Date(event.at).toISOString()
  switch (event.kind) {
    case "attempt":
      console.warn(
        `claude-code-auth: renewal attempt ${event.attempt}${event.standing ? " (standing retry)" : ""} at ${stamp}`,
      )
      return
    case "rate-limited":
      console.warn(
        `claude-code-auth: renewal attempt ${event.attempt} rate limited (HTTP 429); waiting ${event.waitMs}ms`,
      )
      return
    case "budget-exhausted":
      console.warn(
        `claude-code-auth: renewal wait budget exhausted after ${event.waitedMs}ms at ${stamp}; the renewal continues as a standing retry`,
      )
      return
    case "standing-scheduled":
      console.warn(`claude-code-auth: standing renewal retry scheduled at ${stamp}`)
      return
    case "transient-failure":
      console.warn(`claude-code-auth: renewal attempt ${event.attempt} failed transiently: ${event.message}`)
      return
    case "landed":
      console.warn(
        `claude-code-auth: renewal landed at ${stamp}; new credential expires ${event.expiresAt === undefined ? "at an unstated time" : new Date(event.expiresAt).toISOString()}`,
      )
      return
    case "rejected":
      console.warn(`claude-code-auth: renewal rejected at ${stamp}: ${event.message}`)
      return
  }
}

/** A refresh failure with a named, token-free message (#1818). */
export class ClaudeCodeRefreshError extends Error {
  override readonly name = "ClaudeCodeRefreshError"
}

/**
 * The token endpoint answered a renewal with HTTP 429 (#6120): a
 * rate-limit wait, not a refusal. Carries the endpoint's own
 * Retry-After when it stated one. Renewal retries through this error
 * until the wait budget ends; a request that surfaces it fails as a
 * rate limit, never as an authentication failure — the login is not
 * dead, its renewal is merely waiting.
 */
export class ClaudeCodeRefreshRateLimited extends Error {
  override readonly name = "ClaudeCodeRefreshRateLimited"
  constructor(readonly retryAfterMs: number | undefined) {
    super("Claude Code OAuth refresh is rate limited (HTTP 429); renewal is waiting to retry.")
  }
}

/**
 * The endpoint refused the refresh grant itself (a non-429 rejection —
 * HTTP 400 invalid_grant and kin): the one renewal failure that is an
 * outcome rather than a wait. The standing retry never retries past
 * this error; the renewal stops and requests keep the fail-loud floor
 * until the in-product sign-in runs again.
 */
export class ClaudeCodeRefreshRejected extends ClaudeCodeRefreshError {}

/**
 * The endpoint answered 200 but the body was unusable — unparseable,
 * missing a token, an invalid expiry: the exchange's own verdict that
 * nothing usable was issued, the same stop class as a rejected grant.
 * The standing retry never retries past this error either; without
 * this distinction a malformed-answering endpoint would spin the
 * standing loop at full speed.
 */
export class ClaudeCodeRefreshDiscarded extends ClaudeCodeRefreshError {}

/** The endpoint's stated wait: `Retry-After` delay-seconds or HTTP-date (RFC 9110). */
const retryAfterHeaderMs = (response: Response, now: number): number | undefined => {
  const raw = response.headers.get("retry-after")?.trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
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
const exchangeRefreshToken = async (sources: CredentialSources, refreshToken: string): Promise<ClaudeCodeCredential> => {
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
  if (response.status === 429)
    throw new ClaudeCodeRefreshRateLimited(retryAfterHeaderMs(response, sources.now ? sources.now() : Date.now()))
  if (!response.ok)
    throw new ClaudeCodeRefreshRejected(
      `Claude Code OAuth refresh was rejected with HTTP ${response.status}. ` +
        "Re-run the claude-code provider's in-product sign-in if this persists.",
    )
  let data: unknown
  try {
    data = JSON.parse(
      await readBoundedResponseText(
        response,
        OAUTH_TOKEN_RESPONSE_MAX_BYTES,
        () =>
          new ClaudeCodeRefreshDiscarded(
            `Claude Code OAuth refresh response exceeded ${OAUTH_TOKEN_RESPONSE_MAX_BYTES} bytes; the tokens were discarded.`,
          ),
      ),
    )
  } catch (cause) {
    if (cause instanceof ClaudeCodeRefreshError) throw cause
    throw new ClaudeCodeRefreshDiscarded(
      "Claude Code OAuth refresh returned a malformed response; the tokens were discarded.",
    )
  }
  const tokens = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : ""
  if (accessToken.length === 0)
    throw new ClaudeCodeRefreshDiscarded(
      "Claude Code OAuth refresh returned no access token; the tokens were discarded.",
    )
  if ("refresh_token" in tokens && (typeof tokens.refresh_token !== "string" || tokens.refresh_token.trim().length === 0))
    throw new ClaudeCodeRefreshDiscarded(
      "Claude Code OAuth refresh returned an empty refresh token; the tokens were discarded.",
    )
  if (
    "expires_in" in tokens &&
    (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
  )
    throw new ClaudeCodeRefreshDiscarded(
      "Claude Code OAuth refresh returned an invalid expiry; the tokens were discarded.",
    )
  const now = sources.now ? sources.now() : Date.now()
  const oauth: ClaudeCodeOAuthBlob = {
    accessToken,
    // A refresh response that omits the refresh token leaves the prior
    // one in place (buildCredentialsFileContents merges over the blob).
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : undefined,
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
    if (pastedState === undefined)
      throw new ClaudeCodeSignInError(
        "Malformed sign-in code: paste the full code#state value from the authorize page.",
      )
    if (pastedState !== state)
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
        state: pastedState,
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
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : undefined,
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

/** Default timer for the renewal wait; tests inject an instant sleep. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The default timer's unref form: the standing retry's waits pass
 * `unref: true` so the timer does not hold the process open — the
 * retry is ambient work that nothing awaits unless a later load joins
 * it, and a process with no other work must still be able to exit
 * (and a test process to finish). Injected sleeps receive the same
 * flag: it marks the wait as ambient.
 */
const unrefSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref()
  })

/** Lifecycle events are observability only: a throwing observer must never break a renewal. */
const emitRenewalEvent = (sources: CredentialSources, event: RenewalEvent): void => {
  try {
    ;(sources.onRenewalEvent ?? defaultRenewalEvent)(event)
  } catch {}
}

/**
 * Renew with waiting (#6120): run the exchange, and when the endpoint
 * rate-limits it, WAIT — the response's Retry-After when it stated one,
 * otherwise an exponential backoff (5s doubling, capped at 5 minutes) —
 * and retry, until the renewal lands or the wait budget
 * (RENEWAL_WAIT_BUDGET_MS) is spent. The rotated pair is persisted by
 * the exchange itself before the new token is used. Any other failure
 * (a rejected grant, a network error, a malformed response) propagates
 * at once: only a 429 is a wait WITHIN the request — the standing
 * retry in refreshCredential owns what happens after the budget.
 */
const refreshAndPersist = async (
  sources: CredentialSources,
  refreshToken: string,
  options: { readonly standing: boolean },
): Promise<ClaudeCodeCredential> => {
  const effective = sources
  const sleep = effective.sleep ?? defaultSleep
  const budget = effective.renewalWaitBudgetMs ?? RENEWAL_WAIT_BUDGET_MS
  const now = () => (effective.now ? effective.now() : Date.now())
  let waited = 0
  let backoff = RENEWAL_BACKOFF_BASE_MS
  let attempt = 0
  for (;;) {
    attempt += 1
    emitRenewalEvent(effective, { kind: "attempt", at: now(), attempt, standing: options.standing })
    try {
      const credential = await exchangeRefreshToken(effective, refreshToken)
      emitRenewalEvent(effective, { kind: "landed", at: now(), expiresAt: credential.expiresAt })
      return credential
    } catch (cause) {
      if (!(cause instanceof ClaudeCodeRefreshRateLimited)) throw cause
      const wait = Math.max(cause.retryAfterMs ?? backoff, 1_000)
      backoff = Math.min(backoff * 2, RENEWAL_BACKOFF_CAP_MS)
      emitRenewalEvent(effective, { kind: "rate-limited", at: now(), attempt, waitMs: wait })
      if (waited >= budget || wait > budget - waited) {
        emitRenewalEvent(effective, { kind: "budget-exhausted", at: now(), waitedMs: waited })
        throw cause
      }
      waited += wait
      await sleep(wait)
    }
  }
}

/** Renewal chains already retired to the standing retry, by refresh key: at most one per credential. */
const standingRenewals = new Map<string, Promise<ClaudeCodeCredential>>()

/**
 * The standing renewal retry (code#8102): when a request's renewal
 * exhausts its wait budget against a rate limit — or fails transiently
 * (the endpoint unreachable, a failed write-back) — the renewal does
 * not die with the request. It retires here: a timer-driven loop, fed
 * by the same injected sleep, that keeps renewing on the same
 * Retry-After/backoff discipline until the renewal lands or the
 * refresh token is genuinely rejected. A rate limit is a wait, not an
 * outcome, and the retry must not depend on _claude traffic arriving:
 * on 2026-11-10 the door was quota-walled, so the requests that would
 * have re-triggered the renewal were the very requests being
 * suppressed, and the pair never rotated. A renewal stops for good on
 * exactly two verdicts: the endpoint refused the grant itself
 * (ClaudeCodeRefreshRejected — HTTP 400 invalid_grant and kin) or
 * answered 200 with an unusable body (ClaudeCodeRefreshDiscarded —
 * the exchange's own verdict that nothing usable was issued; retrying
 * it would spin the loop at full speed). Concurrent loads join the
 * standing attempt through refreshCredential instead of starting a
 * second exchange.
 */
/**
 * What a load does when it finds a standing retry already running for
 * its credential: join it — single-flight — if the renewal has landed
 * or lands within the same tick; otherwise fall through to the
 * last-issued credential, whose caller-side mapping names the state
 * (an expired credential fails loudly; a renewable one is returned
 * with the pending-renewal notice). A load is never parked on a retry
 * that could wait for hours, and never starts a competing exchange.
 */
const joinStandingRenewal = async (
  sources: CredentialSources,
  standing: Promise<ClaudeCodeCredential>,
  credential: ClaudeCodeCredential,
): Promise<ClaudeCodeCredential> => {
  const now = sources.now ? sources.now() : Date.now()
  if (credential.expiresAt !== undefined && credential.expiresAt <= now + 1_000) return credential
  // A standing renewal that has already landed resolves at once; one
  // still pending after a bounded probe falls through to the
  // credential, whose caller-side mapping names the state: the
  // renewable credential is served with the pending-renewal notice
  // until the renewal lands. The probe waits for the joiner's own
  // in-flight exchange (if any) to settle, then takes one macrotask
  // turn — enough for a same-window landing, never a wait on the
  // retry's cadence. It must not run on the injected sleep: a test
  // double that parks ambient waits would otherwise park the probe.
  const inflight = inflightRefresh.get(`${sources.configDir ?? ""}\u0000${credential.refreshToken}`)
  const pending = Symbol("pending")
  const winner = await Promise.race([
    standing,
    (async () => {
      if (inflight !== undefined) await inflight.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 0))
      return pending
    })(),
  ])
  return winner === pending ? credential : (winner as ClaudeCodeCredential)
}

/**
 * The exact sources object the standing loop exchanges with, set for
 * the synchronous span in which the loop (re)enters refreshCredential
 * through loadCredentialEffect's join path. Identity, not a flag on the
 * caller's sources, so user-supplied sources can never spoof it.
 */
let standingExchangeSources: CredentialSources | undefined

/**
 * Set only for the synchronous span around a standing loop's round
 * call into its own exchange path: during that span the set holds the
 * round's sources object and the key it is renewing, so a re-entrant
 * refreshCredential for the same key and sources recognizes the loop's
 * own round and runs the exchange directly instead of joining.
 */
const standingRoundSpan = new Set<{ sources: CredentialSources; key: string }>()

const scheduleStandingRenewal = (
  sources: CredentialSources,
  key: string,
  refreshToken: string,
): Promise<ClaudeCodeCredential> => {
  const existing = standingRenewals.get(key)
  if (existing !== undefined) return existing
  // A standing renewal scheduled by an exchange whose own host load
  // is still settling must remain joinable past the moment its host
  // promise settles: the settlement of the host promise is what
  // releases the waiters who have already looked the slot up. The
  // fresh-scheduling guard (markFreshlyScheduled, below) records
  // that this slot was scheduled within the current settlement
  // window, and the join path consults it when deciding whether a
  // lookahead is safe — a joiner that lets a just-scheduled slot
  // settle under its feet gets the credential it was served rather
  // than the renewal's outcome.
  markFreshlyScheduled(sources, key)
  // The ambient cadence marks its waits unref'd; a caller whose
  // sleep is ambient-aware (the test harness parks ambient waits
  // behind a gate) sees the marker on every cadence call.
  const sleep = (ms: number) => (sources.sleep === undefined ? unrefSleep(ms) : sources.sleep(ms, true))
  const now = () => (sources.now ? sources.now() : Date.now())
  emitRenewalEvent(sources, { kind: "standing-scheduled", at: now() })
  const standing = (async (): Promise<ClaudeCodeCredential> => {
    let backoff = RENEWAL_BACKOFF_BASE_MS
    let attempt = 0
    for (;;) {
      await sleep(backoff)
      backoff = Math.min(backoff * 2, RENEWAL_BACKOFF_CAP_MS)
      attempt += 1
      try {
        // One exchange per standing round: the rounds themselves are
        // the retry cadence, so a round runs with a zero in-request
        // budget — a 429 ends the round at once and the loop applies
        // the standing backoff before the next, instead of stacking a
        // full in-request wait budget inside every round. The round's
        // sources are FRESH each round (a wrapper object per round),
        // marked as the loop's own for the synchronous re-entry span.
        const roundSources: CredentialSources = {
          ...sources,
          renewalWaitBudgetMs: 0,
          // The round's in-exchange waits ride the same ambient
          // marker as the cadence waits: both are the standing
          // loop's own timing, and ambient-aware callers (the test
          // harness) gate the loop on exactly that marker.
          sleep: (ms: number) => (sources.sleep === undefined ? sleep(ms) : sources.sleep(ms, true)),
        }
        standingExchangeSources = roundSources
        const span = { sources: roundSources, key }
        standingRoundSpan.add(span)
        try {
          return await refreshAndPersist(roundSources, refreshToken, { standing: true })
        } finally {
          standingRoundSpan.delete(span)
          if (standingExchangeSources === roundSources) standingExchangeSources = undefined
        }
      } catch (cause) {
        if (cause instanceof ClaudeCodeRefreshRateLimited) continue
        if (cause instanceof ClaudeCodeRefreshRejected || cause instanceof ClaudeCodeRefreshDiscarded) {
          emitRenewalEvent(sources, { kind: "rejected", at: now(), message: cause.message })
          throw cause
        }
        emitRenewalEvent(sources, {
          kind: "transient-failure",
          at: now(),
          attempt,
          message: cause instanceof Error ? cause.message : "Claude Code OAuth refresh failed.",
        })
      }
    }
  })()
  standingRenewals.set(key, standing)
  // A landed standing renewal has already persisted the rotated pair;
  // a rejected one must not be cached — either way the slot clears on
  // settle so the next expiry starts fresh.
  standing
    .catch(() => {})
    .finally(() => {
      if (standingRenewals.get(key) === standing) standingRenewals.delete(key)
    })
  return standing
}

/** Concurrent renewal-needing requests share exactly one inflight renewal (#1818, #6120). */
const inflightRefresh = new Map<string, Promise<ClaudeCodeCredential>>()

/**
 * Joining an in-flight renewal whose standing slot was scheduled
 * within the current settlement window: the shared attempt's
 * settlement coincides with the standing slot's own settlement, so a
 * waiter that would adopt the standing outcome is served its own
 * credential instead; every other waiter adopts the attempt as
 * before. The distinction only exists inside the fresh-scheduling
 * window — once it lapses, a waiter on the shared attempt is an
 * ordinary waiter on the renewal itself.
 */
const joinInflightStandingAware = async (
  existing: Promise<ClaudeCodeCredential>,
  key: string,
  credential: ClaudeCodeCredential,
  sources: CredentialSources,
): Promise<ClaudeCodeCredential> => {
  const standing = standingRenewals.get(key)
  if (standing !== undefined && isFreshlyScheduled(sources, key)) {
    await existing.catch(() => {})
    return credential
  }
  return existing
}

const refreshCredential = (sources: CredentialSources, credential: ClaudeCodeCredential) => {
  const key = `${sources.configDir ?? ""}\u0000${credential.refreshToken}`
  // The standing loop's own rounds re-enter here through the join path
  // (its in-flight entry was just cleared as the previous attempt
  // settled), and the loop must not join standing code from inside
  // itself: it runs the round's exchange directly, so its per-round
  // sources (the ambient cadence sleep, the zero wait budget) are the
  // ones in force. This check precedes the in-flight lookup: a round's
  // re-entry can coincide with another load's fresh in-flight attempt
  // for the same key, and the loop must not adopt that attempt either.
  for (const span of standingRoundSpan)
    if (span.sources === sources && span.key === key)
      return refreshAndPersist(sources, credential.refreshToken as string, { standing: true })
  const existing = inflightRefresh.get(key)
  if (existing !== undefined) return joinInflightStandingAware(existing, key, credential, sources)
  // While a standing retry is working this credential, a fresh load
  // joins it instead of running a competing in-request renewal.
  const standing = standingRenewals.get(key)
  if (standing !== undefined) return joinStandingRenewal(sources, standing, credential)
  const attempt = refreshAndPersist(sources, credential.refreshToken as string, { standing: false }).catch(
    (cause: unknown) => {
    // Genuine rejections keep today's fail-loud floor and are never
    // retried standing. Everything else — a rate limit that outlasted
    // the wait budget, a transient exchange failure — retires to the
    // standing retry, and THIS request joins it: the request still
    // surfaces the original failure (a 429 still surfaces as
    // RateLimit, never Authentication), and later loads join the
    // standing attempt until it lands.
    if (cause instanceof ClaudeCodeRefreshRejected || cause instanceof ClaudeCodeRefreshDiscarded) {
      emitRenewalEvent(sources, {
        kind: "rejected",
        at: sources.now ? sources.now() : Date.now(),
        message: cause.message,
      })
      throw cause
    }
    scheduleStandingRenewal(sources, key, credential.refreshToken as string)
    throw cause
  })
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

/** The renewal failure mapping every load shares: a rate-limit wait surfaces as RateLimit, never Authentication (#6120). */
const mapRenewalFailure = (cause: unknown) => {
  if (cause instanceof ClaudeCodeRefreshRateLimited)
    return new AIError({
      reason: new RateLimitError({
        message:
          "Claude Code OAuth renewal is waiting out the token endpoint's rate limit (HTTP 429); " +
          "the door reopens when the renewal lands.",
        ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
      }),
    })
  return new AIError({
    reason: new AuthenticationError({
      message: cause instanceof ClaudeCodeRefreshError ? cause.message : "Claude Code OAuth refresh failed.",
    }),
  })
}

/**
 * The refresh a stale-standing load falls back to, sharing the normal
 * path's failure mapping: trust the standing entry when it is already
 * settled, otherwise renew from the file credential in-request. The
 * stale entry was already DELETED by the caller, so nothing here can
 * re-join it — this helper exists only to keep the settled-verdict
 * race out of the main flow.
 */
const refreshAfterStandingEffect = (sources: CredentialSources, credential: ClaudeCodeCredential) =>
  Effect.gen(function* () {
    const key = `${sources.configDir ?? ""}\u0000${credential.refreshToken}`
    // EXTREMELY defensive: if a standing entry exists here despite
    // the caller's deletion, trust it only when it has already
    // settled; a pending one must never be awaited from this branch.
    const standing = standingRenewals.get(key)
    if (standing !== undefined) {
      const verdict = yield* Effect.promise(() =>
        Promise.race([
          standing.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
        ]),
      )
      if (verdict === "settled")
        return yield* Effect.tryPromise({
          try: () => standing,
          catch: (cause) => mapRenewalFailure(cause),
        })
    }
    return yield* Effect.tryPromise({
      try: () => refreshCredential(sources, credential),
      catch: (cause) => mapRenewalFailure(cause),
    })
  })

/** Keys whose standing entry was scheduled within the current macrotask window, with their sources. */
const freshlyScheduledStanding = new Set<{ sources: CredentialSources; key: string }>()
const markFreshlyScheduled = (sources: CredentialSources, key: string) => {
  const entry = { sources, key }
  freshlyScheduledStanding.add(entry)
  setTimeout(() => freshlyScheduledStanding.delete(entry), 0)
}
const isFreshlyScheduled = (sources: CredentialSources, key: string): boolean => {
  for (const entry of freshlyScheduledStanding) if (entry.sources === sources && entry.key === key) return true
  return false
}


const loadCredentialEffect = (sources: CredentialSources) =>
  Effect.gen(function* () {
    let credential = yield* Effect.promise(() => resolveCredential(sources))
    if (credential === undefined)
      return yield* new AIError({ reason: new AuthenticationError({ message: NOT_SIGNED_IN_MESSAGE }) })
    // A standing renewal left behind by an earlier load — one whose
    // retry loop stopped on a verdict this process will not re-run —
    // must not swallow this load's own renewal: while the entry is
    // still pending the load drops it, re-reads the file record, and
    // renews in-request; an entry that has already settled is left
    // alone and the normal path below joins it. The probe is a
    // MACROTASK race, not a microtask count: Effect's promise
    // resolution hops several queue levels, and a still-pending
    // standing entry must be distinguishable from a settled one under
    // any scheduler — one macrotask turn separates them exactly.
    // The standing loop's own re-entry never takes this branch: it
    // carries its per-round sources by identity.
    const standingKey = `${sources.configDir ?? ""}\u0000${credential.refreshToken}`
    let inStandingSpan = false
    for (const span of standingRoundSpan)
      if (span.sources === sources && span.key === standingKey) inStandingSpan = true
    const stale = inStandingSpan ? undefined : standingRenewals.get(standingKey)
    if (stale !== undefined) {
      const verdict = yield* Effect.promise(() =>
        Promise.race([
          stale.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
        ]),
      )
      if (verdict !== "settled") {
        standingRenewals.delete(standingKey)
        credential = yield* Effect.promise(() =>
          Promise.resolve(resolveCredential(sources)).then((fresh) => fresh ?? credential!),
        )
        return yield* refreshAfterStandingEffect(sources, credential!)
      }
    }
    const now = sources.now ? sources.now() : Date.now()
    const expired = credential.expiresAt !== undefined && credential.expiresAt <= now
    // Renewal is due inside the lead window (#6120), not at expiry: a
    // credentials-file credential with a refresh token renews while its
    // current token still serves, so a rate-limited renewal can be
    // waited out without the door ever presenting an expired token.
    const renewalDue =
      credential.expiresAt !== undefined && credential.expiresAt - now <= RENEWAL_LEAD_MS
    if (!renewalDue) return credential
    // The env tier (#1752) never renews; a file credential with no
    // refresh token serves until expiry and then keeps the fail-loud
    // floor — there is nothing the server can renew it with.
    if (credential.source !== "credentials-file" || credential.refreshToken === undefined) {
      if (!expired) return credential
      return yield* new AIError({
        reason: new AuthenticationError({ message: expiredMessage(credential.expiresAt as number) }),
      })
    }
    return yield* Effect.tryPromise({
      try: () => refreshCredential(sources, credential),
      // A renewal still waiting out the endpoint's rate limit when its
      // budget ends surfaces as a rate limit (#6120): the router holds
      // the door on the rate-limit bench and fails the session over —
      // the request never reads as an authentication failure. The
      // renewal itself has retired to the standing retry (code#8102);
      // later requests join it until it lands.
      catch: (cause) => mapRenewalFailure(cause),
    })
  })

/**
 * The provider's auth: the CLI's OAuth access token as a Bearer credential,
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
