import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { MessagingEmbedding } from "@opencode/core/messaging/embedding"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FetchHttpClient.layer)
const GIB = 1024 ** 3

describe("MessagingEmbedding.available", () => {
  const apple = (memory: number) => ({ platform: "darwin", arch: "arm64", memory, nvidia: false })

  it.effect("gates tiers on hardware", () =>
    Effect.sync(() => {
      const m3 = apple(36 * GIB)
      expect(MessagingEmbedding.available("tiny", m3)).toBe(true)
      expect(MessagingEmbedding.available("default", m3)).toBe(true)
      expect(MessagingEmbedding.available("step-up", m3)).toBe(true)
      expect(MessagingEmbedding.available("top", m3)).toBe(false)
      expect(MessagingEmbedding.available("top", apple(64 * GIB))).toBe(true)

      const laptop = { platform: "linux", arch: "x64", memory: 8 * GIB, nvidia: false }
      expect(MessagingEmbedding.available("default", laptop)).toBe(true)
      expect(MessagingEmbedding.available("step-up", laptop)).toBe(false)
      expect(MessagingEmbedding.available("step-up", { ...laptop, memory: 16 * GIB })).toBe(true)
      expect(MessagingEmbedding.available("top", { ...laptop, memory: 128 * GIB })).toBe(false)
      expect(MessagingEmbedding.available("top", { ...laptop, nvidia: true })).toBe(true)
      expect(MessagingEmbedding.available("step-up", { ...laptop, nvidia: true })).toBe(true)
    }),
  )
})

describe("MessagingEmbedding.resolve", () => {
  it.effect("defaults to the default tier", () =>
    Effect.sync(() => {
      const settings = MessagingEmbedding.resolve(undefined, {})
      expect(settings.local?.tier).toBe("default")
      expect(settings.local?.id).toBe("qwen3-embedding-0.6b-q8_0")
      expect(settings.local?.pooling).toBe("last")
      expect(settings.local?.query).toContain("Instruct:")
      expect(settings.local?.url).toBe(
        "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
      )
      expect(settings.autostart).toBe(true)
    }),
  )

  it.effect("resolves tier names, off, and unknown tiers", () =>
    Effect.sync(() => {
      const tiny = MessagingEmbedding.resolve("tiny", {}).local
      expect(tiny?.id).toBe("all-minilm-l6-v2-q8_0")
      expect(tiny?.pooling).toBe("mean")
      expect(tiny?.query).toBeUndefined()
      expect(MessagingEmbedding.resolve("off", {}).local).toBeUndefined()
      expect(MessagingEmbedding.resolve("huge", {}).error).toContain("huge")
      expect(MessagingEmbedding.resolve({ tier: "top", pooling: "cls" }, {}).local?.pooling).toBe("cls")
    }),
  )

  it.effect("derives pooling and query for custom models", () =>
    Effect.sync(() => {
      const qwen = MessagingEmbedding.resolve({ url: "https://example.com/x/Qwen3-Embedding-4B-Q4_K_M.gguf" }, {}).local
      expect(qwen?.tier).toBe("custom")
      expect(qwen?.id).toBe("qwen3-embedding-4b-q4_k_m")
      expect(qwen?.pooling).toBe("last")
      expect(qwen?.query).toContain("Instruct:")
      expect(qwen?.sha256).toBeUndefined()

      const other = MessagingEmbedding.resolve({ path: "/models/nomic.gguf", query: "search: " }, {}).local
      expect(other?.path).toBe("/models/nomic.gguf")
      expect(other?.url).toBeUndefined()
      expect(other?.pooling).toBe("mean")
      expect(other?.query).toBe("search: ")

      // A link that is not an absolute URL is reported, not thrown.
      expect(MessagingEmbedding.resolve({ url: "models/x.gguf" }, {}).error).toContain("Invalid embedding model URL")
      expect(MessagingEmbedding.resolve("default", { OPENCODE_EMBEDDING: "https://" }).error).toContain("Invalid")
    }),
  )

  it.effect("carries configured sha256 and size for custom models", () =>
    Effect.sync(() => {
      const local = MessagingEmbedding.resolve(
        { url: "https://example.com/x/model.gguf", sha256: "abc123", size: 123_456 },
        {},
      ).local
      expect(local?.tier).toBe("custom")
      expect(local?.sha256).toBe("abc123")
      expect(local?.size).toBe(123_456)
    }),
  )

  it.effect("does not carry configured integrity metadata to a different override url", () =>
    Effect.sync(() => {
      const config = { url: "https://example.com/a/model.gguf", sha256: "abc123", size: 123_456 }
      const different = MessagingEmbedding.resolve(config, {
        OPENCODE_EMBEDDING: "https://example.com/b/other.gguf",
      }).local
      expect(different?.url).toBe("https://example.com/b/other.gguf")
      expect(different?.sha256).toBeUndefined()
      expect(different?.size).toBeUndefined()
      const same = MessagingEmbedding.resolve(config, {
        OPENCODE_EMBEDDING: "https://example.com/a/model.gguf",
      }).local
      expect(same?.sha256).toBe("abc123")
      expect(same?.size).toBe(123_456)
    }),
  )

  it.effect("applies environment overrides", () =>
    Effect.sync(() => {
      expect(MessagingEmbedding.resolve("default", { OPENCODE_DISABLE_EMBEDDING: "1" }).local).toBeUndefined()
      expect(MessagingEmbedding.resolve("default", { OPENCODE_EMBEDDING: "tiny" }).local?.tier).toBe("tiny")
      expect(
        MessagingEmbedding.resolve({ path: "/a.gguf" }, { OPENCODE_EMBEDDING: "https://h/m/Model.gguf" }).local,
      ).toMatchObject({ url: "https://h/m/Model.gguf", path: undefined, id: "model" })
      expect(MessagingEmbedding.resolve("tiny", { OPENCODE_EMBEDDING: "/m/b.gguf" }).local?.path).toBe("/m/b.gguf")
      expect(
        MessagingEmbedding.resolve(
          { tier: "off", remote: { url: "https://api", model: "m", key: "{env:EMBED_KEY}" } },
          { EMBED_KEY: "secret" },
        ).remote?.key,
      ).toBe("secret")
    }),
  )
})

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// Serves `body` with Range support; `ranges: false` ignores Range like a server that always restarts.
function rangeServer(body: Uint8Array, options: { ranges: boolean }) {
  const seen: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const range = request.headers.get("range")
      seen.push(range)
      const match = range && options.ranges ? /bytes=(\d+)-/.exec(range) : null
      if (!match) return new Response(body)
      const start = Number(match[1])
      if (start >= body.byteLength)
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${body.byteLength}` } })
      return new Response(body.slice(start), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}` },
      })
    },
  })
  return { server, seen, url: `http://127.0.0.1:${server.port}/model.gguf` }
}

// Serves a tiny body under a declared content-length of `total`: download() must reject the
// declared length from the headers alone, so no multi-GiB body ever crosses the wire.
function declaredServer(total: number) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(total) })
    response.end(new Uint8Array(10))
  })
  return new Promise<{ server: typeof server; url: string }>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolvePromise({ server, url: `http://127.0.0.1:${port}/model.gguf` })
    })
  })
}

const declared = (total: number) =>
  Effect.acquireRelease(
    Effect.promise(() => declaredServer(total)),
    (fixture) =>
      Effect.sync(() => {
        fixture.server.closeAllConnections()
        fixture.server.close()
      }),
  )

const served = (body: Uint8Array, options: { ranges: boolean }) =>
  Effect.acquireRelease(
    Effect.sync(() => rangeServer(body, options)),
    (fixture) => Effect.promise(() => fixture.server.stop(true)),
  )

const payload = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 31) % 251)

const oversized = Uint8Array.from({ length: 500_000 }, (_, index) => (index * 31) % 251)

// Serves `body` as a stream of small chunks with no content-length, like a chunked response.
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

const chunked = (body: Uint8Array, chunk: number) =>
  Effect.acquireRelease(
    Effect.sync(() => chunkedServer(body, chunk)),
    (fixture) => Effect.promise(() => fixture.server.stop(true)),
  )

describe("MessagingEmbedding.download", () => {
  it.live("resumes a partial file with a Range request", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(payload, { ranges: true })
      const dest = path.join(dir, "models", "model.gguf")
      yield* Effect.promise(() => mkdir(path.dirname(dest), { recursive: true }))
      yield* Effect.promise(() => writeFile(`${dest}.part`, payload.slice(0, 50_000)))
      const updates: Array<[number, number | undefined]> = []
      yield* MessagingEmbedding.download({
        url: fixture.url,
        dest,
        sha256: sha(payload),
        onProgress: (received, total) => updates.push([received, total]),
      })
      expect(fixture.seen).toEqual(["bytes=50000-"])
      expect(new Uint8Array(yield* Effect.promise(() => readFile(dest)))).toEqual(payload)
      expect(updates[0]).toEqual([50_000, payload.byteLength])
      expect(updates.at(-1)).toEqual([payload.byteLength, payload.byteLength])
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
    }),
  )

  it.live("restarts from zero when the server ignores Range", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(payload, { ranges: false })
      const dest = path.join(dir, "model.gguf")
      yield* Effect.promise(() => writeFile(`${dest}.part`, new Uint8Array(70_000).fill(7)))
      yield* MessagingEmbedding.download({ url: fixture.url, dest, sha256: sha(payload) })
      expect(fixture.seen).toEqual(["bytes=70000-"])
      expect(new Uint8Array(yield* Effect.promise(() => readFile(dest)))).toEqual(payload)
    }),
  )

  it.live("treats 416 as an already complete part", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(payload, { ranges: true })
      const dest = path.join(dir, "model.gguf")
      yield* Effect.promise(() => writeFile(`${dest}.part`, payload))
      yield* MessagingEmbedding.download({ url: fixture.url, dest, sha256: sha(payload) })
      expect(new Uint8Array(yield* Effect.promise(() => readFile(dest)))).toEqual(payload)
    }),
  )

  it.live("deletes a corrupt part on digest mismatch so the next attempt restarts", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(payload, { ranges: true })
      const dest = path.join(dir, "model.gguf")
      yield* Effect.promise(() => writeFile(`${dest}.part`, new Uint8Array(40_000).fill(9)))
      const exit = yield* Effect.exit(MessagingEmbedding.download({ url: fixture.url, dest, sha256: sha(payload) }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("sha256 mismatch")
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)

      yield* MessagingEmbedding.download({ url: fixture.url, dest, sha256: sha(payload) })
      expect(fixture.seen).toEqual(["bytes=40000-", null])
      expect((yield* Effect.promise(() => stat(dest))).size).toBe(payload.byteLength)
    }),
  )

  it.live("fails fast when the declared length exceeds the known size", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(oversized, { ranges: false })
      const dest = path.join(dir, "model.gguf")
      const updates: Array<number> = []
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          sha256: sha(payload),
          size: payload.byteLength,
          onProgress: (received) => updates.push(received),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("larger than expected")
      // The pre-check fires before the body is read: no progress past the known size was ever reported.
      expect(Math.max(0, ...updates)).toBeLessThanOrEqual(payload.byteLength)
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )

  it.live("aborts a chunked body in flight once it passes the known size", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* chunked(oversized, 10_000)
      const dest = path.join(dir, "model.gguf")
      const updates: Array<number> = []
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          size: payload.byteLength,
          onProgress: (received) => updates.push(received),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("larger than expected")
      // In-flight bound: progress never passes the known size, so the download stopped
      // before the whole 500,000-byte body was consumed.
      expect(Math.max(0, ...updates)).toBeLessThanOrEqual(payload.byteLength)
      expect(Math.max(0, ...updates)).toBeLessThan(oversized.byteLength)
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )

  it.live("checks the expected size even when the digest matches", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(payload, { ranges: false })
      const dest = path.join(dir, "model.gguf")
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          sha256: sha(payload),
          size: payload.byteLength + 1,
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("size mismatch")
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )

  it.live("fails fast at the production default cap on a declared length (no sha256, no size, no limit seam)", () =>
    Effect.gen(function* () {
      // The cap is a named constant sized above the largest built-in tier.
      expect(MessagingEmbedding.MAX_UNKNOWN_SIZE_DOWNLOAD_BYTES).toBe(17_179_869_184)
      expect(MessagingEmbedding.MAX_UNKNOWN_SIZE_DOWNLOAD_BYTES).toBeGreaterThan(
        Math.max(...MessagingEmbedding.tiers.map((tier) => tier.size)),
      )
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* declared(MessagingEmbedding.MAX_UNKNOWN_SIZE_DOWNLOAD_BYTES + 1)
      const dest = path.join(dir, "model.gguf")
      const exit = yield* Effect.exit(MessagingEmbedding.download({ url: fixture.url, dest }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("larger than expected")
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )

  it.live("fails fast when the declared length exceeds the cap for the custom shape (no sha256, no size)", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* served(oversized, { ranges: false })
      const dest = path.join(dir, "model.gguf")
      const updates: Array<number> = []
      const exit = yield* Effect.exit(
        // The custom-URL call shape after resolve(): neither sha256 nor size is set. The limit seam
        // stands in for the 16 GiB production cap so the test body stays small.
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          limit: payload.byteLength,
          onProgress: (received) => updates.push(received),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("larger than expected")
      expect(Math.max(0, ...updates)).toBeLessThanOrEqual(payload.byteLength)
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )

  it.live("aborts a chunked body in flight once it passes the cap for the custom shape (no sha256, no size)", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* chunked(oversized, 10_000)
      const dest = path.join(dir, "model.gguf")
      const updates: Array<number> = []
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          limit: payload.byteLength,
          onProgress: (received) => updates.push(received),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("larger than expected")
      expect(Math.max(0, ...updates)).toBeLessThanOrEqual(payload.byteLength)
      expect(Math.max(0, ...updates)).toBeLessThan(oversized.byteLength)
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )

  it.live("accepts an under-cap chunked body whole for the custom shape (no sha256, no size)", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* chunked(payload, 10_000)
      const dest = path.join(dir, "model.gguf")
      // No limit seam either: the production 16 GiB cap applies and a small body is accepted at
      // its own length — no exact-size requirement is invented for the unknown-size shape.
      yield* MessagingEmbedding.download({ url: fixture.url, dest })
      expect(new Uint8Array(yield* Effect.promise(() => readFile(dest)))).toEqual(payload)
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
    }),
  )

  it.live("bounds the llama.cpp asset shape (sha256 plus recorded size) in flight", () =>
    Effect.gen(function* () {
      const dir = (yield* tmpdirScoped()).path
      const fixture = yield* chunked(oversized, 10_000)
      const dest = path.join(dir, "llama.tar.gz")
      const updates: Array<number> = []
      const exit = yield* Effect.exit(
        MessagingEmbedding.download({
          url: fixture.url,
          dest,
          // The installServer call shape after LLAMA_ASSETS gained exact sizes.
          sha256: sha(payload),
          size: payload.byteLength,
          onProgress: (received) => updates.push(received),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("larger than expected")
      expect(Math.max(0, ...updates)).toBeLessThanOrEqual(payload.byteLength)
      expect(yield* Effect.promise(() => Bun.file(`${dest}.part`).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(dest).exists())).toBe(false)
    }),
  )
})

const EmbeddingRequest = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.String),
  dimensions: Schema.optional(Schema.Number),
})

function fakeOpenAI() {
  const requests: Array<{ body: typeof EmbeddingRequest.Type; authorization: string | null; path: string }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = Schema.decodeUnknownSync(EmbeddingRequest)(await request.json())
      requests.push({ body, authorization: request.headers.get("authorization"), path: new URL(request.url).pathname })
      // Reverse order proves results are sorted by index.
      const data = body.input.map((text, index) => ({ index, embedding: [text.length, 0, 0] })).toReversed()
      return Response.json({ data })
    },
  })
  return { server, requests, url: `http://127.0.0.1:${server.port}/v1/` }
}

function fakeEndpoint(respond: () => Response) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text()
      return respond()
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/v1/` }
}

const service = Effect.fn("test.service")(function* () {
  const dir = (yield* tmpdirScoped()).path
  const context = yield* Layer.build(
    AppNodeBuilder.build(MessagingEmbedding.node, [
      Global.node.replace(Global.layerWith({ bin: path.join(dir, "bin"), cache: path.join(dir, "cache") })),
    ]),
  )
  return Context.get(context, MessagingEmbedding.Service)
})

describe("MessagingEmbedding.Service", () => {
  it.live("fails fast when nothing is usable", () =>
    Effect.gen(function* () {
      const embedding = yield* service()
      yield* embedding.configure("tiny")
      const status = yield* embedding.status()
      expect(status.state).toBe("pending")
      expect(status.tiers?.map((tier) => tier.name)).toEqual(["tiny", "default", "step-up", "top"])
      expect(status.tiers?.find((tier) => tier.name === "default")?.size).toBe("639 MB")
      expect(yield* embedding.model()).toBeUndefined()
      const error = yield* Effect.flip(embedding.embed(["hello"], "document"))
      expect(error).toBeInstanceOf(MessagingEmbedding.UnavailableError)
      expect(error.message).toContain("has not been started")

      yield* embedding.configure("off")
      expect((yield* embedding.status()).state).toBe("off")
    }),
  )

  it.live("keeps other settings when a tier or source is selected at runtime", () =>
    Effect.gen(function* () {
      const embedding = yield* service()
      yield* embedding.configure({ tier: "default", remote: { url: "http://127.0.0.1:9/v1", model: "text-small" } })
      // A start-only request selects nothing and must not reset the configured settings.
      yield* embedding.select({})
      expect(yield* embedding.status()).toMatchObject({ tier: "default", remote: true })
      yield* embedding.select({ tier: "tiny" })
      expect(yield* embedding.status()).toMatchObject({ tier: "tiny", remote: true })
      yield* embedding.select({ path: "/models/custom-embed.gguf" })
      expect(yield* embedding.status()).toMatchObject({ tier: "custom", remote: true })
      yield* embedding.select({ tier: "default" })
      expect(yield* embedding.status()).toMatchObject({ tier: "default", remote: true })
    }),
  )

  it.live("embeds through a remote OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.acquireRelease(Effect.sync(fakeOpenAI), (fixture) =>
        Effect.promise(() => fixture.server.stop(true)),
      )
      const embedding = yield* service()
      yield* embedding.configure({ tier: "default", remote: { url: fake.url, model: "text-small", key: "sk-test" } })
      expect(yield* embedding.model()).toEqual({ id: "remote:text-small", dimensions: undefined })
      expect(yield* embedding.ready).toEqual({ id: "remote:text-small", dimensions: undefined })
      const status = yield* embedding.status()
      expect(status.state).toBe("pending")
      expect(status.remote).toBe(true)

      const texts = Array.from({ length: 40 }, (_, index) => "x".repeat(index + 1))
      const result = yield* embedding.embed([...texts, ""], "query")
      expect(result.model).toBe("remote:text-small")
      expect(result.vectors).toHaveLength(41)
      expect(Array.from(result.vectors[0] ?? [])).toEqual([1, 0, 0])
      expect(fake.requests.map((request) => request.body.input.length)).toEqual([32, 9])
      expect(fake.requests[0]?.path).toBe("/v1/embeddings")
      expect(fake.requests[0]?.authorization).toBe("Bearer sk-test")
      expect(fake.requests[0]?.body.model).toBe("text-small")
      // No query instruction for remote models unless configured; empty input becomes a single space.
      expect(fake.requests[0]?.body.input[0]).toBe("x")
      expect(fake.requests[1]?.body.input.at(-1)).toBe(" ")
    }),
  )

  it.live("applies a configured query instruction and dimensions to remote models", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.acquireRelease(Effect.sync(fakeOpenAI), (fixture) =>
        Effect.promise(() => fixture.server.stop(true)),
      )
      const embedding = yield* service()
      yield* embedding.configure({
        tier: "off",
        query: "q: ",
        remote: { url: fake.url, model: "m", dimensions: 3 },
      })
      expect((yield* embedding.status()).state).toBe("off")
      yield* embedding.embed(["hello"], "query")
      yield* embedding.embed(["hello"], "document")
      expect(fake.requests.map((request) => request.body.input[0])).toEqual(["q: hello", "hello"])
      expect(fake.requests[0]?.body.dimensions).toBe(3)
      expect(fake.requests[0]?.authorization).toBeNull()
    }),
  )

  it.live("surfaces a small remote error body in the failure", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.acquireRelease(
        Effect.sync(() => fakeEndpoint(() => new Response("remote exploded: bad key", { status: 400 }))),
        (fixture) => Effect.promise(() => fixture.server.stop(true)),
      )
      const embedding = yield* service()
      yield* embedding.configure({ tier: "off", remote: { url: fake.url, model: "m" } })
      const error = yield* Effect.flip(embedding.embed(["hello"], "query"))
      expect(error).toBeInstanceOf(MessagingEmbedding.UnavailableError)
      expect(error.message).toContain("HTTP 400")
      expect(error.message).toContain("remote exploded: bad key")
    }),
  )

  it.live("degrades an oversized declared error body to the status-only error", () =>
    Effect.gen(function* () {
      const oversized = "e".repeat(MessagingEmbedding.embeddingErrorMaxResponseBytes + 4096)
      const fake = yield* Effect.acquireRelease(
        Effect.sync(() => fakeEndpoint(() => new Response(oversized, { status: 400 }))),
        (fixture) => Effect.promise(() => fixture.server.stop(true)),
      )
      const embedding = yield* service()
      yield* embedding.configure({ tier: "off", remote: { url: fake.url, model: "m" } })
      const error = yield* Effect.flip(embedding.embed(["hello"], "query"))
      expect(error).toBeInstanceOf(MessagingEmbedding.UnavailableError)
      expect(error.message).toContain("HTTP 400")
      // The whole body must not be buffered just to show 500 chars: no run of body text survives.
      expect(error.message).not.toContain("e".repeat(500))
    }),
  )

  it.live("degrades an oversized streamed error body to the status-only error", () =>
    Effect.gen(function* () {
      const total = MessagingEmbedding.embeddingErrorMaxResponseBytes + 16384
      const fake = yield* Effect.acquireRelease(
        Effect.sync(() =>
          fakeEndpoint(() => {
            let sent = 0
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent >= total) {
                  controller.close()
                  return
                }
                const chunk = new Uint8Array(1024).fill(101)
                sent += chunk.byteLength
                controller.enqueue(chunk)
              },
            })
            return new Response(stream, { status: 400, headers: { "content-type": "text/plain" } })
          }),
        ),
        (fixture) => Effect.promise(() => fixture.server.stop(true)),
      )
      const embedding = yield* service()
      yield* embedding.configure({ tier: "off", remote: { url: fake.url, model: "m" } })
      const error = yield* Effect.flip(embedding.embed(["hello"], "query"))
      expect(error).toBeInstanceOf(MessagingEmbedding.UnavailableError)
      expect(error.message).toContain("HTTP 400")
      expect(error.message).not.toContain("e".repeat(500))
    }),
  )

  it.live("fails cleanly on an oversized success body", () =>
    Effect.gen(function* () {
      // A syntactically valid embeddings payload larger than the success cap (~18 MiB of JSON floats).
      const huge = `{"data":[{"index":0,"embedding":[${"0,".repeat(9_000_000)}0]}]}`
      const fake = yield* Effect.acquireRelease(
        Effect.sync(
          () => fakeEndpoint(() => new Response(huge, { headers: { "content-type": "application/json" } })),
        ),
        (fixture) => Effect.promise(() => fixture.server.stop(true)),
      )
      const embedding = yield* service()
      yield* embedding.configure({ tier: "off", remote: { url: fake.url, model: "m" } })
      const error = yield* Effect.flip(embedding.embed(["hello"], "query"))
      expect(error).toBeInstanceOf(MessagingEmbedding.UnavailableError)
      expect(error.message).toContain(`embeddings response exceeded ${MessagingEmbedding.embeddingMaxResponseBytes} bytes`)
    }),
  )
})
