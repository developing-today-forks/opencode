import { expect, test } from "bun:test"
import { OpenCode } from "../src/promise/index"
import { OpenCode as GeneratedOpenCode } from "../src/promise/generated/index"

// Deadline tests for the generated promise transport (#1385): a real HTTP
// server on an ephemeral port, so a stall crosses the wire as in production.
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const info = { version: "2.0.0", pid: 1, urls: [], paths: { tmp: "/tmp" } }

test("a fast response is unaffected by a configured requestTimeout", async () => {
  const server = serve(() => Response.json(info))
  try {
    const client = OpenCode.make({ baseUrl: server.baseUrl, requestTimeout: 50 })
    expect(await client.server.info()).toEqual(info)
  } finally {
    server.stop()
  }
})

test("a server that never sends headers fails with a Transport error at the deadline, not a hang", async () => {
  const server = serve(async () => {
    await Bun.sleep(10_000)
    return Response.json(info)
  })
  try {
    const client = OpenCode.make({ baseUrl: server.baseUrl, requestTimeout: 50 })
    const started = Date.now()
    await expect(client.server.info()).rejects.toMatchObject({ reason: "Transport" })
    expect(Date.now() - started).toBeLessThan(5_000)
  } finally {
    server.stop()
  }
})

test("a slow-dripping body under the byte cap fails with a Transport error at the deadline", async () => {
  const server = serve(() => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":"2.0'))
      },
    })
    return new Response(stream, { headers: { "content-type": "application/json" } })
  })
  try {
    const client = OpenCode.make({ baseUrl: server.baseUrl, requestTimeout: 50 })
    await expect(client.server.info()).rejects.toMatchObject({ reason: "Transport" })
  } finally {
    server.stop()
  }
})

test("a caller-supplied signal still aborts independently of the deadline", async () => {
  const server = serve(async () => {
    await Bun.sleep(10_000)
    return Response.json(info)
  })
  try {
    const client = OpenCode.make({ baseUrl: server.baseUrl, requestTimeout: 60_000 })
    const controller = new AbortController()
    const pending = client.server.info({ signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ reason: "Transport" })
  } finally {
    server.stop()
  }
})

test("an SSE subscription carries no total deadline: events after the request deadline still arrive", async () => {
  const server = serve(() => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"1","created":0,"type":"server.connected","data":{}}\n\n'))
        await Bun.sleep(150)
        controller.enqueue(encoder.encode('data: {"id":"2","created":0,"type":"server.heartbeat","data":{}}\n\n'))
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  })
  try {
    const client = GeneratedOpenCode.make({ baseUrl: server.baseUrl, requestTimeout: 50 })
    const types: Array<string> = []
    for await (const event of client.event.subscribe()) {
      types.push(event.type)
      if (types.length === 2) break
    }
    expect(types).toEqual(["server.connected", "server.heartbeat"])
  } finally {
    server.stop()
  }
})
