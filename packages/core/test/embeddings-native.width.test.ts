import { describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { embedNative } from "../src/embeddings-native"
import type { NativeOnnxEmbeddingBackend } from "../src/embeddings"

// ---------------------------------------------------------- output width (#1583)
//
// The parity suite in embeddings-native.test.ts needs the real model
// artifact; the output-width check does not. This file mocks the two
// native modules loadModel dynamically imports (onnxruntime-node and
// @huggingface/transformers) and points embedNative at a fake snapshot
// dir — tokenizer.json and the graph file present, contents unused.
// It lives in its own file, named to sort after
// embeddings-native.test.ts: bun test shares one module registry
// across files, so these module mocks are visible to later files in
// the same run — the only other files that touch these modules are
// the parity suite (which the official runner, script/test.ts, skips
// via its sandboxed HOME, and which single-file runs never combine
// with this one) and embeddings.test.ts, which never loads the
// native backend. Each test uses its own snapshot dir because
// loadedModels caches per (snapshot, graph) pair.

let fakeGraphData: Float32Array = new Float32Array(0)

void mock.module("onnxruntime-node", () => ({
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: ReadonlyArray<number>,
    ) {}
  },
  InferenceSession: {
    create: async () => ({
      run: async () => ({ sentence_embedding: { data: fakeGraphData } }),
    }),
  },
}))

void mock.module("@huggingface/transformers", () => ({
  AutoTokenizer: {
    // Two token ids per input, whatever the text — enough to drive
    // embedNative's batching without a real tokenizer.
    from_pretrained: async () => ({ encode: (_text: string) => [101, 102] }),
  },
}))

const fakeSnapshot = async (data: Float32Array): Promise<string> => {
  fakeGraphData = data
  const dir = await mkdtemp(path.join(tmpdir(), "embeddings-native-width-"))
  await writeFile(path.join(dir, "tokenizer.json"), "{}")
  await mkdir(path.join(dir, "onnx"))
  await writeFile(path.join(dir, "onnx", "model_int8.onnx"), "")
  return dir
}

const fakeBackend = (snapshotDir: string): NativeOnnxEmbeddingBackend => ({
  kind: "native-onnx",
  snapshotDir,
  maxTokens: 8192,
})

describe("native embeddings output width (#1583)", () => {
  test("rejects a graph wider than the registration instead of misassigning rows", async () => {
    // The graph emits 8-wide vectors; the registration claims 4. Before
    // the check, input "bb" silently received the tail of "a"'s vector.
    const dir = await fakeSnapshot(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))
    try {
      await expect(
        embedNative({ backend: fakeBackend(dir), inputs: ["a", "bb"], nativeDimensions: 4 }),
      ).rejects.toThrow(
        "produced 16 sentence_embedding values for 2 input(s) (8 per input); " +
          "the registration declares 4 per input (8 total)",
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a graph narrower than the registration instead of fabricating rows", async () => {
    // The graph emits 2-wide vectors; the registration claims 4. Before
    // the check, row 0 concatenated two inputs and row 1 came back
    // empty, with truncateVector zero-padding on Matryoshka requests.
    const dir = await fakeSnapshot(new Float32Array([0.5, 0.5, 0.5, 0.5]))
    try {
      await expect(
        embedNative({ backend: fakeBackend(dir), inputs: ["a", "bb"], nativeDimensions: 4 }),
      ).rejects.toThrow(
        "produced 4 sentence_embedding values for 2 input(s) (2 per input); " +
          "the registration declares 4 per input (8 total)",
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("correct-width output returns per-row vectors unchanged", async () => {
    const dir = await fakeSnapshot(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]))
    try {
      const result = await embedNative({ backend: fakeBackend(dir), inputs: ["a", "bb"], nativeDimensions: 4 })
      expect(result.vectors).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ])
      expect(result.promptTokens).toBe(4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
