import { Generate } from "@opencode/core/generate"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { Cause, Effect, Result, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"
import { Completions } from "@opencode/core/completions"

const streamErrorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "completion failed"
}

const errorResponse = (status: number, message: string, type: string) =>
  HttpServerResponse.jsonUnsafe(Completions.errorBody(message, type), { status })

const serviceError = (error: Generate.Error) =>
  error._tag === "Generate.ModelSelectionError"
    ? errorResponse(400, error.message, "invalid_request_error")
    : errorResponse(502, error.message, "server_error")

export const CompletionsHandler = HttpApiBuilder.group(Api, "server.completions", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    return handlers
      .handleRaw(
        "completions.chat",
        (ctx) =>
          Effect.gen(function* () {
            yield* awaitPlugins
            const body = yield* ctx.request.json.pipe(Effect.catchCause(() => Effect.succeed(null)))
            const parsed = Completions.parseChatRequest(body)
            if (!parsed.ok) return errorResponse(400, parsed.error, "invalid_request_error")
            const generate = yield* Generate.Service
            const meta = {
              id: Completions.completionId(),
              created: Math.floor(Date.now() / 1000),
              model: parsed.value.modelLabel,
            }
            if (!parsed.value.stream) {
              const result = yield* Effect.result(generate.complete(parsed.value.input))
              if (Result.isFailure(result)) return serviceError(result.failure)
              return HttpServerResponse.jsonUnsafe(Completions.completionBody({ ...meta, response: result.success }))
            }
            const translator = new Completions.ChatStreamTranslator(meta)
            const frames = generate
              .stream(parsed.value.input)
              .pipe(
                Stream.flatMap((event) => Stream.fromIterable(translator.push(event))),
                Stream.catchCause((cause) =>
                  Stream.make(Completions.errorFrame(streamErrorMessage(cause))),
                ),
                Stream.concat(Stream.suspend(() => (translator.failed ? Stream.empty : Stream.make(Completions.DONE_FRAME)))),
                Stream.provide(services),
              )
            return HttpServerResponse.stream(frames.pipe(Stream.encodeText), {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            })
          }).pipe(Effect.provide(services), locationErrors),
      )
      .handleRaw("completions.models", () => Effect.succeed(HttpServerResponse.jsonUnsafe(Completions.modelsBody())))
  }),
)
