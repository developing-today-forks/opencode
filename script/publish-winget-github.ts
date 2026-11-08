const GITHUB_API_TIMEOUT_MS = 30_000

/**
 * Hard cap on WinGet GitHub response bodies. Every response read through
 * readResponseBody is small, schema-known JSON, so 1 MiB leaves generous
 * headroom while bounding memory. The request deadline bounds duration,
 * not bytes, so the body is read through the capped reader below
 * (#1336, in the style of #1334's UPDATE_ARTIFACT_RESPONSE_MAX_BYTES).
 */
export const WINGET_GITHUB_RESPONSE_MAX_BYTES = 1024 * 1024

/** Max characters of a non-OK response body embedded in the thrown error. */
export const WINGET_GITHUB_ERROR_BODY_EXCERPT_MAX_CHARS = 1024

type Options = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export namespace WinGetGitHub {
  export function create(token: string | undefined, options: Options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch
    const timeoutMs = options.timeoutMs ?? GITHUB_API_TIMEOUT_MS
    const deadlines = new WeakMap<Response, { operation: string; signal: AbortSignal }>()

    async function request(route: string, init?: { method?: string; body?: unknown }) {
      const method = init?.method ?? "GET"
      const operation = `WinGet GitHub ${method} ${route}`
      const signal = AbortSignal.timeout(timeoutMs)
      try {
        const response = await fetchImpl(`https://api.github.com${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: init?.body === undefined ? undefined : JSON.stringify(init.body),
          signal,
        })
        signal.throwIfAborted()
        deadlines.set(response, { operation, signal })
        return response
      } catch (error) {
        if (signal.aborted) throw new Error(`${operation} timed out after ${timeoutMs}ms`, { cause: error })
        throw error
      }
    }

    async function json(response: Response): Promise<unknown> {
      const deadline = deadlines.get(response)
      if (!deadline) throw new Error(`GitHub response was not created by WinGetGitHub: ${response.url}`)
      try {
        const body = await readResponseText(response, deadline.signal, deadline.operation)
        deadline.signal.throwIfAborted()
        if (!response.ok)
          throw new Error(
            `GitHub ${response.url} returned ${response.status}: ${body.slice(0, WINGET_GITHUB_ERROR_BODY_EXCERPT_MAX_CHARS)}`,
          )
        return JSON.parse(body)
      } catch (error) {
        if (deadline.signal.aborted)
          throw new Error(`${deadline.operation} timed out after ${timeoutMs}ms`, { cause: error })
        throw error
      }
    }

    return { request, json }
  }
}

async function readResponseText(response: Response, signal: AbortSignal, operation: string) {
  return new TextDecoder().decode(await readResponseBody(response, signal, operation))
}

/** Reads a response body until it completes, its request deadline aborts, or it exceeds the byte cap. */
async function readResponseBody(response: Response, signal: AbortSignal, operation: string): Promise<Uint8Array> {
  if (!response.body) {
    signal.throwIfAborted()
    return new Uint8Array()
  }
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > WINGET_GITHUB_RESPONSE_MAX_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`${operation} response exceeded ${WINGET_GITHUB_RESPONSE_MAX_BYTES} bytes`)
  }
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > WINGET_GITHUB_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${operation} response exceeded ${WINGET_GITHUB_RESPONSE_MAX_BYTES} bytes`)
      }
      chunks.push(result.value)
    }
    // Cancellation can settle a pending read as done; never accept partial JSON after the deadline.
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
