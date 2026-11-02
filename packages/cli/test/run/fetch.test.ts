import { expect, test } from "bun:test"
import { createRunFetch } from "../../src/run/fetch"

test("run fetch aborts a stalled non-streaming request at its deadline", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  try {
    await expect(createRunFetch(100)(new URL("/api/info", server.url))).rejects.toThrow()
  } finally {
    server.stop(true)
  }
})

test("run fetch leaves event streams open beyond the request deadline", async () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: connected\n\n"))
            setTimeout(() => {
              controller.enqueue(encoder.encode("data: still-open\n\n"))
              controller.close()
            }, 100)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    const response = await createRunFetch(20)(new URL("/api/event", server.url))
    const reader = response.body!.getReader()
    expect(decoder.decode((await reader.read()).value)).toContain("connected")
    // The delayed event intentionally arrives after the test's 20ms request deadline.
    expect(decoder.decode((await reader.read()).value)).toContain("still-open")
  } finally {
    server.stop(true)
  }
})

test("run fetch leaves the session idle wait unbounded", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null)), 100)),
  })
  try {
    await expect(
      createRunFetch(20)(new URL("/api/experimental/session/ses_test/wait", server.url)),
    ).resolves.toMatchObject({ status: 200 })
  } finally {
    server.stop(true)
  }
})
