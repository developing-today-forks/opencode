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
import { Embeddings } from "@opencode/core/embeddings"

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
      .handleRaw(
        "completions.responses",
        (ctx) =>
          Effect.gen(function* () {
            yield* awaitPlugins
            const body = yield* ctx.request.json.pipe(Effect.catchCause(() => Effect.succeed(null)))
            const parsed = Completions.parseResponsesRequest(body)
            if (!parsed.ok) return errorResponse(400, parsed.error, "invalid_request_error")
            const generate = yield* Generate.Service
            const meta = {
              id: Completions.responseId(),
              created: Math.floor(Date.now() / 1000),
              model: parsed.value.modelLabel,
            }
            if (!parsed.value.stream) {
              const result = yield* Effect.result(generate.complete(parsed.value.input))
              if (Result.isFailure(result)) return serviceError(result.failure)
              return HttpServerResponse.jsonUnsafe(Completions.responsesBody({ ...meta, response: result.success }))
            }
            const translator = new Completions.ResponsesStreamTranslator(meta)
            const failedFrame = (message: string) =>
              `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { id: meta.id, object: "response", created_at: meta.created, model: meta.model, status: "failed", output: [], error: { message } } })}\n\n`
            const frames = generate
              .stream(parsed.value.input)
              .pipe(
                Stream.flatMap((event) => Stream.fromIterable(translator.push(event))),
                Stream.catchCause((cause) => Stream.make(failedFrame(streamErrorMessage(cause)))),
                Stream.provide(services),
              )
            const all = Stream.make(translator.start()).pipe(Stream.concat(frames))
            return HttpServerResponse.stream(all.pipe(Stream.encodeText), {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            })
          }).pipe(Effect.provide(services), locationErrors),
      )
      .handleRaw(
        "completions.embeddings",
        (ctx) =>
          Effect.gen(function* () {
            yield* awaitPlugins
            const body = yield* ctx.request.json.pipe(Effect.catchCause(() => Effect.succeed(null)))
            const parsed = Embeddings.parseEmbeddingsRequest(body)
            if (!parsed.ok) return errorResponse(400, parsed.error, "invalid_request_error")
            const embeddings = yield* Embeddings.Service
            const result = yield* Effect.result(
              embeddings.embed({
                model: parsed.value.model,
                inputs: parsed.value.inputs,
                ...(parsed.value.dimensions !== undefined ? { dimensions: parsed.value.dimensions } : {}),
              }),
            )
            if (Result.isFailure(result)) return errorResponse(502, result.failure.message, "server_error")
            return HttpServerResponse.jsonUnsafe(
              Embeddings.embeddingsBody({
                model: parsed.value.modelLabel,
                vectors: result.success.vectors,
                promptTokens: result.success.promptTokens,
                encodingFormat: parsed.value.encodingFormat,
              }),
            )
          }).pipe(Effect.provide(services), locationErrors),
      )
      .handleRaw("completions.models", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({
            object: "list",
            data: [...Completions.modelsBody().data, ...Embeddings.embeddingModelEntries()],
          }),
        ),
      )
    .handleRaw("completions.model", (ctx) => Effect.succeed(modelByIdResponse(ctx.request.url)))
    .handleRaw("completions.modelRef", (ctx) => Effect.succeed(modelByIdResponse(ctx.request.url)))
  }),
)

// One model by id, shared by the :id endpoint (bare route id, or a full
// provider/model ref URL-encoded as one segment) and the raw two-segment
// :provider/:model endpoint: the id is the path suffix after /v1/models/,
// URL-decoded. Unknown ids answer a loud 404 in the OpenAI error shape.
const modelByIdResponse = (url: string) => {
  const raw = new URL(url, "http://localhost").pathname.slice("/v1/models/".length)
  let id = raw
  try {
    id = decodeURIComponent(raw)
  } catch {
    // A malformed escape is not a served id; it falls through to the 404.
  }
  const model = Completions.modelBody(id)
  return model ? HttpServerResponse.jsonUnsafe(model) : errorResponse(404, `model not found: ${id}`, "invalid_request_error")
}
