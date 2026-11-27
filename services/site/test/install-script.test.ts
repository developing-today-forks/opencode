import { describe, expect, test } from "bun:test"
import { INSTALL_FETCH_TIMEOUT_MS, INSTALL_SCRIPT_URL, installScript } from "../src/lib/install-script"

// The /v2/install proxy (src/lib/install-script.ts, routed in src/middleware.ts) fetches the
// upstream install script under a named deadline (#2885). These tests stub the global fetch:
// a healthy upstream passes through untouched, and a stalled one settles at the deadline with
// a bounded 503 instead of leaving the route pending.

const realFetch = globalThis.fetch

function stubFetch(impl: typeof fetch) {
  globalThis.fetch = impl
}

describe("install script proxy", () => {
  test("the deadline is the named seconds-scale constant from #1246", () => {
    expect(INSTALL_FETCH_TIMEOUT_MS).toBe(30_000)
    expect(INSTALL_SCRIPT_URL).toBe("https://raw.githubusercontent.com/anomalyco/opencode/dev/install")
  })

  test("a healthy upstream passes status, headers and body through, with the deadline attached", async () => {
    let seen: { url: unknown; signal: AbortSignal | null | undefined } = { url: undefined, signal: undefined }
    stubFetch(async (url, init) => {
      seen = { url, signal: init?.signal }
      return new Response("#!/bin/bash\necho install\n", {
        status: 200,
        headers: { "Content-Type": "text/x-shellscript", "Cache-Control": "public, max-age=60" },
      })
    })
    try {
      const response = await installScript()
      expect(seen.url).toBe(INSTALL_SCRIPT_URL)
      expect(seen.signal).toBeInstanceOf(AbortSignal)
      expect(seen.signal?.aborted).toBe(false)
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toBe("text/x-shellscript")
      // The proxy forces no-store over whatever the upstream sent.
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(await response.text()).toBe("#!/bin/bash\necho install\n")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("an upstream error status passes through rather than becoming a 503", async () => {
    stubFetch(async () => new Response("not found\n", { status: 404 }))
    try {
      const response = await installScript()
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("not found\n")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a stalled upstream settles at the deadline with a bounded 503", async () => {
    let seenSignal: AbortSignal | null | undefined
    // A fetch that never answers and only settles when its signal aborts, the way a stalled
    // upstream behaves under AbortSignal.timeout.
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        }),
    )
    try {
      const started = Date.now()
      const response = await installScript(25)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(seenSignal?.aborted).toBe(true)
      expect(response.status).toBe(503)
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(await response.text()).toContain("temporarily unavailable")
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
