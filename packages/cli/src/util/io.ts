import { text } from "node:stream/consumers"

export function readStdin(beforeRead?: () => void) {
  beforeRead?.()
  return text(process.stdin)
}

/** How long `readPipedStdin` waits for a piped stdin to show writer intent
 * (a first chunk, or EOF) before treating it as no piped input at all.
 * Callers whose stdin is the only prompt source pass an infinite grace:
 * a slow producer's first byte is still writer intent, so that read waits
 * for EOF however long the producer takes (Codex P2 on PR #1460). */
export const STDIN_GRACE_MS = 1_000

/**
 * Read piped stdin for the `run` command, without ever hanging on an open
 * pipe nobody writes to (code#1359): an SSH session or automation harness
 * that inherits an open, never-written, never-closed stdin pipe used to
 * block `opencode run` forever at this read, even when the message was
 * already given on the command line. Writer intent is observable — a real
 * producer (`echo ... |`, a here-doc, a file redirect) delivers its first
 * chunk or EOF immediately — so if neither arrives within `graceMs`, the
 * stream is treated as no piped input and the command proceeds. A stream
 * that shows intent is read to EOF exactly like `readStdin`. The stream
 * is a parameter so tests can feed a fake one.
 */
export function readPipedStdin(
  beforeRead?: () => void,
  stream: NodeJS.ReadStream = process.stdin,
  graceMs: number = STDIN_GRACE_MS,
): Promise<string | undefined> {
  beforeRead?.()
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let intent = false
    const timer = Number.isFinite(graceMs)
      ? setTimeout(() => {
          if (intent) return
          cleanup()
          stream.pause()
          resolve(undefined)
        }, graceMs)
      : undefined
    timer?.unref?.()
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      stream.off("data", onData)
      stream.off("end", onEnd)
      stream.off("error", onError)
    }
    const onData = (chunk: Buffer) => {
      intent = true
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      // TextDecoder strips a leading UTF-8 BOM, matching text(process.stdin).
      resolve(new TextDecoder().decode(Buffer.concat(chunks)))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    stream.on("data", onData)
    stream.on("end", onEnd)
    stream.on("error", onError)
  })
}

/**
 * Read stdin as text for auth import, failing as soon as the running byte
 * total exceeds `maximumBytes` instead of buffering the whole stream
 * unbounded the way `text(process.stdin)` does: past the ~512 MiB engine
 * string ceiling an unbounded read dies with an opaque RangeError/OOM
 * instead of this clear too-large error. Scoped to auth import - the
 * other stdin readers stay as they are (mini's unbounded `readStdin`,
 * run's grace-bounded `readPipedStdin`). The stream is a parameter so tests can feed a fake one.
 */
export async function readBoundedStdin(
  maximumBytes: number,
  stream: AsyncIterable<Uint8Array | string> = process.stdin,
): Promise<string> {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk
    size += bytes.byteLength
    if (size > maximumBytes)
      throw new Error(`Auth data too large: stdin exceeds the ${maximumBytes}-byte limit`)
    chunks.push(bytes)
  }
  // TextDecoder strips a leading UTF-8 BOM, matching text(process.stdin).
  return new TextDecoder().decode(Buffer.concat(chunks, size))
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
