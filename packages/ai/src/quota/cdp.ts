import type { JsonObject, JsonValue, QuotaContext } from "./types.js"
import {
  asObject,
  envOf,
  isJsonObject,
  parseJsonValue,
  QUOTA_RESPONSE_MAX_BYTES,
  readQuotaJson,
} from "./utils.js"

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
  send: (method: string, params?: JsonObject) => Promise<JsonObject>
  close: () => void
}

/** Decode one /json target entry: the DevTools list is wire JSON, so fields are read, never assumed. */
const decodeTarget = (value: JsonValue): CdpTarget | null => {
  const record = asObject(value)
  if (!record) return null
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    url: typeof record.url === "string" ? record.url : undefined,
    webSocketDebuggerUrl: typeof record.webSocketDebuggerUrl === "string" ? record.webSocketDebuggerUrl : undefined,
  }
}

const decodeTargets = (value: JsonValue): CdpTarget[] => {
  if (!Array.isArray(value)) return []
  const targets: CdpTarget[] = []
  for (const entry of value) {
    const target = decodeTarget(entry)
    if (target) targets.push(target)
  }
  return targets
}

export const cdpBaseOf = (ctx: QuotaContext): string => {
  const env = envOf(ctx)
  return (ctx.cdpBase ?? env.OPENCODE_QUOTA_CDP_URL ?? "http://127.0.0.1:19222").replace(/\/+$/, "")
}

const httpJson = async (url: string, init?: RequestInit): Promise<JsonValue> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  return readQuotaJson(response)
}

/**
 * Per-request bound for a DevTools WebSocket request, consistent with
 * this file's other bounds (10s HTTP `AbortSignal.timeout`, 20s
 * page-wait deadline, 5s page close): a wedged renderer must never
 * leave a request — or the `cdpPageFetch` awaiting it — pending
 * forever. Shortened in tests via `QuotaContext.cdpRequestTimeoutMs`.
 */
export const CDP_REQUEST_TIMEOUT_MS = 10_000

interface PendingRequest {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const connectWs = (wsUrl: string, requestTimeoutMs: number = CDP_REQUEST_TIMEOUT_MS): Promise<WsClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map<number, PendingRequest>()
    let id = 0
    let opened = false
    // Connection-establishment bound (#1895): the request timeout above
    // only bounds sends AFTER open, and a handshake that stalls (the
    // endpoint accepts TCP but never completes the upgrade) fires
    // neither onopen nor onerror/onclose — without this timer the
    // connect, and the cdpPageFetch awaiting it, hang forever. The same
    // bound value is reused: it is this file's per-operation bound.
    const connectTimer = setTimeout(() => {
      if (opened) return
      try {
        ws.close()
      } catch {}
      reject(new Error(`CDP websocket connect timed out after ${requestTimeoutMs}ms`))
    }, requestTimeoutMs)
    ;(connectTimer as { unref?: () => void }).unref?.()
    const settleAll = (error: Error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }
    ws.onmessage = (event: MessageEvent) => {
      const message = asObject(parseJsonValue(String(event.data)))
      if (!message) return
      const messageId = typeof message.id === "number" ? message.id : null
      if (messageId === null || !pending.has(messageId)) return
      const entry = pending.get(messageId)
      if (!entry) return
      pending.delete(messageId)
      clearTimeout(entry.timer)
      entry.resolve(message.error ? { error: message.error } : (asObject(message.result) ?? {}))
    }
    ws.onopen = () => {
      opened = true
      clearTimeout(connectTimer)
      resolve({
        send: (method, params = {}) =>
          new Promise<JsonObject>((res, rej) => {
            const next = ++id
            const timer = setTimeout(() => {
              pending.delete(next)
              rej(new Error(`CDP request ${method} timed out after ${requestTimeoutMs}ms`))
            }, requestTimeoutMs)
            ;(timer as { unref?: () => void }).unref?.()
            pending.set(next, { resolve: res, reject: rej, timer })
            try {
              ws.send(JSON.stringify({ id: next, method, params }))
            } catch (error) {
              clearTimeout(timer)
              pending.delete(next)
              rej(error instanceof Error ? error : new Error(String(error)))
            }
          }),
        close: () => {
          settleAll(new Error("websocket closed"))
          ws.close()
        },
      })
    }
    ws.onerror = () => {
      const error = new Error("websocket error")
      clearTimeout(connectTimer)
      if (!opened) reject(error)
      settleAll(error)
    }
    ws.onclose = () => {
      const error = new Error("websocket closed")
      clearTimeout(connectTimer)
      if (!opened) reject(error)
      settleAll(error)
    }
  })

const evaluate = async (client: WsClient, expression: string): Promise<JsonValue> => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`page eval exception: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
  }
  return asObject(result.result)?.value ?? null
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
  // Some reads cannot know their paths until the page they run in is
  // known — the Meta portal's team is carried by the open page's URL
  // (#1931). When a resolver is given, the paths actually fetched are
  // the ones it returns for the established page's URL; `paths` is the
  // pre-page default the caller would have used without one.
  resolvePaths?: (pageUrl: string) => string[],
): Promise<CdpPageFetchOutcome> => {
  const base = cdpBaseOf(ctx)
  let targets: CdpTarget[]
  try {
    targets = decodeTargets(await httpJson(`${base}/json/list`))
  } catch (error) {
    throw new Error(
      `cdp-unavailable: CDP ${base}/json/list unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let page = targets.find((t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(origin))
  let createdId: string | undefined
  if (!page?.webSocketDebuggerUrl) {
    try {
      const created = decodeTarget(
        await httpJson(`${base}/json/new?${encodeURIComponent(`${origin}/`)}`, { method: "PUT" }),
      )
      if (!created) throw new Error("DevTools /json/new returned an undecodable target")
      createdId = created.id
      targets = decodeTargets(await httpJson(`${base}/json/list`))
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
    client = await connectWs(page.webSocketDebuggerUrl, ctx.cdpRequestTimeoutMs ?? CDP_REQUEST_TIMEOUT_MS)
    const pageUrl = await waitForPage(client, origin)
    const effectivePaths = resolvePaths ? resolvePaths(pageUrl) : paths
    const expression = `(async () => {
      const paths = ${JSON.stringify(effectivePaths)};
      const out = {};
      const readBoundedText = async (response) => {
        const reader = response.body?.getReader();
        if (!reader) return "";
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > ${QUOTA_RESPONSE_MAX_BYTES}) {
              throw new Error("Quota response exceeded ${QUOTA_RESPONSE_MAX_BYTES} bytes");
            }
            text += decoder.decode(value, { stream: true });
          }
          return text + decoder.decode();
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      };
      for (const path of paths) {
        try {
          const r = await fetch(new URL(path, ${JSON.stringify(origin)}).toString(), {
            headers: { Accept: "application/json" },
            credentials: "include",
            signal: AbortSignal.timeout(10_000),
          });
          out[path] = { status: r.status, url: r.url, text: await readBoundedText(r) };
        } catch (e) {
          out[path] = { status: 0, url: "", text: "", error: String(e) };
        }
      }
      return out;
    })()`
    const raw = await evaluate(client, expression)
    const results: Record<string, CdpFetchResult> = {}
    if (isJsonObject(raw)) {
      for (const [path, value] of Object.entries(raw)) {
        const record = asObject(value)
        results[path] = {
          status: typeof record?.status === "number" ? record.status : 0,
          url: typeof record?.url === "string" ? record.url : "",
          text: typeof record?.text === "string" ? record.text : "",
        }
      }
    }
    for (const path of effectivePaths) {
      if (!results[path]) results[path] = { status: 0, url: "", text: "" }
    }
    return { results, pageUrl }
  } catch (error) {
    // A request that timed out or a socket that died mid-fetch is the
    // cdp-unavailable class, like the reachability failures above, so
    // callers classify it instead of hanging or misreading it as data.
    // Page-eval exceptions keep their own class.
    if (error instanceof Error && error.message.startsWith("page eval exception")) throw error
    throw new Error(
      `cdp-unavailable: CDP page fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    client?.close()
    if (createdId) {
      const closed = await fetch(`${base}/json/close/${createdId}`, { signal: AbortSignal.timeout(5_000) }).catch(
        () => undefined,
      )
      await closed?.body?.cancel().catch(() => undefined)
    }
  }
}

/** Whether an HTTP outcome from a console read is the session-expired class. */
export const isSessionExpiredStatus = (result: CdpFetchResult): boolean =>
  result.status === 401 || result.status === 403 || result.url.includes("auth") || result.url.includes("login")
