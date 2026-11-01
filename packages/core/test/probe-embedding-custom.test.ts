import { describe, expect } from "bun:test"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/http"
import { MessagingEmbedding } from "@opencode/core/messaging/embedding"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FetchHttpClient.layer)

// Chunked server (no content-length) serving `body` in 10k chunks.
function chunkedServer(body: Uint8Array, chunk: number) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      let offset = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= body.byteLength) {
            controller.close()
            return
          }
          const next = body.slice(offset, offset + chunk)
          offset += next.byteLength
          controller.enqueue(next)
        },
      })
      return new Response(stream)
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/model.gguf` }
}

// Endless chunked server: never closes the stream.
function endlessServer(chunk: number) {
  const fill = new Uint8Array(chunk).fill(7)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(fill)
        },
      })
      return new Response(stream)
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/model.gguf` }
}

describe("probe: custom-shape download (no sha256, no size)", () => {
  it.live("resolve() custom URL local has neither sha256 nor size", () =>
    Effect.sync(() => {
      const local = MessagingEmbedding.resolve({ url: "https://example.com/x/model.gguf" }, {}).local
      console.log("PROBE custom local:", JSON.stringify({ tier: local?.tier, sha256: local?.sha256, size: local?.size }))
      expect(local?.tier).toBe("custom")
      expect(local?.sha256).toBeUndefined()
      expect(local?.size).toBeUndefined()
    }),
  )

  it.live("a 5,000,000-byte chunked body is accepted whole with no sha/size", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const body = Uint8Array.from({ length: 5_000_000 }, (_, i) => (i * 31) % 251)
      const fixture = chunkedServer(body, 10_000)
      const dest = path.join(dir, "model.gguf")
      const updates: Array<number> = []
      try {
        // Exactly the ensureModel call shape for a custom URL: sha256/size undefined.
        yield* MessagingEmbedding.download({
          url: fixture.url,
          dest,
          sha256: undefined,
          size: undefined,
          onProgress: (received) => updates.push(received),
        })
      } finally {
        fixture.server.stop(true)
      }
      const size = (yield* Effect.promise(() => stat(dest))).size
      console.log("PROBE accepted dest bytes:", size, "max progress:", Math.max(0, ...updates))
      expect(size).toBe(5_000_000)
    }),
  )

  it.live("an endless chunked body never self-terminates; .part grows until externally timed out", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = endlessServer(65_536)
      const dest = path.join(dir, "model.gguf")
      yield* Effect.promise(() => mkdir(path.dirname(dest), { recursive: true }))
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({ url: fixture.url, dest, sha256: undefined, size: undefined }).pipe(
          Effect.timeout("3 seconds"),
        ),
      )
      fixture.server.stop(true)
      const partSize = yield* Effect.promise(() =>
        stat(`${dest}.part`).then(
          (info) => info.size,
          () => -1,
        ),
      )
      console.log("PROBE endless exit:", exit._tag, "part bytes after 3s timeout:", partSize)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(partSize).toBeGreaterThan(1_000_000)
    }),
  )
})
