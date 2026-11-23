import { describe, expect, test } from "bun:test"
import app from "../src/share"

// Oracle: the documented 16 KiB cap on POST /api/share (#2648), enforced by
// the shared bounded-body helper in src/body.ts. Bodies at or under the cap
// keep the pre-cap behavior byte-for-byte; bodies over it — declared up
// front or only discovered while streaming — are refused with 413 before
// parsing, so an oversized body that is not even valid JSON still answers
// 413 rather than a parse failure, and the route never runs.

const limit = 16 * 1024
const sessionID = "ses_1234567890abcdef"

// A valid share body of exactly `size` bytes: the session id plus an inert
// padding field the route ignores.
const bodyOfSize = (size: number) => {
  const pad = size - JSON.stringify({ sessionID, pad: "" }).length
  return JSON.stringify({ sessionID, pad: "x".repeat(pad) })
}

const post = (body: BodyInit, headers?: Record<string, string>) =>
  app.request("https://opncd.ai/api/share", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })

describe("share body limit", () => {
  test("an in-limit share request behaves as before", async () => {
    const res = await post(JSON.stringify({ sessionID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "90abcdef",
      secret: "discontinued",
      url: "https://opncd.ai/share/90abcdef",
    })
  })

  test("a body exactly at the cap is accepted", async () => {
    const body = bodyOfSize(limit)
    expect(body.length).toBe(limit)
    const res = await post(body, { "content-length": String(limit) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "90abcdef",
      secret: "discontinued",
      url: "https://opncd.ai/share/90abcdef",
    })
  })

  test("a declared content-length over the cap is refused with 413 before parsing", async () => {
    // Not valid JSON: a 413 (not a parse error) proves the refusal happened
    // before the body was consumed or parsed.
    const body = "x".repeat(limit + 1)
    const res = await post(body, { "content-length": String(body.length) })
    expect(res.status).toBe(413)
  })

  test("a chunked body is cut off at the cap and refused with 413", async () => {
    const chunk = new TextEncoder().encode("x".repeat(4096))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of Array(5).fill(chunk)) controller.enqueue(part)
        controller.close()
      },
    })
    const res = await app.request(
      new Request("https://opncd.ai/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      }),
    )
    expect(res.status).toBe(413)
  })
})
