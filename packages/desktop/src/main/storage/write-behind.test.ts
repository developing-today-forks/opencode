import { describe, expect, test } from "bun:test"
import { createWriteBehind } from "./write-behind"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("write-behind", () => {
  test("coalesces a burst into one batch with the latest value per key", async () => {
    const batches: Map<string, number>[] = []
    const writer = createWriteBehind<number>({ delay: 10, write: (batch) => batches.push(batch) })
    writer.set("a", 1)
    writer.set("b", 1)
    writer.set("a", 2)
    expect(writer.get("a")).toBe(2)
    expect(batches).toHaveLength(0)
    await wait(30)
    expect(batches).toHaveLength(1)
    expect([...batches[0]!]).toEqual([
      ["a", 2],
      ["b", 1],
    ])
    expect(writer.has("a")).toBe(false)
  })

  test("flush writes immediately and close stops accepting writes", () => {
    const batches: Map<string, number>[] = []
    const writer = createWriteBehind<number>({ delay: 1_000, write: (batch) => batches.push(batch) })
    writer.set("a", 1)
    writer.flush()
    expect(batches).toHaveLength(1)
    writer.set("b", 2)
    writer.close()
    expect(batches).toHaveLength(2)
    writer.set("c", 3)
    writer.flush()
    expect(batches).toHaveLength(2)
  })

  test("a failed flush re-arms and persists the batch without another set", async () => {
    const batches: Map<string, number>[] = []
    const errors: unknown[] = []
    let calls = 0
    const writer = createWriteBehind<number>({
      delay: 10,
      write: (batch) => {
        calls += 1
        if (calls === 1) throw new Error("transient")
        batches.push(batch)
      },
      onError: (error) => errors.push(error),
    })
    writer.set("a", 1)
    await wait(150)
    expect(errors).toHaveLength(1)
    expect(batches).toHaveLength(1)
    expect([...batches[0]!]).toEqual([["a", 1]])
    expect(writer.has("a")).toBe(false)
    writer.close()
  })

  test("close retries a requeued batch and persists it when the write recovers", () => {
    const batches: Map<string, number>[] = []
    let calls = 0
    const writer = createWriteBehind<number>({
      delay: 1_000,
      write: (batch) => {
        calls += 1
        if (calls === 1) throw new Error("transient")
        batches.push(batch)
      },
      onError: () => {},
    })
    writer.set("a", 1)
    writer.flush()
    expect(batches).toHaveLength(0)
    expect(writer.has("a")).toBe(true)
    writer.close()
    expect(batches).toHaveLength(1)
    expect([...batches[0]!]).toEqual([["a", 1]])
  })

  test("writes after a failed flush take precedence over the requeued batch", async () => {
    const batches: Map<string, number>[] = []
    let calls = 0
    const writer = createWriteBehind<number>({
      delay: 10,
      write: (batch) => {
        calls += 1
        if (calls === 1) throw new Error("transient")
        batches.push(batch)
      },
      onError: () => {},
    })
    writer.set("a", 1)
    writer.flush()
    writer.set("a", 2)
    await wait(150)
    expect(batches).toHaveLength(1)
    expect([...batches[0]!]).toEqual([["a", 2]])
    writer.close()
  })
})
