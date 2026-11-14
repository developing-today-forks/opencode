// Voice input for the TUI composer — #2387, design §6 of
// specs/2026-11-08_design_voice-input-stt-facade.md (adopted, PR #2032).
//
// The composer offers two entry points against the item-1 STT façade
// (POST /v1/audio/transcriptions, #2385): attach an existing audio file
// (§5.1) and record from the microphone (§6.1). Both land in the same
// review-before-send state (§6.2): audio is never auto-submitted and a
// transcript is never auto-sent — on success the transcript is inserted
// into the composer as editable draft text (§6.3). Before submission the
// resolved registration's `audio_leaves_machine` flag is surfaced (§5.3)
// via `voicePrivacyNotice`.
//
// No STT provider key ever reaches this client (§3): the façade owns
// provider keys; this module authenticates with the server session
// headers the TUI already holds and sends only the multipart form.

import {
  TRANSCRIPTION_MODELS,
  resolveTranscriptionModel,
  type TranscriptionModelRegistration,
} from "@opencode/core/transcription-facade"

export type { TranscriptionModelRegistration }

export const DEFAULT_VOICE_MODEL: string | undefined = TRANSCRIPTION_MODELS[0]?.ref

/** Resolve a model label (or the default registration) to the registry
 * entry the client surfaces caps/privacy from. Mirrors the façade's own
 * resolution so what the composer promises matches what the server
 * enforces. */
export function voiceRegistration(label?: string): TranscriptionModelRegistration | undefined {
  const resolved = resolveTranscriptionModel(label ?? DEFAULT_VOICE_MODEL)
  return typeof resolved === "string" ? undefined : resolved
}

export interface VoiceAudio {
  readonly name: string
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly source: "file" | "recording"
  readonly durationSeconds?: number
}

export interface VoiceProvenance {
  readonly provider: string
  readonly model: string
  readonly durationSeconds?: number
  readonly language?: string
}

export type VoiceStateName = "idle" | "recording" | "reviewing" | "submitting" | "error"

export interface VoiceSnapshot {
  readonly state: VoiceStateName
  readonly audio?: VoiceAudio
  readonly elapsedSeconds: number
  readonly error?: string
  readonly lastProvenance?: VoiceProvenance
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

export function voiceMediaType(name: string, declared?: string): string {
  if (declared) return declared
  const extension = name.split(".").pop()?.toLowerCase()
  return (extension ? EXTENSION_MEDIA_TYPES[extension] : undefined) ?? ""
}

function acceptedExtensions(registration: TranscriptionModelRegistration): string {
  const extensions = Object.entries(EXTENSION_MEDIA_TYPES)
    .filter(([, mediaType]) => registration.capabilities.mediaTypes.includes(mediaType))
    .map(([extension]) => extension)
  return extensions.join(", ")
}

/** Client-side pre-flight of the §5.2 caps, so an oversized or
 * unsupported file fails in the composer with an actionable message
 * instead of a raw façade payload. The façade re-checks server-side. */
export function validateVoiceAudio(
  registration: TranscriptionModelRegistration,
  audio: { name: string; mediaType: string; size: number },
): string | undefined {
  if (audio.size === 0) return "The audio file is empty — pick a recording with sound in it."
  if (audio.size > registration.maxUploadBytes)
    return `Audio is ${(audio.size / (1024 * 1024)).toFixed(1)} MiB; ${registration.ref} accepts at most ${(registration.maxUploadBytes / (1024 * 1024)).toFixed(0)} MiB. Trim or split the recording and try again.`
  if (!registration.capabilities.mediaTypes.includes(audio.mediaType))
    return `${registration.ref} does not accept ${audio.mediaType || "this file type"}; accepted types: ${acceptedExtensions(registration)}. Convert the file and try again.`
  return undefined
}

/** The §5.3 pre-submit surfacing: whether the audio leaves this machine
 * for the resolved registration, and whose retention policy then
 * applies. Shown in the review state before any submission happens. */
export function voicePrivacyNotice(registration: TranscriptionModelRegistration): string {
  if (!registration.audioLeavesMachine)
    return `Audio stays on this machine: ${registration.ref} is a local backend. ${registration.retention}`
  return `Audio will leave this machine for transcription by ${registration.providerID} (${registration.ref}). ${registration.retention}`
}

export function formatVoiceClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/**
 * The §6.1 recording state machine, framework-free so the flows are
 * testable at the level the TUI's other input features are tested:
 * idle → recording → reviewing → submitting → idle (inserted), with
 * cancel available in recording and reviewing (audio discarded
 * immediately and locally), and error retaining the audio so the user
 * can retry or discard (§6.2).
 */
export class VoiceInputMachine {
  #snapshot: VoiceSnapshot = { state: "idle", elapsedSeconds: 0 }
  readonly #registration: TranscriptionModelRegistration

  constructor(registration: TranscriptionModelRegistration) {
    this.#registration = registration
  }

  get snapshot(): VoiceSnapshot {
    return this.#snapshot
  }

  get registration(): TranscriptionModelRegistration {
    return this.#registration
  }

  /** Attach an existing audio file (§5.1): validated, then reviewing. */
  attach(audio: VoiceAudio): VoiceSnapshot {
    if (this.#snapshot.state === "recording" || this.#snapshot.state === "submitting") return this.#snapshot
    const problem = validateVoiceAudio(this.#registration, {
      name: audio.name,
      mediaType: audio.mediaType,
      size: audio.bytes.length,
    })
    if (problem) {
      this.#snapshot = { state: "error", elapsedSeconds: 0, error: problem }
      return this.#snapshot
    }
    this.#snapshot = { state: "reviewing", audio, elapsedSeconds: 0 }
    return this.#snapshot
  }

  startRecording(): VoiceSnapshot {
    if (this.#snapshot.state !== "idle" && this.#snapshot.state !== "error") return this.#snapshot
    this.#snapshot = { state: "recording", elapsedSeconds: 0 }
    return this.#snapshot
  }

  /** Advance the recording clock. Returns true when the §5.2 duration
   * cap is hit — capture stops and moves to reviewing, never
   * auto-submits (§6.1); the caller stops the recorder and calls
   * finishRecording with the captured bytes. */
  tick(seconds: number): boolean {
    if (this.#snapshot.state !== "recording") return false
    const elapsedSeconds = this.#snapshot.elapsedSeconds + seconds
    this.#snapshot = { ...this.#snapshot, elapsedSeconds }
    return elapsedSeconds >= this.#registration.capabilities.maxDurationSeconds
  }

  finishRecording(audio: VoiceAudio): VoiceSnapshot {
    if (this.#snapshot.state !== "recording") return this.#snapshot
    const problem = validateVoiceAudio(this.#registration, {
      name: audio.name,
      mediaType: audio.mediaType,
      size: audio.bytes.length,
    })
    if (problem) {
      this.#snapshot = { state: "error", elapsedSeconds: 0, error: problem }
      return this.#snapshot
    }
    this.#snapshot = { state: "reviewing", audio, elapsedSeconds: 0 }
    return this.#snapshot
  }

  /** Cancel/discard from recording, reviewing, or error: the captured
   * audio is dropped immediately and locally (§6.1/§6.2). */
  cancel(): VoiceSnapshot {
    if (this.#snapshot.state === "submitting") return this.#snapshot
    this.#snapshot = { state: "idle", elapsedSeconds: 0, lastProvenance: this.#snapshot.lastProvenance }
    return this.#snapshot
  }

  beginSubmit(): VoiceSnapshot {
    const audio = this.#snapshot.audio
    if (!audio || (this.#snapshot.state !== "reviewing" && this.#snapshot.state !== "error")) return this.#snapshot
    this.#snapshot = { state: "submitting", audio, elapsedSeconds: 0 }
    return this.#snapshot
  }

  /** A façade failure (§2.4) renders as an actionable composer state
   * with the audio retained locally for retry/discard (§6.2). */
  fail(message: string): VoiceSnapshot {
    const audio = this.#snapshot.audio
    this.#snapshot = audio
      ? { state: "error", audio, elapsedSeconds: 0, error: message }
      : { state: "error", elapsedSeconds: 0, error: message }
    return this.#snapshot
  }

  /** Submission succeeded and the transcript was inserted as draft
   * (§6.3): provenance is kept for the insertion affordance. */
  complete(provenance: VoiceProvenance): VoiceSnapshot {
    this.#snapshot = { state: "idle", elapsedSeconds: 0, lastProvenance: provenance }
    return this.#snapshot
  }
}

export class VoiceTranscriptionError extends Error {
  readonly code?: string
  readonly status?: number
  constructor(message: string, options?: { code?: string; status?: number }) {
    super(message)
    this.name = "VoiceTranscriptionError"
    this.code = options?.code
    this.status = options?.status
  }
}

function actionableError(status: number, code: string | undefined, message: string): VoiceTranscriptionError {
  if (status === 401 || code === "authentication_error")
    return new VoiceTranscriptionError(
      "The server rejected the transcription request's authentication. Reconnect to the server and try again.",
      { code, status },
    )
  if (status === 429 || code === "rate_limit_error")
    return new VoiceTranscriptionError(
      "The transcription provider is rate-limiting requests. Wait a moment, then retry — your audio is still held locally.",
      { code, status },
    )
  if (code === "model_not_found")
    return new VoiceTranscriptionError(
      `${message} Set OPENCODE_TRANSCRIPTION_MODEL to a registered ref and try again.`,
      { code, status },
    )
  // The façade's §2.4 messages are written to be acted on (caps,
  // accepted media types, unsupported options) — surface them as-is
  // rather than a raw payload dump.
  return new VoiceTranscriptionError(message, { code, status })
}

export interface VoiceTranscriptionResult {
  readonly text: string
  readonly provenance: VoiceProvenance
}

/** One batch call to the façade (§6.2: submitting calls the façade
 * once). Parses the §2.3 normalized envelope and maps §2.4 typed
 * errors to actionable composer messages. */
export async function submitVoiceTranscription(input: {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  readonly registration: TranscriptionModelRegistration
  readonly audio: VoiceAudio
  readonly language?: string
}): Promise<VoiceTranscriptionResult> {
  const doFetch = input.fetch ?? fetch
  const form = new FormData()
  form.set("file", new Blob([input.audio.bytes as BlobPart], { type: input.audio.mediaType }), input.audio.name)
  form.set("model", input.registration.ref)
  if (input.language) form.set("language", input.language)
  const endpoint = `${input.url.replace(/\/$/, "")}/v1/audio/transcriptions`
  let response: Response
  try {
    response = await doFetch(endpoint, { method: "POST", headers: { ...input.headers }, body: form })
  } catch {
    throw new VoiceTranscriptionError(
      `Could not reach the transcription façade at ${endpoint}. Check that the server is running, then retry — your audio is still held locally.`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = (body as { error?: { message?: string; code?: string } } | undefined)?.error
    throw actionableError(response.status, error?.code, error?.message ?? `Transcription failed (HTTP ${response.status}).`)
  }
  const envelope = body as {
    text?: string
    language?: string
    duration?: number
    provider_metadata?: { provider?: string; model?: string }
  }
  if (typeof envelope?.text !== "string")
    throw new VoiceTranscriptionError("The façade answered without a transcript. Retry, or discard the audio and re-record.")
  return {
    text: envelope.text,
    provenance: {
      provider: envelope.provider_metadata?.provider ?? input.registration.providerID,
      model: envelope.provider_metadata?.model ?? input.registration.modelID,
      ...(envelope.duration !== undefined ? { durationSeconds: envelope.duration } : {}),
      ...(envelope.language !== undefined ? { language: envelope.language } : {}),
    },
  }
}

// ------------------------------------------------------------ capture (§6.1)
//
// Capture uses the terminal host's microphone access via the platform
// audio path available to the Bun process: an external recorder
// (ffmpeg / arecord / sox `rec`) writing a WAV file. Where no capture
// path exists the record affordance is hidden and file attach remains
// — a visible dead control is worse than an absent one (§6.1).

export interface RecorderCandidate {
  readonly command: string
  readonly args: (outputPath: string) => ReadonlyArray<string>
}

export function recorderCandidates(platform: string): ReadonlyArray<RecorderCandidate> {
  if (platform === "darwin")
    return [
      { command: "ffmpeg", args: (output) => ["-y", "-f", "avfoundation", "-i", ":0", "-ac", "1", "-ar", "16000", output] },
      { command: "rec", args: (output) => ["-r", "16000", "-c", "1", output] },
    ]
  if (platform === "win32") return []
  // linux and other unix: ALSA via ffmpeg or arecord, sox as fallback.
  return [
    { command: "ffmpeg", args: (output) => ["-y", "-f", "alsa", "-i", "default", "-ac", "1", "-ar", "16000", output] },
    { command: "arecord", args: (output) => ["-f", "cd", "-t", "wav", output] },
    { command: "rec", args: (output) => ["-r", "16000", "-c", "1", output] },
  ]
}

export function detectRecorder(
  which: (command: string) => boolean,
  platform: string = process.platform,
): RecorderCandidate | undefined {
  return recorderCandidates(platform).find((candidate) => which(candidate.command))
}

export interface RecorderHandle {
  /** Stop capture, letting the recorder finalize the file (SIGINT is
   * the finalize signal for ffmpeg/arecord/sox). */
  stop(): void
  /** Abandon capture immediately (cancel): the partial file is
   * discarded by the caller. */
  kill(): void
}

export type RecorderSpawn = (command: string, args: ReadonlyArray<string>) => RecorderHandle

export function startRecorder(
  candidate: RecorderCandidate,
  outputPath: string,
  spawn: RecorderSpawn,
): RecorderHandle {
  return spawn(candidate.command, candidate.args(outputPath))
}
