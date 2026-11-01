import { describe, expect, test } from "bun:test"
import { deadlineSignal, readBoundedResponseText, readExcerptResponseText } from "./http-body.js"

const tooLarge = () => new Error("response body too large")
const encode = (text: string) => new TextEncoder().encode(text)

type StreamState = { pulls: number; cancelled: boolean }

function trackedStream(chunks: Array<Uint8Array>, state: StreamState, hangAfter = false) {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
        return
      }
      if (hangAfter) return new Promise<void>(() => {})
      controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
}

function fakeResponse(body: ReadableStream<Uint8Array> | null, init: { headers?: Record<string, string>; text?: string } = {}) {
  return {
    headers: new Headers(init.headers ?? {}),
    body,
    text: async () => init.text ?? "",
  } as unknown as Response
}

const freshState = (): StreamState => ({ pulls: 0, cancelled: false })

describe("readBoundedResponseText conformance (#1127 edge table)", () => {
  const rows: Array<{
    name: string
    run: () => Promise<string>
    expectText?: string
    expectTooLarge?: boolean
    after?: () => void
  }> = []

  rows.push({
    name: "returns a normal body",
    run: () => readBoundedResponseText(new Response("hello world"), 1024, tooLarge),
    expectText: "hello world",
  })
  rows.push({
    name: "accepts a body exactly at the cap",
    run: () => readBoundedResponseText(new Response("x".repeat(1024)), 1024, tooLarge),
    expectText: "x".repeat(1024),
  })
  rows.push({
    name: "empty body returns empty",
    run: () => readBoundedResponseText(new Response(""), 1024, tooLarge),
    expectText: "",
  })
  {
    const state = freshState()
    rows.push({
      name: "declared length over cap refuses before reading",
      run: () =>
        readBoundedResponseText(
          fakeResponse(trackedStream([encode("small")], state), { headers: { "content-length": "1025" } }),
          1024,
          tooLarge,
        ),
      expectTooLarge: true,
      after: () => {
        expect(state.pulls).toBe(0)
        expect(state.cancelled).toBe(true)
      },
    })
  }
  {
    const state = freshState()
    const chunk = new Uint8Array(512).fill(97)
    rows.push({
      name: "chunked drip over cap refuses at the cap and cancels",
      run: () => readBoundedResponseText(fakeResponse(trackedStream([chunk, chunk, chunk], state)), 1024, tooLarge),
      expectTooLarge: true,
      after: () => expect(state.cancelled).toBe(true),
    })
  }
  rows.push({
    name: "no-stream fallback enforces the cap",
    run: () => readBoundedResponseText(fakeResponse(null, { text: "x".repeat(1025) }), 1024, tooLarge),
    expectTooLarge: true,
  })
  rows.push({
    name: "no-stream fallback returns an in-cap body",
    run: () => readBoundedResponseText(fakeResponse(null, { text: "fallback" }), 1024, tooLarge),
    expectText: "fallback",
  })

  for (const row of rows) {
    test(row.name, async () => {
      if (row.expectTooLarge) await expect(row.run()).rejects.toThrow("response body too large")
      else expect(await row.run()).toBe(row.expectText!)
      row.after?.()
    })
  }
})

describe("readExcerptResponseText conformance (#1127 edge table)", () => {
  test("excerpt cut at the cap returns exactly the prefix, across chunks", async () => {
    const state = freshState()
    const response = fakeResponse(trackedStream([encode("hello "), encode("world")], state))
    expect(await readExcerptResponseText(response, 5)).toBe("hello")
    expect(await readExcerptResponseText(fakeResponse(trackedStream([encode("hello "), encode("world")], freshState())), 8)).toBe(
      "hello wo",
    )
  })

  test("empty body returns empty", async () => {
    expect(await readExcerptResponseText(new Response(""), 1024)).toBe("")
  })

  test("deadline firing mid-body aborts the read and returns the prefix", async () => {
    const state = freshState()
    const response = fakeResponse(trackedStream([encode("hello ")], state, true))
    const text = await readExcerptResponseText(response, 1024, deadlineSignal(undefined, 25))
    expect(text).toBe("hello ")
    expect(state.cancelled).toBe(true)
  })

  test("caller signal aborting first wins over a long deadline", async () => {
    const caller = new AbortController()
    const state = freshState()
    const response = fakeResponse(trackedStream([encode("partial")], state, true))
    const signal = deadlineSignal(caller.signal, 60_000)
    const pending = readExcerptResponseText(response, 1024, signal)
    // Let the first chunk land, then abort mid-body.
    await new Promise((resolve) => setTimeout(resolve, 10))
    caller.abort(new Error("caller stopped"))
    expect(await pending).toBe("partial")
    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).message).toBe("caller stopped")
  })

  test("a broken stream returns the prefix read so far", async () => {
    let first = true
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false
          controller.enqueue(encode("kept"))
          return
        }
        controller.error(new Error("boom"))
      },
    })
    expect(await readExcerptResponseText(fakeResponse(stream), 1024)).toBe("kept")
  })
})

describe("deadlineSignal (#1127)", () => {
  test("without a caller signal it is a plain timeout signal", async () => {
    const signal = deadlineSignal(undefined, 15)
    expect(signal.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signal.aborted).toBe(true)
  })

  test("the timeout wins when the caller never aborts", async () => {
    const caller = new AbortController()
    const signal = deadlineSignal(caller.signal, 15)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signal.aborted).toBe(true)
    expect(signal.reason?.name).toBe("TimeoutError")
  })
})
