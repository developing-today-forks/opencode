import { describe, expect, mock, spyOn, test } from "bun:test"

mock.module("@solidjs/router", () => ({ query: (load: () => unknown) => load }))

const { github } = await import("./github")

const apiBase = "https://api.github.com/repos/anomalyco/opencode"

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(impl, { preconnect: fetch.preconnect }),
  )
}

function healthyFetch(url: string) {
  if (url.endsWith("/releases")) {
    return Response.json([{ name: "First", html_url: "https://example.com/releases/v1", tag_name: "v1.0.0" }])
  }
  if (url.includes("/contributors")) {
    return new Response(null, {
      headers: { Link: `<${apiBase}/contributors?per_page=1&page=42>; rel="last"` },
    })
  }
  return Response.json({ stargazers_count: 1234 })
}

describe("github query fetch bounds", () => {
  test("returns stars, release, and contributors on healthy responses", async () => {
    const fetcher = stubFetch(async (input) => healthyFetch(String(input)))
    try {
      expect(await github()).toEqual({
        stars: 1234,
        release: { name: "First", url: "https://example.com/releases/v1", tag_name: "v1.0.0" },
        contributors: 42,
      })
    } finally {
      fetcher.mockRestore()
    }
  })

  test("settles as undefined when a fetch stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(async () => new Response(new ReadableStream({ start() {} })))
    try {
      const pending = github()
      controller.abort()
      expect(await pending).toBeUndefined()
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("settles as undefined and cancels an over-cap releases body", async () => {
    let cancelled = false
    const fetcher = stubFetch(async (input) => {
      const url = String(input)
      if (!url.endsWith("/releases")) return healthyFetch(url)
      return new Response(
        new ReadableStream({
          pull(stream) {
            stream.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    })
    try {
      expect(await github()).toBeUndefined()
      expect(cancelled).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })
})
