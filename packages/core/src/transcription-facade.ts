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
 * Phase 1 shipped batch only (§7); phase 2 (§8.5) adds opt-in
 * streaming for stream-capable registrations: `stream=true` on a
 * registration whose capabilities declare `stream: false` still
 * fails typed (§2.4) — the façade never fake-streams a batch
 * result as deltas. Five providers are
 * registered (§8.1 + §8.2) — OpenAI whisper-1, whose protocol defines the capability
 * shape the registry mirrors (§3), plus Deepgram, Google, AssemblyAI and
 * ElevenLabs, each verified against its recorded fixtures in packages/ai
 * before enablement. Route names (`opencode-route/<route-id>`) resolve
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
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { AIError, AuthenticationError, Media, ProviderID, QuotaExceededError, RateLimitError, Transcription, TranscriptionClient, TranscriptionResponse, UnsupportedOperationError } from "@opencode/ai"
import type { TranscriptionEvent, TranscriptionModel } from "@opencode/ai"
import { configure } from "@opencode/ai/providers/openai"
import { configure as configureAssemblyAI } from "@opencode/ai/providers/assemblyai"
import { configure as configureDeepgram } from "@opencode/ai/providers/deepgram"
import { configure as configureElevenLabs } from "@opencode/ai/providers/elevenlabs"
import { configure as configureGoogle } from "@opencode/ai/providers/google"
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
  {
    ref: "deepgram/nova-3",
    providerID: "deepgram",
    modelID: "nova-3",
    // The Deepgram protocol's shape for nova-3 (protocols/deepgram-transcription.ts):
    // an inline (batch) route; utterances give segment timestamps and the
    // word timings give word timestamps; diarization is a model choice
    // (diarize_model), not a separate model.
    capabilities: {
      stream: false,
      timestamps: ["segment", "word"],
      diarize: true,
      maxDurationSeconds: 600,
      mediaTypes: ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/flac", "audio/x-flac"],
    },
    backend: { kind: "http" },
    apiKeyEnv: "DEEPGRAM_API_KEY",
    audioLeavesMachine: true,
    retention:
      "Audio is processed by the Deepgram API and retained only under that API's data controls; the façade itself retains no audio.",
    maxUploadBytes: 25 * MIB,
  },
  {
    ref: "google/gemini-3.5-transcribe",
    providerID: "google",
    modelID: "gemini-3.5-transcribe",
    // The Google protocol's shape (protocols/google-transcription.ts): a
    // streaming route natively (the façade's phase-1 route stays batch
    // only, §7); the finish event carries segment and word timings, and
    // diarization is a generation-config option. Only `transcribe`
    // models are accepted by the protocol.
    capabilities: {
      stream: true,
      timestamps: ["segment", "word"],
      diarize: true,
      maxDurationSeconds: 600,
      mediaTypes: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave", "audio/aiff", "audio/x-aiff", "audio/aac", "audio/ogg", "audio/flac", "audio/x-flac"],
    },
    backend: { kind: "http" },
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    audioLeavesMachine: true,
    retention:
      "Audio is processed by the Google Gemini API and retained only under that API's data controls; the façade itself retains no audio.",
    maxUploadBytes: 25 * MIB,
  },
  {
    ref: "assemblyai/universal-3-5-pro",
    providerID: "assemblyai",
    modelID: "universal-3-5-pro",
    // The AssemblyAI protocol's shape (protocols/assemblyai-transcription.ts):
    // a queued submit-and-poll route, still one façade call (§3);
    // utterances give segment timestamps with speakers, words give word
    // timestamps, and speaker labels are the diarization path.
    capabilities: {
      stream: false,
      timestamps: ["segment", "word"],
      diarize: true,
      maxDurationSeconds: 600,
      mediaTypes: ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/flac", "audio/x-flac"],
    },
    backend: { kind: "http" },
    apiKeyEnv: "ASSEMBLYAI_API_KEY",
    audioLeavesMachine: true,
    retention:
      "Audio is processed by the AssemblyAI API and retained only under that API's data controls; the façade itself retains no audio.",
    maxUploadBytes: 25 * MIB,
  },
  {
    ref: "elevenlabs/scribe_v2",
    providerID: "elevenlabs",
    modelID: "scribe_v2",
    // The ElevenLabs protocol's shape (protocols/elevenlabs-transcription.ts):
    // an inline (batch) route; timed words give word timestamps, and
    // speaker turns derived from diarized words give segment timestamps;
    // diarization is a request option on the same model.
    capabilities: {
      stream: false,
      timestamps: ["segment", "word"],
      diarize: true,
      maxDurationSeconds: 600,
      mediaTypes: ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/flac", "audio/x-flac"],
    },
    backend: { kind: "http" },
    apiKeyEnv: "ELEVENLABS_API_KEY",
    audioLeavesMachine: true,
    retention:
      "Audio is processed by the ElevenLabs API and retained only under that API's data controls; the façade itself retains no audio.",
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
  readonly stream?: boolean
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
  const value = form.fields[name] ?? form.fields[`${name}[]`]
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
  // ownValue (#865/#2392): the extension comes from an uploaded filename, so a
  // prototype member name must miss, not resolve to an inherited member.
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

  // Streaming is phase 2 (§7/§8.5): stream=true is honored only on
  // a registration that declares the stream capability; on any other
  // route it fails typed, never fake-streams (§2.4).
  const streamField = field(form, "stream")
  const stream = streamField === "true" || streamField === "1"
  if (stream && !capabilities.stream)
    return fail(
      shape(
        400,
        "stream_not_supported",
        `${registration.ref} does not stream; streaming requires a stream-capable registration — omit stream for a batch transcription`,
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
      ...(stream ? { stream: true } : {}),
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

/**
 * The §7 phase-2 SSE frame payload for one streamed event: the
 * TranscriptionEvent grammar serialized with the OpenAI protocol's
 * frame names (`transcript.text.delta` / `transcript.text.segment` /
 * `transcript.text.done`). The finish frame carries the full §2.3
 * envelope, so a streaming caller ends with exactly what a batch
 * caller receives. Queued/progress events are route-internal (a
 * queued route is never stream-capable, §3) and have no §7 frame:
 * they serialize to undefined and the handler skips them.
 */
export const transcriptionStreamFrame = (
  event: TranscriptionEvent,
  registration: TranscriptionModelRegistration,
  responseFormat: "json" | "verbose_json",
): string | undefined => {
  switch (event.type) {
    case "text-delta":
      return JSON.stringify({ type: "transcript.text.delta", delta: event.delta })
    case "segment":
      return JSON.stringify({
        type: "transcript.text.segment",
        segment: {
          text: event.segment.text,
          start: event.segment.startSeconds,
          end: event.segment.endSeconds,
          ...(event.segment.speaker !== undefined ? { speaker: event.segment.speaker } : {}),
        },
      })
    case "finish": {
      const { type: _type, ...transcript } = event
      return JSON.stringify({
        type: "transcript.text.done",
        ...transcriptionBody(new TranscriptionResponse(transcript), registration, responseFormat),
      })
    }
    default:
      return undefined
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
  /**
   * Phase-2 streaming (§7/§8.5): the outer effect performs the
   * setup failures a batch call reports before any byte (missing
   * provider key, unwired factory) so the handler can still answer
   * with a §2.4 JSON error; the returned stream carries the
   * provider's events and fails typed mid-stream. §4 parity is
   * recorded exactly once per call, from inside the stream.
   */
  readonly transcribeStream: (
    input: ParsedTranscriptionRequest,
  ) => Effect.Effect<Stream.Stream<TranscriptionEvent, Error>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TranscriptionFacade") {}

/** Provider factories by providerID: the registry holds no protocol
 * code (§3); a registration resolves to the packages/ai provider
 * factory named here. */
const PROVIDER_FACTORIES: Readonly<
  Record<string, (modelID: string, apiKey: string) => TranscriptionModel>
> = {
  openai: (modelID, apiKey) => configure({ apiKey }).transcription(modelID),
  deepgram: (modelID, apiKey) => configureDeepgram({ apiKey }).transcription(modelID),
  google: (modelID, apiKey) => configureGoogle({ apiKey }).transcription(modelID),
  assemblyai: (modelID, apiKey) => configureAssemblyAI({ apiKey }).transcription(modelID),
  elevenlabs: (modelID, apiKey) => configureElevenLabs({ apiKey }).transcription(modelID),
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
        // ownValue (#865/#2392): a prototype-named providerID must miss to the
        // not-wired failure below, never resolve to an inherited member that
        // would then be CALLED as the factory.
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
    const transcribeStream: Interface["transcribeStream"] = (input) =>
      Effect.gen(function* () {
        const { registration } = input
        const startedAt = Date.now()
        const observed = ModelRouteLog.observer({
          routeID: "",
          providerID: registration.providerID,
          modelID: registration.modelID,
          startedAt,
        })
        const apiKey = process.env[registration.apiKeyEnv]
        if (apiKey === undefined || apiKey === "") {
          observed.done("failure", {
            failure: new Error(`${registration.apiKeyEnv} is not set`),
            outputStarted: false,
          })
          return yield* new FacadeError(
            shape(
              502,
              "upstream_failure",
              `transcription provider ${registration.providerID} is not configured: ${registration.apiKeyEnv} is not set`,
            ),
          )
        }
        const factory = ownValue(PROVIDER_FACTORIES, registration.providerID)
        if (!factory) {
          observed.done("failure", {
            failure: new Error(`no transcription factory for ${registration.providerID}`),
            outputStarted: false,
          })
          return yield* new FacadeError(
            shape(502, "upstream_failure", `no transcription factory is wired for provider ${registration.providerID}`),
          )
        }
        // §4 parity for streamed calls: the attempt row is written
        // exactly once — success on the finish event (usage from the
        // finish event, as the batch path), failure on a stream
        // error, or failure when the stream ends without a finish.
        let outputStarted = false
        let firstOutputAt: number | undefined
        let settled = false
        const events = client.stream(
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
        return events.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (!outputStarted) {
                outputStarted = true
                firstOutputAt = Date.now()
              }
              if (event.type === "finish" && !settled) {
                settled = true
                const tokens = usageTokens(event.usage)
                observed.done("success", {
                  outputStarted: true,
                  firstOutputAt: firstOutputAt ?? Date.now(),
                  ...(tokens !== undefined ? { tokens } : {}),
                })
              }
            }),
          ),
          Stream.mapError((failure) => {
            if (!settled) {
              settled = true
              observed.done("failure", { failure, outputStarted })
            }
            return new FacadeError(classifyFailure(failure))
          }),
          Stream.concat(
            Stream.suspend(() => {
              if (settled) return Stream.empty
              settled = true
              const message = "the transcription stream ended without a finish event"
              observed.done("failure", { failure: new Error(message), outputStarted })
              return Stream.fail(new FacadeError(shape(502, "upstream_failure", message)))
            }),
          ),
        )
      })
    return Service.of({ transcribe, transcribeStream })
  }),
).pipe(Layer.provide(TranscriptionClient.layer))

export const node = makeLocationNode({ service: Service, layer, deps: [requestExecutor] })
