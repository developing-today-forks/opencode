/**
 * Bounded share_data fetch for the public share page (#1179, design #1127).
 *
 * The share page (`packages/web/src/pages/s/[id].astro`) renders a public,
 * unauthenticated route from `${VITE_API_URL}/share_data`. It used to fetch
 * with no deadline and buffer the whole body via `res.json()`: a stalled API
 * hung the Astro render indefinitely and an oversized body buffered whole in
 * the web server.
 *
 * This module is the per-app copy of the canonical bounded pair in
 * `@opencode/util` (`packages/util/src/http-body.ts`), per #1127 contract
 * point 4: `packages/web` has no `@opencode/*` runtime dependency and its
 * deploy bundle has not adopted `@opencode/util`, so the pair is carried
 * here, pinned by the same edge cases (declared-length pre-check, in-flight
 * chunk counting, cancel at cap). The deadline and the cap are named at this
 * site:
 *
 * - `SHARE_DATA_TIMEOUT_MS = 8_000` — one deadline covering the fetch and
 *   the body read. Precedent: the console `/s` proxy for this route family
 *   (`packages/console/app/src/routes/s/[id].ts`) uses `PROXY_TIMEOUT_MS =
 *   8_000`.
 * - `SHARE_DATA_MAX_BYTES = 32 * 1024 * 1024` (32 MiB) — refuse semantics.
 *   Sized from real payloads measured in triage of #1179 (19 real local
 *   sessions assembled in the share_data shape, compact JSON: median
 *   48,399 B, p90 2,526,732 B, max 27,309,923 B): the cap covers every
 *   measured session, 1.23x over the max and ~13x over p90.
 *
 * Every failure is a controlled result naming the failure, never an
 * unhandled throw: timeout / over-cap / non-OK / non-JSON map to 502, and
 * the existing 404 semantic is kept for a missing share (upstream 404, or a
 * well-formed payload the caller finds has no `info`).
 */

export const SHARE_DATA_TIMEOUT_MS = 8_000
export const SHARE_DATA_MAX_BYTES = 32 * 1024 * 1024

import type { Session } from "opencode/session/index"

export interface ShareData {
  info?: Session.Info
  messages: Record<string, { role?: string; modelID?: string }>
}

export type ShareDataResult =
  | { ok: true; data: ShareData }
  | { ok: false; status: 404 | 502; message: string }

export interface LoadShareDataOptions {
  timeoutMs?: number
  maxBytes?: number
}

class ShareDataTooLarge extends Error {}

const deadlineMessage = (timeoutMs: number) =>
  `share_data fetch did not complete within the ${timeoutMs} ms deadline (SHARE_DATA_TIMEOUT_MS)`
const tooLargeMessage = (maxBytes: number) =>
  `share_data response exceeded the ${maxBytes} byte cap (SHARE_DATA_MAX_BYTES)`

/**
 * Read a response body as text under a hard byte cap (refuse semantics):
 * a declared `content-length` above the cap fails before the body is read;
 * a streamed body is bounded in flight as its chunks arrive and the read is
 * cancelled at the cap. The deadline `signal` cancels the read when it
 * aborts, so a slow-drip body is cut by the same deadline as the fetch.
 */
export const readBoundedShareDataText = async (
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> => {
  const tooLarge = () => new ShareDataTooLarge(tooLargeMessage(maximumBytes))
  const contentLength = response.headers.get("content-length")
  const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
  const declaredSize =
    parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
  if (declaredSize !== undefined && declaredSize > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) {
    // No stream to bound in flight (exotic Response implementations only);
    // the declared-length check above has already run.
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maximumBytes) throw tooLarge()
    return text
  }
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal?.reason).catch(() => undefined)
  if (signal) {
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  }
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw signal.reason ?? new Error("share_data read aborted")
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (size + value.byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge()
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

const isTimeout = (error: unknown, signal: AbortSignal) =>
  signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))

/**
 * Fetch and parse share_data under the named deadline and cap. Never
 * throws: every failure is returned as a controlled result for the page to
 * turn into its response.
 */
export const loadShareData = async (
  apiUrl: string,
  id: string,
  options: LoadShareDataOptions = {},
): Promise<ShareDataResult> => {
  const timeoutMs = options.timeoutMs ?? SHARE_DATA_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? SHARE_DATA_MAX_BYTES
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(`${apiUrl}/share_data?id=${id}`, { signal })
  } catch (error) {
    if (isTimeout(error, signal)) return { ok: false, status: 502, message: deadlineMessage(timeoutMs) }
    return {
      ok: false,
      status: 502,
      message: `share_data fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // A missing share keeps its existing 404 semantic; the body is not read.
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, status: 404, message: "share_data not found (upstream 404)" }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, status: 502, message: `share_data upstream responded with status ${response.status}` }
  }
  let text: string
  try {
    text = await readBoundedShareDataText(response, maxBytes, signal)
  } catch (error) {
    if (error instanceof ShareDataTooLarge) return { ok: false, status: 502, message: error.message }
    if (isTimeout(error, signal)) return { ok: false, status: 502, message: deadlineMessage(timeoutMs) }
    return {
      ok: false,
      status: 502,
      message: `share_data response read failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, status: 502, message: "share_data upstream returned a non-JSON body" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 502, message: "share_data upstream returned a JSON body that is not a share payload object" }
  }
  const data = parsed as ShareData
  if (typeof data.messages !== "object" || data.messages === null) data.messages = {}
  return { ok: true, data }
}
