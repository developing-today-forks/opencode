import { describe, expect, test } from "bun:test"
import { cdpPageFetch, connectWs } from "../src/quota/cdp.js"
import type { QuotaContext } from "../src/quota/types.js"

const quotaCtx = (overrides: Partial<QuotaContext>): QuotaContext => ({
  credentials: [],
  disabledProviders: new Set(),
  instances: new Map(),
  providerConfig: {},
  ...overrides,
})

type FakeMode = "wedge-after-location" | "silent" | "close-on-request" | "reply" | "eval-exception"

/**
 * A fake DevTools endpoint: HTTP /json routes plus a WebSocket whose
 * behavior is set by `mode` — never replies at all ("silent"), closes
 * the socket on the first request ("close-on-request"), answers every
 * request ("reply"), or answers the location probe but never the
 * fetch evaluate ("wedge-after-location", the wedged-renderer shape
 * from #1803).
 */
const startFakeCdp = (mode: FakeMode, locationSuffix = "") => {
  const closedPageIds: string[] = []
  let created = false
  let port = 0
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/devtools/")) {
        if (srv.upgrade(req)) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      const origin = `http://127.0.0.1:${port}`
      const target = {
        id: "page-1",
        type: "page",
        url: `${origin}/`,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`,
      }
      if (url.pathname === "/json/list") return Response.json(created ? [target] : [])
      if (url.pathname === "/json/new") {
        created = true
        return Response.json(target)
      }
      if (url.pathname.startsWith("/json/close/")) {
        closedPageIds.push(url.pathname.slice("/json/close/".length))
        return new Response("Target is closing")
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(ws, message) {
        let parsed: { id?: number; params?: { expression?: string } } = {}
        try {
          parsed = JSON.parse(String(message))
        } catch {
          return
        }
        if (typeof parsed.id !== "number") return
        const id = parsed.id
        if (mode === "close-on-request") {
          ws.close()
          return
        }
        if (mode === "silent") return
        const expression = parsed.params?.expression ?? ""
        if (expression.includes("document.location.href")) {
          ws.send(
            JSON.stringify({ id, result: { result: { value: `http://127.0.0.1:${port}/${locationSuffix}` } } }),
          )
          return
        }
        if (mode === "reply") {
          ws.send(JSON.stringify({ id, result: { ok: true } }))
          return
        }
        if (mode === "eval-exception") {
          ws.send(
            JSON.stringify({
              id,
              result: {
                result: { type: "object" },
                exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom in page" } },
              },
            }),
          )
          return
        }
        // wedge-after-location: the fetch evaluate is never answered.
      },
    },
  })
  port = server.port
  return {
    base: `http://127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`,
    closedPageIds,
    stop: () => server.stop(true),
  }
}

describe("cdp websocket request bounds (#1803)", () => {
  test("a request that gets no reply rejects within the bound", async () => {
    const fake = startFakeCdp("silent")
    try {
      const client = await connectWs(fake.wsUrl, 150)
      const started = Date.now()
      await expect(client.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow("timed out after 150ms")
      expect(Date.now() - started).toBeLessThan(5_000)
      client.close()
    } finally {
      fake.stop()
    }
  })

  test("a socket that closes mid-request settles the pending request", async () => {
    const fake = startFakeCdp("close-on-request")
    try {
      const client = await connectWs(fake.wsUrl, 30_000)
      await expect(client.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(/websocket (closed|error)/)
    } finally {
      fake.stop()
    }
  })

  test("the replying path is unchanged", async () => {
    const fake = startFakeCdp("reply")
    try {
      const client = await connectWs(fake.wsUrl, 1_000)
      await expect(client.send("Runtime.evaluate", { expression: "1" })).resolves.toEqual({ ok: true })
      client.close()
    } finally {
      fake.stop()
    }
  })

  test("a stalled handshake rejects within the bound (#1895)", async () => {
    // A raw TCP endpoint that accepts the connection and never speaks:
    // the WebSocket handshake can neither complete nor fail, so without
    // a connect bound connectWs never settles.
    const { createServer } = await import("node:net")
    const server = createServer((socket) => {
      socket.on("error", () => {})
    })
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
    try {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const started = Date.now()
      await expect(connectWs(`ws://127.0.0.1:${port}/devtools/page/page-1`, 150)).rejects.toThrow(
        "connect timed out after 150ms",
      )
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      server.close()
    }
  })

  test("cdpPageFetch surfaces a stalled handshake as cdp-unavailable", async () => {
    const { createServer } = await import("node:net")
    const stall = createServer((socket) => {
      socket.on("error", () => {})
    })
    await new Promise<void>((resolveListen) => stall.listen(0, "127.0.0.1", resolveListen))
    const stallAddress = stall.address()
    const stallPort = typeof stallAddress === "object" && stallAddress !== null ? stallAddress.port : 0
    let httpPort = 0
    const http = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const origin = `http://127.0.0.1:${httpPort}`
        if (url.pathname === "/json/list")
          return Response.json([
            {
              id: "page-1",
              type: "page",
              url: `${origin}/`,
              webSocketDebuggerUrl: `ws://127.0.0.1:${stallPort}/devtools/page/page-1`,
            },
          ])
        return new Response("not found", { status: 404 })
      },
    })
    httpPort = http.port
    try {
      const ctx = quotaCtx({ cdpBase: `http://127.0.0.1:${httpPort}`, cdpRequestTimeoutMs: 200 })
      const started = Date.now()
      await expect(cdpPageFetch(ctx, `http://127.0.0.1:${httpPort}`, ["/api/thing"])).rejects.toThrow(
        "cdp-unavailable:",
      )
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      http.stop(true)
      stall.close()
    }
  })

  test("cdpPageFetch fetches the paths a resolver derives from the page URL (#1931)", async () => {
    const fake = startFakeCdp("reply", "?team_id=team-page")
    try {
      const ctx = quotaCtx({ cdpBase: fake.base, cdpRequestTimeoutMs: 2_000 })
      const outcome = await cdpPageFetch(ctx, fake.origin, ["/api/portal/teams/default/subscription-quota"], (pageUrl) => [
        `/api/portal/teams/${new URL(pageUrl).searchParams.get("team_id") ?? "none"}/subscription-quota`,
      ])
      expect(outcome.pageUrl).toContain("team_id=team-page")
      expect(Object.keys(outcome.results)).toEqual(["/api/portal/teams/team-page/subscription-quota"])
    } finally {
      fake.stop()
    }
  })

  test("cdpPageFetch without a resolver fetches the given paths (control, #1931)", async () => {
    const fake = startFakeCdp("reply", "?team_id=team-page")
    try {
      const ctx = quotaCtx({ cdpBase: fake.base, cdpRequestTimeoutMs: 2_000 })
      const outcome = await cdpPageFetch(ctx, fake.origin, ["/api/thing"])
      expect(Object.keys(outcome.results)).toEqual(["/api/thing"])
    } finally {
      fake.stop()
    }
  })

  test("cdpPageFetch passes page eval exceptions through in their own class and runs its cleanup (#2165)", async () => {
    const fake = startFakeCdp("eval-exception")
    try {
      const ctx = quotaCtx({ cdpBase: fake.base, cdpRequestTimeoutMs: 2_000 })
      const error = await cdpPageFetch(ctx, fake.origin, ["/api/thing"]).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : String(error)
      expect(message.startsWith("page eval exception:")).toBe(true)
      expect(message).toContain("boom in page")
      expect(message).not.toContain("cdp-unavailable")
      // The finally cleanup closed the page this call created.
      expect(fake.closedPageIds).toEqual(["page-1"])
    } finally {
      fake.stop()
    }
  })

  test("cdpPageFetch surfaces a wedged evaluate as cdp-unavailable and runs its cleanup", async () => {
    const fake = startFakeCdp("wedge-after-location")
    try {
      const ctx = quotaCtx({ cdpBase: fake.base, cdpRequestTimeoutMs: 200 })
      const started = Date.now()
      await expect(cdpPageFetch(ctx, fake.origin, ["/api/thing"])).rejects.toThrow("cdp-unavailable:")
      expect(Date.now() - started).toBeLessThan(10_000)
      // The finally cleanup closed the page this call created.
      expect(fake.closedPageIds).toEqual(["page-1"])
    } finally {
      fake.stop()
    }
  })
})
