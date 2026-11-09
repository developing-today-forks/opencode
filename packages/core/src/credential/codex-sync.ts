export * as CodexSync from "./codex-sync.js"

import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"

/**
 * Re-homes the Muse → credential-store token sync from the codex-proxy door
 * (developing-today/code `bin/codex-proxy.mjs`, port 18744) into the fork (#1154).
 *
 * The Muse is the sole refresher of its ChatGPT token lineage: it owns
 * `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) and refreshes it on its own
 * schedule. This sync periodically copies that file's tokens into the stored
 * credential for the file's account, so the store tracks the CLI. The target
 * is selected by account ID (see selectTarget): deployed configurations keep
 * the ChatGPT credentials on instance doors such as `openai.main`, not on the
 * base `openai` integration, and a sync that only looks under `openai` finds
 * nothing and silently leaves the door's credential to expire. Two
 * deliberate differences from the door's sync:
 *
 * - The stored expiry is the access token's TRUE JWT `exp`, never the door's
 *   synthetic now + 30 days, which masked the real expiry behind a fake
 *   far-future date and suppressed every consumer's expiry handling.
 * - The credential is stamped with Credential.externalRefreshMetadataKey, so
 *   Integration.connection.resolve never refreshes it. Without that guard the
 *   true expiry would unmask the fork's own refresh in the last minutes of each
 *   token's life, and fork and CLI would race to rotate one shared refresh-token
 *   lineage — whichever lost would hold a dead token.
 *
 * The sync updates the selected credential in place (same row) and skips the
 * write when nothing changed. If the stored access token is NEWER than the
 * file's (by JWT expiry), some other writer has advanced the lineage past the
 * CLI file; the sync then leaves the row untouched and logs an error instead of
 * reverting it to stale tokens.
 */

const integrationID = Integration.ID.make("openai")

export type Status =
  | "updated"
  | "unchanged"
  | "diverged"
  | "no-auth-file"
  | "invalid-auth-file"
  | "no-credential"
  | "not-oauth"
  | "failed"

export interface Interface {
  /** Copies the Muse tokens into the selected `openai` credential once. Never fails. */
  readonly syncOnce: () => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodexSync") {}

interface FileTokens {
  readonly access: string
  readonly refresh?: string
  readonly accountID?: string
  /** True expiry of the access token, ms since epoch (its JWT `exp`). */
  readonly expires: number
}

const Claims = Schema.fromJsonString(
  Schema.Struct({
    exp: Schema.Number,
    iat: Schema.optional(Schema.Number),
  }),
)
const decodeClaims = Schema.decodeUnknownOption(Claims)

/** Decodes a JWT's `exp` (as ms since epoch) without verifying the signature. */
const jwtExpiry = (token: string) => {
  const segment = token.split(".")[1]
  if (!segment) return undefined
  const claims = Option.getOrUndefined(decodeClaims(Buffer.from(segment, "base64url").toString("utf8")))
  return claims ? claims.exp * 1000 : undefined
}

const AuthFile = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.optional(
      Schema.Struct({
        access_token: Schema.String,
        refresh_token: Schema.optional(Schema.String),
        account_id: Schema.optional(Schema.String),
      }),
    ),
  }),
)
const decodeAuthFile = Schema.decodeUnknownOption(AuthFile)

/** Parses a Muse auth file into the tokens the store needs, or undefined when unusable. */
export const parseAuthFile = (text: string): FileTokens | undefined => {
  const tokens = Option.getOrUndefined(decodeAuthFile(text))?.tokens
  if (!tokens) return undefined
  const expires = jwtExpiry(tokens.access_token)
  if (expires === undefined) return undefined
  return {
    access: tokens.access_token,
    ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : {}),
    ...(tokens.account_id ? { accountID: tokens.account_id } : {}),
    expires,
  }
}

export type Plan =
  | { readonly action: "update"; readonly value: Credential.OAuth }
  | { readonly action: "unchanged" }
  | { readonly action: "diverged" }

/**
 * Decides how the stored credential should move toward the auth file's tokens.
 * A stored token from a NEWER lineage than the file's is never reverted
 * ("diverged"); an identical end state is "unchanged" so the caller can skip
 * the write entirely.
 */
export const plan = (current: Credential.OAuth, file: FileTokens): Plan => {
  if (current.access !== file.access) {
    const stored = jwtExpiry(current.access)
    if (stored === undefined || file.expires <= stored) return { action: "diverged" }
  }
  const value = Credential.OAuth.make({
    ...current,
    access: file.access,
    refresh: file.refresh ?? current.refresh,
    expires: file.expires,
    metadata: {
      ...current.metadata,
      ...(file.accountID ? { accountID: file.accountID } : {}),
      [Credential.externalRefreshMetadataKey]: true,
    },
  })
  const same =
    current.access === value.access &&
    current.refresh === value.refresh &&
    current.expires === value.expires &&
    metadataEqual(current.metadata, value.metadata)
  return same ? { action: "unchanged" } : { action: "update", value }
}

/**
 * Selects the stored credential the Muse auth file belongs to.
 *
 * The file names its account, and the account is the lineage's identity: the
 * target is the OAuth credential whose stored account ID equals the file's,
 * wherever it lives — the base `openai` integration or an instance door such
 * as `openai.main`. Without an account match (including files that carry no
 * account ID), selection falls back to the base integration's selected
 * credential, as before. One account's tokens are never written into another
 * account's credential.
 */
export const selectTarget = (
  credentials: ReadonlyArray<Credential.Info>,
  file: FileTokens,
): Credential.Info | undefined => {
  const doors = credentials.filter(
    (credential) =>
      credential.integrationID === integrationID || String(credential.integrationID).startsWith("openai."),
  )
  if (file.accountID) {
    const match = doors.filter(
      (credential) => credential.value.type === "oauth" && credential.value.metadata?.accountID === file.accountID,
    )
    if (match.length) return match.at(-1)
  }
  // Connection resolution projects an integration's saved list in reverse and
  // selects the first entry, so the selected credential is the list's last.
  return credentials.filter((credential) => credential.integrationID === integrationID).at(-1)
}

const metadataEqual = (
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  return [...keys].every((key) => a?.[key] === b?.[key])
}

export const make = (authPath: string) =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const fs = yield* FSUtil.Service

    const attempt: Effect.Effect<Status, Error, never> = Effect.gen(function* () {
      const text = yield* fs.readFileStringSafe(authPath)
      if (text === undefined) return "no-auth-file"
      const file = parseAuthFile(text)
      if (!file) {
        yield* Effect.logWarning("codex credential sync skipped: auth file is not usable", { authPath })
        return "invalid-auth-file"
      }
      if (file.expires <= Date.now())
        yield* Effect.logWarning(
          "codex credential sync: the Muse access token has expired and the CLI has not refreshed it yet",
          { authPath, expires: new Date(file.expires).toISOString() },
        )
      const saved = yield* credentials.all()
      const target = selectTarget(saved, file)
      if (!target) return "no-credential"
      if (target.value.type !== "oauth") return "not-oauth"
      const result = plan(target.value, file)
      if (result.action === "unchanged") return "unchanged"
      if (result.action === "diverged") {
        yield* Effect.logError(
          "codex credential sync skipped: the stored credential is newer than the Muse file; leaving it untouched",
          { credentialID: target.id, integrationID: target.integrationID },
        )
        return "diverged"
      }
      yield* credentials.update(target.id, { value: result.value })
      yield* Effect.logInfo("codex credential synced from the Muse", {
        credentialID: target.id,
        integrationID: target.integrationID,
        expires: new Date(result.value.expires).toISOString(),
      })
      return "updated"
    })

    return Service.of({
      syncOnce: () =>
        attempt.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("codex credential sync failed", { cause }).pipe(Effect.as("failed" as const)),
          ),
        ),
    })
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const authPath = process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, "auth.json")
      : path.join(global.home, ".codex", "auth.json")
    return yield* make(authPath)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Credential.node, FSUtil.node, Global.node],
})

const loop = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* Service
    yield* sync.syncOnce().pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1))), Effect.forkScoped)
  }),
)

/** Starts the periodic sync with the host's global services; the sync itself is CodexSync.node. */
export const loopNode = makeGlobalNode({ name: "codex-credential-sync", layer: loop, deps: [node] })
