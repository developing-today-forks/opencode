import { describe, expect, test } from "bun:test"
import app from "../src/share"
import worker from "../src/index"

// Session sharing was discontinued: src/share.ts is the tombstone + no-store
// compat shim that src/index.ts serves on the opncd.ai host. V1 clients still
// create, sync, and remove shares there, and the V1 GitHub Action fails its
// run when share creation fails, so the shim accepts those requests without
// storing anything. Oracles: the HTTP status, JSON body, and tombstone page
// of each surviving route, and the 410 tombstone for everything else —
// including the removed /share_create, /share_sync, and /share_delete routes
// the previous suite exercised against the deleted SyncServer (#2704).

const sessionID = "ses_1234567890abcdef"

const post = (path: string, body: unknown) =>
  app.request(`https://opncd.ai${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("share compat shim", () => {
  test("share creation answers with the discontinued secret and a tombstone url", async () => {
    const res = await post("/api/share", { sessionID })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "90abcdef",
      secret: "discontinued",
      url: "https://opncd.ai/share/90abcdef",
    })
  })

  test("share id is the last eight characters of the session id", async () => {
    const res = await post("/api/share", { sessionID: "ses_aaaabbbbccccdddd" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "ccccdddd",
      secret: "discontinued",
      url: "https://opncd.ai/share/ccccdddd",
    })
  })

  test("share sync is accepted and stores nothing", async () => {
    const res = await post("/api/share/90abcdef/sync", {
      sessionID,
      key: "session/info/" + sessionID,
      content: { id: sessionID, title: "t" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  test("share removal is accepted", async () => {
    const res = await app.request("https://opncd.ai/api/share/90abcdef", { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})

describe("share tombstone", () => {
  test("a shared-session link serves the discontinued page with 410", async () => {
    const res = await app.request("https://opncd.ai/share/90abcdef")
    expect(res.status).toBe(410)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("Session sharing has been discontinued")
  })

  test("the removed share routes fall through to the tombstone", async () => {
    for (const path of ["/share_create", "/share_sync", "/share_delete"]) {
      const res = await post(path, { sessionID })
      expect(res.status).toBe(410)
    }
  })

  test("any other path on the share host is tombstoned", async () => {
    const res = await app.request("https://opncd.ai/anything-else")
    expect(res.status).toBe(410)
    expect(await res.text()).toContain("Session sharing has been discontinued")
  })
})

describe("legacy host wiring (src/index.ts)", () => {
  test("non-api hostnames get the share tombstone", async () => {
    const res = await worker.fetch(new Request("https://opncd.ai/share/90abcdef"), {}, undefined as any)
    expect(res.status).toBe(410)
    expect(await res.text()).toContain("Session sharing has been discontinued")
  })

  test("api hostnames get the token-exchange app", async () => {
    const res = await worker.fetch(new Request("https://api.opencode.ai/"), {}, undefined as any)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("Hello, world!")
  })
})
