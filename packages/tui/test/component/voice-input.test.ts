import { describe, expect, test } from "bun:test"
import {
  VoiceInputMachine,
  VoiceTranscriptionError,
  detectRecorder,
  formatVoiceClock,
  recorderCandidates,
  submitVoiceTranscription,
  validateVoiceAudio,
  voiceMediaType,
  voicePrivacyNotice,
  voiceRegistration,
} from "../../src/component/prompt/voice-input"

const registration = voiceRegistration()!
const audio = (overrides?: Partial<{ name: string; mediaType: string; size: number; source: "file" | "recording" }>) => ({
  name: overrides?.name ?? "clip.wav",
  mediaType: overrides?.mediaType ?? "audio/wav",
  bytes: new Uint8Array(overrides?.size ?? 4),
  source: overrides?.source ?? ("file" as const),
})

describe("registration + privacy (§5.3)", () => {
  test("the default registration is the item-1 façade's openai/whisper-1", () => {
    expect(registration.ref).toBe("openai/whisper-1")
    expect(registration.audioLeavesMachine).toBe(true)
    expect(registration.capabilities.maxDurationSeconds).toBe(600)
  })

  test("the pre-submit notice surfaces audio_leaves_machine and retention", () => {
    const notice = voicePrivacyNotice(registration)
    expect(notice).toContain("will leave this machine")
    expect(notice).toContain("openai")
    expect(notice).toContain(registration.retention)
  })

  test("a local registration's notice promises audio stays on the machine", () => {
    const notice = voicePrivacyNotice({ ...registration, audioLeavesMachine: false })
    expect(notice).toContain("stays on this machine")
  })
})

describe("validation (§5.2 caps)", () => {
  test("accepts a wav under the caps", () => {
    expect(validateVoiceAudio(registration, { name: "a.wav", mediaType: "audio/wav", size: 1024 })).toBeUndefined()
  })

  test("rejects an empty file", () => {
    expect(validateVoiceAudio(registration, { name: "a.wav", mediaType: "audio/wav", size: 0 })).toContain("empty")
  })

  test("rejects over the 25 MiB upload cap with the cap named", () => {
    const problem = validateVoiceAudio(registration, {
      name: "a.wav",
      mediaType: "audio/wav",
      size: 26 * 1024 * 1024,
    })
    expect(problem).toContain("25 MiB")
  })

  test("rejects an unsupported media type naming accepted types", () => {
    const problem = validateVoiceAudio(registration, { name: "a.mkv", mediaType: "video/x-matroska", size: 10 })
    expect(problem).toContain("does not accept")
    expect(problem).toContain("wav")
  })

  test("media type falls back to the file extension", () => {
    expect(voiceMediaType("note.m4a")).toBe("audio/x-m4a")
    expect(voiceMediaType("note.bin")).toBe("")
    expect(voiceMediaType("note.bin", "audio/ogg")).toBe("audio/ogg")
  })
})

describe("state machine (§6.1/§6.2)", () => {
  test("attach lands in reviewing, never auto-submits", () => {
    const machine = new VoiceInputMachine(registration)
    expect(machine.attach(audio()).state).toBe("reviewing")
    expect(machine.snapshot.audio?.name).toBe("clip.wav")
  })

  test("an invalid attach lands in error with no audio held", () => {
    const machine = new VoiceInputMachine(registration)
    const snapshot = machine.attach(audio({ mediaType: "video/x-matroska" }))
    expect(snapshot.state).toBe("error")
    expect(snapshot.audio).toBeUndefined()
    expect(snapshot.error).toContain("does not accept")
  })

  test("cancel in reviewing discards the audio immediately", () => {
    const machine = new VoiceInputMachine(registration)
    machine.attach(audio())
    const snapshot = machine.cancel()
    expect(snapshot.state).toBe("idle")
    expect(snapshot.audio).toBeUndefined()
  })

  test("recording ticks to the 600s cap and stops there (no auto-submit)", () => {
    const machine = new VoiceInputMachine(registration)
    machine.startRecording()
    expect(machine.tick(599)).toBe(false)
    expect(machine.tick(1)).toBe(true)
    const snapshot = machine.finishRecording(audio({ source: "recording" }))
    expect(snapshot.state).toBe("reviewing")
  })

  test("cancel in recording returns to idle", () => {
    const machine = new VoiceInputMachine(registration)
    machine.startRecording()
    machine.tick(3)
    expect(machine.cancel().state).toBe("idle")
  })

  test("submit → fail retains the audio in error for retry; complete clears it and keeps provenance", () => {
    const machine = new VoiceInputMachine(registration)
    machine.attach(audio())
    expect(machine.beginSubmit().state).toBe("submitting")
    const failed = machine.fail("provider busy")
    expect(failed.state).toBe("error")
    expect(failed.audio?.name).toBe("clip.wav")
    expect(machine.beginSubmit().state).toBe("submitting")
    const done = machine.complete({ provider: "openai", model: "whisper-1", durationSeconds: 3.5 })
    expect(done.state).toBe("idle")
    expect(done.audio).toBeUndefined()
    expect(done.lastProvenance?.model).toBe("whisper-1")
  })
})

describe("façade client (§2.3 envelope, §2.4 errors)", () => {
  const okFetch = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  test("posts multipart with the model ref and maps the envelope to text + provenance", async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, init }
      return new Response(
        JSON.stringify({
          text: "hello from voice",
          language: "en",
          duration: 2.25,
          provider_metadata: { provider: "openai", model: "whisper-1" },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const result = await submitVoiceTranscription({
      url: "http://localhost:4096/",
      headers: { Authorization: "Basic x" },
      fetch: spy,
      registration,
      audio: audio(),
    })
    expect(seen?.url).toBe("http://localhost:4096/v1/audio/transcriptions")
    const form = seen?.init?.body as FormData
    expect(form.get("model")).toBe("openai/whisper-1")
    expect((form.get("file") as File).name).toBe("clip.wav")
    // No provider key is ever sent by the client (§3) — only the
    // server session headers the caller passed in.
    expect(Object.keys(seen?.init?.headers ?? {})).toEqual(["Authorization"])
    expect(result.text).toBe("hello from voice")
    expect(result.provenance).toEqual({ provider: "openai", model: "whisper-1", durationSeconds: 2.25, language: "en" })
  })

  test("a typed façade error surfaces its actionable message and code", async () => {
    await expect(
      submitVoiceTranscription({
        url: "http://localhost:4096",
        fetch: okFetch({ error: { message: "audio is 1 bytes; the cap is 2", type: "invalid_request_error", code: "audio_too_large" } }, 413),
        registration,
        audio: audio(),
      }),
    ).rejects.toMatchObject({ code: "audio_too_large", status: 413 })
  })

  test("401 maps to a reconnect instruction, not the raw payload", async () => {
    const error = await submitVoiceTranscription({
      url: "http://localhost:4096",
      fetch: okFetch({ error: { message: "unauthorized", type: "authentication_error", code: "x" } }, 401),
      registration,
      audio: audio(),
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(VoiceTranscriptionError)
    expect((error as Error).message).toContain("authentication")
  })

  test("a network failure keeps the audio-retry guidance", async () => {
    const error = await submitVoiceTranscription({
      url: "http://localhost:4096",
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
      registration,
      audio: audio(),
    }).catch((caught) => caught)
    expect((error as Error).message).toContain("still held locally")
  })
})

describe("capture detection (§6.1)", () => {
  test("no recorder on the platform → affordance hidden (undefined)", () => {
    expect(detectRecorder(() => false, "linux")).toBeUndefined()
    expect(recorderCandidates("win32")).toEqual([])
  })

  test("ffmpeg is preferred and records 16 kHz mono wav", () => {
    const candidate = detectRecorder((command) => command === "ffmpeg" || command === "arecord", "linux")
    expect(candidate?.command).toBe("ffmpeg")
    expect(candidate?.args("/tmp/x.wav")).toContain("alsa")
    expect(candidate?.args("/tmp/x.wav").at(-1)).toBe("/tmp/x.wav")
  })

  test("arecord is the fallback when ffmpeg is absent", () => {
    expect(detectRecorder((command) => command === "arecord", "linux")?.command).toBe("arecord")
    expect(detectRecorder((command) => command === "ffmpeg", "darwin")?.args("/tmp/x.wav")).toContain("avfoundation")
  })
})

test("formatVoiceClock renders m:ss", () => {
  expect(formatVoiceClock(0)).toBe("0:00")
  expect(formatVoiceClock(65)).toBe("1:05")
  expect(formatVoiceClock(600)).toBe("10:00")
})
