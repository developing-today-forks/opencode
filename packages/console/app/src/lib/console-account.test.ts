import { describe, expect, mock, spyOn, test } from "bun:test"

// Mock the Resource module outright (the stats-proxy.test.ts pattern):
// SST Resource values freeze process-wide on first access, so setting
// env vars here would lose to whichever test file touches Resource first.
mock.module("@opencode/console-resource", () => ({
  Resource: {
    CONSOLE_CRM_LOOKUP_URL: { value: "https://crm.example.test/lookup" },
    CONSOLE_CRM_TOKEN: { value: "local-test-token" },
  },
}))

const { lookupConsoleAccount, CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES } = await import("./console-account")

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: fetch.preconnect }))
}

const account = {
  id: "acct-1",
  email: "person@example.test",
  name: "Person",
  createdAt: "2026-01-01T00:00:00.000Z",
}

describe("lookupConsoleAccount body cap", () => {
  test("parses a normal lookup response and sends the 3s timeout signal", async () => {
    let seenInput: RequestInfo | URL | undefined
    let seenInit: RequestInit | undefined
    const fetcher = stubFetch(async (input, init) => {
      seenInput = input
      seenInit = init
      return Response.json({ account })
    })
    try {
      expect(await lookupConsoleAccount("person@example.test")).toEqual(account)
      expect(String(seenInput)).toBe("https://crm.example.test/lookup")
      expect(seenInit?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("a null account parses to null", async () => {
    const fetcher = stubFetch(async () => Response.json({ account: null }))
    try {
      expect(await lookupConsoleAccount("person@example.test")).toBeNull()
    } finally {
      fetcher.mockRestore()
    }
  })

  test("rejects a response whose declared content-length exceeds the cap", async () => {
    const fetcher = stubFetch(
      async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES + 1),
          },
        }),
    )
    try {
      await expect(lookupConsoleAccount("person@example.test")).rejects.toThrow("too large")
    } finally {
      fetcher.mockRestore()
    }
  })

  test("rejects a streamed response that grows past the cap", async () => {
    const chunk = new Uint8Array(32 * 1024).fill(120)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    })
    const fetcher = stubFetch(async () => new Response(stream, { headers: { "content-type": "application/json" } }))
    try {
      await expect(lookupConsoleAccount("person@example.test")).rejects.toThrow("exceeded")
    } finally {
      fetcher.mockRestore()
    }
  })

  test("a non-OK response still rejects before any body read", async () => {
    const fetcher = stubFetch(async () => new Response("nope", { status: 502 }))
    try {
      await expect(lookupConsoleAccount("person@example.test")).rejects.toThrow("Console account lookup failed (502)")
    } finally {
      fetcher.mockRestore()
    }
  })

  test("the cap is the named 64 KiB", () => {
    expect(CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES).toBe(64 * 1024)
  })
})
