import { describe, expect, spyOn, test } from "bun:test"
import type { APIEvent } from "@solidjs/start/server"

// @opencode/console-resource is provided by the shared preload fixture (test/preload.ts, #1522).

const docsIndex = await import("./docs/index")
const docsPath = await import("./docs/[...path]")
const share = await import("./s/[id]")
const enterprise = await import("./t/[...path]")

function event(url: string) {
  return { request: new Request(url) } as unknown as APIEvent
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

const routes = [
  { name: "docs index", mod: docsIndex, url: "https://console.example.com/docs", cookie: true },
  { name: "docs path", mod: docsPath, url: "https://console.example.com/docs/guide", cookie: true },
  { name: "share", mod: share, url: "https://console.example.com/s/abc123", cookie: true },
  { name: "enterprise", mod: enterprise, url: "https://console.example.com/t/team/page", cookie: false },
] as const

describe("console proxy routes upstream deadline", () => {
  test("every route exports the shared 8s deadline", () => {
    for (const route of routes) expect(route.mod.PROXY_TIMEOUT_MS).toBe(8_000)
  })

  for (const route of routes) {
    test(route.name + ": passes a timeout signal to fetch and streams an in-bounds response through", async () => {
      const timeout = spyOn(AbortSignal, "timeout")
      let seenSignal: AbortSignal | null | undefined
      const fetcher = stubFetch(async (_input, init) => {
        seenSignal = init?.signal
        return new Response("upstream-body", { status: 200, headers: { "content-type": "text/plain" } })
      })
      try {
        const response = await route.mod.GET(event(route.url))
        expect(timeout).toHaveBeenCalledWith(8_000)
        expect(seenSignal).toBeInstanceOf(AbortSignal)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe("upstream-body")
        if (route.cookie) expect(response.headers.get("set-cookie")).toContain("oc_locale=")
      } finally {
        fetcher.mockRestore()
        timeout.mockRestore()
      }
    })

    test(route.name + ": a stalled upstream fails at the deadline instead of hanging", async () => {
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
        const pending = route.mod.GET(event(route.url))
        controller.abort()
        await expect(pending).rejects.toThrow("aborted")
      } finally {
        fetcher.mockRestore()
        timeout.mockRestore()
      }
    })
  }

  test("docs path: the redirect short-circuit still fires before any fetch", async () => {
    const fetcher = stubFetch(async () => new Response("should not be fetched"))
    try {
      const response = await docsPath.GET(event("https://console.example.com/docs/zen"))
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toContain("/v2/docs/console/models/")
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })
})
