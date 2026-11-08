import { describe, expect, spyOn, test } from "bun:test"

// Resource values resolve from SST_RESOURCE_* env (the salesforce.test.ts pattern).
process.env.SST_RESOURCE_EMAILOCTOPUS_API_KEY = JSON.stringify({ value: "test-key" })

const { subscribe, readErrorBodyExcerpt, ERROR_BODY_MAX_BYTES } = await import("./enterprise")

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

describe("enterprise EmailOctopus subscribe bounds", () => {
  test("resolves true on a normal subscribe", async () => {
    const fetcher = stubFetch(async () => new Response(null, { status: 200 }))
    try {
      expect(await subscribe("person@example.test", "Test Person")).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("degrades to false when the upstream stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    const fetcher = stubFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const aborted = () => reject(new DOMException("The operation timed out", "TimeoutError"))
          if (init?.signal?.aborted) return aborted()
          init?.signal?.addEventListener("abort", aborted)
        }),
    )
    try {
      const pending = subscribe("person@example.test", "Test Person")
      controller.abort()
      expect(await pending).toBe(false)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
      errors.mockRestore()
    }
  })

  test("logs only an 8 KiB excerpt of an oversized error body and cancels the stream", async () => {
    let cancelled = false
    const chunk = new Uint8Array(4096).fill(120)
    const fetcher = stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              stream.enqueue(chunk)
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 500, statusText: "Internal Server Error" },
        ),
    )
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(await subscribe("person@example.test", "Test Person")).toBe(false)
      expect(cancelled).toBe(true)
      const excerpt = errors.mock.calls.at(-1)?.at(-1)
      expect(typeof excerpt).toBe("string")
      expect((excerpt as string).length).toBe(ERROR_BODY_MAX_BYTES)
      expect(ERROR_BODY_MAX_BYTES).toBe(8192)
    } finally {
      fetcher.mockRestore()
      errors.mockRestore()
    }
  })

  test("readErrorBodyExcerpt returns a short error body whole", async () => {
    expect(await readErrorBodyExcerpt(new Response("nope", { status: 400 }))).toBe("nope")
    expect(await readErrorBodyExcerpt(new Response(null, { status: 400 }))).toBe("")
  })
})
