import { text } from "node:stream/consumers"

export function readStdin(beforeRead?: () => void) {
  beforeRead?.()
  return text(process.stdin)
}

const tooLarge = (maximumBytes: number) =>
  new Error(`Session data too large: response body exceeds the ${maximumBytes}-byte limit`)

/**
 * Read a response body as text, failing as soon as the body is known to
 * exceed `maximumBytes` instead of buffering it unbounded: a declared
 * content-length over the cap fails before any bytes are read, and a
 * streamed body is cut the moment its running total passes the cap.
 */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const contentLength = response.headers.get("content-length")
  const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
  const declaredSize =
    parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
  if (declaredSize !== undefined && declaredSize > maximumBytes) throw tooLarge(maximumBytes)
  if (!response.body) {
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > maximumBytes) throw tooLarge(maximumBytes)
    return body
  }
  const reader = response.body.getReader()
  // Tie the read to the caller's deadline: when the signal fires, cancel the
  // reader so a stalled or slow-dripping body errors out instead of the read
  // waiting forever under the size cap.
  const abort = () => void reader.cancel(signal?.reason).catch(() => undefined)
  signal?.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge(maximumBytes)
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  // A cancel from the abort listener resolves the pending read as done, so
  // re-check the signal here: a timed-out read must not return a partial
  // body as if it were complete.
  signal?.throwIfAborted()
  // TextDecoder (like response.text()) strips a leading UTF-8 BOM;
  // Buffer.toString("utf8") would preserve it and break JSON parsing.
  return new TextDecoder().decode(Buffer.concat(chunks, size))
}
