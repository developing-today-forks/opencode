import { afterAll, describe, expect, test } from "bun:test"
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_MODELS,
  Embeddings,
  embeddingModelEntries,
  embeddingsBody,
  parseEmbeddingsRequest,
  resolveEmbeddingModel,
  type EmbeddingModel,
} from "@opencode/core/embeddings"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { testEffect } from "./lib/effect"
import { withEnv } from "./fixture/env"

// ---------------------------------------------------------- registry + translation

const parsed = (body: unknown) => {
  const result = parseEmbeddingsRequest(body)
  if (!result.ok) throw new Error(`expected parse success, got: ${result.error}`)
  return result.value
}

testEffect(Layer.empty).effect("the first registered embedding model is the local Snowflake backend", () =>
  Effect.sync(() => {
    const first = EMBEDDING_MODELS[0]
    expect(first?.providerID).toBe("local-embed")
    expect(first?.modelID).toBe("snowflake-arctic-embed-m-v2.0")
    expect(first?.dimensions).toBe(768)
    expect(first?.baseURL).toBe("http://127.0.0.1:18752/v1")
    expect(embeddingModelEntries().map((entry) => entry.id)).toContain("local-embed/snowflake-arctic-embed-m-v2.0")
  }),
)

testEffect(Layer.empty).effect("resolves a full catalog ref, a bare model id, and the default", () =>
  Effect.sync(() => {
    expect(parsed({ model: "local-embed/snowflake-arctic-embed-m-v2.0", input: "hi" }).model.ref).toBe(
      "local-embed/snowflake-arctic-embed-m-v2.0",
    )
    const bare = parsed({ model: "snowflake-arctic-embed-m-v2.0", input: "hi" })
    expect(bare.model.providerID).toBe("local-embed")
    expect(bare.modelLabel).toBe("snowflake-arctic-embed-m-v2.0")
    expect(parsed({ input: "hi" }).model.ref).toBe("local-embed/snowflake-arctic-embed-m-v2.0")
    const resolved = resolveEmbeddingModel("local-embed/snowflake-arctic-embed-m-v2.0")
    expect(typeof resolved).not.toBe("string")
  }),
)

testEffect(Layer.empty).effect("rejects unregistered models loudly, listing what is registered", () =>
  Effect.sync(() => {
    const result = parseEmbeddingsRequest({ model: "openai/text-embedding-3-small", input: "hi" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("not a registered embedding model")
      expect(result.error).toContain("local-embed/snowflake-arctic-embed-m-v2.0")
    }
    expect(parseEmbeddingsRequest({ model: "workhorse", input: "hi" }).ok).toBe(false)
  }),
)

testEffect(Layer.empty).effect("passes varied-length input arrays through faithfully, with no truncation", () =>
  Effect.sync(() => {
    const long = "word ".repeat(5000)
    const value = parsed({
      model: "snowflake-arctic-embed-m-v2.0",
      input: ["a", "a much longer piece of text", long, ""],
    })
    expect(value.inputs).toEqual(["a", "a much longer piece of text", long, ""])
    expect(parsed({ input: "single" }).inputs).toEqual(["single"])
  }),
)

testEffect(Layer.empty).effect("rejects malformed input shapes loudly", () =>
  Effect.sync(() => {
    expect(parseEmbeddingsRequest({ input: [] }).ok).toBe(false)
    expect(parseEmbeddingsRequest({ input: [[1, 2, 3]] }).ok).toBe(false)
    expect(parseEmbeddingsRequest({ input: [42] }).ok).toBe(false)
    expect(parseEmbeddingsRequest({}).ok).toBe(false)
    expect(parseEmbeddingsRequest("nope").ok).toBe(false)
    expect(parseEmbeddingsRequest({ input: "hi", encoding_format: "binary" }).ok).toBe(false)
  }),
)

testEffect(Layer.empty).effect("dimensions is honored only where the registration supports it", () =>
  Effect.sync(() => {
    expect(parsed({ input: "hi", dimensions: 256 }).dimensions).toBe(256)
    expect(parsed({ input: "hi", dimensions: 768 }).dimensions).toBe(768)
    const rejected = parseEmbeddingsRequest({ input: "hi", dimensions: 512 })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error).toContain("dimensions 512 is not supported")
      expect(rejected.error).toContain("768")
    }
    expect(parseEmbeddingsRequest({ input: "hi", dimensions: 12.5 }).ok).toBe(false)
  }),
)

testEffect(Layer.empty).effect("renders the OpenAI embeddings shape in float and base64", () =>
  Effect.sync(() => {
    const body = embeddingsBody({
      model: "m",
      vectors: [
        [1, 0.5],
        [0, 1],
      ],
      promptTokens: 9,
      encodingFormat: "float",
    })
    expect(body.object).toBe("list")
    expect(body.model).toBe("m")
    expect(body.data[0]).toEqual({ object: "embedding", index: 0, embedding: [1, 0.5] })
    expect(body.data[1]?.index).toBe(1)
    expect(body.usage).toEqual({ prompt_tokens: 9, total_tokens: 9 })

    const encoded = embeddingsBody({ model: "m", vectors: [[1, 0.5]], promptTokens: 3, encodingFormat: "base64" })
    const embedding = encoded.data[0]?.embedding
    if (typeof embedding !== "string") throw new Error("expected a base64 string embedding")
    const floats = new Float32Array(Buffer.from(embedding, "base64").buffer)
    expect([...floats]).toEqual([1, 0.5])
  }),
)

// ---------------------------------------------------------- service against a stub backend

const stubModel: EmbeddingModel = {
  ref: "stub/test-embed",
  providerID: "stub",
  modelID: "test-embed",
  dimensions: 4,
  supportedDimensions: [4, 2],
  baseURL: "http://127.0.0.1:1/v1", // replaced below once the stub server has a port
  ownedBy: "stub",
}

const seen: Array<Record<string, unknown>> = []
let stubDimension = 4
let stubIndices: number[] | undefined
let stubOmitLast = false
const stub = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as Record<string, unknown>
    seen.push(body)
    const inputs = body.input as string[]
    const dimensions = typeof body.dimensions === "number" ? body.dimensions : stubDimension
    let data = inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dimensions }, (_, axis) => (axis === 0 ? text.length : index)),
    }))
    const indices = stubIndices
    if (indices) data = data.map((entry, position) => ({ ...entry, index: indices[position] ?? entry.index }))
    if (stubOmitLast) data = data.slice(0, -1)
    return Response.json({
      object: "list",
      data,
      usage: { prompt_tokens: 11, total_tokens: 11 },
    })
  },
})
afterAll(() => stub.stop(true))
const model: EmbeddingModel = { ...stubModel, baseURL: `http://127.0.0.1:${stub.port}/v1` }

const attempts: ModelRouteLog.Attempt[] = []
ModelRouteLog.setSink((event) => {
  if (event.kind === "attempt") attempts.push(event.row)
})

const it = testEffect(Embeddings.layer.pipe(Layer.provide(FetchHttpClient.layer)))

it.effect("rejects native-onnx embeddings at the surface in the Node bundle", () =>
  withEnv({ OPENCODE_NODE_BUNDLE: "1" }, () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Service
      const result = yield* Effect.result(embeddings.embed({ model: DEFAULT_EMBEDDING_MODEL, inputs: ["hello"] }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toBe(
          "native-onnx embeddings are unsupported in the Node bundle; use the Bun build for native embeddings",
        )
      }
    }),
  ),
)

it.effect("embeds through the door against a stub backend and records a route_attempt row", () =>
  Effect.gen(function* () {
    const embeddings = yield* Embeddings.Service
    const result = yield* embeddings.embed({ model, inputs: ["a", "varied length input", "x"] })
    expect(result.vectors).toHaveLength(3)
    expect(result.vectors[0]).toEqual([1, 0, 0, 0])
    expect(result.vectors[1]?.[0]).toBe("varied length input".length)
    expect(result.promptTokens).toBe(11)
    expect(seen.at(-1)).toMatchObject({ model: "test-embed", input: ["a", "varied length input", "x"] })

    const attempt = attempts.find((row) => row.provider_id === "stub")
    expect(attempt?.model_id).toBe("test-embed")
    expect(attempt?.outcome).toBe("success")
    expect(attempt?.session_id).toBeUndefined()
    expect(attempt?.tokens_input).toBe(11)
    expect(attempt?.tokens_output).toBe(0)
  }),
)

it.effect("passes a supported dimensions request to the backend and accepts its shorter vectors", () =>
  Effect.gen(function* () {
    const embeddings = yield* Embeddings.Service
    const result = yield* embeddings.embed({ model, inputs: ["hi"], dimensions: 2 })
    expect(result.vectors[0]).toHaveLength(2)
    expect(seen.at(-1)).toMatchObject({ dimensions: 2 })
  }),
)

it.effect("fails loudly when the backend returns a duplicated index", () =>
  Effect.gen(function* () {
    stubIndices = [0, 0, 1]
    const embeddings = yield* Embeddings.Service
    const result = yield* Effect.result(embeddings.embed({ model, inputs: ["a", "bb", "ccc"] }))
    stubIndices = undefined
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toContain("invalid index set")
  }),
)

it.effect("fails loudly when the backend returns an out-of-range index", () =>
  Effect.gen(function* () {
    stubIndices = [0, 1, 99]
    const embeddings = yield* Embeddings.Service
    const result = yield* Effect.result(embeddings.embed({ model, inputs: ["a", "bb", "ccc"] }))
    stubIndices = undefined
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toContain("invalid index set")
  }),
)

it.effect("fails loudly when the backend returns fewer embeddings than inputs", () =>
  Effect.gen(function* () {
    stubOmitLast = true
    const embeddings = yield* Embeddings.Service
    const result = yield* Effect.result(embeddings.embed({ model, inputs: ["a", "bb"] }))
    stubOmitLast = false
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toContain("expected 2 embeddings")
  }),
)

it.effect("fails loudly when the backend returns the wrong dimension", () =>
  Effect.gen(function* () {
    stubDimension = 3
    const embeddings = yield* Embeddings.Service
    const result = yield* Effect.result(embeddings.embed({ model, inputs: ["hi"] }))
    stubDimension = 4
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toContain("3-dimensional")
    const attempt = attempts.filter((row) => row.provider_id === "stub").at(-1)
    expect(attempt?.outcome).toBe("failure")
  }),
)

describe("embeddings door is backend-agnostic", () => {
  test("a second registration resolves without any door change", () => {
    const other: EmbeddingModel = {
      ref: "other/future-embed",
      providerID: "other",
      modelID: "future-embed",
      dimensions: 1024,
      supportedDimensions: [1024],
      baseURL: "http://127.0.0.1:9/v1",
      ownedBy: "other",
    }
    expect(other.dimensions).toBe(1024)
    expect(EMBEDDING_MODELS.every((entry) => entry.providerID !== "other")).toBe(true)
  })
})
