import { describe, expect, test } from "bun:test"
import { DISCORD_ERROR_BODY_MAX_BYTES, postDiscordSupportMessage, readErrorBodyExcerpt } from "../src/discord"

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

describe("postDiscordSupportMessage", () => {
  test("posts the message and resolves true on a 2xx response", async () => {
    let seen: { url: string; body: unknown } | undefined
    const { baseUrl, stop } = serve(async (req) => {
      seen = { url: req.url, body: await req.json() }
      return Response.json({ id: "1" })
    })
    try {
      const ok = await postDiscordSupportMessage({
        channelId: "123",
        token: "test-token",
        content: "hello support",
        baseUrl,
      })
      expect(ok).toBe(true)
      expect(seen?.url).toContain("/channels/123/messages")
      expect(seen?.body).toEqual({ content: "hello support" })
    } finally {
      stop()
    }
  })

  test("rejects at the timeout when the upstream stalls", async () => {
    const { baseUrl, stop } = serve(() => new Promise<Response>(() => {}))
    try {
      let error: unknown
      try {
        await postDiscordSupportMessage({
          channelId: "123",
          token: "test-token",
          content: "hello",
          baseUrl,
          timeoutMs: 100,
        })
      } catch (err) {
        error = err
      }
      expect((error as { name?: string })?.name).toBe("TimeoutError")
    } finally {
      stop()
    }
  })

  test("resolves false and stays bounded on an endless error body", async () => {
    const { baseUrl, stop } = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(4096)))
            },
          }),
          { status: 500 },
        ),
    )
    try {
      const ok = await postDiscordSupportMessage({
        channelId: "123",
        token: "test-token",
        content: "hello",
        baseUrl,
        timeoutMs: 2_000,
      })
      expect(ok).toBe(false)
    } finally {
      stop()
    }
  })
})

describe("readErrorBodyExcerpt", () => {
  test("caps the excerpt at DISCORD_ERROR_BODY_MAX_BYTES", async () => {
    const response = new Response("y".repeat(DISCORD_ERROR_BODY_MAX_BYTES * 4))
    const excerpt = await readErrorBodyExcerpt(response, AbortSignal.timeout(2_000))
    expect(new TextEncoder().encode(excerpt).byteLength).toBeLessThanOrEqual(DISCORD_ERROR_BODY_MAX_BYTES)
    expect(excerpt.length).toBeGreaterThan(0)
  })
})
