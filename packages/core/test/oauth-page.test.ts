import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })

  test("the bootstrap POST deadline surfaces a stalled request as an error", async () => {
    const nodes = pageNodes()
    const controller = new AbortController()
    const html = OauthCallbackPage.bootstrap({ tokenPath: "/token" })
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    runScript(
      script!,
      nodes,
      {
        timeout(milliseconds) {
          expect(milliseconds).toBe(5_000)
          return controller.signal
        },
      },
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        }),
    )

    controller.abort(new Error("deadline exceeded"))
    await nodes.detailUpdated
    expect(nodes.card.dataset.status).toBe("error")
    expect(nodes.detail.textContent).toContain("deadline exceeded")
  })

  test("the bootstrap POST deadline aborts a stalled error-body read", async () => {
    const nodes = pageNodes()
    const controller = new AbortController()
    let resolveBodyRead = () => {}
    const bodyReadStarted = new Promise<void>((resolve) => (resolveBodyRead = resolve))
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          resolveBodyRead()
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const html = OauthCallbackPage.bootstrap({ tokenPath: "/token" })
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    runScript(
      script!,
      nodes,
      {
        timeout(milliseconds) {
          expect(milliseconds).toBe(5_000)
          return controller.signal
        },
      },
      async () => new Response(body, { status: 400 }),
    )

    await bodyReadStarted
    controller.abort(new Error("deadline exceeded"))
    await nodes.detailUpdated
    expect(nodes.card.dataset.status).toBe("error")
    expect(nodes.detail.textContent).toContain("callback failed (400)")
    expect(cancelled).toBe(true)
  })

  test("the bootstrap displays a capped error excerpt and cancels an oversized body", async () => {
    const nodes = pageNodes()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(100_000)))
      },
      cancel() {
        cancelled = true
      },
    })
    const html = OauthCallbackPage.bootstrap({ tokenPath: "/token" })
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    runScript(
      script!,
      nodes,
      { timeout: () => new AbortController().signal },
      async () => new Response(body, { status: 400 }),
    )

    await nodes.detailUpdated
    expect(nodes.card.dataset.status).toBe("error")
    expect(nodes.detail.textContent).toHaveLength(64 * 1024)
    expect(cancelled).toBe(true)
  })
})

function pageNodes() {
  let text = ""
  let resolveDetailUpdate = () => {}
  const detailUpdated = new Promise<void>((resolve) => (resolveDetailUpdate = resolve))
  return {
    card: { dataset: { status: "pending" } },
    headline: { textContent: "" },
    message: { textContent: "" },
    detail: {
      hidden: true,
      get textContent() {
        return text
      },
      set textContent(value: string) {
        text = value
        resolveDetailUpdate()
      },
    },
    footnote: { textContent: "" },
    detailUpdated,
  }
}

function runScript(
  script: string,
  nodes: ReturnType<typeof pageNodes>,
  abortSignal: { timeout: (milliseconds: number) => AbortSignal },
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>,
) {
  const elements = {
    "oc-card": nodes.card,
    "oc-headline": nodes.headline,
    "oc-message": nodes.message,
    "oc-detail": nodes.detail,
    "oc-footnote": nodes.footnote,
  }
  const document = { getElementById: (id: keyof typeof elements) => elements[id] }
  const window = { location: { origin: "http://127.0.0.1", hash: "#access_token=test&state=test", search: "" } }
  new Function("window", "document", "fetch", "AbortSignal", script)(window, document, fetch, abortSignal)
}
