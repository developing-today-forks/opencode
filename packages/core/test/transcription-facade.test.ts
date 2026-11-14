import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RequestExecutor } from "@opencode/ai/route"
import { TranscriptionFacade } from "@opencode/core/transcription-facade"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { TranscriptionResponse } from "@opencode/ai"

const mp3 = { bytes: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), mediaType: "audio/mpeg", filename: "note.mp3" }

const parse = (fields: Record<string, string | string[]>, file: unknown = mp3, enabled?: ReadonlySet<string>) =>
  TranscriptionFacade.parseTranscriptionRequest(
    { fields, ...(file !== undefined && file !== null ? { file: file as TranscriptionFacade.TranscriptionFormFile } : {}) },
    enabled,
  )

describe("TranscriptionFacade registry", () => {
  test("resolves the OpenAI registration by ref and by bare model id", () => {
    expect(TranscriptionFacade.resolveTranscriptionModel("openai/whisper-1")).toMatchObject({ ref: "openai/whisper-1" })
    expect(TranscriptionFacade.resolveTranscriptionModel("whisper-1")).toMatchObject({ ref: "openai/whisper-1" })
    const missing = TranscriptionFacade.resolveTranscriptionModel("openai/gpt-4o-transcribe")
    expect(typeof missing).toBe("string")
  })

  test("resolves the §8.2 registrations by ref and by bare model id, with their key sources", () => {
    expect(TranscriptionFacade.resolveTranscriptionModel("deepgram/nova-3")).toMatchObject({
      ref: "deepgram/nova-3",
      providerID: "deepgram",
      apiKeyEnv: "DEEPGRAM_API_KEY",
    })
    expect(TranscriptionFacade.resolveTranscriptionModel("nova-3")).toMatchObject({ ref: "deepgram/nova-3" })
    expect(TranscriptionFacade.resolveTranscriptionModel("google/gemini-3.5-transcribe")).toMatchObject({
      ref: "google/gemini-3.5-transcribe",
      providerID: "google",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    })
    expect(TranscriptionFacade.resolveTranscriptionModel("gemini-3.5-transcribe")).toMatchObject({
      ref: "google/gemini-3.5-transcribe",
    })
    expect(TranscriptionFacade.resolveTranscriptionModel("assemblyai/universal-3-5-pro")).toMatchObject({
      ref: "assemblyai/universal-3-5-pro",
      providerID: "assemblyai",
      apiKeyEnv: "ASSEMBLYAI_API_KEY",
    })
    expect(TranscriptionFacade.resolveTranscriptionModel("universal-3-5-pro")).toMatchObject({
      ref: "assemblyai/universal-3-5-pro",
    })
    expect(TranscriptionFacade.resolveTranscriptionModel("elevenlabs/scribe_v2")).toMatchObject({
      ref: "elevenlabs/scribe_v2",
      providerID: "elevenlabs",
      apiKeyEnv: "ELEVENLABS_API_KEY",
    })
    expect(TranscriptionFacade.resolveTranscriptionModel("scribe_v2")).toMatchObject({ ref: "elevenlabs/scribe_v2" })
  })

  test("the §8.2 registrations declare diarization and segment+word timestamps", () => {
    for (const ref of ["deepgram/nova-3", "google/gemini-3.5-transcribe", "assemblyai/universal-3-5-pro", "elevenlabs/scribe_v2"]) {
      const registration = TranscriptionFacade.resolveTranscriptionModel(ref)
      expect(typeof registration).not.toBe("string")
      if (typeof registration === "string") continue
      expect(registration.capabilities.diarize).toBe(true)
      expect(registration.capabilities.timestamps).toEqual(["segment", "word"])
      expect(registration.capabilities.maxDurationSeconds).toBe(600)
      expect(registration.audioLeavesMachine).toBe(true)
      expect(registration.backend.kind).toBe("http")
    }
  })

  test("a disabled provider's refs vanish from resolution", () => {
    const enabled = new Set<string>(["deepgram"])
    expect(typeof TranscriptionFacade.resolveTranscriptionModel("openai/whisper-1", enabled)).toBe("string")
    const parsed = parse({ model: "openai/whisper-1" }, mp3, enabled)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe("model_not_found")
  })
})

describe("TranscriptionFacade parse (§2.2/§2.4/§5)", () => {
  test("a §8.2 registration accepts diarize and word timestamps, and rejects a media type it does not declare", () => {
    const parsed = parse({ model: "deepgram/nova-3", diarize: "true", timestamp_granularities: ["word"] })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.registration.ref).toBe("deepgram/nova-3")
      expect(parsed.value.diarize).toBe(true)
      expect(parsed.value.timestamps).toBe("word")
    }
    const aiff = { bytes: new Uint8Array([0x46, 0x4f, 0x52, 0x4d]), mediaType: "audio/aiff", filename: "note.aiff" }
    const rejected = parse({ model: "deepgram/nova-3" }, aiff)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe("unsupported_media_type")
    const accepted = parse({ model: "google/gemini-3.5-transcribe" }, aiff)
    expect(accepted.ok).toBe(true)
  })

  test("happy path maps fields, with word granularity winning over segment", () => {
    const parsed = parse({
      model: "openai/whisper-1",
      language: "en",
      prompt: "names",
      timestamp_granularities: ["segment", "word"],
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.timestamps).toBe("word")
      expect(parsed.value.language).toBe("en")
      expect(parsed.value.responseFormat).toBe("json")
      expect(parsed.value.registration.ref).toBe("openai/whisper-1")
    }
  })

  test("stream=true fails typed stream_not_supported, never fake-streams", () => {
    const parsed = parse({ model: "openai/whisper-1", stream: "true" })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.status).toBe(400)
      expect(parsed.error.code).toBe("stream_not_supported")
    }
  })

  test("unknown model is 404 model_not_found; missing file is 400 invalid_audio", () => {
    const noModel = parse({ model: "acme/nope" })
    expect(noModel.ok).toBe(false)
    if (!noModel.ok) {
      expect(noModel.error.status).toBe(404)
      expect(noModel.error.code).toBe("model_not_found")
    }
    const noFile = parse({ model: "openai/whisper-1" }, null)
    expect(noFile.ok).toBe(false)
    if (!noFile.ok) expect(noFile.error.code).toBe("invalid_audio")
  })

  test("unaccepted media type is 400 unsupported_media_type naming what is accepted", () => {
    const parsed = parse(
      { model: "openai/whisper-1" },
      { bytes: new Uint8Array([1]), mediaType: "video/mp4", filename: "clip.mp4" },
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("unsupported_media_type")
      expect(parsed.error.message).toContain("audio/mpeg")
    }
  })

  test("oversize upload is 413 audio_too_large", () => {
    const big = { bytes: new Uint8Array(26 * 1024 * 1024), mediaType: "audio/mpeg", filename: "big.mp3" }
    const parsed = parse({ model: "openai/whisper-1" }, big)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.status).toBe(413)
      expect(parsed.error.code).toBe("audio_too_large")
    }
  })

  test("diarize on a non-diarizing registration fails typed; text format is not offered", () => {
    const diarize = parse({ model: "openai/whisper-1", diarize: "true" })
    expect(diarize.ok).toBe(false)
    if (!diarize.ok) expect(diarize.error.code).toBe("diarize_not_supported")
    const text = parse({ model: "openai/whisper-1", response_format: "srt" })
    expect(text.ok).toBe(false)
    if (!text.ok) expect(text.error.code).toBe("unsupported_response_format")
  })

  test("provider_options must be a JSON object", () => {
    const bad = parse({ model: "openai/whisper-1", provider_options: "[1,2]" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe("invalid_request")
    const good = parse({ model: "openai/whisper-1", provider_options: "{\"temperature\":0}" })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.value.providerOptions).toEqual({ temperature: 0 })
  })
})

describe("TranscriptionFacade envelope (§2.3)", () => {
  test("maps the internal response to the wire envelope, omitting what was not reported", () => {
    const registration = TranscriptionFacade.resolveTranscriptionModel("openai/whisper-1")
    if (typeof registration === "string") throw new Error(registration)
    const body = TranscriptionFacade.transcriptionBody(
      new TranscriptionResponse({
        text: "hello",
        language: "en",
        durationSeconds: 2,
        segments: [{ text: "hello", startSeconds: 0, endSeconds: 2, speaker: "A" }],
        usage: { type: "seconds", seconds: 2 },
      }),
      registration,
      "json",
    )
    expect(body).toEqual({
      text: "hello",
      language: "en",
      duration: 2,
      segments: [{ text: "hello", start: 0, end: 2, speaker: "A" }],
      usage: { type: "seconds", seconds: 2 },
      notices: [],
      provider_metadata: { provider: "openai", model: "whisper-1" },
    })
  })
})

const fixtureBody = () =>
  Bun.file(
    new URL("../../ai/test/fixtures/recordings/openai-transcription/returns-whisper-word-timestamps.json", import.meta.url)
      .pathname,
  )
    .json()
    .then((recording) => recording.interactions[0].response.body as string)

const facadeWithStub = (respond: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>) => {
  const stub = HttpClient.make((request) => respond(request))
  const executor = RequestExecutor.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, stub)))
  return TranscriptionFacade.layer.pipe(Layer.provide(executor))
}

describe("TranscriptionFacade parity (§4)", () => {
  test("a recorded-fixture transcription yields the normalized envelope and exactly one route_attempt row", async () => {
    const body = await fixtureBody()
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const parsed = parse({ model: "openai/whisper-1", timestamp_granularities: ["word"] })
      if (!parsed.ok) throw new Error(parsed.error.message)
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const facade = yield* TranscriptionFacade.Service
          return yield* facade.transcribe(parsed.value)
        }).pipe(
          Effect.provide(
            facadeWithStub((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
                ),
              ),
            ),
          ),
        ),
      )
      const envelope = TranscriptionFacade.transcriptionBody(response, parsed.value.registration, "json")
      expect(envelope.text).toBe("Hello from OpenCode!")
      expect(envelope.language).toBe("english")
      expect(envelope.words).toHaveLength(3)
      expect(envelope.words?.[0]).toEqual({ word: "Hello", start: 0, end: 0.6200000047683716 })
      expect(envelope.usage).toEqual({ type: "seconds", seconds: 2 })

      const attempts = events.filter((event) => event.kind === "attempt")
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.row).toMatchObject({
        route_id: "",
        provider_id: "openai",
        model_id: "whisper-1",
        outcome: "success",
        tokens_input: 2,
        tokens_output: 0,
      })
      expect(attempts[0]?.row.session_id ?? null).toBeNull()
    } finally {
      ModelRouteLog.setSink(undefined)
      delete process.env.OPENAI_API_KEY
    }
  })

  test("a provider 429 records the attempt as a failure and surfaces 429 with the provider message", async () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const parsed = parse({ model: "openai/whisper-1" })
      if (!parsed.ok) throw new Error(parsed.error.message)
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const facade = yield* TranscriptionFacade.Service
          return yield* Effect.result(facade.transcribe(parsed.value))
        }).pipe(
          Effect.provide(
            facadeWithStub((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      error: { message: "You exceeded your current quota; resets at 12:00 UTC", type: "insufficient_quota", code: "insufficient_quota" },
                    }),
                    { status: 429, headers: { "content-type": "application/json" } },
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") {
        expect(failure.failure.status).toBe(429)
        expect(["quota_exceeded", "rate_limit"]).toContain(failure.failure.code)
        expect(failure.failure.message).toContain("quota")
      }
      const attempts = events.filter((event) => event.kind === "attempt")
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.row).toMatchObject({ provider_id: "openai", model_id: "whisper-1", outcome: "failure" })
    } finally {
      ModelRouteLog.setSink(undefined)
      delete process.env.OPENAI_API_KEY
    }
  })

  test("a missing provider key fails typed and still records the attempt", async () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))
    delete process.env.OPENAI_API_KEY
    try {
      const parsed = parse({ model: "openai/whisper-1" })
      if (!parsed.ok) throw new Error(parsed.error.message)
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const facade = yield* TranscriptionFacade.Service
          return yield* Effect.result(facade.transcribe(parsed.value))
        }).pipe(
          Effect.provide(
            facadeWithStub(() => Effect.die(new Error("HTTP must not be called without a key"))),
          ),
        ),
      )
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") {
        expect(failure.failure.status).toBe(502)
        expect(failure.failure.message).toContain("OPENAI_API_KEY")
      }
      expect(events.filter((event) => event.kind === "attempt")).toHaveLength(1)
    } finally {
      ModelRouteLog.setSink(undefined)
    }
  })
})
