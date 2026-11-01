/**
 * Bounded body reads for native fetch `Response`s, plus deadline
 * composition — the dependency-free native pair from design #1127
 * ("bounded by default"), living in `@opencode/util`, the lowest shared
 * layer, for every package that can take a workspace dependency but
 * cannot import `@opencode/core` (whose Effect HttpClient variant,
 * `collectBoundedResponseBody`, stays in core).
 *
 * Two named semantics, chosen on purpose:
 * - `readBoundedResponseText` — refuse semantics, for any body the
 *   caller will parse or act on: a declared `content-length` above the
 *   cap fails before the body is read; a streamed body is bounded in
 *   flight as its chunks arrive and the read is cancelled at the cap.
 *   Never buffers the whole body and checks afterwards.
 * - `readExcerptResponseText` — truncate semantics, for diagnostics-only
 *   text (an error body being logged or placed in an error message):
 *   returns the prefix read up to the cap; a signal (or a broken stream)
 *   cuts the read short and still returns what was read.
 *
 * Neither function introduces a cap or a deadline value: call sites
 * pass their own, under #992's `timeoutMs` ceiling.
 */
export const readBoundedResponseText = async (
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error,
): Promise<string> => {
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
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    if (size + value.byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
    size += value.byteLength
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read a response body as an excerpt: at most `maximumBytes` of the
 * prefix, for diagnostics-only text. When `signal` aborts (e.g. a
 * deadline composed by `deadlineSignal`), the read is cancelled and the
 * prefix read so far is returned instead of rejecting — an error path
 * logging an excerpt should not fail because the body stalled.
 */
export const readExcerptResponseText = async (
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> => {
  if (!response.body) {
    // No stream to bound in flight (exotic Response implementations only).
    const text = await response.text().catch(() => "")
    const encoded = new TextEncoder().encode(text)
    return new TextDecoder().decode(encoded.subarray(0, maximumBytes))
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
    while (size < maximumBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const slice = value.subarray(0, maximumBytes - size)
      chunks.push(slice)
      size += slice.byteLength
    }
  } catch {
    // A broken stream still leaves a useful excerpt behind.
  } finally {
    signal?.removeEventListener("abort", abort)
    void reader.cancel().catch(() => undefined)
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

/**
 * Compose a caller-supplied signal with a timeout into one deadline
 * signal: the result aborts when either source aborts (the caller's
 * reason wins when the caller aborts first). Introduces no default
 * timeout value — call sites pass their own `timeoutMs`, under #992's
 * ceiling. Uses `AbortSignal.any` where available, with an equivalent
 * manual composition elsewhere.
 */
export const deadlineSignal = (caller: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!caller) return timeout
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, timeout])
  const controller = new AbortController()
  const abort = () => {
    if (controller.signal.aborted) return
    controller.abort(caller.aborted ? caller.reason : timeout.reason)
  }
  if (caller.aborted || timeout.aborted) abort()
  else {
    caller.addEventListener("abort", abort, { once: true })
    timeout.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}
