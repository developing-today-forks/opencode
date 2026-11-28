import { describe, expect, test } from "bun:test"
import { cdpPageFetch, isSessionExpiredStatus } from "../src/quota/cdp.js"
import type { QuotaContext } from "../src/quota/types.js"

const quotaCtx = (overrides: Partial<QuotaContext>): QuotaContext => ({
  credentials: [],
  disabledProviders: new Set(),
  instances: new Map(),
  providerConfig: {},
  ...overrides,
})

// Fake CDP whose fetch evaluate replies with exceptionDetails (a page-side JS throw).
const startFakeException = () => {
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
      const target = { id: "page-1", type: "page", url: `${origin}/`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1` }
      if (url.pathname === "/json/list") return Response.json(created ? [target] : [])
      if (url.pathname === "/json/new") { created = true; return Response.json(target) }
      if (url.pathname.startsWith("/json/close/")) { closedPageIds.push(url.pathname.slice("/json/close/".length)); return new Response("Target is closing") }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(ws, message) {
        let parsed: { id?: number; params?: { expression?: string } } = {}
        try { parsed = JSON.parse(String(message)) } catch { return }
        if (typeof parsed.id !== "number") return
        const expression = parsed.params?.expression ?? ""
        if (expression.includes("document.location.href")) {
          ws.send(JSON.stringify({ id: parsed.id, result: { result: { value: `http://127.0.0.1:${port}/` } } }))
          return
        }
        ws.send(JSON.stringify({ id: parsed.id, result: { exceptionDetails: { text: "Error: boom in page", exception: { description: "Error: boom in page" } }, result: { type: "undefined" } } }))
      },
    },
  })
  port = server.port
  return { base: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, closedPageIds, stop: () => server.stop(true) }
}

describe("probe: page eval exception passthrough", () => {
  test("cdpPageFetch rejects with page eval exception, NOT cdp-unavailable, and cleans up", async () => {
    const fake = startFakeException()
    try {
      const ctx = quotaCtx({ cdpBase: fake.base, cdpRequestTimeoutMs: 2_000 })
      let err: unknown
      try { await cdpPageFetch(ctx, fake.origin, ["/api/thing"]) } catch (e) { err = e }
      console.log("PROBE-EXC-MSG:", err instanceof Error ? err.message : String(err))
      expect(err instanceof Error ? err.message : "").toStartWith("page eval exception")
      expect(err instanceof Error ? err.message : "").not.toContain("cdp-unavailable")
      expect(fake.closedPageIds).toEqual(["page-1"])
    } finally { fake.stop() }
  })
})

describe("probe: isSessionExpiredStatus url substring", () => {
  test("cases", () => {
    const cases: Array<[string, { status: number; url: string; text: string }]> = [
      ["200 authorizations path", { status: 200, url: "https://admin.mistral.ai/api/authorizations", text: "{}" }],
      ["200 login-history path", { status: 200, url: "https://dev.meta.ai/api/login-history", text: "{}" }],
      ["200 authord subdomain-ish", { status: 200, url: "https://console.example.com/authors/42", text: "{}" }],
      ["401 plain (control expired)", { status: 401, url: "https://admin.mistral.ai/api/budgets", text: "" }],
      ["403 plain (control expired)", { status: 403, url: "https://dev.meta.ai/api/portal/teams", text: "" }],
      ["200 redirect-to-login (intended)", { status: 200, url: "https://admin.mistral.ai/login?next=/billing", text: "" }],
      ["200 plain (control ok)", { status: 200, url: "https://dev.meta.ai/api/portal/teams/t1/subscription-quota", text: "{}" }],
      ["500 plain (control not expired)", { status: 500, url: "https://admin.mistral.ai/api/budgets", text: "" }],
    ]
    for (const [name, r] of cases) console.log("PROBE-EXP", name, "=>", isSessionExpiredStatus(r))
    expect(true).toBe(true)
  })
})
