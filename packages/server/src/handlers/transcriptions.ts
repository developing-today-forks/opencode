import { Cause, Effect, Option, Result, Stream } from "effect"
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Completions } from "@opencode/core/completions"
import { Model } from "@opencode/core/model"
import { TranscriptionFacade } from "@opencode/core/transcription-facade"

/**
 * The STT door's route handler (#2385, design §2): POST
 * /v1/audio/transcriptions. It lives in its own handler file and is
 * registered alongside the completions handler in that builder's
 * chain (handlers/completions.ts). The handler owns the multipart
 * surface only — parsing, registry resolution, envelope shaping and
 * error mapping live in @opencode/core/transcription-facade,
 * mirroring how the embeddings door splits work between the server
 * handlers and core.
 */

const errorType = (status: number) =>
  status === 401
    ? "authentication_error"
    : status === 429
      ? "rate_limit_error"
      : status >= 500
        ? "server_error"
        : "invalid_request_error"

const errorResponse = (status: number, message: string, code: string) =>
  HttpServerResponse.jsonUnsafe(Completions.errorBody(message, errorType(status), code), { status })

interface TranscriptionRequestContext {
  readonly request: HttpServerRequest.HttpServerRequest
}

export const transcriptionRoute = (ctx: TranscriptionRequestContext) =>
  Effect.gen(function* () {
    const contentType = Option.getOrElse(Headers.get(ctx.request.headers, "content-type"), () => "")
    const body = yield* ctx.request.arrayBuffer.pipe(Effect.catchCause(() => Effect.succeed(null)))
    const form = body
      ? yield* Effect.promise(() =>
          new Response(body, { headers: { "content-type": contentType } }).formData(),
        ).pipe(Effect.catchCause(() => Effect.succeed(null)))
      : null
    if (!form) return errorResponse(400, "request body must be multipart/form-data", "invalid_audio")
    const fields: Record<string, string | string[]> = {}
    let file: TranscriptionFacade.TranscriptionFormFile | undefined
    // The project's lib types type FormData entry values as strings
    // only; at runtime file parts are File values, hence the cast.
    const entries = (form as unknown as { entries(): Iterable<[string, string | File]> }).entries()
    for (const [name, value] of entries) {
      if (typeof value === "string") {
        const existing = fields[name]
        if (existing === undefined) fields[name] = value
        else if (Array.isArray(existing)) existing.push(value)
        else fields[name] = [existing, value]
        continue
      }
      if (name === "file" && file === undefined) {
        const bytes = new Uint8Array(yield* Effect.promise(() => value.arrayBuffer()))
        file = {
          bytes,
          mediaType: value.type,
          ...(value.name ? { filename: value.name } : {}),
        }
      }
    }
    // Config gating identical to chat providers (§3): a provider
    // absent from the location's enabled catalog has its
    // transcription refs vanish from resolution too.
    const models = yield* Model.Service
    const catalog = yield* models.catalog()
    const enabledProviders = new Set(catalog.map((model) => model.providerID))
    const parsed = TranscriptionFacade.parseTranscriptionRequest({ fields, file }, enabledProviders)
    if (!parsed.ok) return errorResponse(parsed.error.status, parsed.error.message, parsed.error.code)
    const facade = yield* TranscriptionFacade.Service
    if (!parsed.value.stream) {
      const result = yield* Effect.result(facade.transcribe(parsed.value))
      if (Result.isFailure(result))
        return errorResponse(result.failure.status, result.failure.message, result.failure.code)
      return HttpServerResponse.jsonUnsafe(
        TranscriptionFacade.transcriptionBody(result.success, parsed.value.registration, parsed.value.responseFormat),
      )
    }
    // Phase-2 streaming (§7/§8.5): SSE frames of transcript.text.delta /
    // transcript.text.segment / transcript.text.done, terminated by
    // `data: [DONE]`. Setup failures (missing provider key, unwired
    // factory) still answer with the §2.4 JSON error — the stream has
    // not started; failures after the first frame ride the stream as
    // one error frame and no [DONE] follows, mirroring the chat
    // façades' streaming translation.
    const streamResult = yield* Effect.result(facade.transcribeStream(parsed.value))
    if (Result.isFailure(streamResult))
      return errorResponse(streamResult.failure.status, streamResult.failure.message, streamResult.failure.code)
    let finished = false
    let failed = false
    const frames = streamResult.success.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type === "finish") finished = true
        }),
      ),
      Stream.flatMap((event) => {
        const frame = TranscriptionFacade.transcriptionStreamFrame(
          event,
          parsed.value.registration,
          parsed.value.responseFormat,
        )
        return frame === undefined ? Stream.empty : Stream.make(`data: ${frame}\n\n`)
      }),
      Stream.catchCause((cause) => {
        const failure: unknown = Cause.squash(cause)
        failed = true
        const shape =
          failure instanceof TranscriptionFacade.FacadeError
            ? failure
            : { status: 502, code: "upstream_failure", message: "transcription stream failed" }
        return Stream.make(
          `data: ${JSON.stringify(Completions.errorBody(shape.message, errorType(shape.status), shape.code))}\n\n`,
        )
      }),
      Stream.concat(Stream.suspend(() => (finished && !failed ? Stream.make("data: [DONE]\n\n") : Stream.empty))),
    )
    return HttpServerResponse.stream(frames.pipe(Stream.encodeText), {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
