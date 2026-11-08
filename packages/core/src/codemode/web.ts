export * as CodeModeWeb from "./web.js"

import { Extension } from "@opencode/codemode"

const TIMEOUT_MS = 30_000

/**
 * Cap on a fetched response body. The executing program is model-written, so the URL is effectively
 * model-chosen and the body untrusted; 5 MiB is the webfetch tool's `MAX_RESPONSE_BYTES` bound for the
 * same kind of fetch. Without it, 30 s of a fast connection is gigabytes buffered whole.
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

const readBounded = async (response: Response, method: string): Promise<Uint8Array> => {
  const tooLarge = () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`)
  // HEAD and 304 responses have no body; their content-length may describe the GET representation.
  if (method !== "HEAD" && response.status !== 304) {
    const declared = Number(response.headers.get("content-length"))
    if (Number.isSafeInteger(declared) && declared > MAX_RESPONSE_BYTES) {
      // Cancel before rejecting: an uncancelled body keeps downloading in the background
      // until it completes or the fetch timeout fires.
      await response.body?.cancel().catch(() => {})
      throw tooLarge()
    }
  }
  if (!response.body) {
    const bytes = await response.bytes()
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw tooLarge()
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

type Init = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

const fetch = async (input: string | URL, init: Init = {}) => {
  if (URL.parse(String(input))?.protocol === "file:") throw new Error("fetch cannot be used for filesystem access.")
  const method = (init.method ?? "GET").toUpperCase()
  const response = await globalThis.fetch(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const bytes = await readBounded(response, method)
  const headers = Object.fromEntries(response.headers)
  const text = () => new TextDecoder().decode(bytes)
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    headers: {
      // Own-property lookups only (#805): headers is a plain record, so a bare index or
      // `in` reads through Object.prototype - an absent "constructor" resolved to the
      // Object function and "__proto__" to Object.prototype instead of null / false.
      get: (name: string) => {
        const key = name.toLowerCase()
        return Object.hasOwn(headers, key) ? headers[key] : null
      },
      has: (name: string) => Object.hasOwn(headers, name.toLowerCase()),
      entries: () => Object.entries(headers),
    },
    text: async () => text(),
    json: async () => JSON.parse(text()),
    bytes: async () => bytes,
  }
}

export const extension = Extension.make({ name: "web", globals: { fetch } })

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>) => {
  const [input, init] = args as [string | URL, Init | undefined]
  return { method: init?.method?.toUpperCase() ?? "GET", url: String(input) }
}
