/**
 * Native in-process embeddings backend (#1554, step 2).
 *
 * The embeddings door's first backend is a local HTTP sidecar (the
 * python service in ~/local-embed, :18752). This module is the same
 * backend baked into the server process: the fork loads the model's
 * ONNX graph with onnxruntime-node and tokenizes with the
 * @huggingface/transformers JS tokenizer, so a call never leaves the
 * process. It registers additively behind `EMBEDDING_MODELS`
 * (backend kind "native-onnx"); the HTTP backend stays the default
 * until a registration is deliberately flipped (step 3).
 *
 * Sidecar semantics replicated exactly — parity is defined against
 * the sidecar, and the step-1 spike (branch spike/1554-native-embeddings)
 * proved each of these is load-bearing:
 *
 * - Tokenization: the model's tokenizer is a SentencePiece Unigram
 *   model (not BERT WordPiece); the transformers.js implementation
 *   reproduces the python `tokenizers` ids exactly. Inputs are
 *   encoded as-is — NO truncation. The shipped tokenizer.json carries
 *   a 512-token truncation setting the sidecar deliberately disables;
 *   `encode()` here does not apply it (verified: a 3000-token input
 *   encodes to 3002 ids, matching the sidecar's prompt_tokens).
 * - Batching/padding: one session run per call, rows padded to the
 *   batch's longest input with pad_id 1 and attention mask 0 (the
 *   tokenizer's shipped padding config). The int8 graph is
 *   padding-sensitive: pad_id 0 degrades batch cosine to ~0.97,
 *   pad_id 1 restores per-element bit-identity with the sidecar.
 * - Prompt tokens are the true per-input token counts (the unpadded
 *   ids lengths, equal to the sidecar's attention-mask sums).
 * - Context limit: an input over the model's context is rejected
 *   loudly, never silently truncated (the sidecar's rule).
 * - Pooling/normalization: the ONNX export's `sentence_embedding`
 *   output is already CLS-pooled and L2-normalized; nothing to apply.
 * - Matryoshka `dimensions`: truncate the native vector and
 *   renormalize, computed in float64 and rounded back to float32,
 *   matching the sidecar's truncate().
 *
 * Loading is lazy: this module's top level touches no native binding;
 * the tokenizer and inference session are created on the first embed
 * call for a given snapshot and then shared. Server boot pays nothing
 * (spike: import ~26 ms / +0 MB; first call ~1.2-1.5 s, +~380 MB RSS
 * with the 311 MB int8 model resident).
 *
 * Packaging note (step-2 finding, also on #1554): the native bindings
 * this module loads — onnxruntime-node's .node, and sharp's, which
 * @huggingface/transformers loads transitively — need libstdc++
 * (libstdc++.so.6) and zlib (libz.so.1) on the process loader path.
 * Bare dev shells on NixOS need LD_LIBRARY_PATH with the gcc-lib and
 * zlib store paths (the same paths ~/local-embed/run.sh carries);
 * the packaged server's nix closure must provide them.
 *
 * Node bundle (packages/cli/vite.node.config.ts, #1615): the native
 * bindings cannot be inlined there — onnxruntime-node's loader
 * dynamically requires its .node file, which the bundler cannot
 * resolve, and the throw lands at bundle initialisation. The Node
 * build therefore stubs onnxruntime-node (and sharp, which
 * @huggingface/transformers loads) out of the bundle: this backend
 * is unavailable under Node and any use throws a clear error there.
 * It stays available under the Bun build, which resolves the real
 * packages from node_modules.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { NativeOnnxEmbeddingBackend } from "./embeddings.js"

export interface NativeEmbedInput {
  readonly backend: NativeOnnxEmbeddingBackend
  readonly inputs: ReadonlyArray<string>
  readonly dimensions?: number
  /** The registration's native output dimension (the graph's output width). */
  readonly nativeDimensions: number
}

export interface NativeEmbedResult {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>
  /** Summed true token counts across the inputs. */
  readonly promptTokens: number
}

const DEFAULT_ONNX_FILE = "onnx/model_int8.onnx"

/** Resolves the snapshot directory for a native registration: the
 * registration's env override wins, then its literal snapshotDir
 * (`~/` expands against the process home). Loud when neither is set —
 * a native registration without a snapshot can only be a wiring bug. */
export const resolveSnapshotDir = (backend: NativeOnnxEmbeddingBackend): string => {
  const fromEnv = backend.snapshotEnv ? process.env[backend.snapshotEnv] : undefined
  const dir = fromEnv ?? backend.snapshotDir
  if (!dir)
    throw new Error(
      `native-onnx embeddings backend has no model snapshot directory (set ${backend.snapshotEnv ?? "snapshotDir"} on the registration)`,
    )
  return dir.startsWith("~/") ? path.join(homedir(), dir.slice(2)) : dir
}

interface LoadedModel {
  readonly encode: (text: string) => ReadonlyArray<number>
  readonly run: (ids: BigInt64Array, mask: BigInt64Array, batch: number, width: number) => Promise<Float32Array>
}

/** One lazy load per (snapshot, graph) pair, shared by every call. */
const loadedModels = new Map<string, Promise<LoadedModel>>()

const loadModel = (snapshotDir: string, onnxFile: string): Promise<LoadedModel> => {
  const key = `${snapshotDir}\n${onnxFile}`
  const existing = loadedModels.get(key)
  if (existing) return existing
  const pending = (async (): Promise<LoadedModel> => {
    const tokenizerPath = path.join(snapshotDir, "tokenizer.json")
    if (!existsSync(tokenizerPath))
      throw new Error(`native-onnx embeddings backend: no tokenizer.json in model snapshot ${snapshotDir}`)
    const graphPath = path.join(snapshotDir, onnxFile)
    if (!existsSync(graphPath)) throw new Error(`native-onnx embeddings backend: no ONNX graph at ${graphPath}`)
    const ort = await import("onnxruntime-node")
    const { AutoTokenizer } = await import("@huggingface/transformers")
    const tokenizer = await AutoTokenizer.from_pretrained(snapshotDir)
    const session = await ort.InferenceSession.create(graphPath)
    return {
      encode: (text) => tokenizer.encode(text),
      run: async (ids, mask, batch, width) => {
        const outputs = await session.run(
          {
            input_ids: new ort.Tensor("int64", ids, [batch, width]),
            attention_mask: new ort.Tensor("int64", mask, [batch, width]),
          },
          ["sentence_embedding"],
        )
        const tensor = outputs["sentence_embedding"]
        if (!tensor || !(tensor.data instanceof Float32Array))
          throw new Error(`native embeddings model at ${snapshotDir} produced no sentence_embedding output`)
        return tensor.data
      },
    }
  })()
  loadedModels.set(key, pending)
  return pending
}

/** Matryoshka truncation + renormalization, the sidecar's truncate():
 * float64 math, result rounded back to float32. A request for the
 * native dimension returns the graph's vector untouched. */
const truncateVector = (full: ReadonlyArray<number>, dimensions: number, nativeDimensions: number): number[] => {
  if (dimensions === nativeDimensions) return [...full]
  if (dimensions > nativeDimensions)
    throw new Error(`native embeddings backend cannot widen a ${nativeDimensions}-dimensional vector to ${dimensions}`)
  const sliced = new Float64Array(dimensions)
  for (let index = 0; index < dimensions; index++) sliced[index] = full[index] ?? 0
  let squares = 0
  for (const value of sliced) squares += value * value
  const norm = Math.sqrt(squares)
  return Array.from(sliced, (value) => Math.fround(norm > 0 ? value / norm : value))
}

export const embedNative = async (input: NativeEmbedInput): Promise<NativeEmbedResult> => {
  const snapshotDir = resolveSnapshotDir(input.backend)
  const model = await loadModel(snapshotDir, input.backend.onnxFile ?? DEFAULT_ONNX_FILE)

  const idsList = input.inputs.map((text) => model.encode(text))
  const counts = idsList.map((ids) => ids.length)
  const max = Math.max(...counts)
  if (max > input.backend.maxTokens)
    throw new Error(
      `input of ${max} tokens exceeds the model's ${input.backend.maxTokens}-token context; ` +
        "the native embeddings backend rejects instead of silently truncating",
    )

  // One run for the whole batch, padded to its longest input with
  // pad_id 1 / mask 0 (see the header: parity depends on it).
  const width = max
  const ids = new BigInt64Array(input.inputs.length * width).fill(1n)
  const mask = new BigInt64Array(input.inputs.length * width)
  idsList.forEach((row, rowIndex) =>
    row.forEach((id, columnIndex) => {
      ids[rowIndex * width + columnIndex] = BigInt(id)
      mask[rowIndex * width + columnIndex] = 1n
    }),
  )
  const data = await model.run(ids, mask, input.inputs.length, width)

  // The graph's output width is the registration's claim, and until now
  // nothing checked the tensor against it (#1583): slicing by
  // nativeDimensions with a wider graph hands each input the tail of
  // its neighbour's vector, and a narrower one is silently zero-padded
  // by truncateVector — while every returned vector still has the
  // registered length, so the caller's length check passes. Reject
  // loudly, like every other invariant in this module.
  const expected = input.inputs.length * input.nativeDimensions
  if (data.length !== expected)
    throw new Error(
      `native embeddings model at ${snapshotDir} produced ${data.length} sentence_embedding values for ` +
        `${input.inputs.length} input(s) (${input.inputs.length ? data.length / input.inputs.length : 0} per input); ` +
        `the registration declares ${input.nativeDimensions} per input (${expected} total) — ` +
        `the snapshot and the registration disagree`,
    )

  const dimensions = input.dimensions ?? input.nativeDimensions
  const vectors = idsList.map((_, rowIndex) => {
    const full = Array.from(data.subarray(rowIndex * input.nativeDimensions, (rowIndex + 1) * input.nativeDimensions))
    return truncateVector(full, dimensions, input.nativeDimensions)
  })
  return { vectors, promptTokens: counts.reduce((sum, count) => sum + count, 0) }
}
