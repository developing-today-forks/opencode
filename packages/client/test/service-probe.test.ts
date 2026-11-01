import { expect, test } from "bun:test"
import { maxProbeBodyBytes, probeResult } from "../src/service-probe"

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  return {
    info: { url: `http://127.0.0.1:${server.port}`, pid: 4242, version: "1.2.3" },
    stop: () => server.stop(true),
  }
}

test("a small info body classifies as ready and compatible", async () => {
  const server = serve(() => Response.json({ version: "1.2.3", pid: 4242 }))
  try {
    const result = await probeResult(server.info)
    expect(result.timedOut).toBe(false)
    expect(result.service).toMatchObject({ state: "ready", compatible: true, version: "1.2.3" })
  } finally {
    server.stop()
  }
})

test("an over-cap declared length is not classified", async () => {
  // Response.json sets a real content-length above the cap, so the probe's
  // declared-length check rejects the body before it is consumed.
  const server = serve(() =>
    Response.json({ version: "1.2.3", pid: 4242, pad: "x".repeat(maxProbeBodyBytes) }),
  )
  try {
    const result = await probeResult(server.info)
    expect(result.service).toBeUndefined()
    expect(result.timedOut).toBe(false)
  } finally {
    server.stop()
  }
})

test("an over-cap streamed body is not classified", async () => {
  // No content-length here, so the probe's in-flight byte counting is what
  // rejects the body. Server-side pull/cancel counts are not observable
  // through a real socket (the server may buffer ahead), so this pins the
  // classification outcome; the bounded reader cancels in flight by design.
  const chunk = new Uint8Array(8_192).fill(120)
  let pulled = 0
  const server = serve(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1
            if (pulled <= 20) controller.enqueue(chunk)
            else controller.close()
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  )
  try {
    const result = await probeResult(server.info)
    expect(result.service).toBeUndefined()
    expect(result.timedOut).toBe(false)
  } finally {
    server.stop()
  }
})

test("a body that stalls mid-delivery reports a timeout, not an unreadable body", async () => {
  const server = serve(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":"1.2.3","pid":4242'))
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  )
  try {
    const result = await probeResult(server.info, 200)
    expect(result.service).toBeUndefined()
    expect(result.timedOut).toBe(true)
  } finally {
    server.stop()
  }
})
