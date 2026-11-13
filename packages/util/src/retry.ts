export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const transientMessages = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  // Bun names a refused connection ConnectionRefused rather than ECONNREFUSED.
  "connectionrefused",
  "etimedout",
  "socket hang up",
]

// Generated clients wrap fetch failures as ClientError("Transport", { cause }) and Bun/Node put the
// network detail in `code`, so the transient signal may sit anywhere along the cause chain.
function isTransientError(error: unknown, depth = 0): boolean {
  if (!error) return false
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : ""
  // oxlint-disable-next-line no-base-to-string -- Error input is intentionally normalized for message matching.
  const message = `${String(error instanceof Error ? error.message : error)} ${code}`.toLowerCase()
  if (transientMessages.some((item) => message.includes(item))) return true
  if (!(error instanceof Error) || depth >= 5) return false
  return isTransientError(error.cause, depth + 1)
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  // Normalise attempts to a finite count >= 1: NaN would skip the operation entirely and throw
  // undefined (the #562 symptom), +Infinity would retry forever, and a fractional count would
  // never match the loop-exit guard, so it is floored. NaN gets a single attempt; +Infinity
  // falls back to the default count.
  const requestedAttempts = options.attempts ?? 3
  let attempts = Math.max(Math.floor(requestedAttempts), 1)
  if (Number.isNaN(requestedAttempts)) attempts = 1
  if (requestedAttempts === Number.POSITIVE_INFINITY) attempts = 3
  const delay = options.delay ?? 500
  const factor = options.factor ?? 2
  const maxDelay = options.maxDelay ?? 10_000
  const retryIf = options.retryIf ?? isTransientError
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !retryIf(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay * Math.pow(factor, attempt), maxDelay)))
    }
  }
  throw lastError
}
