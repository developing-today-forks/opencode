import { describe, expect, test } from "bun:test"
import { lazy } from "../../src/util/lazy"

// Oracle: issue #2196 acceptance — a synchronously throwing initializer is
// not cached as a loaded undefined; success-path caching (including a
// legitimately undefined result) is unchanged and runs exactly once.
describe("util/lazy", () => {
  test("success caches and runs the initializer once", () => {
    let calls = 0
    const get = lazy(() => {
      calls++
      return 42
    })
    expect(get()).toBe(42)
    expect(get()).toBe(42)
    expect(calls).toBe(1)
  })

  test("a legitimately undefined result caches and runs once (watcher shape)", () => {
    let calls = 0
    const get = lazy((): string | undefined => {
      calls++
      return undefined
    })
    expect(get()).toBeUndefined()
    expect(get()).toBeUndefined()
    expect(calls).toBe(1)
  })

  test("a synchronously throwing initializer is retried on the next call", () => {
    let calls = 0
    const get = lazy(() => {
      calls++
      if (calls === 1) throw new Error("transient load failure")
      return 42
    })
    expect(() => get()).toThrow("transient load failure")
    expect(get()).toBe(42)
    expect(get()).toBe(42)
    expect(calls).toBe(2)
  })

  test("an always-throwing initializer throws on every call and is never cached as undefined", () => {
    let calls = 0
    const get = lazy((): number => {
      calls++
      throw new Error("boom")
    })
    expect(() => get()).toThrow("boom")
    expect(() => get()).toThrow("boom")
    expect(calls).toBe(2)
  })

  test("a promise-returning initializer caches the same promise and runs once (pty/shell-parse shape)", async () => {
    let calls = 0
    const get = lazy(() => {
      calls++
      return Promise.resolve(7)
    })
    const first = get()
    expect(get()).toBe(first)
    expect(await first).toBe(7)
    expect(calls).toBe(1)
  })
})
