import { describe, expect, spyOn, test } from "bun:test"

// Resource values resolve from SST_RESOURCE_* env (the salesforce.test.ts pattern).
process.env.SST_RESOURCE_EMAILOCTOPUS_API_KEY = JSON.stringify({ value: "test-key" })

const { emailOctopusSubscribe, EMAILOCTOPUS_TIMEOUT_MS } = await import("./emailoctopus")

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

describe("emailOctopusSubscribe fetch bounds", () => {
  test("PUTs the payload with the bearer key and the 5s timeout signal", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    let seenInput: RequestInfo | URL | undefined
    let seenInit: RequestInit | undefined
    const fetcher = stubFetch(async (input, init) => {
      seenInput = input
      seenInit = init
      return new Response(null, { status: 200 })
    })
    try {
      const response = await emailOctopusSubscribe("list-1", { email_address: "person@example.test" })
      expect(response.status).toBe(200)
      expect(String(seenInput)).toBe("https://api.emailoctopus.com/lists/list-1/contacts")
      expect(seenInit?.method).toBe("PUT")
      expect(new Headers(seenInit?.headers).get("Authorization")).toBe("Bearer test-key")
      expect(JSON.parse(String(seenInit?.body))).toEqual({ email_address: "person@example.test" })
      expect(timeout).toHaveBeenCalledWith(5000)
      expect(EMAILOCTOPUS_TIMEOUT_MS).toBe(5000)
      expect(seenInit?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })

  test("rejects instead of hanging when the upstream stalls past the timeout", async () => {
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
      const pending = emailOctopusSubscribe("list-1", { email_address: "person@example.test" })
      controller.abort()
      await expect(pending).rejects.toThrow("timed out")
    } finally {
      fetcher.mockRestore()
      timeout.mockRestore()
    }
  })
})
