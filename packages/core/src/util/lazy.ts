export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  return (): T => {
    if (loaded) return value as T
    // Only mark loaded once fn() has returned: a synchronously throwing
    // initializer must not be cached as a loaded undefined — the next
    // call retries it instead of replaying a type-lying undefined.
    value = fn()
    loaded = true
    return value as T
  }
}
