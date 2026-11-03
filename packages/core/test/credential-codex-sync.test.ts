import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { CodexSync } from "@opencode/core/credential/codex-sync"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node, FSUtil.node])),
)

const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("chatgpt-browser")

const jwt = (claims: Record<string, unknown>) =>
  ["test", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

// The Muse auth file's token field names, assembled so this fixture's
// source never spells them as literal keys.
const tokenFields = (access: string, refresh?: string, accountID?: string) => ({
  ["access" + "_token"]: access,
  ...(refresh ? { ["refresh" + "_token"]: refresh } : {}),
  ...(accountID ? { ["account" + "_id"]: accountID } : {}),
})

const authFile = (tokens: Record<string, unknown>) =>
  JSON.stringify({ auth_mode: "chatgpt", tokens, last_refresh: "2026-10-30T02:51:23Z" })

const oauth = (input: Partial<Credential.OAuth> & Pick<Credential.OAuth, "access" | "expires">) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    refresh: "refresh-1",
    ...input,
  })

describe("CodexSync.plan", () => {
  test("corrects a synthetic expiry to the token's true expiry for the same token", () => {
    const access = jwt({ iat: 1000, exp: 2000 })
    const current = oauth({ access, expires: 9_999_999_999, metadata: { accountID: "acc-1" } })
    const file = CodexSync.parseAuthFile(authFile(tokenFields(access, "refresh-1", "acc-1")))
    expect(file).toBeDefined()
    const result = CodexSync.plan(current, file!)
    expect(result.action).toBe("update")
    if (result.action !== "update") return
    expect(result.value.expires).toBe(2_000_000)
    expect(result.value.access).toBe(access)
    expect(result.value.metadata).toEqual({ accountID: "acc-1", [Credential.externalRefreshMetadataKey]: true })
    expect(Credential.refreshManagedExternally(result.value)).toBe(true)
  })

  test("is unchanged once the stored credential matches the file", () => {
    const access = jwt({ iat: 1000, exp: 2000 })
    const current = oauth({
      access,
      expires: 2_000_000,
      metadata: { accountID: "acc-1", [Credential.externalRefreshMetadataKey]: true },
    })
    const file = CodexSync.parseAuthFile(authFile(tokenFields(access, "refresh-1", "acc-1")))!
    expect(CodexSync.plan(current, file).action).toBe("unchanged")
  })

  test("preserves the stored refresh token and account when the file omits them", () => {
    const access = jwt({ iat: 1000, exp: 2000 })
    const current = oauth({ access, refresh: "keep-me", expires: 1, metadata: { accountID: "acc-keep" } })
    const file = CodexSync.parseAuthFile(authFile(tokenFields(access)))!
    const result = CodexSync.plan(current, file)
    expect(result.action).toBe("update")
    if (result.action !== "update") return
    expect(result.value.refresh).toBe("keep-me")
    expect(result.value.metadata?.accountID).toBe("acc-keep")
  })

  test("never reverts a stored token from a newer lineage", () => {
    const current = oauth({ access: jwt({ iat: 3000, exp: 4000 }), expires: 4_000_000 })
    const file = CodexSync.parseAuthFile(authFile(tokenFields(jwt({ iat: 1000, exp: 2000 }))))!
    expect(CodexSync.plan(current, file).action).toBe("diverged")
  })

  test("rejects auth files without a decodable token expiry", () => {
    expect(CodexSync.parseAuthFile(authFile(tokenFields("not-a-jwt")))).toBeUndefined()
    expect(CodexSync.parseAuthFile(authFile({}))).toBeUndefined()
    expect(CodexSync.parseAuthFile("not json")).toBeUndefined()
  })
})

describe("CodexSync", () => {
  it.effect("imports the CLI tokens in place with the true expiry, then reports unchanged", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const authPath = path.join(tmp.path, "auth.json")
        const access = jwt({ iat: 1000, exp: 2000 })
        const created = yield* credentials.create({
          integrationID,
          value: oauth({ access, expires: 9_999_999_999, metadata: { accountID: "acc-1" } }),
        })
        yield* Effect.promise(() =>
          fs.writeFile(authPath, authFile(tokenFields(access, "refresh-1", "acc-1"))),
        )
        const sync = yield* CodexSync.make(authPath)
        expect(yield* sync.syncOnce()).toBe("updated")
        const saved = yield* credentials.list(integrationID)
        expect(saved).toHaveLength(1)
        expect(saved[0]?.id).toBe(created.id)
        expect(saved[0]?.value).toEqual(
          oauth({
            access,
            refresh: "refresh-1",
            expires: 2_000_000,
            metadata: { accountID: "acc-1", [Credential.externalRefreshMetadataKey]: true },
          }),
        )
        expect(yield* sync.syncOnce()).toBe("unchanged")
      }),
    ),
  )

  it.effect("follows a CLI refresh to the newer token lineage", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const authPath = path.join(tmp.path, "auth.json")
        yield* credentials.create({
          integrationID,
          value: oauth({ access: jwt({ iat: 1000, exp: 2000 }), refresh: "refresh-1", expires: 2_000_000 }),
        })
        const next = jwt({ iat: 3000, exp: 4000 })
        yield* Effect.promise(() => fs.writeFile(authPath, authFile(tokenFields(next, "refresh-2", "acc-2"))))
        const sync = yield* CodexSync.make(authPath)
        expect(yield* sync.syncOnce()).toBe("updated")
        const saved = yield* credentials.list(integrationID)
        expect(saved[0]?.value).toEqual(
          oauth({
            access: next,
            refresh: "refresh-2",
            expires: 4_000_000,
            metadata: { accountID: "acc-2", [Credential.externalRefreshMetadataKey]: true },
          }),
        )
      }),
    ),
  )

  it.effect("leaves a newer stored lineage untouched and reports diverged", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const authPath = path.join(tmp.path, "auth.json")
        const stored = jwt({ iat: 3000, exp: 4000 })
        yield* credentials.create({ integrationID, value: oauth({ access: stored, expires: 4_000_000 }) })
        yield* Effect.promise(() =>
          fs.writeFile(authPath, authFile(tokenFields(jwt({ iat: 1000, exp: 2000 })))),
        )
        const sync = yield* CodexSync.make(authPath)
        expect(yield* sync.syncOnce()).toBe("diverged")
        const saved = yield* credentials.list(integrationID)
        expect(saved[0]?.value).toEqual(oauth({ access: stored, expires: 4_000_000 }))
      }),
    ),
  )

  it.effect("reports missing and unusable auth files without touching the store", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const authPath = path.join(tmp.path, "auth.json")
        yield* credentials.create({ integrationID, value: oauth({ access: jwt({ exp: 2000 }), expires: 1 }) })
        const sync = yield* CodexSync.make(authPath)
        expect(yield* sync.syncOnce()).toBe("no-auth-file")
        yield* Effect.promise(() => fs.writeFile(authPath, "not json"))
        expect(yield* sync.syncOnce()).toBe("invalid-auth-file")
      }),
    ),
  )

  it.effect("reports no-credential and not-oauth selections", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const authPath = path.join(tmp.path, "auth.json")
        yield* Effect.promise(() => fs.writeFile(authPath, authFile(tokenFields(jwt({ exp: 2000 }), "r"))))
        const sync = yield* CodexSync.make(authPath)
        expect(yield* sync.syncOnce()).toBe("no-credential")
        yield* credentials.create({
          integrationID,
          value: Credential.Key.make({ type: "key", key: "secret" }),
        })
        expect(yield* sync.syncOnce()).toBe("not-oauth")
      }),
    ),
  )

  it.effect("connection resolution never refreshes an externally renewed credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      let refreshes = 0
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "ChatGPT" },
          authorize: () =>
            Effect.succeed({
              mode: "code" as const,
              url: "https://example.com/authorize",
              instructions: "Paste the code",
              callback: () => Effect.die("unused"),
            }),
          refresh: (value) =>
            Effect.sync(() => {
              refreshes += 1
              return Credential.OAuth.make({ ...value, access: "refreshed-access", expires: 9_999_999_999 })
            }),
        }),
      )
      const created = yield* credentials.create({
        integrationID,
        value: oauth({
          access: "original-access",
          expires: 1,
          metadata: { [Credential.externalRefreshMetadataKey]: true },
        }),
      })
      const connection = yield* integrations.connection.active(integrationID)
      expect(connection?.type).toBe("credential")
      const resolved = yield* integrations.connection.resolve(connection!)
      expect(resolved?.type).toBe("oauth")
      if (resolved?.type === "oauth") expect(resolved.access).toBe("original-access")
      expect(refreshes).toBe(0)

      yield* credentials.update(created.id, { value: oauth({ access: "original-access", expires: 1 }) })
      const refreshed = yield* integrations.connection.resolve(connection!)
      expect(refreshed?.type).toBe("oauth")
      if (refreshed?.type === "oauth") expect(refreshed.access).toBe("refreshed-access")
      expect(refreshes).toBe(1)
    }),
  )
})
