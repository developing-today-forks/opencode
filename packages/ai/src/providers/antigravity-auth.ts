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
// is extracted from the agy binary at runtime (the first 35 chars of its
// embedded GOCSPX blob — the pairing the standalone door verified live)
// and is never persisted. Google does not rotate the refresh token for
// this client, so refreshing here never invalidates the CLI's stored
// credential. This mirrors bin/antigravity-direct.mjs in
// developing-today/code, which this module replaces.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth, MissingCredentialError } from "../route/auth.js"

const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const FALLBACK_UA = "antigravity/cli/1.4.11 (aidev_client; os_type=linux; arch=amd64; cl=1010154931; auth_method=consumer)"

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
let binaryIntelCache: { readonly ua: string; readonly clientSecret?: string } | undefined

/** Drop the in-memory access token (upstream 401: re-read + refresh on next use). */
export const invalidate = () => {
  cached = undefined
}

const parseExpiry = (value: unknown) => {
  if (typeof value !== "string" || !value) return 0
  const parsed = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"))
  return Number.isNaN(parsed) ? 0 : parsed
}

const findSecretTool = async (): Promise<string> => {
  const { accessSync, constants, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const candidates: string[] = []
  if (process.env.SECRET_TOOL_PATH) candidates.push(process.env.SECRET_TOOL_PATH)
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(join(dir, "secret-tool"))
  try {
    for (const store of readdirSync("/nix/store").filter((entry) => entry.includes("libsecret")).sort())
      candidates.push(join("/nix/store", store, "bin", "secret-tool"))
  } catch {}
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error("secret-tool not found (set SECRET_TOOL_PATH)")
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
        const creds = JSON.parse(out) as { token?: { access_token?: string; refresh_token?: string; expiry?: string } }
        if (!creds.token?.refresh_token) return reject(new Error("keyring credential has unexpected shape"))
        resolve({
          accessToken: creds.token.access_token,
          refreshToken: creds.token.refresh_token,
          expiryMs: parseExpiry(creds.token.expiry),
        })
      } catch (cause) {
        reject(new Error(`keyring credential is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`))
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

/** User-Agent + OAuth client secret from the agy binary, scanned in chunks, memory only. */
const binaryIntel = async () => {
  if (binaryIntelCache) return binaryIntelCache
  const bin = await findAgyBinary()
  let ua = FALLBACK_UA
  let clientSecret: string | undefined
  if (bin) {
    const { openSync, readSync, closeSync } = await import("node:fs")
    const fd = openSync(bin, "r")
    try {
      const chunk = Buffer.alloc(1 << 20)
      let carry = ""
      let position = 0
      let read: number
      while ((read = readSync(fd, chunk, 0, chunk.length, position)) > 0) {
        position += read
        const text = carry + chunk.toString("latin1", 0, read)
        if (!clientSecret) {
          const match = text.match(/GOCSPX-[A-Za-z0-9_-]{10,}/)
          // The binary embeds two client secrets concatenated (70 chars);
          // the first 35 chars pair with OAUTH_CLIENT_ID (verified live).
          if (match) clientSecret = match[0].slice(0, 35)
        }
        if (ua === FALLBACK_UA) {
          const match = text.match(/antigravity\/cli\/[0-9.]+ \(aidev_client;[^)]*\)/)
          if (match) ua = match[0]
        }
        if (clientSecret && ua !== FALLBACK_UA) break
        carry = text.slice(-256)
      }
    } finally {
      closeSync(fd)
    }
  }
  binaryIntelCache = { ua, clientSecret }
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

const refresh = async (refreshToken: string): Promise<TokenState> => {
  const { clientSecret } = await binaryIntel()
  if (!clientSecret) throw new Error("could not extract OAuth client secret from agy binary")
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString()
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) },
    body,
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`token endpoint HTTP ${response.status}: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number }
  if (!parsed.access_token) throw new Error("token endpoint returned no access_token")
  return { accessToken: parsed.access_token, expiryMs: Date.now() + (parsed.expires_in ?? 3600) * 1000 }
}

const loadToken = (): Promise<TokenState> => {
  if (cached && cached.expiryMs - Date.now() > 60_000) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const creds = await readKeyringCreds()
      if (creds.accessToken && creds.expiryMs - Date.now() > 60_000) {
        cached = { accessToken: creds.accessToken, expiryMs: creds.expiryMs }
        return cached
      }
      cached = await refresh(creds.refreshToken)
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
