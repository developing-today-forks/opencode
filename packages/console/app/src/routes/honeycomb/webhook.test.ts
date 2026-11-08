import { describe, expect, spyOn, test } from "bun:test"
import type { APIEvent } from "@solidjs/start/server"

// @opencode/console-resource is provided by the shared preload fixture (test/preload.ts, #1522).

const { POST, DISCORD_TIMEOUT_MS } = await import("./webhook")

function event(token = "test-secret") {
  return {
    request: new Request("https://console.example.test/honeycomb/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Honeycomb-Webhook-Token": token },
      body: JSON.stringify({
        type: "custom",
        name: "Test alert",
        status: "TRIGGERED",
        url: "https://ui.honeycomb.io/example",
      }),
    }),
  } as unknown as APIEvent
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

describe("honeycomb webhook Discord relay deadline", () => {
  test("exports the 5s deadline shared with the function relay", () => {
    expect(DISCORD_TIMEOUT_MS).toBe(5_000)
  })

  test("relays a fast Discord 2xx as 200 and passes a timeout signal", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    let seenSignal: AbortSignal | null | undefined
    const fetcher = stubFetch(async (_input, init) => {
      seenSignal = init?.signal
      return new Response(null, { status: 204 })
    })
    try {
      const response = await POST(event())
      expect(timeout).toHaveBeenCalledWith(5_000)
      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ message: "sent" })
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("settles a stalled Discord endpoint as 502 at the deadline instead of hanging", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const aborted = () => reject(new DOMException("aborted", "AbortError"))
          if (init?.signal?.aborted) return aborted()
          init?.signal?.addEventListener("abort", aborted)
        }),
    )
    try {
      const pending = POST(event())
      controller.abort()
      const response = await pending
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ message: "discord webhook failed" })
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("still maps a non-OK Discord response to 502", async () => {
    const fetcher = stubFetch(async () => new Response(null, { status: 500 }))
    try {
      expect((await POST(event())).status).toBe(502)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("rejects a bad token with 401 before any fetch", async () => {
    const fetcher = stubFetch(async () => new Response(null, { status: 204 }))
    try {
      expect((await POST(event("wrong-secret"))).status).toBe(401)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })
})
