import { describe, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { HttpClientResponse } from "effect/http"
import {
  collectBoundedResponseBody,
  decodeBoundedResponseJson,
  readBoundedResponseText,
  readBoundedResponseTextEffect,
} from "@opencode/core/tool/http-body"

const tooLarge = () => new Error("response body too large")

// collectBoundedResponseBody only reads `headers` and `stream` from the
// response, so a minimal fake with a deterministic chunk sequence pins
// chunk-boundary behaviour (growth, zero-length chunks) that a web
// Response stream does not guarantee.
const fakeResponse = (
  chunks: Array<Uint8Array>,
  headers: Record<string, string> = {},
  onStream: () => void = () => undefined,
  onChunk: () => void = () => undefined,
) =>
  ({
    headers,
    stream: Stream.unwrap(
      Effect.sync(() => {
        onStream()
        return Stream.fromIterable(chunks).pipe(Stream.tap(() => Effect.sync(onChunk)))
      }),
    ),
  }) as unknown as HttpClientResponse.HttpClientResponse

const collect = (response: HttpClientResponse.HttpClientResponse, maximumBytes: number) =>
  Effect.runPromise(collectBoundedResponseBody(response, maximumBytes, tooLarge))

describe("collectBoundedResponseBody (#1068)", () => {
  test("returns a normal multi-chunk body", async () => {
    const body = await collect(
      fakeResponse([new TextEncoder().encode("hello "), new TextEncoder().encode("world")]),
      1024,
    )
    expect(new TextDecoder().decode(body)).toBe("hello world")
  })

  test("grows past the initial 64 KiB allocation for a multi-chunk body", async () => {
    // No declared length, so the initial allocation is 64 KiB; three
    // 32 KiB chunks cross it and force the doubling growth path.
    const chunk = new Uint8Array(32 * 1024).fill(97)
    const body = await collect(fakeResponse([chunk, chunk, chunk]), 128 * 1024)
    expect(body.byteLength).toBe(96 * 1024)
    expect(body.every((byte) => byte === 97)).toBe(true)
  })

  test("rejects a declared oversized body before consuming the stream", async () => {
    let streamed = false
    const response = fakeResponse([new TextEncoder().encode("small body")], { "content-length": "1025" }, () => {
      streamed = true
    })
    await expect(collect(response, 1024)).rejects.toThrow("response body too large")
    expect(streamed).toBe(false)
  })

  test("rejects a streamed oversized body in flight", async () => {
    const chunk = new Uint8Array(512)
    const chunks = [chunk, chunk, chunk, chunk]
    let pulled = 0
    await expect(
      collect(
        fakeResponse(chunks, {}, undefined, () => pulled++),
        1024,
      ),
    ).rejects.toThrow("response body too large")
    expect(pulled).toBeLessThan(chunks.length)
  })

  test("skips zero-length chunks", async () => {
    const body = await collect(
      fakeResponse([new Uint8Array(0), new TextEncoder().encode("data"), new Uint8Array(0)]),
      1024,
    )
    expect(new TextDecoder().decode(body)).toBe("data")
  })

  test("accepts a body exactly at the cap", async () => {
    const body = await collect(fakeResponse([new Uint8Array(1024).fill(98)]), 1024)
    expect(body.byteLength).toBe(1024)
  })
})

describe("readBoundedResponseText (#1068)", () => {
  const max = 1024

  test("returns a normal body", async () => {
    const text = await readBoundedResponseText(new Response("hello world"), max, tooLarge)
    expect(text).toBe("hello world")
  })

  test("rejects a declared oversized body before reading it", async () => {
    let bodyRead = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("small body"))
        },
        pull(controller) {
          bodyRead = true
          controller.close()
        },
      }),
      { headers: { "content-length": String(max + 1) } },
    )
    await expect(readBoundedResponseText(response, max, tooLarge)).rejects.toThrow("response body too large")
    expect(bodyRead).toBe(false)
  })

  test("rejects a streamed oversized body in flight", async () => {
    const chunkBytes = max / 2
    const totalChunks = 8
    let pulled = 0
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (pulled === totalChunks) return controller.close()
          pulled++
          controller.enqueue(new Uint8Array(chunkBytes))
        },
      }),
    )
    await expect(readBoundedResponseText(response, max, tooLarge)).rejects.toThrow("response body too large")
    expect(pulled).toBeLessThan(totalChunks)
  })

  test("accepts a body exactly at the cap", async () => {
    const text = await readBoundedResponseText(new Response("a".repeat(max)), max, tooLarge)
    expect(text).toBe("a".repeat(max))
  })

  test("rejects an oversized body when the response has no readable stream", async () => {
    // "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit, so its length stays under the cap
    // while its byte length exceeds it — this also pins the byte-count (not text.length) check.
    const big = "é".repeat(max / 2 + 1)
    const response = Object.assign(new Response(null), { text: async () => big })
    expect(response.body).toBeNull()
    expect(big.length).toBeLessThan(max)
    await expect(readBoundedResponseText(response, max, tooLarge)).rejects.toThrow("response body too large")
  })
})

describe("readBoundedResponseTextEffect / decodeBoundedResponseJson (#1029)", () => {
  const text = (response: HttpClientResponse.HttpClientResponse, max = 64) =>
    Effect.runPromise(readBoundedResponseTextEffect(response, max, tooLarge))
  const decode = <A, I>(schema: Schema.Codec<A, I>) =>
    decodeBoundedResponseJson(schema)(
      fakeResponse([new TextEncoder().encode(JSON.stringify({ a: "x" }))]),
      64,
      tooLarge,
    )

  test("reads a small text body", async () => {
    expect(await text(fakeResponse([new TextEncoder().encode("nope")]))).toBe("nope")
  })

  test("fails instead of buffering a body over the cap", async () => {
    await expect(text(fakeResponse([new Uint8Array(128).fill(97)]), 64)).rejects.toThrow("response body too large")
  })

  test("decodes JSON under the cap", async () => {
    const decoded = await Effect.runPromise(decode(Schema.Struct({ a: Schema.String })))
    expect(decoded).toEqual({ a: "x" })
  })

  test("fails on invalid JSON", async () => {
    const response = fakeResponse([new TextEncoder().encode("not json")])
    await expect(
      Effect.runPromise(decodeBoundedResponseJson(Schema.Struct({ a: Schema.String }))(response, 64, tooLarge)),
    ).rejects.toThrow()
  })
})
