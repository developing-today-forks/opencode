import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/http"
import { MessagingEmbedding } from "@opencode/core/messaging/embedding"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FetchHttpClient.layer)
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// Serves `body` whole (no Range support needed: fresh dest, no .part).
const served = (body: Uint8Array) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body) })
      return { server, url: `http://127.0.0.1:${server.port}/model.gguf` }
    }),
    (fixture) => Effect.promise(() => fixture.server.stop(true)),
  )

const expected = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 251)
const oversized = Uint8Array.from({ length: 5_000_000 }, (_, i) => (i * 31) % 251)

describe("probe: MessagingEmbedding.download in-flight size bound", () => {
  it.live("control: exact-size body with sha passes", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(expected)
      const dest = path.join(dir, "model.gguf")
      yield* MessagingEmbedding.download({ url: fixture.url, dest, sha256: sha(expected), size: expected.byteLength })
      expect((yield* Effect.promise(() => Bun.file(dest).exists()))).toBe(true)
    }),
  )

  it.live("oversized body vs declared size: how much is consumed before rejection?", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(oversized)
      const dest = path.join(dir, "model.gguf")
      const progress: number[] = []
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          size: expected.byteLength,
          onProgress: (received) => progress.push(received),
        }),
      )
      console.log("EXIT failure?", Exit.isFailure(exit), String(exit).slice(0, 200))
      console.log("MAX RECEIVED (declared size 100000):", Math.max(...progress))
      // Probe assertion documenting CURRENT behaviour: everything is written before any rejection.
      expect(Math.max(...progress)).toBe(oversized.byteLength)
    }),
  )

  it.live("oversized body vs sha-only (llama.cpp asset call shape): how much is consumed?", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(oversized)
      const dest = path.join(dir, "asset.tar.gz")
      const progress: number[] = []
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          sha256: sha(expected),
          onProgress: (received) => progress.push(received),
        }),
      )
      console.log("EXIT failure?", Exit.isFailure(exit), String(exit).slice(0, 200))
      console.log("MAX RECEIVED (sha-only, no size):", Math.max(...progress))
      expect(Math.max(...progress)).toBe(oversized.byteLength)
    }),
  )
})
