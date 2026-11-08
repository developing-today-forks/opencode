// Mistral Vibe credential bridge — the vibe provider (#1653) emulates the
// mistral-vibe CLI binary's wire behavior natively; this module mirrors
// the binary's credential resolution (utils/api_keys.py +
// core/config/vibe_schema.py in the mistral-vibe 3.1.0 package) so the
// provider spends the exact credential the binary's one-time browser
// sign-in provisions.
//
// Resolution order (the binary's resolve_api_key_with_origin, first hit
// wins):
//   0. explicit config: `auth` override, then static `apiKey` (fork-level,
//      for tests/offline — mirrors antigravity-auth's keyringAuth inputs)
//   1. environment MISTRAL_API_KEY (the binary loads ~/.vibe/.env values
//      into its process env UNDER the real env, so a real env var wins
//      over the file)
//   2. ~/.vibe/.env (dotenv; VIBE_HOME overrides the directory) — the
//      binary writes this file (0600) only as the fallback for when no OS
//      keyring backend is available at sign-in time
//   3. OS keyring, service "ai.mistral.vibe", username "MISTRAL_API_KEY"
//      (what `vibe --setup`'s browser sign-in stores: a plain workspace
//      API key, sent as Bearer verbatim — no refresh, no exchange)
//   4. OS keyring, legacy service "vibe", same username (the binary
//      migrates legacy entries to the new service; read-only here)
//
// The keyring is read in place through the native Secret Service binding;
// no helper process is spawned. The credential is never copied into the
// fork's credential store, written back, or logged. The vibe CLI remains
// the owner of the stored credential.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth, MissingCredentialError } from "../route/auth.js"

export const API_KEY_ENV_VAR = "MISTRAL_API_KEY"
export const KEYRING_SERVICE = "ai.mistral.vibe"
export const LEGACY_KEYRING_SERVICE = "vibe"

export const NOT_SIGNED_IN_MESSAGE =
  "Mistral Vibe is not signed in on this machine: no MISTRAL_API_KEY in the environment, " +
  '~/.vibe/.env, or the OS keyring (service "ai.mistral.vibe"). ' +
  "Run `vibe --setup` once and complete the browser sign-in, or set MISTRAL_API_KEY."

/** Injectable credential sources (tests); every field defaults to the real machine source. */
export interface CredentialSources {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (path: string) => string | undefined | Promise<string | undefined>
  readonly keyringLookup?: (service: string, username: string) => Promise<string | undefined>
  readonly onShadowDiagnostic?: (diagnostic: ShadowDiagnostic) => void
}

/**
 * Emitted when a non-keyring tier wins while a keyring sign-in entry also
 * exists (#1809): the winning tier's credential is what gets billed, not
 * the sign-in credential, and that rerouting must not be silent. Carries
 * only the winning tier and the shadowed keyring service — never any part
 * of any credential value.
 */
export interface ShadowDiagnostic {
  readonly winningTier: "environment" | "dotenv-file"
  readonly shadowedService: string
}

/** Minimal dotenv parser: KEY=VALUE lines, `#` comments, optional `export `, optional quotes. */
export const parseDotEnv = (contents: string): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const statement = line.startsWith("export ") ? line.slice("export ".length) : line
    const eq = statement.indexOf("=")
    if (eq <= 0) continue
    const key = statement.slice(0, eq).trim()
    let value = statement.slice(eq + 1).trim()
    const quoted = value.match(/^(['"])((?:\\.|(?!\1).)*)\1(?:[ \t]*#.*)?$/)
    if (quoted) {
      value = quoted[2]
    } else {
      // Unquoted values may carry a trailing comment (`KEY=value # note`).
      const comment = value.indexOf(" #")
      if (comment >= 0) value = value.slice(0, comment).trimEnd()
    }
    if (key) values[key] = value
  }
  return values
}

/**
 * One keyring read. Any failure (no Secret Service, entry absent, timeout)
 * resolves to undefined — the binary treats keyring
 * trouble as "no credential there" and falls through, and the resolver's
 * final absence error names every location checked.
 */
const defaultKeyringLookup = async (service: string, username: string): Promise<string | undefined> => {
  const { lookupSecretService } = await import("./secret-service.js")
  return lookupSecretService(service, username)
}

const defaultReadFile = async (path: string): Promise<string | undefined> => {
  const { readFileSync } = await import("node:fs")
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

const defaultShadowDiagnostic = (diagnostic: ShadowDiagnostic): void => {
  console.warn(
    `vibe-auth: MISTRAL_API_KEY from the ${diagnostic.winningTier === "environment" ? "environment" : "~/.vibe/.env file"} ` +
      `shadows the OS keyring sign-in entry (service "${diagnostic.shadowedService}"); ` +
      "billing uses the winning tier's credential, not the sign-in credential",
  )
}

/**
 * Existence-only keyring probe for the non-keyring win paths (#1809): the
 * probed value is never logged, returned, or used — only its presence
 * decides whether the shadow diagnostic fires. Probe or sink failures
 * never break resolution: observability must not become an auth outage.
 */
const reportShadowedKeyring = async (
  sources: CredentialSources,
  lookup: NonNullable<CredentialSources["keyringLookup"]>,
  winningTier: ShadowDiagnostic["winningTier"],
): Promise<void> => {
  let shadowedService: string | undefined
  try {
    for (const service of [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE]) {
      if ((await lookup(service, API_KEY_ENV_VAR))?.trim()) {
        shadowedService = service
        break
      }
    }
  } catch {
    return
  }
  if (!shadowedService) return
  try {
    ;(sources.onShadowDiagnostic ?? defaultShadowDiagnostic)({ winningTier, shadowedService })
  } catch {}
}

/**
 * The binary's credential resolution (tiers 1-4 above). Rejects with the
 * not-signed-in guidance when no tier holds a key.
 */
export const resolveApiKey = async (sources: CredentialSources = {}): Promise<string> => {
  const env = sources.env ?? process.env
  const lookup = sources.keyringLookup ?? defaultKeyringLookup
  const fromEnv = env[API_KEY_ENV_VAR]?.trim()
  if (fromEnv) {
    await reportShadowedKeyring(sources, lookup, "environment")
    return fromEnv
  }

  const { join } = await import("node:path")
  const { homedir } = await import("node:os")
  const vibeHome = env.VIBE_HOME?.trim() ? env.VIBE_HOME : join(homedir(), ".vibe")
  const contents = await (sources.readFile ?? defaultReadFile)(join(vibeHome, ".env"))
  if (contents !== undefined) {
    const fromFile = parseDotEnv(contents)[API_KEY_ENV_VAR]?.trim()
    if (fromFile) {
      await reportShadowedKeyring(sources, lookup, "dotenv-file")
      return fromFile
    }
  }

  for (const service of [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE]) {
    const fromKeyring = (await lookup(service, API_KEY_ENV_VAR))?.trim()
    if (fromKeyring) return fromKeyring
  }

  throw new Error(NOT_SIGNED_IN_MESSAGE)
}

let cached: string | undefined
let inflight: Promise<string> | undefined

/** Drop the in-memory credential (re-resolve on next use). Production
 * caller: the Vibe route's transport, on a 401 (#1900). */
export const invalidate = () => {
  cached = undefined
  inflight = undefined
}

const loadApiKey = (sources?: CredentialSources): Promise<string> => {
  // Explicit sources (tests, embedding hosts) bypass the process cache.
  if (sources) return resolveApiKey(sources)
  if (cached !== undefined) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = (async () => {
    try {
      cached = await resolveApiKey()
      return cached
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

const loadApiKeyEffect = (sources?: CredentialSources) =>
  Effect.tryPromise({
    try: () => loadApiKey(sources),
    catch: (cause: unknown) =>
      new MissingCredentialError(
        "mistral vibe credential",
        cause instanceof Error ? cause.message : NOT_SIGNED_IN_MESSAGE,
      ),
  })

/**
 * The User-Agent the mistral-vibe binary presents on its API requests
 * on the built-in `mistral` backend provider (the route vibe-direct
 * clones): `mistral-client-python/Mistral-Vibe/<version>`. The
 * `mistral-client-python/` prefix comes from the binary's own
 * `vibe/utils/http.py::get_user_agent(backend)`, which returns
 * `Mistral-Vibe/{version}` and prepends `mistral-client-python/` when
 * backend == "mistral" — wire-captured 2026-11-06 against the built-in
 * mistral-backend provider (real Mistral Vibe CLI 3.1.0, POST
 * /v1/chat/completions). The unprefixed form `Mistral-Vibe/3.1.0` is
 * what a generic-backend capture produces and is NOT what the real
 * Mistral route sends. The version tracks the fleet's installed
 * release (mistral-vibe 3.1.0, the uv-tool install in
 * ~/.local/share/uv/tools); move it when that install moves. Stamped
 * in auth, after the transport's header merge, for the same reason as
 * claude-code-auth: a session request's own harness User-Agent would
 * otherwise override it and the wire would present OpenCode's
 * identity, not Vibe's.
 */
export const CLI_USER_AGENT = "mistral-client-python/Mistral-Vibe/3.1.0"

/**
 * Bearer auth whose credential is the vibe binary's own sign-in credential,
 * resolved exactly as the binary resolves it. An explicit `auth` override
 * wins; an explicit static `apiKey` is accepted for tests/offline use.
 */
export const vibeAuth = (input: {
  readonly auth?: Auth.Definition
  readonly apiKey?: string
  readonly sources?: CredentialSources
}) => {
  if (input.auth) return input.auth
  if (input.apiKey !== undefined)
    return Auth.custom((authInput) =>
      Effect.succeed(
        Headers.setAll(authInput.headers, {
          authorization: `Bearer ${input.apiKey as string}`,
          "user-agent": CLI_USER_AGENT,
        }),
      ),
    )
  return Auth.custom((authInput) =>
    Effect.gen(function* () {
      const apiKey = yield* loadApiKeyEffect(input.sources)
      return Headers.setAll(authInput.headers, {
        authorization: `Bearer ${apiKey}`,
        "user-agent": CLI_USER_AGENT,
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

export * as VibeAuth from "./vibe-auth.js"
