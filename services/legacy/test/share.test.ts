import { describe, expect, mock, test } from "bun:test"

// api.ts imports the SST resource bindings and the Workers runtime; both
// are replaced with in-process stubs so the share routes and the
// SyncServer durable object run against in-memory storage (#2563).
mock.module("sst", () => ({
  Resource: {
    ADMIN_SECRET: { value: "admin-secret" },
    DISCORD_SUPPORT_CHANNEL_ID: { value: "channel" },
    DISCORD_SUPPORT_BOT_TOKEN: { value: "bot-token" },
    GITHUB_APP_ID: { value: "1" },
    GITHUB_APP_PRIVATE_KEY: { value: "key" },
  },
}))
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any
    env: any
    constructor(ctx: any, env: any) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { default: app, SyncServer } = await import("../src/api")

const sessionID = "ses_1234567890abcdef"

const makeServer = () => {
  const store = new Map<string, any>()
  const bucket = new Map<string, string>()
  const storage = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: any) => {
      store.set(key, value)
    },
    deleteAll: async () => {
      store.clear()
    },
    list: async () => new Map(store),
  }
  const Bucket = {
    put: async (key: string, value: string) => {
      bucket.set(key, value)
    },
    list: async () => ({ objects: [] }),
    delete: async (key: string) => {
      bucket.delete(key)
    },
  }
  const ctx = { storage, getWebSockets: () => [], acceptWebSocket: () => {} }
  const server = new SyncServer(ctx as any, { Bucket } as any)
  return { server, store, bucket, Bucket }
}

const makeApp = () => {
  const fixture = makeServer()
  const env = {
    SYNC_SERVER: {
      idFromName: (name: string) => name,
      get: () => fixture.server,
    },
    Bucket: fixture.Bucket,
    WEB_DOMAIN: "share.example",
  }
  const post = (path: string, body: unknown) =>
    app.request(
      path,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env as any,
    )
  return { ...fixture, post }
}

describe("SyncServer.assertSecret (#2563)", () => {
  test("rejects every secret while the share has no stored secret", async () => {
    const { server } = makeServer()
    await expect(server.assertSecret(undefined as any)).rejects.toThrow("Invalid secret")
    await expect(server.assertSecret("")).rejects.toThrow("Invalid secret")
    await expect(server.assertSecret("anything")).rejects.toThrow("Invalid secret")
  })

  test("rejects the old secret after clear() deleted the share", async () => {
    const { server } = makeServer()
    const secret = await server.share(sessionID)
    await expect(server.assertSecret(secret)).resolves.toBeUndefined()
    await server.clear()
    await expect(server.assertSecret(secret)).rejects.toThrow("Invalid secret")
    await expect(server.assertSecret(undefined as any)).rejects.toThrow("Invalid secret")
  })

  test("accepts only the share's own secret", async () => {
    const { server } = makeServer()
    const secret = await server.share(sessionID)
    await expect(server.assertSecret("wrong")).rejects.toThrow("Invalid secret")
    await expect(server.assertSecret(secret)).resolves.toBeUndefined()
  })
})

describe("share routes (#2563)", () => {
  test("share_sync without a secret writes nothing, before share_create and after share_delete", async () => {
    const { post, bucket, store } = makeApp()
    const key = "session/info/" + sessionID

    const unshared = await post("/share_sync", { sessionID, key, content: { id: sessionID } })
    expect(unshared.status).not.toBe(200)
    expect(bucket.size).toBe(0)
    expect([...store.keys()].filter((k) => k.startsWith("session/"))).toEqual([])

    const created = (await (await post("/share_create", { sessionID })).json()) as { secret: string }
    const createdSecret = created["secret"]
    const deleted = await post("/share_delete", { sessionID, secret: createdSecret })
    expect(deleted.status).toBe(200)

    const afterDelete = await post("/share_sync", { sessionID, key, content: { id: sessionID } })
    expect(afterDelete.status).not.toBe(200)
    const withOldSecret = await post("/share_sync", {
      sessionID,
      secret: createdSecret,
      key,
      content: { id: sessionID },
    })
    expect(withOldSecret.status).not.toBe(200)
    expect(bucket.size).toBe(0)
    expect([...store.keys()].filter((k) => k.startsWith("session/"))).toEqual([])
  })

  test("share_sync with the share secret publishes; a missing-secret delete is refused", async () => {
    const { post, bucket } = makeApp()
    const created = (await (await post("/share_create", { sessionID })).json()) as { secret: string }
    const createdSecret = created["secret"]

    const noSecretDelete = await post("/share_delete", { sessionID })
    expect(noSecretDelete.status).not.toBe(200)

    const synced = await post("/share_sync", {
      sessionID,
      secret: createdSecret,
      key: "session/info/" + sessionID,
      content: { id: sessionID, title: "t" },
    })
    expect(synced.status).toBe(200)
    expect([...bucket.keys()]).toEqual(["share/session/info/" + sessionID + ".json"])

    const wrong = await post("/share_sync", {
      sessionID,
      secret: "wrong",
      key: "session/info/" + sessionID,
      content: {},
    })
    expect(wrong.status).not.toBe(200)
  })
})
