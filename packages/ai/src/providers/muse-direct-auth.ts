// Muse direct credential bridge — the muse-direct provider (#1825)
// serves the fleet's Muse plan seats (the muse-spark / muse-wonder
// contributor models) over Meta's native wire, replacing the loopback
// bin/muse-proxy.mjs door in developing-today/code. There is no
// subprocess, no Muse CLI spawn and no proxy hop: this module performs
// the one credential exchange the plan itself defines, in-process, over
// HTTPS.
//
// The Muse account credential lives in ~/.config/muse/auth.json
// (MUSE_AUTH_PATH overrides the path — the door's own variable),
// written by the Muse app's sign-in:
//   { "providers": { "meta": { "access_token": "dca:...",
//                              "api_key": "LLM|..." } } }
// The access_token is the ACCOUNT token; it is never sent to the
// inference endpoint. When the file has no stored api_key, it is exchanged at
// POST https://api.meta.ai/muse-code/key (Authorization: Bearer
// <account token>, x-api-version: 1.0.0, body {"onboard": false}) for
// the plan's minted inference key (the response's api_key field), and
// inference then carries that key as a bare Bearer credential — the
// door's recorded direct-mode behaviour, ported behaviour for
// behaviour:
//
//   - the minted key is cached in memory for 10 minutes (the door's
//     DIRECT_KEY_TTL_MS);
//   - on the bootstrap path, an upstream 401 invalidates the minted-key
//     cache; the route's transport re-prepares and re-exchanges once
//     (see protocols/muse-direct-responses.ts);
//   - an exchange reporting is_subs_active === false or
//     require_payment === true is a HARD error carrying the door's own
//     messages — never a silent fallback to another route or key;
//   - a stored api_key is the primary inference credential, even when an
//     account token is also present; it is read fresh per request;
//   - the account token is exchanged only when no api_key is stored.
//
// The credential is read IN PLACE, never copied into the fork's
// credential store, and never logged. Values are trimmed before use:
// a blank value is no credential (the #1765 rule the other bridges
// hold).
import { Effect } from "effect"
import { Headers } from "effect/http"
import { readBoundedResponseText } from "@opencode/util/http-body"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth } from "../route/auth.js"

export const AUTH_PATH_ENV_VAR = "MUSE_AUTH_PATH"
export const DEFAULT_API_BASE = "https://api.meta.ai"
export const KEY_EXCHANGE_PATH = "/muse-code/key"
/** The door's DIRECT_KEY_TTL_MS: minted-key cache lifetime. */
export const MINTED_KEY_TTL_MS = 10 * 60 * 1000
/** Deadline for the key exchange; the endpoint returns a small JSON struct. */
export const KEY_EXCHANGE_TIMEOUT_MS = 15_000
/** Byte cap for the key-exchange response body; the claude-code exchange's cap (#1862). */
export const KEY_EXCHANGE_RESPONSE_MAX_BYTES = 1024 * 1024

export const NOT_SIGNED_IN_MESSAGE =
  "Muse account credential unavailable: no usable providers.meta credential in the Muse auth file " +
  `(default ~/.config/muse/auth.json; ${AUTH_PATH_ENV_VAR} overrides the path). Sign in with the Muse app ` +
  "so the file holds an account access_token (exchanged for the plan's inference key) or a minted api_key; " +
  "muse-direct fails closed rather than falling back to a proxy, a CLI, or a pay-as-you-go key."

export const SUBSCRIPTION_INACTIVE_MESSAGE =
  "Direct Meta route unavailable: Muse Code subscription is not active (is_subs_active=false)"
export const PAYMENT_REQUIRED_MESSAGE =
  "Direct Meta route unavailable: Muse Code subscription requires payment (require_payment=true)"
export const REAUTH_REQUIRED_MESSAGE = "Muse account credential was rejected; sign in again with the Muse app"

/** Injectable credential sources (tests); every field defaults to the real machine source. */
export interface CredentialSources {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (path: string) => string | undefined | Promise<string | undefined>
  /** Fetch used for the key exchange (tests); defaults to the global fetch. */
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  /** Credential file path (defaults to $MUSE_AUTH_PATH or ~/.config/muse/auth.json). */
  readonly authPath?: string
  /** Meta API base for the key exchange (defaults to https://api.meta.ai; no /v1 suffix). */
  readonly apiBase?: string
  /** Override for the key-exchange deadline (tests); defaults to 15 seconds. */
  readonly exchangeTimeoutMs?: number
}

export interface MuseCredential {
  readonly accountToken?: string
  readonly inferenceKey?: string
}

const nonBlank = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Parse the Muse auth file; anything malformed reads as "no credential there". */
export const parseAuthFile = (contents: string): MuseCredential | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const providers = (parsed as Record<string, unknown>).providers
  if (typeof providers !== "object" || providers === null) return undefined
  const meta = (providers as Record<string, unknown>).meta
  if (typeof meta !== "object" || meta === null) return undefined
  const record = meta as Record<string, unknown>
  const credential: MuseCredential = {
    accountToken: nonBlank(record.access_token),
    inferenceKey: nonBlank(record.api_key),
  }
  return credential.accountToken === undefined && credential.inferenceKey === undefined ? undefined : credential
}

export const authFilePath = async (sources: CredentialSources = {}): Promise<string> => {
  if (sources.authPath) return sources.authPath
  const fromEnv = (sources.env ?? process.env)[AUTH_PATH_ENV_VAR]
  if (fromEnv) return fromEnv
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  return join(homedir(), ".config", "muse", "auth.json")
}

const defaultReadFile = async (path: string): Promise<string | undefined> => {
  const { readFile } = await import("node:fs/promises")
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

const readCredential = async (sources: CredentialSources): Promise<MuseCredential | undefined> => {
  const contents = await (sources.readFile ?? defaultReadFile)(await authFilePath(sources))
  return contents === undefined ? undefined : parseAuthFile(contents)
}

/**
 * One exchange against /muse-code/key: the account token for the
 * plan's minted inference key. A rejected account token has a named
 * re-auth message; subscription states are hard errors with the door's
 * own wording.
 */
export const exchangeMintedKey = async (accountToken: string, sources: CredentialSources = {}): Promise<string> => {
  const base = (sources.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  const fetchFn = sources.fetchFn ?? fetch
  const response = await fetchFn(`${base}${KEY_EXCHANGE_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accountToken}`,
      "x-api-version": "1.0.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({ onboard: false }),
    signal: AbortSignal.timeout(sources.exchangeTimeoutMs ?? KEY_EXCHANGE_TIMEOUT_MS),
  })
  const text = await readBoundedResponseText(
    response,
    KEY_EXCHANGE_RESPONSE_MAX_BYTES,
    () => new Error(`Muse key exchange response exceeded ${KEY_EXCHANGE_RESPONSE_MAX_BYTES} bytes`),
  )
  if (response.status === 401) throw new Error(REAUTH_REQUIRED_MESSAGE)
  if (!response.ok) throw new Error(`Muse key exchange failed: HTTP ${response.status}: ${text.slice(0, 200)}`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error("Muse key exchange returned a non-JSON response")
  }
  if (typeof body !== "object" || body === null) throw new Error("Muse key exchange returned an unexpected response")
  const record = body as Record<string, unknown>
  if (record.is_subs_active === false) throw new Error(SUBSCRIPTION_INACTIVE_MESSAGE)
  if (record.require_payment === true) throw new Error(PAYMENT_REQUIRED_MESSAGE)
  const mintedKey = nonBlank(record.api_key)
  if (!mintedKey) throw new Error("Muse key exchange returned no api_key")
  return mintedKey
}

interface KeyState {
  readonly key: string
  readonly cachedAt: number
}

interface SourceState {
  readonly generation: number
  cached?: KeyState
  inflight?: Promise<string>
}

// Each injected credential source object owns its own cache. The default
// machine source keeps one shared cache, while generations let a 401
// invalidate every source without retaining retired source objects.
const defaultSources: CredentialSources = {}
const cacheBySources = new WeakMap<CredentialSources, SourceState>()
let cacheGeneration = 0

/** Drop the cached bootstrap key after an upstream 401. */
export const invalidate = () => {
  cacheGeneration++
}

const now = (sources: CredentialSources) => (sources.now ?? Date.now)()

const loadKey = (sources: CredentialSources = defaultSources): Promise<string> => {
  const previous = cacheBySources.get(sources)
  const state = previous?.generation === cacheGeneration ? previous : { generation: cacheGeneration }
  if (state !== previous) cacheBySources.set(sources, state)
  if (state.inflight) return state.inflight
  const inflight = (async () => {
    try {
      const credential = await readCredential(sources)
      if (credential?.inferenceKey) {
        // A stored minted key is the stable inference credential; re-read it
        // on every request so the Muse app can rotate it in place.
        return credential.inferenceKey
      }
      if (state.cached && now(sources) - state.cached.cachedAt < MINTED_KEY_TTL_MS) return state.cached.key
      if (!credential) throw new Error(NOT_SIGNED_IN_MESSAGE)
      if (!credential.accountToken) throw new Error(NOT_SIGNED_IN_MESSAGE)
      const key = await exchangeMintedKey(credential.accountToken, sources)
      state.cached = { key, cachedAt: now(sources) }
      return key
    } finally {
      state.inflight = undefined
    }
  })()
  state.inflight = inflight
  return inflight
}

const loadKeyEffect = (sources?: CredentialSources) =>
  Effect.tryPromise({
    try: () => loadKey(sources),
    catch: (cause: unknown) =>
      new AIError({
        reason: new AuthenticationError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      }),
  })

/**
 * Bearer auth whose credential is the Muse plan's minted inference
 * key, exchanged in-process from the Muse account credential. An
 * explicit `auth` override wins; an explicit static `apiKey` (an
 * already-minted key) is accepted for tests/offline use. There is
 * deliberately NO pay-as-you-go fallback: this door is plan-backed.
 */
export const museDirectAuth = (input: {
  readonly auth?: Auth.Definition
  readonly apiKey?: string
  readonly sources?: CredentialSources
}) => {
  if (input.auth) return input.auth
  if (input.apiKey !== undefined) return Auth.bearer(input.apiKey)
  const sources = input.sources
  return Auth.custom((authInput) =>
    loadKeyEffect(sources).pipe(Effect.map((key) => Headers.set(authInput.headers, "authorization", `Bearer ${key}`))),
  )
}

export * as MuseDirectAuth from "./muse-direct-auth.js"
