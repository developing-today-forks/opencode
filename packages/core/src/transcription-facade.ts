export * as TranscriptionFacade from "./transcription-facade.js"

/**
 * Speech-to-text façade for `POST /v1/audio/transcriptions` (#2385,
 * design §8.1 of specs/2026-11-08_design_voice-input-stt-facade.md,
 * parent #1678). Mirror of the embeddings door (#1146): translation
 * and service code live here in core, the HTTP surface is one handler
 * file in packages/server registered alongside the completions
 * handler, and providers register in `TRANSCRIPTION_MODELS` the way
 * embedding models register in `EMBEDDING_MODELS` — the translation
 * layer carries no provider-specific branching; a provider's
 * capability shape, key source and retention posture live only in its
 * registration.
 *
 * Phase 1 is batch only (§7): the façade never fake-streams, so a
 * `stream=true` request fails typed (§2.4). One provider is registered
 * end-to-end — OpenAI whisper-1, whose protocol defines the capability
 * shape the registry mirrors (§3). Further registrations are their own
 * tickets (§8.2); route names (`opencode-route/<route-id>`) resolve
 * once media routes are wired into the resolver — until then a label
 * that matches no concrete registration answers `model_not_found`,
 * which is the §2.4 answer for a model that matches no concrete ref
 * and no route.
 *
 * Keys are owned by this layer (§3, the #1146 rule): the caller
 * authenticates with the existing server auth and never sends an STT
 * provider key; the provider key is read from the registration's
 * `apiKeyEnv` at call time.
 *
 * Accounting parity (§4): every attempt records a route_attempt row
 * through the same ModelRouteLog observer the generation and
 * embeddings paths use, with session_id NULL (the door convention),
 * route_id "" (the direct-ref convention). Usage columns carry what
 * MediaUsage reported, in the ledger's media convention (the reported
 * number in tokens_input, tokens_output = 0); a provider that reports
 * no usage records the attempt with no usage values rather than an
 * invented number. Failures record the attempt and its classified
 * failure.
 *
 * Retention (§5.3): the façade retains no audio after the call. Bytes
 * live only in the request-scoped input; nothing is written to the
 * session store, the ledger, or logs.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { AIError, AuthenticationError, Media, ProviderID, QuotaExceededError, RateLimitError, Transcription, TranscriptionClient, UnsupportedOperationError } from "@opencode/ai"
import type { TranscriptionModel, TranscriptionResponse } from "@opencode/ai"
import { configure as configureOpenAI } from "@opencode/ai/providers/openai"
import { ModelRouteLog } from "./model-route-log.js"
import { ownValue } from "./util/record.js"
import { requestExecutor } from "./effect/app-node-platform.js"

// ------------------------------------------------------------ registry (§3)

export interface TranscriptionCapabilities {
  readonly stream: boolean
  readonly timestamps: ReadonlyArray<"segment" | "word">
  readonly diarize: boolean
  /** Per-registration duration cap in seconds (§5.2). */
  readonly maxDurationSeconds: number
  /** MIME types the registration accepts (§5.1/§5.2). */
  readonly mediaTypes: ReadonlyArray<string>
}

export interface TranscriptionModelRegistration {
  /** Catalog ref the caller addresses: `provider/model`. */
  readonly ref: string
  readonly providerID: string
  readonly modelID: string
  readonly capabilities: TranscriptionCapabilities
  /** Phase 1 registers HTTP backends only; the kind exists from day
   * one so a native-local backend is a later registration flip (§3). */
  readonly backend: { readonly kind: "http" }
  /** Environment variable holding the provider key (§3). */
  readonly apiKeyEnv: string
  /** False only for a native-local backend (§3). */
  readonly audioLeavesMachine: boolean
  /** The provider's documented audio-retention posture (§3). */
  readonly retention: string
  /** Upload size cap in bytes (§5.2: 25 MiB default, overridable per
   * registration but never silently unlimited). */
  readonly maxUploadBytes: number
}

const MIB = 1024 * 1024

export const TRANSCRIPTION_MODELS: ReadonlyArray<TranscriptionModelRegistration> = [
  {
    ref: "openai/whisper-1",
    providerID: "openai",
    modelID: "whisper-1",
    // The OpenAI protocol's computed capability shape for whisper
    // models (protocols/openai-transcription.ts): no event streaming,
    // segment + word timestamps, no diarization.
    capabilities: {
      stream: false,
      timestamps: ["segment", "word"],
      diarize: false,
      maxDurationSeconds: 600,
      mediaTypes: ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/flac", "audio/x-flac"],
    },
    backend: { kind: "http" },
    apiKeyEnv: "OPENAI_API_KEY",
    audioLeavesMachine: true,
    retention:
      "Audio is processed by the OpenAI API and retained only under that API's data controls; the façade itself retains no audio.",
    maxUploadBytes: 25 * MIB,
  },
]

/**
 * Resolves a caller's model label to a registration: a full catalog
 * ref (`openai/whisper-1`) or a bare model id (`whisper-1`). When
 * `enabledProviders` is given, registrations whose provider is absent
 * from it vanish — the same config gating chat providers get from the
 * catalog (`disabled_providers` removes them there, §3). Anything
 * else is an error the caller can act on, listing what is registered.
 */
export const resolveTranscriptionModel = (
  label: unknown,
  enabledProviders?: ReadonlySet<string>,
): TranscriptionModelRegistration | string => {
  const visible = TRANSCRIPTION_MODELS.filter(
    (model) => enabledProviders === undefined || enabledProviders.has(model.providerID),
  )
  const refs = visible.map((model) => model.ref).join(", ")
  if (typeof label !== "string" || label === "") return `model is required; registered transcription models: ${refs}`
  const byRef = visible.find((model) => model.ref === label)
  if (byRef) return byRef
  if (!label.includes("/")) {
    const byID = visible.find((model) => model.modelID === label)
    if (byID) return byID
  }
  return `model ${label} is not a registered transcription model; registered transcription models: ${refs}`
}

// ------------------------------------------------------------ errors (§2.4)

export interface FacadeErrorShape {
  readonly status: number
  readonly code: string
  readonly message: string
}

export class FacadeError extends Schema.TaggedError<FacadeError>()("TranscriptionFacade.FacadeError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

const shape = (status: number, code: string, message: string): FacadeErrorShape => ({ status, code, message })

// ------------------------------------------------------------ request parsing (§2.2, §5)

export interface TranscriptionFormFile {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly filename?: string
}

export interface TranscriptionForm {
  /** Multipart text fields; repeated fields (e.g.
   * `timestamp_granularities[]`) arrive as arrays. */
  readonly fields: Readonly<Record<string, string | ReadonlyArray<string>>>
  readonly file?: TranscriptionFormFile
}

export interface ParsedTranscriptionRequest {
  readonly modelLabel: string
  readonly registration: TranscriptionModelRegistration
  readonly audio: TranscriptionFormFile
  readonly language?: string
  readonly prompt?: string
  readonly responseFormat: "json" | "verbose_json"
  readonly timestamps?: "segment" | "word"
  readonly diarize?: boolean
  readonly speakers?: number
  readonly providerOptions?: Record<string, unknown>
}

export type ParseTranscriptionResult =
  | { readonly ok: true; readonly value: ParsedTranscriptionRequest }
  | { readonly ok: false; readonly error: FacadeErrorShape }

const field = (form: TranscriptionForm, name: string): string | undefined => {
  const value = form.fields[name]
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

const fieldList = (form: TranscriptionForm, name: string): ReadonlyArray<string> => {
  const value = ownValue(form.fields, name) ?? ownValue(form.fields, `${name}[]`)
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value
  return []
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  m4a: "audio/x-m4a",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
}

export const parseTranscriptionRequest = (
  form: TranscriptionForm,
  enabledProviders?: ReadonlySet<string>,
): ParseTranscriptionResult => {
  const fail = (error: FacadeErrorShape): ParseTranscriptionResult => ({ ok: false, error })

  const modelLabel = field(form, "model")
  if (modelLabel === undefined || modelLabel === "")
    return fail(shape(400, "invalid_request", "model is required"))
  const registration = resolveTranscriptionModel(modelLabel, enabledProviders)
  if (typeof registration === "string") return fail(shape(404, "model_not_found", registration))
  const capabilities = registration.capabilities

  const file = form.file
  if (!file || file.bytes.length === 0)
    return fail(shape(400, "invalid_audio", "a non-empty file part with audio is required"))
  if (file.bytes.length > registration.maxUploadBytes)
    return fail(
      shape(
        413,
        "audio_too_large",
        `audio is ${file.bytes.length} bytes; the cap for ${registration.ref} is ${registration.maxUploadBytes} bytes`,
      ),
    )
  const extension = file.filename?.split(".").pop()?.toLowerCase()
  const mediaType = file.mediaType || (extension ? ownValue(EXTENSION_MEDIA_TYPES, extension) : undefined) || ""
  if (!capabilities.mediaTypes.includes(mediaType))
    return fail(
      shape(
        400,
        "unsupported_media_type",
        `${registration.ref} does not accept ${mediaType || "unknown media type"}; accepted media types: ${capabilities.mediaTypes.join(", ")}`,
      ),
    )

  const responseFormat = field(form, "response_format") ?? "json"
  if (responseFormat !== "json" && responseFormat !== "verbose_json")
    return fail(
      shape(
        400,
        "unsupported_response_format",
        `response_format ${responseFormat} is not offered by the façade; use json or verbose_json`,
      ),
    )

  // Batch only in phase 1 (§7): stream=true on this non-stream route
  // fails typed, never fake-streams (§2.4).
  const stream = field(form, "stream")
  if (stream === "true" || stream === "1")
    return fail(
      shape(
        400,
        "stream_not_supported",
        "streaming transcription is not available on this route in phase 1; omit stream for a batch transcription",
      ),
    )

  let timestamps: "segment" | "word" | undefined
  const granularities = fieldList(form, "timestamp_granularities")
  for (const granularity of granularities) {
    if (granularity !== "segment" && granularity !== "word")
      return fail(shape(400, "invalid_request", `unknown timestamp granularity: ${granularity}`))
    if (!capabilities.timestamps.includes(granularity))
      return fail(
        shape(
          400,
          "timestamps_not_supported",
          `${registration.ref} cannot produce ${granularity} timestamps; supported: ${capabilities.timestamps.join(", ") || "none"}`,
        ),
      )
    // Word is the finer granularity and routes may return more than
    // asked, so a segment+word request is honored at word level.
    if (granularity === "word" || timestamps === undefined) timestamps = granularity
  }

  let diarize: boolean | undefined
  const diarizeField = field(form, "diarize")
  if (diarizeField !== undefined) {
    diarize = diarizeField === "true" || diarizeField === "1"
    if (diarize && !capabilities.diarize)
      return fail(shape(400, "diarize_not_supported", `${registration.ref} does not diarize`))
  }

  let speakers: number | undefined
  const speakersField = field(form, "speakers")
  if (speakersField !== undefined) {
    const parsed = Number(speakersField)
    if (!Number.isInteger(parsed) || parsed <= 0)
      return fail(shape(400, "invalid_request", "speakers must be a positive integer"))
    speakers = parsed
  }

  let providerOptions: Record<string, unknown> | undefined
  const providerOptionsField = field(form, "provider_options")
  if (providerOptionsField !== undefined && providerOptionsField !== "") {
    try {
      const parsed: unknown = JSON.parse(providerOptionsField)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return fail(shape(400, "invalid_request", "provider_options must be a JSON object"))
      providerOptions = parsed as Record<string, unknown>
    } catch {
      return fail(shape(400, "invalid_request", "provider_options must be a JSON object"))
    }
  }

  const language = field(form, "language")
  const prompt = field(form, "prompt")
  return {
    ok: true,
    value: {
      modelLabel,
      registration,
      audio: { bytes: file.bytes, mediaType, ...(file.filename !== undefined ? { filename: file.filename } : {}) },
      ...(language !== undefined && language !== "" ? { language } : {}),
      ...(prompt !== undefined && prompt !== "" ? { prompt } : {}),
      responseFormat,
      ...(timestamps !== undefined ? { timestamps } : {}),
      ...(diarize !== undefined ? { diarize } : {}),
      ...(speakers !== undefined ? { speakers } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
    },
  }
}

// ------------------------------------------------------------ response envelope (§2.3)

/**
 * The normalized batch envelope: TranscriptionResponse serialized
 * with OpenAI-flavoured field names where a direct equivalent exists.
 * Optional fields are present exactly when the provider reported
 * them — absence means "not reported", never a fabricated value.
 */
export const transcriptionBody = (
  response: TranscriptionResponse,
  registration: TranscriptionModelRegistration,
  responseFormat: "json" | "verbose_json",
) => {
  const providerMetadata = response.providerMetadata?.[registration.providerID]
  return {
    text: response.text,
    ...(response.language !== undefined ? { language: response.language } : {}),
    ...(response.durationSeconds !== undefined ? { duration: response.durationSeconds } : {}),
    ...(response.segments !== undefined
      ? {
          segments: response.segments.map((segment) => ({
            text: segment.text,
            start: segment.startSeconds,
            end: segment.endSeconds,
            ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
          })),
        }
      : {}),
    ...(response.words !== undefined
      ? {
          words: response.words.map((word) => ({
            word: word.text,
            start: word.startSeconds,
            end: word.endSeconds,
            ...(word.speaker !== undefined ? { speaker: word.speaker } : {}),
            ...(word.confidence !== undefined ? { confidence: word.confidence } : {}),
          })),
        }
      : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
    notices: response.notices ?? [],
    provider_metadata: {
      provider: registration.providerID,
      model: registration.modelID,
      ...(providerMetadata !== undefined ? { provider_metadata: providerMetadata } : {}),
    },
    // verbose_json's pass-through escape hatch (§2.3): the ai layer
    // normalizes the provider payload away, so the retained
    // provider-native metadata is what can be carried here.
    ...(responseFormat === "verbose_json" ? { provider_response: providerMetadata ?? null } : {}),
  }
}

/** The transcription entries GET /v1/models can advertise alongside
 * the other doors' models (§3). */
export const transcriptionModelEntries = (enabledProviders?: ReadonlySet<string>) =>
  TRANSCRIPTION_MODELS.filter(
    (model) => enabledProviders === undefined || enabledProviders.has(model.providerID),
  ).map((model) => ({ id: model.ref, object: "model", created: 0, owned_by: model.providerID }))

// ------------------------------------------------------------ service

export type Error = FacadeError

export interface Interface {
  readonly transcribe: (input: ParsedTranscriptionRequest) => Effect.Effect<TranscriptionResponse, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TranscriptionFacade") {}

/** Provider factories by providerID: the registry holds no protocol
 * code (§3); a registration resolves to the packages/ai provider
 * factory named here. */
const PROVIDER_FACTORIES: Readonly<
  Record<string, (modelID: string, apiKey: string) => TranscriptionModel>
> = {
  openai: (modelID, apiKey) => configureOpenAI({ apiKey }).transcription(modelID),
}

/** A stalled provider must fail, not hang the door. Transcription of
 * a 600-second clip legitimately takes longer than an embedding. */
const REQUEST_TIMEOUT = "120 seconds"

const usageTokens = (
  usage: TranscriptionResponse["usage"],
): { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined => {
  if (usage === undefined) return undefined
  const zero = { output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  switch (usage.type) {
    case "seconds":
    case "compute":
      return { input: Math.round(usage.seconds), ...zero }
    case "characters":
      return { input: usage.characters, ...zero }
    case "credits":
      return { input: usage.credits, ...zero }
    case "tokens":
      return {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }
  }
}

/** Maps a provider failure to the §2.4 envelope shape: quota and
 * rate-limit failures keep the provider's message (reset hint
 * included) at 429; capability failures the request schema promised
 * to fail typed land at 400; everything else is an upstream 502. */
const classifyFailure = (failure: unknown): FacadeErrorShape => {
  if (failure instanceof AIError) {
    const reason = failure.reason as { _tag?: string; message?: string; operation?: string }
    const message = reason.message ?? failure.message ?? "transcription failed"
    if (reason instanceof QuotaExceededError)
      return shape(429, "quota_exceeded", message)
    if (reason instanceof RateLimitError) return shape(429, "rate_limit", message)
    if (reason instanceof UnsupportedOperationError) {
      if (reason.operation === "media.timestamps") return shape(400, "timestamps_not_supported", message)
      if (reason.operation === "media.diarize") return shape(400, "diarize_not_supported", message)
      if (reason.operation === "media.stream") return shape(400, "stream_not_supported", message)
      return shape(400, "unsupported_operation", message)
    }
    if (reason instanceof AuthenticationError) return shape(502, "upstream_failure", message)
    if (reason._tag === "InvalidRequest") return shape(400, "invalid_audio", message)
    return shape(502, "upstream_failure", message)
  }
  return shape(502, "upstream_failure", failure instanceof Error ? failure.message : String(failure))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* TranscriptionClient.Service
    const transcribe: Interface["transcribe"] = (input) =>
      Effect.gen(function* () {
        const { registration } = input
        const startedAt = Date.now()
        const observed = ModelRouteLog.observer({
          routeID: "",
          providerID: registration.providerID,
          modelID: registration.modelID,
          startedAt,
        })
        const fail = (failureShape: FacadeErrorShape, failure: unknown) => {
          observed.done("failure", { failure, outputStarted: false })
          return new FacadeError(failureShape)
        }
        const apiKey = process.env[registration.apiKeyEnv]
        if (apiKey === undefined || apiKey === "")
          return yield* fail(
            shape(
              502,
              "upstream_failure",
              `transcription provider ${registration.providerID} is not configured: ${registration.apiKeyEnv} is not set`,
            ),
            new Error(`${registration.apiKeyEnv} is not set`),
          )
        const factory = ownValue(PROVIDER_FACTORIES, registration.providerID)
        if (!factory)
          return yield* fail(
            shape(502, "upstream_failure", `no transcription factory is wired for provider ${registration.providerID}`),
            new Error(`no transcription factory for ${registration.providerID}`),
          )
        const result = yield* Effect.result(
          client
            .generate(
              Transcription.request({
                model: factory(registration.modelID, apiKey),
                audio: Media.bytes(input.audio.bytes, input.audio.mediaType),
                ...(input.language !== undefined ? { language: input.language } : {}),
                ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                ...(input.timestamps !== undefined ? { timestamps: input.timestamps } : {}),
                ...(input.diarize !== undefined ? { diarize: input.diarize } : {}),
                ...(input.speakers !== undefined ? { speakers: input.speakers } : {}),
                ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
              }),
            )
            .pipe(
              Effect.timeoutOrElse({
                duration: REQUEST_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new AIError({
                      reason: new UnsupportedOperationError({
                        operation: "media.timeout",
                        provider: ProviderID.make(registration.providerID),
                        route: registration.ref,
                        message: `timed out waiting for the ${registration.providerID} transcription backend`,
                      }),
                    }),
                  ),
              }),
            ),
        )
        if (result._tag === "Failure") {
          const failureShape = classifyFailure(result.failure)
          return yield* fail(failureShape, result.failure)
        }
        const tokens = usageTokens(result.success.usage)
        observed.done("success", {
          outputStarted: true,
          firstOutputAt: Date.now(),
          ...(tokens !== undefined ? { tokens } : {}),
        })
        return result.success
      })
    return Service.of({ transcribe })
  }),
).pipe(Layer.provide(TranscriptionClient.layer))

export const node = makeLocationNode({ service: Service, layer, deps: [requestExecutor] })
