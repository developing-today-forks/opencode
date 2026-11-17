// Coalesces a burst of writes into one batch. The latest value per key wins, so a store that
// re-serializes on every mutation costs one row write per flush instead of one per change.
const MAX_RETRY_DELAY = 30_000

export function createWriteBehind<T>(input: {
  delay: number
  write: (batch: Map<string, T>) => void
  onError?: (error: unknown) => void
}) {
  const pending = new Map<string, T>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let failures = 0

  const flush = () => {
    clearTimeout(timer)
    timer = undefined

    if (closed || pending.size === 0) return
    const batch = new Map(pending)
    pending.clear()

    try {
      input.write(batch)
      failures = 0
    } catch (error) {
      // The renderer already saw these writes succeed. Keep them queued so the next flush retries
      // them; anything written for the same key since then takes precedence.
      for (const [key, value] of batch) if (!pending.has(key)) pending.set(key, value)

      if (!input.onError) throw error
      input.onError(error)

      // A requeue without a timer is a promise nothing keeps: one transient error would leave
      // the batch unpersisted until some unrelated future set() or a graceful quit. Re-arm with
      // bounded exponential backoff so the retry happens on its own.
      failures += 1
      if (!closed && pending.size > 0) {
        const backoff = Math.min(input.delay * 2 ** failures, MAX_RETRY_DELAY)
        timer ??= setTimeout(flush, backoff)
      }
    }
  }

  return {
    get: (key: string) => pending.get(key),
    has: (key: string) => pending.has(key),
    entries: () => pending.values(),
    set(key: string, value: T) {
      if (closed) return
      pending.set(key, value)
      timer ??= setTimeout(flush, input.delay)
    },
    drop(predicate: (value: T) => boolean) {
      for (const [key, value] of pending) if (predicate(value)) pending.delete(key)
    },
    flush,
    close() {
      if (closed) return
      // Flush, then attempt whatever a failed flush requeued at least once more before giving
      // up: the caller closes the database right after this, so a batch left pending here is
      // lost. If writes are still pending after the last attempt, surface the failure instead
      // of closing silently over it.
      let failure: unknown
      let threw = false
      try {
        flush()
      } catch (error) {
        failure = error
        threw = true
      }
      if (pending.size > 0) {
        try {
          flush()
        } catch (error) {
          failure = error
          threw = true
        }
      }
      closed = true
      clearTimeout(timer)
      timer = undefined
      if (threw && pending.size > 0) throw failure
    },
  }
}
