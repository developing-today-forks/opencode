import { describe, expect, mock, spyOn, test } from "bun:test"

mock.module("sst/resource", () => ({
  Resource: { EMAILOCTOPUS_API_KEY: { value: "test-key" } },
}))

const { POST, EMAILOCTOPUS_TIMEOUT_MS } = await import("./newsletter")

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

function event() {
  const form = new FormData()
  form.set("email", "person@example.test")
  return {
    request: new Request("https://stats.opencode.ai/api/newsletter", { method: "POST", body: form }),
  } as Parameters<typeof POST>[0]
}

describe("stats newsletter EmailOctopus bounds", () => {
  test("subscribes normally with the 5s timeout signal", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    let seen: RequestInit | undefined
    const fetcher = stubFetch(async (_input, init) => {
      seen = init
      return new Response(null, { status: 200 })
    })
    try {
      const response = await POST(event())
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(timeout).toHaveBeenCalledWith(5000)
      expect(EMAILOCTOPUS_TIMEOUT_MS).toBe(5000)
      expect(seen?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("still returns 502 on a non-OK upstream response", async () => {
    const fetcher = stubFetch(async () => new Response(null, { status: 500 }))
    try {
      expect((await POST(event())).status).toBe(502)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("fails instead of hanging when the upstream stalls past the timeout", async () => {
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    const fetcher = stubFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const aborted = () => reject(new DOMException("The operation timed out", "TimeoutError"))
          if (init?.signal?.aborted) return aborted()
          init?.signal?.addEventListener("abort", aborted)
        }),
    )
    try {
      const pending = POST(event())
      controller.abort()
      await expect(pending).rejects.toThrow("timed out")
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })
})
