import { describe, expect, mock, spyOn, test } from "bun:test"

mock.module("@solidjs/router", () => ({ query: (load: () => unknown) => load }))

const { loadChangelog } = await import("./changelog")

describe("loadChangelog fetch bounds", () => {
  test("fails softly on stalled and oversized bodies and parses a healthy response", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    const fetcher = spyOn(globalThis, "fetch")
    try {
      const controller = new AbortController()
      timeout.mockReturnValue(controller.signal)
      fetcher.mockImplementation(Object.assign(async () => new Response(new ReadableStream({ start() {} })), { preconnect: fetch.preconnect }))
      const stalled = loadChangelog()
      controller.abort()
      expect(await stalled).toEqual({ ok: false, releases: [] })

      timeout.mockRestore()
      let pulls = 0
      let cancelled = false
      fetcher.mockImplementation(Object.assign(async () => new Response(new ReadableStream({
        pull(stream) {
          pulls++
          stream.enqueue(new Uint8Array(1024 * 1024))
        },
        cancel() { cancelled = true },
      })), { preconnect: fetch.preconnect }))
      expect(await loadChangelog()).toEqual({ ok: false, releases: [] })
      expect(cancelled).toBe(true)
      expect(pulls).toBeLessThan(40)

      fetcher.mockImplementation(Object.assign(async () => Response.json([
        {
          tag_name: "v1.0.0",
          name: "First",
          body: "## Changes\n- something shipped",
          published_at: "2026-01-01T00:00:00Z",
          html_url: "https://example.com/releases/v1.0.0",
        },
      ]), { preconnect: fetch.preconnect }))
      const healthy = await loadChangelog()
      expect(healthy.ok).toBe(true)
      expect(healthy.releases).toHaveLength(1)
      expect(healthy.releases[0].tag).toBe("v1.0.0")
      expect(healthy.releases[0].sections).toEqual([{ title: "Changes", items: ["something shipped"] }])
    } finally {
      timeout.mockRestore()
      fetcher.mockRestore()
    }
  })
})
