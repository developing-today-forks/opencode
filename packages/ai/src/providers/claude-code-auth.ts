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
// the fork's credential store, never written back, and never logged. This
// provider deliberately does NOT refresh the token: the refresh token is
// the CLI's, a refresh here would rotate it out from under the CLI, and
// renewal of an expired login is the interactive `claude` sign-in. An
// expired credential therefore fails LOUDLY (see claudeCodeAuth) instead
// of silently degrading — the fail-closed floor of code#6117.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth } from "../route/auth.js"

export const OAUTH_TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"
export const CREDENTIALS_FILE_NAME = ".credentials.json"

export const NOT_SIGNED_IN_MESSAGE =
  "Claude Code is not signed in on this machine: no OAuth credential in ~/.claude/.credentials.json " +
  `and no ${OAUTH_TOKEN_ENV_VAR} in the environment. Run \`claude\` once and complete the claude.ai sign-in.`

export const expiredMessage = (expiresAt: number) =>
  "The Claude Code OAuth credential in ~/.claude/.credentials.json expired at " +
  `${new Date(expiresAt).toISOString()} and this provider does not refresh the CLI's login. ` +
  "Run `claude` and complete the sign-in to renew it; until then claude-code requests fail closed " +
  "rather than falling back to the CLI or an API key."

export interface ClaudeCodeCredential {
  readonly accessToken: string
  /** Epoch milliseconds, when the source carries expiry metadata. */
  readonly expiresAt?: number
  readonly source: "credentials-file" | "environment"
}

/** Injectable credential sources (tests); every field defaults to the real machine source. */
export interface CredentialSources {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (path: string) => string | undefined | Promise<string | undefined>
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
  const { accessToken, expiresAt } = oauth as Record<string, unknown>
  // A blank value is no credential (the vibe-auth rule): trim, and treat
  // whitespace-only as absent, so resolution falls through to the env tier
  // instead of sending a Bearer of spaces.
  const token = typeof accessToken === "string" ? accessToken.trim() : ""
  if (token.length === 0) return undefined
  return {
    accessToken: token,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined,
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

const loadCredentialEffect = (sources: CredentialSources) =>
  Effect.gen(function* () {
    const credential = yield* Effect.promise(() => resolveCredential(sources))
    if (credential === undefined)
      return yield* new AIError({ reason: new AuthenticationError({ message: NOT_SIGNED_IN_MESSAGE }) })
    const now = sources.now ? sources.now() : Date.now()
    if (credential.expiresAt !== undefined && credential.expiresAt <= now)
      return yield* new AIError({
        reason: new AuthenticationError({ message: expiredMessage(credential.expiresAt) }),
      })
    return credential
  })

/**
 * The provider's auth: the CLI's OAuth access token as a Bearer header.
 * The load-bearing OAuth beta flags ride on the route's static headers
 * (see protocols/claude-code-messages.ts); this layer owns only the
 * credential itself, re-read per request so a renewed sign-in is picked
 * up without a restart.
 */
export const claudeCodeAuth = (input: {
  readonly auth?: Auth.Definition
  readonly accessToken?: string
  readonly sources?: CredentialSources
}) => {
  if (input.auth) return input.auth
  if (input.accessToken !== undefined) return Auth.bearer(input.accessToken)
  const sources = input.sources ?? {}
  return Auth.custom((authInput) =>
    loadCredentialEffect(sources).pipe(
      Effect.map((credential) =>
        Headers.setAll(authInput.headers, { authorization: `Bearer ${credential.accessToken}` }),
      ),
    ),
  )
}

export * as ClaudeCodeAuth from "./claude-code-auth.js"
