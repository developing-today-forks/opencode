import type { QuotaContext } from "./types.js"
import { envOf } from "./utils.js"

/**
 * Console-session reads through the laptop browser's Chrome DevTools
 * Protocol endpoint — the pattern the fleet's console producers (the
 * retired Meta exporter, the OpenDesign renewal keeper) established:
 * the fetch is evaluated inside a page of the provider's own origin, so
 * the session cookie never leaves the browser and is never read into
 * this process, written to a file, or logged.
 */

export interface CdpFetchResult {
  status: number
  url: string
  text: string
}

export interface CdpPageFetchOutcome {
  /** Per-path results keyed by the path that was requested. */
  results: Record<string, CdpFetchResult>
  /** The URL of the page the fetches ran in (may carry a team_id parameter). */
  pageUrl: string
}

interface CdpTarget {
  id?: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

interface WsClient {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => void
}

export const cdpBaseOf = (ctx: QuotaContext): string => {
  const env = envOf(ctx)
  return (ctx.cdpBase ?? env.OPENCODE_QUOTA_CDP_URL ?? "http://127.0.0.1:19222").replace(/\/+$/, "")
}

const httpJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.json()
}

const connectWs = (wsUrl: string): Promise<WsClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    let id = 0
    ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          id?: number
          result?: Record<string, unknown>
          error?: unknown
        }
        if (message.id && pending.has(message.id)) {
          const settle = pending.get(message.id) as (value: Record<string, unknown>) => void
          pending.delete(message.id)
          settle(message.error ? { error: message.error } : (message.result ?? {}))
        }
      } catch {
        // A non-JSON frame carries no answer any caller waits on.
      }
    }
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise<Record<string, unknown>>((res) => {
            const next = ++id
            pending.set(next, res)
            ws.send(JSON.stringify({ id: next, method, params }))
          }),
        close: () => ws.close(),
      })
    ws.onerror = () => reject(new Error("websocket error"))
  })

const evaluate = async (client: WsClient, expression: string): Promise<unknown> => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`page eval exception: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
  }
  const inner = (result.result as Record<string, unknown> | undefined)?.value
  return inner
}

const waitForPage = async (client: WsClient, origin: string): Promise<string> => {
  const deadline = Date.now() + 20_000
  let last = ""
  while (Date.now() < deadline) {
    const value = await evaluate(client, "document.location.href").catch(() => "")
    last = typeof value === "string" ? value : ""
    if (last.startsWith(origin)) return last
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return last
}

/**
 * Fetch `paths` (same-origin paths on `origin`) inside a page of that
 * origin in the CDP browser, creating the page when none is open and
 * closing a page this call created. Throws an Error prefixed
 * `cdp-unavailable:` when the browser cannot be reached or no page can
 * be established; per-path HTTP outcomes are returned, not thrown, so
 * callers classify them (401 is `session-expired`, never zeros).
 */
export const cdpPageFetch = async (
  ctx: QuotaContext,
  origin: string,
  paths: string[],
): Promise<CdpPageFetchOutcome> => {
  const base = cdpBaseOf(ctx)
  let targets: CdpTarget[]
  try {
    targets = (await httpJson(`${base}/json/list`)) as CdpTarget[]
  } catch (error) {
    throw new Error(
      `cdp-unavailable: CDP ${base}/json/list unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let page = targets.find((t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(origin))
  let createdId: string | undefined
  if (!page?.webSocketDebuggerUrl) {
    try {
      const created = (await httpJson(`${base}/json/new?${encodeURIComponent(`${origin}/`)}`, {
        method: "PUT",
      })) as CdpTarget
      createdId = created.id
      targets = (await httpJson(`${base}/json/list`)) as CdpTarget[]
      page =
        targets.find((t) => t.id === createdId) ??
        targets.find((t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(origin))
    } catch (error) {
      throw new Error(
        `cdp-unavailable: could not open a ${origin} page: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`cdp-unavailable: browser is up but no ${origin} page could be established`)
  }
  let client: WsClient | undefined
  try {
    client = await connectWs(page.webSocketDebuggerUrl)
    const pageUrl = await waitForPage(client, origin)
    const expression = `(async () => {
      const paths = ${JSON.stringify(paths)};
      const out = {};
      for (const path of paths) {
        try {
          const r = await fetch(new URL(path, ${JSON.stringify(origin)}).toString(), {
            headers: { Accept: "application/json" },
            credentials: "include",
          });
          out[path] = { status: r.status, url: r.url, text: await r.text() };
        } catch (e) {
          out[path] = { status: 0, url: "", text: "", error: String(e) };
        }
      }
      return out;
    })()`
    const raw = await evaluate(client, expression)
    const results: Record<string, CdpFetchResult> = {}
    if (raw && typeof raw === "object") {
      for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
        const record = value as { status?: number; url?: string; text?: string }
        results[path] = {
          status: typeof record.status === "number" ? record.status : 0,
          url: typeof record.url === "string" ? record.url : "",
          text: typeof record.text === "string" ? record.text : "",
        }
      }
    }
    for (const path of paths) {
      if (!results[path]) results[path] = { status: 0, url: "", text: "" }
    }
    return { results, pageUrl }
  } finally {
    client?.close()
    if (createdId) {
      await fetch(`${base}/json/close/${createdId}`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
    }
  }
}

/** Whether an HTTP outcome from a console read is the session-expired class. */
export const isSessionExpiredStatus = (result: CdpFetchResult): boolean =>
  result.status === 401 || result.status === 403 || result.url.includes("auth") || result.url.includes("login")
