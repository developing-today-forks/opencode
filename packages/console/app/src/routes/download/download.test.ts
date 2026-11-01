import { describe, expect, spyOn, test } from "bun:test"
import type { APIEvent } from "@solidjs/start"
import { GET } from "./[channel]/[platform]"

const assetUrl = "https://example.com/opencode-desktop-mac-arm64.dmg"
const metadata = { metadata: { files: { "opencode-desktop-mac-arm64.dmg": { url: assetUrl } } } }

function event(platform = "darwin-aarch64-dmg", channel = "stable") {
  return { params: { platform, channel } } as unknown as APIEvent
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(impl, { preconnect: fetch.preconnect }),
  )
}

describe("download GET fetch bounds", () => {
  test("redirects on a healthy metadata document and 404s before fetching an unknown platform", async () => {
    const fetcher = stubFetch(async () => Response.json(metadata))
    try {
      const response = await GET(event())
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(assetUrl)

      const missing = await GET(event("unknown-platform"))
      expect(missing.status).toBe(404)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("passes through a non-OK upstream status", async () => {
    const fetcher = stubFetch(async () => new Response(null, { status: 503 }))
    try {
      expect((await GET(event())).status).toBe(503)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("settles as 502 when the fetch stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(
      async () => new Response(new ReadableStream({ start() {} })),
    )
    try {
      const pending = GET(event())
      controller.abort()
      expect((await pending).status).toBe(502)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("settles as 502 and cancels an over-cap streamed body", async () => {
    let pulls = 0
    let cancelled = false
    const fetcher = stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              pulls++
              stream.enqueue(new Uint8Array(1024 * 1024))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    try {
      expect((await GET(event())).status).toBe(502)
      expect(cancelled).toBe(true)
      expect(pulls).toBeLessThan(10)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("settles as 502 fast when the declared content-length is over the cap", async () => {
    const fetcher = stubFetch(
      async () =>
        new Response(JSON.stringify(metadata), {
          headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
        }),
    )
    try {
      expect((await GET(event())).status).toBe(502)
    } finally {
      fetcher.mockRestore()
    }
  })
})
