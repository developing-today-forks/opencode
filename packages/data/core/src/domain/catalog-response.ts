// The catalog is approximately 11 MB; 32 MiB gives it roughly threefold headroom.
const CATALOG_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export async function readCatalogResponse(response: Response, signal: AbortSignal) {
  if (!response.body) return ""
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
      if (size > CATALOG_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new Error("Model catalog response exceeded size limit")
      }
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
