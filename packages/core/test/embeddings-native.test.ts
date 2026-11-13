import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { EMBEDDING_MODELS, Embeddings, type EmbeddingModel } from "@opencode/core/embeddings"
import { embedNative } from "@opencode/core/embeddings-native"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { testEffect } from "./lib/effect"

// ---------------------------------------------------------- native-only registration
//
// The native in-process backend (#1554) registers behind the same
// EMBEDDING_MODELS registry; step 3 flipped the shipped registration
// to it: the default backend is now native-onnx, with snapshot
// resolution via LOCAL_EMBED_SNAPSHOT / the HF cache default. Step 4
// (#1689) retired the HTTP sidecar, so native-onnx is the only kind.
test("the registered Snowflake model defaults to the native-onnx backend", () => {
  expect(EMBEDDING_MODELS[0]?.backend).toEqual({
    kind: "native-onnx",
    snapshotEnv: "LOCAL_EMBED_SNAPSHOT",
    snapshotDir:
      "~/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f",
    maxTokens: 8192,
  })
})

// ---------------------------------------------------------- native parity
//
// Reference vectors: test/fixtures/embeddings-native-parity.json,
// captured from the retired :18752 sidecar (the step-1 spike's vectors,
// re-verified bit-identical against it before baking in).
// The native backend must reproduce them in-process: bit-identical
// for the 768-d outputs (single and mixed-length batch), and within
// float rounding for the 256-d Matryoshka truncation.
//
// The suite needs the model artifact — an HF snapshot of
// Snowflake/snowflake-arctic-embed-m-v2.0 in the local cache (or
// OPENCODE_EMBED_TEST_SNAPSHOT / LOCAL_EMBED_SNAPSHOT pointing at
// one). CI has no model file, so without one the whole describe
// skips, following the repo's describe.skip pattern for missing
// local tools. Running it also needs libstdc++/libz on the loader
// path (see embeddings-native.ts); on the dev laptop:
//   LD_LIBRARY_PATH=<gcc-lib>/lib:<zlib>/lib bun test test/embeddings-native.test.ts

interface ParityFixture {
  readonly texts: ReadonlyArray<string>
  readonly tokenCounts: ReadonlyArray<number>
  readonly expectedSingle768: ReadonlyArray<ReadonlyArray<number>>
  readonly expectedBatch768: ReadonlyArray<ReadonlyArray<number>>
  readonly expectedBatch256: ReadonlyArray<ReadonlyArray<number>>
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dir, "fixtures", "embeddings-native-parity.json"), "utf8"),
) as ParityFixture

const discoverSnapshot = (): string | undefined => {
  const hub = path.join(
    homedir(),
    ".cache",
    "huggingface",
    "hub",
    "models--Snowflake--snowflake-arctic-embed-m-v2.0",
    "snapshots",
  )
  const candidates = [
    process.env.OPENCODE_EMBED_TEST_SNAPSHOT,
    process.env.LOCAL_EMBED_SNAPSHOT,
    ...(existsSync(hub) ? readdirSync(hub).map((entry) => path.join(hub, entry)) : []),
  ]
  return candidates.find(
    (dir) =>
      dir !== undefined &&
      existsSync(path.join(dir, "onnx", "model_int8.onnx")) &&
      existsSync(path.join(dir, "tokenizer.json")),
  )
}

const snapshotDir = discoverSnapshot()
const describeNative = snapshotDir ? describe : describe.skip

const nativeModel: EmbeddingModel = {
  ref: "local-embed/snowflake-arctic-embed-m-v2.0",
  providerID: "local-embed",
  modelID: "snowflake-arctic-embed-m-v2.0",
  dimensions: 768,
  supportedDimensions: [768, 256],
  ownedBy: "local-embed",
  backend: { kind: "native-onnx", snapshotDir, maxTokens: 8192 },
}

const it = testEffect(Embeddings.layer.pipe(Layer.provide(FetchHttpClient.layer)))
const NATIVE_TIMEOUT = { timeout: 120_000 }

const maxAbsDelta = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number =>
  left.reduce((max, value, index) => Math.max(max, Math.abs(value - (right[index] ?? Number.NaN))), 0)

describeNative("native in-process embeddings backend (#1554 step 2)", () => {
  it.effect(
    "single text is bit-identical to the sidecar reference",
    () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings.Service
        const result = yield* embeddings.embed({ model: nativeModel, inputs: [fixture.texts[0]!] })
        expect(result.vectors).toHaveLength(1)
        expect(result.vectors[0]).toEqual(fixture.expectedSingle768[0])
        expect(result.promptTokens).toBe(fixture.tokenCounts[0])
      }),
    NATIVE_TIMEOUT,
  )

  it.effect(
    "mixed-length batch is bit-identical per element, tokens counted from the masks",
    () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings.Service
        const result = yield* embeddings.embed({ model: nativeModel, inputs: fixture.texts })
        expect(result.vectors).toHaveLength(fixture.texts.length)
        result.vectors.forEach((vector, index) => expect(vector).toEqual(fixture.expectedBatch768[index]))
        expect(result.promptTokens).toBe(fixture.tokenCounts.reduce((sum, count) => sum + count, 0))
      }),
    NATIVE_TIMEOUT,
  )

  it.effect(
    "dimensions=256 Matryoshka matches the sidecar within float rounding",
    () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings.Service
        const result = yield* embeddings.embed({ model: nativeModel, inputs: fixture.texts, dimensions: 256 })
        expect(result.vectors).toHaveLength(fixture.texts.length)
        result.vectors.forEach((vector, index) => {
          expect(vector).toHaveLength(256)
          expect(maxAbsDelta(vector, fixture.expectedBatch256[index]!)).toBeLessThanOrEqual(1e-6)
        })
      }),
    NATIVE_TIMEOUT,
  )

  it.effect(
    "rejects an input over the 8192-token context loudly instead of truncating",
    () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings.Service
        const result = yield* Effect.result(embeddings.embed({ model: nativeModel, inputs: ["word ".repeat(9000)] }))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain("exceeds the model's 8192-token context")
          expect(result.failure.message).toContain("rejects instead of silently truncating")
        }
      }),
    NATIVE_TIMEOUT,
  )
})

// ---------------------------------------------------------- load-failure eviction (#1567)
//
// Model-free: a failed first load (here: an empty snapshot dir) must not
// be cached forever. After the snapshot is fixed, a retry must re-attempt
// the load and fail at the NEXT missing piece — never replay the stale
// first error.
describe("native load failure eviction (#1567)", () => {
  test("a failed first load is evicted: fixing the snapshot lets a retry advance", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "embeddings-native-load-"))
    const backend = { kind: "native-onnx", snapshotDir: dir, maxTokens: 8192 } as const

    await expect(embedNative({ backend, inputs: ["hello"], nativeDimensions: 768 })).rejects.toThrow(
      "no tokenizer.json",
    )

    writeFileSync(path.join(dir, "tokenizer.json"), "{}")

    await expect(embedNative({ backend, inputs: ["hello"], nativeDimensions: 768 })).rejects.toThrow(
      "no ONNX graph",
    )
  })
})
