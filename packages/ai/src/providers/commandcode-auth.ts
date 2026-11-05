// Command Code credential bridge — the commandcode provider (#6117)
// emulates the Command Code CLI's wire behavior natively (see
// protocols/commandcode.ts); this module mirrors the CLI's own
// credential storage so the provider spends the exact credential the
// one-time `cmd login` provisions.
//
// The CLI (verified against the installed command-code 1.74.1 bundle)
// stores its login in ~/.commandcode/auth.json (0600) as
//   { "apiKey": "user_...", "userId": ..., "userName": ...,
//     "keyName": ..., "authenticatedAt": ... }
// and sends that key as `Authorization: Bearer <apiKey>` to
// https://api.commandcode.ai — the same key the fork's command-code
// quota provider reads from the project auth store /
// COMMAND_CODE_API_KEY (packages/ai/src/quota/providers/command-code.ts).
//
// Resolution order:
//   0. explicit config: `auth` override, then static `apiKey`
//      (fork-level, for tests/offline — mirrors antigravity-auth's inputs)
//   1. environment COMMAND_CODE_API_KEY, then COMMANDCODE_API_KEY
//   2. ~/.commandcode/auth.json (the CLI's login file, read in place)
//
// The key is never copied into the fork's credential store, never
// written back, and never logged. The CLI remains the owner of the
// stored credential.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { AIError, AuthenticationError } from "../schema/index.js"
import { Auth } from "../route/auth.js"

export const API_KEY_ENV_VARS = ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"] as const
export const AUTH_FILE_NAME = "auth.json"
export const AUTH_DIR_NAME = ".commandcode"

export const NOT_SIGNED_IN_MESSAGE =
  "Command Code is not signed in on this machine: no apiKey in ~/.commandcode/auth.json and no " +
  "COMMAND_CODE_API_KEY in the environment. Run `cmd login` once and complete the sign-in, " +
  "or set COMMAND_CODE_API_KEY."

/** Injectable credential sources (tests); every field defaults to the real machine source. */
export interface CredentialSources {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (path: string) => string | undefined | Promise<string | undefined>
  /** Directory holding auth.json (defaults to ~/.commandcode). */
  readonly authDir?: string
}

/** Parse the CLI's auth file; anything malformed reads as "no credential there". */
export const parseAuthFile = (contents: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const apiKey = (parsed as Record<string, unknown>).apiKey
  return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined
}

const authFilePath = async (sources: CredentialSources): Promise<string> => {
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  return join(sources.authDir ?? join(homedir(), AUTH_DIR_NAME), AUTH_FILE_NAME)
}

const defaultReadFile = async (path: string): Promise<string | undefined> => {
  const { readFile } = await import("node:fs/promises")
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** First credential a source can produce, in the order above. */
export const resolveApiKey = async (sources: CredentialSources = {}): Promise<string | undefined> => {
  const env = sources.env ?? process.env
  for (const name of API_KEY_ENV_VARS) {
    const value = env[name]
    if (value !== undefined && value.length > 0) return value
  }
  const readFile = sources.readFile ?? defaultReadFile
  const contents = await readFile(await authFilePath(sources))
  if (contents !== undefined) return parseAuthFile(contents)
  return undefined
}

/**
 * The CLI version this emulation tracks. The gateway keys behavior on
 * the `x-command-code-version` header (the CLI sends its own version),
 * so the value must move with the installed CLI; 1.74.1 is the fleet's
 * installed release, whose bundle this protocol was extracted from.
 * Deployments on a different CLI release override it via the provider's
 * `cliVersion` setting.
 */
export const CLI_VERSION = "1.74.1"

/** The CLI's per-request headers (bundle: buildCommandApiHeaders). */
export const cliHeaders = (apiKey: string, cliVersion: string = CLI_VERSION) => ({
  authorization: `Bearer ${apiKey}`,
  "user-agent": "cli",
  "x-command-code-version": cliVersion,
  "x-cli-environment": "production",
})

/** The provider's auth: the CLI's API key plus its client-identity headers, re-read per request. */
export const commandCodeAuth = (input: {
  readonly auth?: Auth.Definition
  readonly apiKey?: string
  readonly sources?: CredentialSources
  readonly cliVersion?: string
}) => {
  if (input.auth) return input.auth
  if (input.apiKey !== undefined)
    return Auth.custom((authInput) =>
      Effect.succeed(Headers.setAll(authInput.headers, cliHeaders(input.apiKey as string, input.cliVersion))),
    )
  const sources = input.sources ?? {}
  return Auth.custom((authInput) =>
    Effect.gen(function* () {
      const apiKey = yield* Effect.promise(() => resolveApiKey(sources))
      if (apiKey === undefined)
        return yield* new AIError({ reason: new AuthenticationError({ message: NOT_SIGNED_IN_MESSAGE }) })
      return Headers.setAll(authInput.headers, cliHeaders(apiKey, input.cliVersion))
    }),
  )
}

export * as CommandCodeAuth from "./commandcode-auth.js"
