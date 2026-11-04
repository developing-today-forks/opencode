export const OPENAPI_FETCH_TIMEOUT_MS = 8_000
// The current generated spec is ~860 KiB; 4 MiB leaves room for growth while
// bounding the memory used by each request.
export const OPENAPI_MAX_BYTES = 4 * 1024 * 1024

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const OPENAPI_URL = "https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/dev/packages/protocol/openapi.json"

export async function GET() {
  const signal = AbortSignal.timeout(OPENAPI_FETCH_TIMEOUT_MS)
  const response = await fetch(OPENAPI_URL, { signal }).catch(() => undefined)
  if (!response) return new Response(null, { status: 502 })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    return new Response(null, { status: response.status })
  }

  const json = await readCappedJson(response, signal)
  if (json === undefined) return new Response(null, { status: 502 })
  return json
}

/** Read the generated spec through a hard size cap; an abort or over-cap read cancels the body. */
async function readCappedJson(response: Response, signal: AbortSignal): Promise<JsonValue | undefined> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > OPENAPI_MAX_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return undefined

  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      size += result.value.byteLength
      if (size > OPENAPI_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(result.value)
    }

    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue
  } catch {
    return undefined
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
