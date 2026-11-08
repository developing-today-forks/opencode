export * as Embeddings from "./embeddings.js"

/**
 * OpenAI embeddings wire translation + backend service for the
 * embeddings door (#1146, wave A1). The door is a general embeddings
 * mechanism, not a one-off for the first backend: embedding models
 * register in `EMBEDDING_MODELS` like chat models register in the
 * catalog, each with its own provider, model id, output dimension and
 * supported `dimensions` values. The translation layer below carries
 * no backend-specific branching — Snowflake Arctic Embed specifics
 * (provider id, model id, 768 dimensions, the model snapshot) live
 * only in its registration. A future embedding model plugs in by
 * adding a registration; its dimension comes from the registration,
 * never from an assumption in this layer.
 *
 * A registration also names its backend kind. The native-onnx kind
 * (#1554) runs the model's ONNX graph in this process (see
 * embeddings-native.ts); the old HTTP sidecar backend was retired in
 * step 4 (#1689), so native-onnx is the only kind. The Node bundle
 * explicitly does not support native-onnx; the Bun build is the
 * supported route.
 *
 * The service validates vector dimensions so a misbehaving backend
 * fails loudly instead of returning wrong-shaped vectors.
 *
 * Varied lengths: the door passes the caller's input array through
 * faithfully — no truncation, padding or chunking at this layer.
 * Padding/batching is the backend's job; if a backend truncates long
 * inputs, that is the backend's documented behavior, not a silent
 * behavior of this door.
 *
 * Accounting: every call records a route_attempt row through the same
 * ModelRouteLog observer the generation paths use, with session_id
 * NULL (the door convention), route_id "" (the direct-ref convention:
 * the caller addressed a concrete provider/model, not a route),
 * tokens_input = the backend-reported prompt tokens and
 * tokens_output = 0. Embeddings fit the existing ledger shape that
 * way; no new table or silent skip.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { ModelRouteLog } from "./model-route-log.js"
import { embedNative } from "./embeddings-native.js"

/** Native in-process backend (#1554): the server runs the model's
 * ONNX graph itself — no sidecar, no HTTP hop. The snapshot is an
 * HF model snapshot directory (tokenizer.json + the ONNX graph);
 * loaded lazily on the first embed call, never at boot. */
export interface NativeOnnxEmbeddingBackend {
  readonly kind: "native-onnx"
  /** HF snapshot directory holding `tokenizer.json` and the ONNX graph. */
  readonly snapshotDir?: string
  /** Environment variable that overrides `snapshotDir` when set. */
  readonly snapshotEnv?: string
  /** ONNX graph file inside the snapshot. Defaults to "onnx/model_int8.onnx". */
  readonly onnxFile?: string
  /** The model's token context. Longer inputs are rejected loudly by
   * the backend, never silently truncated. */
  readonly maxTokens: number
}

export type EmbeddingBackend = NativeOnnxEmbeddingBackend

export interface EmbeddingModel {
  /** Catalog ref the caller addresses: `provider/model`. */
  readonly ref: string
  readonly providerID: string
  readonly modelID: string
  /** The model's native output dimension. Per model, never assumed. */
  readonly dimensions: number
  /** Every `dimensions` value the backend honors, native included. A caller
   * asking for anything else is rejected loudly at parse time. */
  readonly supportedDimensions: ReadonlyArray<number>
  readonly ownedBy: string
  /** Which backend serves this registration. Native-onnx is the only
   * kind since the HTTP sidecar was retired (#1689, step 4). */
  readonly backend: EmbeddingBackend
}

/**
 * The embedding catalog. First registration (Drew, 2026-11-02:
 * "support embeddings using local snowflake"): local Snowflake Arctic
 * Embed, served by the native-onnx backend (#1690). The HTTP sidecar
 * that originally served it was retired in step 4 (#1689); no hosted
 * embeddings API is registered here.
 * Arctic Embed m-v2.0 is 768-dimensional and supports Matryoshka
 * truncation to 256, which the local backend honors.
 */
export const EMBEDDING_MODELS: ReadonlyArray<EmbeddingModel> = [
  {
    ref: "local-embed/snowflake-arctic-embed-m-v2.0",
    providerID: "local-embed",
    modelID: "snowflake-arctic-embed-m-v2.0",
    dimensions: 768,
    supportedDimensions: [768, 256],
    ownedBy: "local-embed",
    // Snapshot resolution: the LOCAL_EMBED_SNAPSHOT env var wins;
    // otherwise the HF cache snapshot dir below is used. The backend
    // throws loudly when the snapshot is missing.
    backend: {
      kind: "native-onnx",
      snapshotEnv: "LOCAL_EMBED_SNAPSHOT",
      snapshotDir:
        "~/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f",
      maxTokens: 8192,
    },
  },
]

export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_MODELS[0]

const registeredRefs = () => EMBEDDING_MODELS.map((model) => model.ref).join(", ")

/** Resolves a caller's model label to a registration: a full catalog
 * ref (`local-embed/snowflake-arctic-embed-m-v2.0`), a bare model id
 * (`snowflake-arctic-embed-m-v2.0`), or — with no label — the default
 * (first registered) embedding model. Anything else is an error the
 * caller can act on, listing what is registered. */
export const resolveEmbeddingModel = (label: unknown): EmbeddingModel | string => {
  if (label === undefined || label === null || label === "")
    return DEFAULT_EMBEDDING_MODEL ?? "no embedding models are registered"
  if (typeof label !== "string") return "model must be a string"
  const byRef = EMBEDDING_MODELS.find((model) => model.ref === label)
  if (byRef) return byRef
  if (!label.includes("/")) {
    const byID = EMBEDDING_MODELS.find((model) => model.modelID === label)
    if (byID) return byID
  }
  return `model ${label} is not a registered embedding model; registered embedding models: ${registeredRefs()}`
}

// ------------------------------------------------------------ translation

export interface ParsedEmbeddingsRequest {
  readonly modelLabel: string
  readonly model: EmbeddingModel
  readonly inputs: ReadonlyArray<string>
  readonly encodingFormat: "float" | "base64"
  readonly dimensions?: number
}

export type ParseEmbeddingsResult =
  | { readonly ok: true; readonly value: ParsedEmbeddingsRequest }
  | { readonly ok: false; readonly error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseEmbeddingsRequest = (body: unknown): ParseEmbeddingsResult => {
  if (!isRecord(body)) return { ok: false, error: "request body must be a JSON object" }
  const model = resolveEmbeddingModel(body.model)
  if (typeof model === "string") return { ok: false, error: model }

  const inputs: string[] = []
  if (typeof body.input === "string") inputs.push(body.input)
  else if (Array.isArray(body.input)) {
    for (const entry of body.input) {
      if (typeof entry !== "string")
        return { ok: false, error: "input entries must be strings; token-array input is not supported by this door" }
      inputs.push(entry)
    }
  } else return { ok: false, error: "input is required and must be a string or an array of strings" }
  if (!inputs.length) return { ok: false, error: "input must not be empty" }

  const encodingFormat = body.encoding_format === undefined ? "float" : body.encoding_format
  if (encodingFormat !== "float" && encodingFormat !== "base64")
    return { ok: false, error: `unsupported encoding_format: ${String(body.encoding_format)}` }

  let dimensions: number | undefined
  if (body.dimensions !== undefined) {
    if (typeof body.dimensions !== "number" || !Number.isInteger(body.dimensions) || body.dimensions <= 0)
      return { ok: false, error: "dimensions must be a positive integer" }
    if (!model.supportedDimensions.includes(body.dimensions))
      return {
        ok: false,
        error: `dimensions ${body.dimensions} is not supported by ${model.ref}; supported dimensions: ${model.supportedDimensions.join(", ")}`,
      }
    dimensions = body.dimensions
  }

  return {
    ok: true,
    value: {
      modelLabel: typeof body.model === "string" && body.model ? body.model : model.ref,
      model,
      inputs,
      encodingFormat,
      ...(dimensions !== undefined ? { dimensions } : {}),
    },
  }
}

const base64Float32 = (vector: ReadonlyArray<number>): string => {
  const bytes = new Uint8Array(new Float32Array(vector).buffer)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(binary)
}

export const embeddingsBody = (args: {
  readonly model: string
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>
  readonly promptTokens: number
  readonly encodingFormat: "float" | "base64"
}) => ({
  object: "list",
  data: args.vectors.map((vector, index) => ({
    object: "embedding",
    index,
    embedding: args.encodingFormat === "base64" ? base64Float32(vector) : [...vector],
  })),
  model: args.model,
  usage: { prompt_tokens: args.promptTokens, total_tokens: args.promptTokens },
})

/** The embedding entries GET /v1/models advertises alongside the chat routes. */
export const embeddingModelEntries = () =>
  EMBEDDING_MODELS.map((model) => ({ id: model.ref, object: "model", created: 0, owned_by: model.ownedBy }))

// ------------------------------------------------------------ service

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Embeddings.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = UnavailableError

export interface EmbedInput {
  readonly model: EmbeddingModel
  readonly inputs: ReadonlyArray<string>
  readonly dimensions?: number
}

export interface EmbedResult {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>
  /** Prompt tokens the backend reported; 0 when it reported none. */
  readonly promptTokens: number
}

export interface Interface {
  readonly embed: (input: EmbedInput) => Effect.Effect<EmbedResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Embeddings") {}

/** A stalled local backend must fail, not hang the door. */
const REQUEST_TIMEOUT = "60 seconds"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const embed: Interface["embed"] = (input) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const observed = ModelRouteLog.observer({
          routeID: "",
          providerID: input.model.providerID,
          modelID: input.model.modelID,
          startedAt,
        })
        const result = yield* Effect.result(
          Effect.gen(function* () {
            if (process.env.OPENCODE_NODE_BUNDLE === "1")
              return yield* Effect.fail(
                new Error(
                  "native-onnx embeddings are unsupported in the Node bundle; use the Bun build for native embeddings",
                ),
              )
            const native = yield* Effect.tryPromise({
              try: () =>
                embedNative({
                  backend: input.model.backend,
                  inputs: input.inputs,
                  ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
                  nativeDimensions: input.model.dimensions,
                }),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
            const expected = input.dimensions ?? input.model.dimensions
            for (const vector of native.vectors)
              if (vector.length !== expected)
                return yield* Effect.fail(
                  new Error(
                    `embedding backend returned a ${vector.length}-dimensional vector for ${input.model.ref}; expected ${expected}`,
                  ),
                )
            return native
          }).pipe(
            Effect.timeoutOrElse({
              duration: REQUEST_TIMEOUT,
              orElse: () =>
                Effect.fail(new Error(`timed out waiting for the ${input.model.providerID} embeddings backend`)),
            }),
          ),
        )
        if (result._tag === "Failure") {
          const message = result.failure instanceof Error ? result.failure.message : String(result.failure)
          observed.done("failure", { failure: result.failure, outputStarted: false })
          return yield* new UnavailableError({ message, service: input.model.providerID })
        }
        observed.done("success", {
          outputStarted: true,
          firstOutputAt: Date.now(),
          tokens: { input: result.success.promptTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        return result.success
      })

    return Service.of({ embed })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [httpClient] })
