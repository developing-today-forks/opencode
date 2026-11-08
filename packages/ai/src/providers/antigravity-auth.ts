// Antigravity (agy CLI) credential bridge — Gate 1 of #1414 (see the
// credential story recorded on that issue).
//
// The live credential is the agy CLI's OAuth token set in the Secret
// Service keyring: service "gemini", username "antigravity". It is read
// in place through the native keyring binding and never copied, written
// back, or logged. Token refresh uses the separately provisioned
// ANTIGRAVITY_OAUTH_CLIENT_SECRET; this provider no longer inspects or
// depends on the agy executable.
import { Duration, Effect, Schema, Stream } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth, MissingCredentialError } from "../route/auth.js"

const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
/**
 * The agy CLI's wire User-Agent, captured from the fleet's installed CLI
 * (~/.gemini/bin/agy 1.5.0) on 2026-11-06. The grammar (version and
 * changelist) is the CLI's own; keep this value aligned with that wire
 * identity without inspecting the installed executable.
 */
export const FALLBACK_UA =
  "antigravity/cli/1.5.0 (aidev_client; os_type=linux; arch=amd64; cl=1013440158; auth_method=consumer)"

/**
 * Deadline + size cap for the token-refresh exchange (#1469). The token
 * endpoint returns a small JSON struct (a few KB in practice); 64 KiB is
 * generous headroom (mirrors core's oauthMaxResponseBytes, #1026) while
 * keeping a misbehaving endpoint from buffering an unbounded body into
 * memory. The 15s deadline matches the Secret Service lookup timeout:
 * loadToken() shares one inflight promise, so a stalled refresh would
 * otherwise wedge every Antigravity auth attempt process-wide.
 */
export const TOKEN_REFRESH_TIMEOUT_MS = 15_000
export const TOKEN_REFRESH_MAX_RESPONSE_BYTES = 64 * 1024

const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

interface KeyringCreds {
  readonly accessToken?: string
  readonly refreshToken: string
  readonly expiryMs: number
}

interface TokenState {
  readonly accessToken: string
  readonly expiryMs: number
}

let cached: TokenState | undefined
let inflight: Promise<TokenState> | undefined

/** Drop the in-memory access token (upstream 401: re-read + refresh on next use). */
export const invalidate = () => {
  cached = undefined
}

const parseExpiry = (value: unknown) => {
  if (typeof value !== "string" || !value) return 0
  const parsed = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"))
  return Number.isNaN(parsed) ? 0 : parsed
}

export const CLIENT_SECRET_NOT_FOUND_MESSAGE =
  "ANTIGRAVITY_OAUTH_CLIENT_SECRET is not configured; provision the OAuth client secret in the provider environment before token refresh."

/**
 * Parse the agy keyring credential JSON, applying the blank-credential
 * rule (#1765, the rule vibe-auth holds and #1763 extended to the other
 * bridges): a blank value is no credential. Tokens are trimmed before
 * use; a whitespace-only refresh_token is the unexpected-shape/absent
 * case, and a whitespace-only access_token is absent (undefined) so it
 * is never cached or sent as a Bearer <redacted>
 */
export const parseKeyringCreds = (out: string): KeyringCreds => {
  let creds: { token?: { access_token?: string; refresh_token?: string; expiry?: string } }
  try {
    creds = JSON.parse(out) as { token?: { access_token?: string; refresh_token?: string; expiry?: string } }
  } catch (cause) {
    throw new Error(`keyring credential is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const refreshToken = creds.token?.refresh_token?.trim()
  if (!refreshToken) throw new Error("keyring credential has unexpected shape")
  return {
    accessToken: creds.token?.access_token?.trim() || undefined,
    refreshToken,
    expiryMs: parseExpiry(creds.token?.expiry),
  }
}

const readKeyringCreds = async (): Promise<KeyringCreds> => {
  const { lookupSecretService } = await import("./secret-service.js")
  const value = await lookupSecretService("gemini", "antigravity")
  if (!value)
    throw new Error(
      'Antigravity Secret Service entry is missing or unavailable (service "gemini", username "antigravity"). Sign in with agy and ensure the keyring is unlocked.',
    )
  return parseKeyringCreds(value)
}

const loadTokenEffect = Effect.tryPromise({
  try: () => loadToken(),
  catch: (cause: unknown) =>
    new MissingCredentialError(
      "antigravity keyring",
      `Antigravity keyring credential unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    ),
})

const readBoundedTokenResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const tooLarge = () => new Error(`token endpoint response exceeded ${TOKEN_REFRESH_MAX_RESPONSE_BYTES} bytes`)
    const contentLength = response.headers["content-length"]
    const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
    const declaredSize =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
    if (declaredSize !== undefined && declaredSize > TOKEN_REFRESH_MAX_RESPONSE_BYTES) return yield* Effect.fail(tooLarge())

    let body = Buffer.allocUnsafe(Math.min(TOKEN_REFRESH_MAX_RESPONSE_BYTES, declaredSize || 64 * 1024))
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (chunk.byteLength === 0) return Effect.void
      if (size + chunk.byteLength > TOKEN_REFRESH_MAX_RESPONSE_BYTES) return Effect.fail(tooLarge())
      if (size + chunk.byteLength > body.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(TOKEN_REFRESH_MAX_RESPONSE_BYTES, Math.max(size + chunk.byteLength, body.byteLength * 2)))
        body.copy(grown, 0, 0, size)
        body = grown
      }
      body.set(chunk, size)
      size += chunk.byteLength
      return Effect.void
    })
    return body.subarray(0, size).toString("utf8")
  })

export const refresh = (
  refreshToken: string,
  timeoutMs = TOKEN_REFRESH_TIMEOUT_MS,
  clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim(),
) =>
  Effect.gen(function* () {
    if (!clientSecret) return yield* Effect.fail(new Error(CLIENT_SECRET_NOT_FOUND_MESSAGE))
    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString()
    const request = HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
      HttpClientRequest.bodyText(body, "application/x-www-form-urlencoded"),
    )
    const http = yield* HttpClient.HttpClient
    const response = yield* HttpClient.withScope(http).execute(request)
    const text = yield* readBoundedTokenResponse(response)
    if (response.status !== 200)
      return yield* Effect.fail(new Error(`token endpoint rejected refresh (HTTP ${response.status})`))
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse))(text)
    const accessToken = parsed.access_token?.trim()
    if (!accessToken) return yield* Effect.fail(new Error("token endpoint returned no access_token"))
    return { accessToken, expiryMs: Date.now() + (parsed.expires_in ?? 3600) * 1000 }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.fail(new Error(`token endpoint request timed out after ${timeoutMs}ms`)),
    }),
  )

const loadToken = (): Promise<TokenState> => {
  if (cached && cached.expiryMs - Date.now() > 60_000) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const creds = await readKeyringCreds()
      const accessToken = creds.accessToken?.trim()
      if (accessToken && creds.expiryMs - Date.now() > 60_000) {
        cached = { accessToken, expiryMs: creds.expiryMs }
        return cached
      }
      cached = await Effect.runPromise(refresh(creds.refreshToken).pipe(Effect.provide(FetchHttpClient.layer)))
      return cached
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

/**
 * Bearer auth whose credential is the keyring access token, refreshed in
 * memory. An explicit `auth` override wins; an explicit static token is
 * accepted for tests/offline use. There is deliberately NO API-key
 * fallback: this door is plan-backed (NEVER FUNDS).
 */
export const keyringAuth = (input: { readonly auth?: Auth.Definition; readonly accessToken?: string }) => {
  if (input.auth) return input.auth
  if (input.accessToken !== undefined) return Auth.bearer(input.accessToken)
  return Auth.custom((authInput) =>
    Effect.gen(function* () {
      const token = yield* loadTokenEffect
      return Headers.setAll(authInput.headers, {
        authorization: `Bearer ${token.accessToken}`,
        "user-agent": FALLBACK_UA,
      })
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AIError({
            reason: new AuthenticationError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          }),
      ),
    ),
  )
}

export * as AntigravityAuth from "./antigravity-auth.js"
