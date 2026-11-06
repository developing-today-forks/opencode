// Antigravity (agy CLI) credential bridge — Gate 1 of #1414 (see the
// credential story recorded on that issue).
//
// The live credential is the agy CLI's OAuth token set in the OS keyring
// (Secret Service): service "gemini", username "antigravity", shape
// { token: { access_token, refresh_token, expiry, token_type },
// auth_method: "consumer" }. The provider reads it IN PLACE via
// `secret-tool lookup` — it is never synced into the fork's credential
// store, never written back, and never logged. The agy CLI remains the
// owner of the stored credential (it alone writes the keyring, on its
// own logins/runs).
//
// Access-token refresh is the CLI's own exchange, held in memory only:
// POST https://oauth2.googleapis.com/token with grant_type=refresh_token
// and the CLI's embedded OAuth client. The client id below is a public
// identifier (it appears in the CLI's sign-in URLs); the paired secret
// is extracted from the agy binary at runtime and is never persisted.
// The binary embeds several GOCSPX runs and which one pairs with the
// client id below has moved between agy releases (#1633: on 1.4.11 the
// first run is a decoy), so extraction collects every candidate (each
// run's first 35 chars, plus chars 35-70 for runs of 70+ chars) and the
// refresh exchange tries them in order, advancing only when the token
// endpoint rejects a candidate as invalid_client; the winner is cached
// in memory only. Google does not rotate the refresh token for
// this client, so refreshing here never invalidates the CLI's stored
// credential. This mirrors bin/antigravity-direct.mjs in
// developing-today/code, which this module replaces.
import { Duration, Effect, Schema, Stream } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth, MissingCredentialError } from "../route/auth.js"

const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
/**
 * The agy CLI's wire User-Agent when the binary scan below cannot read
 * one out of the installed binary. Current agy builds CONSTRUCT this
 * string at runtime (no literal copy exists in the binary - verified
 * against both installed builds, 2026-11-06), so for them this constant
 * is the effective identity and must move with the installed CLI. The
 * value below was captured from the wire of the fleet's installed CLI
 * (~/.gemini/bin/agy 1.5.0 - the install `findAgyBinary` prefers) on
 * 2026-11-06; the grammar (version + changelist) is the CLI's own.
 */
export const FALLBACK_UA =
  "antigravity/cli/1.5.0 (aidev_client; os_type=linux; arch=amd64; cl=1013440158; auth_method=consumer)"

/**
 * Deadline + size cap for the token-refresh exchange (#1469). The token
 * endpoint returns a small JSON struct (a few KB in practice); 64 KiB is
 * generous headroom (mirrors core's oauthMaxResponseBytes, #1026) while
 * keeping a misbehaving endpoint from buffering an unbounded body into
 * memory. The 15s deadline matches the keyring exec timeout in this file:
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
let binaryIntelCache:
  | { readonly bin?: string; readonly ua: string; readonly clientSecrets: readonly string[] }
  | undefined
/** The candidate the token endpoint last accepted; tried first next time. Memory only, never logged. */
let winningSecret: string | undefined

/** Drop the in-memory access token (upstream 401: re-read + refresh on next use). */
export const invalidate = () => {
  cached = undefined
}

const parseExpiry = (value: unknown) => {
  if (typeof value !== "string" || !value) return 0
  const parsed = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"))
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Why a missing secret-tool fails the way it does (#1825): the
 * antigravity credential lives in the Secret Service keyring and this
 * bridge reads it with libsecret's secret-tool — there is no file/env
 * tier for this provider — so the error names the binary and the
 * supported remedies instead of surfacing as an opaque throw.
 */
export const SECRET_TOOL_NOT_FOUND_MESSAGE =
  "secret-tool not found: the antigravity credential is stored in the Secret Service keyring " +
  "(service \"gemini\", username \"antigravity\") and is read with libsecret's secret-tool, which is not " +
  "installed on this host. Install libsecret (or set SECRET_TOOL_PATH to a secret-tool binary); " +
  "the keyring entry itself is written by signing in with the agy CLI."

export const AGY_SECRET_EXTRACTION_MESSAGE =
  "could not extract OAuth client secret from agy binary: token refresh reads the client secret " +
  "from the agy CLI binary's bytes, and no GOCSPX candidate was found. Install the agy CLI " +
  "(or set AGY_BIN to its path) so the binary is present on this host."

export const findSecretTool = async (nixStoreDir = "/nix/store"): Promise<string> => {
  const { accessSync, constants, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const candidates: string[] = []
  if (process.env.SECRET_TOOL_PATH) candidates.push(process.env.SECRET_TOOL_PATH)
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(join(dir, "secret-tool"))
  try {
    for (const store of readdirSync(nixStoreDir).filter((entry) => entry.includes("libsecret")).sort())
      candidates.push(join(nixStoreDir, store, "bin", "secret-tool"))
  } catch {}
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(SECRET_TOOL_NOT_FOUND_MESSAGE)
}

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
  const { execFile } = await import("node:child_process")
  const env = { ...process.env }
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`
  }
  const tool = await findSecretTool()
  return new Promise<KeyringCreds>((resolve, reject) => {
    execFile(tool, ["lookup", "service", "gemini", "username", "antigravity"], { env, timeout: 15_000, maxBuffer: 1 << 20 }, (error, out) => {
      if (error) return reject(new Error(`keyring lookup failed: ${error.message}`))
      try {
        resolve(parseKeyringCreds(out))
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  })
}

const findAgyBinary = async (): Promise<string | undefined> => {
  const { accessSync, constants } = await import("node:fs")
  const { join } = await import("node:path")
  const { homedir } = await import("node:os")
  const candidates = [process.env.AGY_BIN, join(homedir(), ".gemini", "bin", "agy"), "/run/current-system/sw/bin/agy"].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

/** User-Agent + OAuth client secret candidates from the agy binary, scanned in chunks, memory only. */
const binaryIntel = async () => {
  const bin = await findAgyBinary()
  if (binaryIntelCache && binaryIntelCache.bin === bin) return binaryIntelCache
  let ua = FALLBACK_UA
  const runs = new Set<string>()
  if (bin) {
    const { openSync, readSync, closeSync } = await import("node:fs")
    const fd = openSync(bin, "r")
    try {
      const chunk = Buffer.alloc(1 << 20)
      let carry = ""
      let position = 0
      let read: number
      // No early exit (#1633): every GOCSPX run in the binary is a
      // candidate, and runs can appear anywhere in the file. Matches are
      // collected from the stable region (all but the last 256 chars,
      // which carry into the next chunk). A match that REACHES the end
      // of the stable region may continue into the carry region, so it
      // is not collected yet: collect returns its start index and the
      // carry begins there instead, so the next pass (or the final
      // flush) sees the run from its first char and matches it whole —
      // never a truncated prefix, and never lost when the part inside
      // the stable region is shorter than the match minimum (#1822).
      const collect = (text: string, flush: boolean): number => {
        const stableEnd = flush ? text.length : Math.max(0, text.length - 256)
        const stable = text.slice(0, stableEnd)
        let pending = -1
        for (const match of stable.matchAll(/GOCSPX-[A-Za-z0-9_-]{10,}/g)) {
          if (!flush && match.index + match[0].length === stableEnd) {
            pending = match.index
            continue
          }
          runs.add(match[0])
        }
        if (!flush && pending < 0) {
          // A run can also hide BELOW the match minimum at the boundary:
          // only a fragment of it (or of the GOCSPX- literal itself) sits
          // inside the stable region, so matchAll cannot see it yet.
          // Defer from the fragment start the same way, or the carry —
          // which starts after it — would cut the run's head off and the
          // run would be lost entirely.
          const fragment = stable.match(/GOCSPX-[A-Za-z0-9_-]*$/)
          if (fragment) pending = stable.length - fragment[0].length
          else {
            for (let k = Math.min(6, stable.length); k >= 1; k--) {
              if (stable.endsWith("GOCSPX-".slice(0, k))) {
                pending = stable.length - k
                break
              }
            }
          }
        }
        if (ua === FALLBACK_UA) {
          const match = text.match(/antigravity\/cli\/[0-9.]+ \(aidev_client;[^)]*\)/)
          if (match) ua = match[0]
        }
        return pending
      }
      while ((read = readSync(fd, chunk, 0, chunk.length, position)) > 0) {
        position += read
        const text = carry + chunk.toString("latin1", 0, read)
        const pending = collect(text, false)
        carry = pending >= 0 ? text.slice(pending) : text.slice(-256)
      }
      collect(carry, true)
    } finally {
      closeSync(fd)
    }
  }
  // Candidate shape (#1633): each run's first 35 chars, plus chars 35-70
  // for runs of 70+ chars (the 1.4.8 layout concatenates two secrets in
  // one run), deduped in scan order.
  const clientSecrets: string[] = []
  for (const run of runs) {
    for (const candidate of [run.slice(0, 35), ...(run.length >= 70 ? [run.slice(35, 70)] : [])])
      if (!clientSecrets.includes(candidate)) clientSecrets.push(candidate)
  }
  binaryIntelCache = { bin, ua, clientSecrets }
  return binaryIntelCache
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

/** The token endpoint rejected this candidate as not-the-client-secret (#1633). */
class InvalidClientError extends Error {
  readonly _tag = "InvalidClientError"
}

export const refresh = (refreshToken: string, timeoutMs = TOKEN_REFRESH_TIMEOUT_MS) =>
  Effect.gen(function* () {
    const { clientSecrets } = yield* Effect.tryPromise({
      try: () => binaryIntel(),
      catch: (cause) => cause,
    })
    if (clientSecrets.length === 0)
      return yield* Effect.fail(new Error(AGY_SECRET_EXTRACTION_MESSAGE))
    // Try the last accepted candidate first, then the rest in scan order.
    const ordered =
      winningSecret && clientSecrets.includes(winningSecret)
        ? [winningSecret, ...clientSecrets.filter((candidate) => candidate !== winningSecret)]
        : [...clientSecrets]
    const exchange = (clientSecret: string) =>
      Effect.gen(function* () {
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
        if (response.status !== 200) {
          // Only invalid_client means "wrong candidate" (#1633); every
          // other failure (invalid_grant for a bad stored grant, 5xx,
          // transport) surfaces unchanged instead of cycling candidates.
          let errorCode: string | undefined
          try {
            errorCode = (JSON.parse(text) as { error?: string }).error
          } catch {}
          if (response.status === 401 && errorCode === "invalid_client")
            return yield* Effect.fail(new InvalidClientError(`token endpoint HTTP ${response.status}: ${text.slice(0, 200)}`))
          return yield* Effect.fail(new Error(`token endpoint HTTP ${response.status}: ${text.slice(0, 200)}`))
        }
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
    let lastInvalidClient: InvalidClientError | undefined
    for (const candidate of ordered) {
      const token = yield* exchange(candidate).pipe(
        Effect.catch((error) => {
          if (error instanceof InvalidClientError) {
            lastInvalidClient = error
            return Effect.succeed(undefined)
          }
          return Effect.fail(error)
        }),
      )
      if (token) {
        winningSecret = candidate
        return token
      }
    }
    return yield* Effect.fail(lastInvalidClient ?? new Error(AGY_SECRET_EXTRACTION_MESSAGE))
  })

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
      const intel = yield* Effect.promise(() => binaryIntel())
      return Headers.setAll(authInput.headers, {
        authorization: `Bearer ${token.accessToken}`,
        "user-agent": intel.ua,
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
