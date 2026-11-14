import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { TranscriptionFacade } from "@opencode/core/transcription-facade"
import { TranscriptionResponse } from "@opencode/ai"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

/**
 * HTTP-level tests for the STT door (#2385). The façade service is
 * replaced with a stub; the typed-error behavior of the full parse +
 * registry path is covered in packages/core/test/transcription-facade.test.ts.
 * This test server's catalog enables no providers (models fetch is
 * off), which is itself one of the cases under test: a disabled or
 * unconfigured provider's transcription refs vanish (§3 gating).
 */
const fakeFacade = makeLocationNode({
  service: TranscriptionFacade.Service,
  layer: Layer.succeed(
    TranscriptionFacade.Service,
    TranscriptionFacade.Service.of({
      transcribe: () => Effect.succeed(new TranscriptionResponse({ text: "probe transcript", language: "en" })),
      transcribeStream: () => Effect.succeed(Stream.empty),
    }),
  ),
  deps: [],
})

const setup = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-stt-door-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ model: "base/default" })))
  return yield* ServerFetch.make(
    {
      database: { path: ":memory:" },
      config: { directory: global },
      fs: { filewatcher: false },
      models: { fetch: false },
    },
    { overrides: [TranscriptionFacade.node.replace(fakeFacade)] },
  )
})

const postForm = (handler: (request: Request) => Promise<Response>, form: FormData) =>
  Effect.promise(() => handler(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form })))

it.live("a provider absent from the enabled catalog vanishes: 404 model_not_found in the §2.4 envelope", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const form = new FormData()
    form.set("model", "openai/whisper-1")
    form.set("file", new File([new Uint8Array([1, 2, 3])], "note.mp3", { type: "audio/mpeg" }))
    const response = yield* postForm(handler, form)
    expect(response.status).toBe(404)
    const body = yield* Effect.promise(() => response.json())
    expect(body.error.code).toBe("model_not_found")
    expect(body.error.type).toBe("invalid_request_error")
  }),
)

it.live("a missing model field is a typed 400 before anything else", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const form = new FormData()
    form.set("file", new File([new Uint8Array([1, 2, 3])], "note.mp3", { type: "audio/mpeg" }))
    const response = yield* postForm(handler, form)
    expect(response.status).toBe(400)
    const body = yield* Effect.promise(() => response.json())
    expect(body.error.code).toBe("invalid_request")
  }),
)

it.live("a non-multipart body is a typed 400 invalid_audio, never a 500", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://localhost/v1/audio/transcriptions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/whisper-1" }),
        }),
      ),
    )
    expect(response.status).toBe(400)
    const body = yield* Effect.promise(() => response.json())
    expect(body.error.code).toBe("invalid_audio")
  }),
)

it.live("stream=true keeps the same §3 gating: a vanished provider's ref is 404, never an SSE 200", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const form = new FormData()
    form.set("model", "google/gemini-3.5-transcribe")
    form.set("stream", "true")
    form.set("file", new File([new Uint8Array([1, 2, 3])], "note.mp3", { type: "audio/mpeg" }))
    const response = yield* postForm(handler, form)
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).not.toContain("text/event-stream")
    const body = yield* Effect.promise(() => response.json())
    expect(body.error.code).toBe("model_not_found")
  }),
)
