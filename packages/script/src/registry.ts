/** The registry document that version resolution reads: the latest published
 * @opencode/cli version. A small JSON document (2,451 B measured 2026-11-01), read
 * at build time on the release path — bounded in time and size so a stalled or
 * oversized registry response fails the build loudly instead of hanging it (#1275). */

export const REGISTRY_FETCH_TIMEOUT_MS = 8_000
/** ~400x the measured document: headroom for registry metadata growth, small
 * enough that a hostile or broken upstream cannot buffer unboundedly. */
export const MAX_REGISTRY_DOC_BYTES = 1024 * 1024

const REGISTRY_URL = "https://registry.npmjs.org/@opencode%2fcli/latest"

export interface RegistryFetchOptions {
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

/** Fetches the latest published version string, or throws: a non-OK status, a
 * timeout, and an over-cap body all settle as errors, exactly as the unbounded
 * read's failures did — there is no fallback version. */
export async function fetchRegistryVersion(
  fetchImpl: typeof fetch = fetch,
  options: RegistryFetchOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_REGISTRY_DOC_BYTES
  const signal = AbortSignal.timeout(options.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS)
  const res = await fetchImpl(REGISTRY_URL, { signal })
  if (!res.ok) throw new Error(res.statusText)
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined)
    throw new Error(`Registry response exceeded size limit (${declared} > ${maxBytes} bytes)`)
  }
  if (!res.body) throw new Error("Registry response had no body")
  const reader = res.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new Error(`Registry response exceeded size limit (${maxBytes} bytes)`)
      }
      chunks.push(result.value)
    }
    // The abort handler above cancels the reader, which settles a pending
    // read as done — so a body that stalls after a complete document would
    // otherwise parse as a success at the deadline. The deadline still owns
    // this read: an aborted signal rejects before the document is accepted.
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }
    if (typeof data.version !== "string") throw new Error("Registry response had no version")
    return data.version
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
