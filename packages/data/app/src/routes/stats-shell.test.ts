import { describe, expect, mock, spyOn, test } from "bun:test"

mock.module("@solidjs/router", () => ({ query: (load: () => unknown) => load }))

const { getGitHubStars, githubLink } = await import("./stats-shell")

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(impl, { preconnect: fetch.preconnect }),
  )
}

describe("getGitHubStars fetch bounds", () => {
  test("formats the star count on a healthy response and falls back on non-OK", async () => {
    const fetcher = stubFetch(async () => Response.json({ stargazers_count: 100_000 }))
    try {
      expect(await getGitHubStars()).toBe("100K")
      fetcher.mockImplementation(
        Object.assign(async () => new Response(null, { status: 503 }), { preconnect: fetch.preconnect }),
      )
      expect(await getGitHubStars()).toBe(githubLink.fallbackStars)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("falls back when the fetch stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(async () => new Response(new ReadableStream({ start() {} })))
    try {
      const pending = getGitHubStars()
      controller.abort()
      expect(await pending).toBe(githubLink.fallbackStars)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("falls back and cancels an over-cap body", async () => {
    let cancelled = false
    const fetcher = stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              stream.enqueue(new Uint8Array(1024 * 1024))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    try {
      expect(await getGitHubStars()).toBe(githubLink.fallbackStars)
      expect(cancelled).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })
})
