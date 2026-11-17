import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// The /feishu webhook must verify Feishu's verification token before any
// side effect, must never log the message body, and must answer malformed
// content with a clean 4xx (#2564). Oracles: the HTTP status and body of
// each request shape, and whether the Discord relay fetch fired at all.
mock.module("sst", () => ({
  Resource: {
    ADMIN_SECRET: { value: "secret" },
    DISCORD_SUPPORT_CHANNEL_ID: { value: "channel" },
    DISCORD_SUPPORT_BOT_TOKEN: { value: "bot-token" },
    FEISHU_VERIFICATION_TOKEN: { value: "verify-token" },
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

const { default: app } = await import("../src/api")

const realFetch = globalThis.fetch
let fetches: string[] = []
beforeEach(() => {
  fetches = []
  globalThis.fetch = (async (input: any) => {
    fetches.push(String(input))
    return new Response("{}", { status: 200 })
  }) as any
})
afterEach(() => {
  // Restore the real fetch so other test files in the same process are
  // unaffected by the relay stub.
  globalThis.fetch = realFetch
})

const post = (body: unknown) =>
  app.request("/feishu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

describe("feishu webhook verification (#2564)", () => {
  test("answers the url_verification challenge when the token matches", async () => {
    const res = await post({ challenge: "abc", token: "verify-token", type: "url_verification" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: "abc" })
    expect(fetches).toEqual([])
  })

  test("rejects a wrong token with 401 and relays nothing", async () => {
    const res = await post({
      token: "wrong",
      event: { message: { message_id: "m1", content: JSON.stringify({ text: "hello" }) } },
    })
    expect(res.status).toBe(401)
    expect(fetches).toEqual([])
  })

  test("rejects a missing token with 401", async () => {
    const res = await post({ event: { message: { message_id: "m1", content: "hello" } } })
    expect(res.status).toBe(401)
    expect(fetches).toEqual([])
  })

  test("accepts the v2 header token and relays the message", async () => {
    const res = await post({
      header: { event_type: "im.message.receive_v1", token: "verify-token" },
      event: { message: { message_id: "m2", content: JSON.stringify({ text: "need help" }) } },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(fetches.length).toBe(1)
    expect(fetches[0]).toContain("/channels/channel/messages")
  })

  test("answers malformed message content with 400, not 500", async () => {
    const res = await post({
      token: "verify-token",
      event: { message: { message_id: "m3", content: "{not json" } },
    })
    expect(res.status).toBe(400)
    expect(fetches).toEqual([])
  })

  test("answers a malformed JSON body with 400", async () => {
    const res = await post("{not json")
    expect(res.status).toBe(400)
    expect(fetches).toEqual([])
  })
})
