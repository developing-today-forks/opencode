import { describe, expect, test } from "bun:test"
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
    expect(first?.backend.kind).toBe("native-onnx")
    expect(embeddingModelEntries().map((entry) => entry.id)).toContain("local-embed/snowflake-arctic-embed-m-v2.0")
  }),
)

testEffect(Layer.empty).effect("every registration names a backend; the retired HTTP sidecar is gone", () =>
  Effect.sync(() => {
    for (const model of EMBEDDING_MODELS) expect(model.backend.kind).toBe("native-onnx")
    const registration = JSON.stringify(EMBEDDING_MODELS)
    expect(registration).not.toContain("18752")
    expect(registration).not.toContain("OPENCODE_LOCAL_EMBED_BASE_URL")
    expect(registration).not.toContain("baseURL")
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

// ---------------------------------------------------------- service (native-onnx only)

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

it.effect("fails loudly through the door when the model snapshot is missing", () =>
  withEnv({ LOCAL_EMBED_SNAPSHOT: "/nonexistent/local-embed-snapshot" }, () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Service
      const result = yield* Effect.result(embeddings.embed({ model: DEFAULT_EMBEDDING_MODEL, inputs: ["hi"] }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.service).toBe("local-embed")
    }),
  ),
)

describe("embeddings door is backend-agnostic", () => {
  test("a second registration resolves without any door change", () => {
    const other: EmbeddingModel = {
      ref: "other/future-embed",
      providerID: "other",
      modelID: "future-embed",
      dimensions: 1024,
      supportedDimensions: [1024],
      ownedBy: "other",
      backend: { kind: "native-onnx", maxTokens: 512 },
    }
    expect(other.dimensions).toBe(1024)
    expect(EMBEDDING_MODELS.every((entry) => entry.providerID !== "other")).toBe(true)
  })
})
