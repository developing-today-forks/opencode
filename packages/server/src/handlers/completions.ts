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
import { OpenAIFacadeResponse } from "@opencode/core/openai-facade-response"

const streamErrorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "completion failed"
}

/**
 * Whether a streaming failure is the quota/rate-limit class (#1441):
 * Generate surfaces that class as its own tagged error, so a stream
 * that fails before (or instead of) producing output answers in the
 * door's established error form, typed as a rate-limit failure, with
 * the provider's message — reset hint included — preserved.
 */
const streamIsQuota = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return (
    !!error &&
    typeof error === "object" &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "Generate.QuotaError"
  )
}

/**
 * The request body as raw text plus its parsed form. The raw text is the
 * pass-through candidate (#1146): on a dialect match Generate forwards it
 * byte-for-byte, so the door must not round-trip it through JSON first.
 * Unparseable bodies parse to null and fail wire validation as before.
 */
const requestBody = (ctx: { request: { text: Effect.Effect<string, unknown> } }) =>
  ctx.request.text.pipe(
    Effect.catchCause(() => Effect.succeed("")),
    Effect.map((raw) => {
      try {
        return { raw, body: JSON.parse(raw) as unknown }
      } catch {
        return { raw, body: null }
      }
    }),
  )

const errorResponse = (status: number, message: string, type: string, code?: string) =>
  HttpServerResponse.jsonUnsafe(Completions.errorBody(message, type, code), { status })

// Design §2 error mapping (#1441): quota/rate-limit failures answer
// 429 with the provider's message (reset hint included) preserved;
// selection failures are the caller's 400; everything else upstream
// stays the generic 502.
const serviceError = (error: Generate.Error) =>
  error._tag === "Generate.ModelSelectionError"
    ? errorResponse(400, error.message, "invalid_request_error")
    : error._tag === "Generate.QuotaError"
      ? errorResponse(429, error.message, "rate_limit_error")
      : errorResponse(502, error.message, "server_error")

const messagesErrorResponse = (status: number, message: string, type: string) =>
  HttpServerResponse.jsonUnsafe(Completions.messagesErrorBody(message, type), { status })

const messagesServiceError = (error: Generate.Error) =>
  error._tag === "Generate.ModelSelectionError"
    ? messagesErrorResponse(400, error.message, "invalid_request_error")
    : error._tag === "Generate.QuotaError"
      ? messagesErrorResponse(429, error.message, "rate_limit_error")
      : messagesErrorResponse(502, error.message, "api_error")


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
            const { raw, body } = yield* requestBody(ctx)
            const parsed = Completions.parseChatRequest(body)
            if (!parsed.ok) return errorResponse(400, parsed.error, "invalid_request_error")
            const input = { ...parsed.value.input, dialect: "chat" as const, rawBody: raw }
            const generate = yield* Generate.Service
            const meta = {
              id: Completions.completionId(),
              created: Math.floor(Date.now() / 1000),
              model: parsed.value.modelLabel,
            }
            if (!parsed.value.stream) {
              const result = yield* Effect.result(generate.complete(input))
              if (Result.isFailure(result)) return serviceError(result.failure)
              return HttpServerResponse.jsonUnsafe(Completions.completionBody({ ...meta, response: result.success }))
            }
            const translator = new Completions.ChatStreamTranslator(meta)
            const frames = generate
              .stream(input)
              .pipe(
                Stream.flatMap((event) => Stream.fromIterable(translator.push(event))),
                Stream.catchCause((cause) =>
                  Stream.make(
                    Completions.errorFrame(
                      streamErrorMessage(cause),
                      streamIsQuota(cause) ? "rate_limit_error" : "server_error",
                    ),
                  ),
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
            const { raw, body } = yield* requestBody(ctx)
            const parsed = Completions.parseResponsesRequest(body)
            if (!parsed.ok) return errorResponse(400, parsed.error, "invalid_request_error")
            const generate = yield* Generate.Service
            const store = yield* OpenAIFacadeResponse.Service
            const meta = {
              id: Completions.responseId(),
              created: Math.floor(Date.now() / 1000),
              model: parsed.value.modelLabel,
            }
            // Chain resolution (#1149, design §4): the referenced row's
            // stored items are the cumulative history, so exactly one row
            // is loaded and prepended to this turn's input. An unknown or
            // expired id is OpenAI's 404 `response_not_found`; a chain
            // already at the depth bound is a 400 asking for a full resend.
            let input = parsed.value.input
            let parent: OpenAIFacadeResponse.Stored | undefined
            if (parsed.value.previousResponseId) {
              parent = yield* store.get(parsed.value.previousResponseId)
              if (!parent)
                return errorResponse(
                  404,
                  `response not found: ${parsed.value.previousResponseId}`,
                  "invalid_request_error",
                  "response_not_found",
                )
              if (parent.depth >= OpenAIFacadeResponse.MAX_CHAIN_DEPTH)
                return errorResponse(
                  400,
                  `previous_response_id chain is already ${OpenAIFacadeResponse.MAX_CHAIN_DEPTH} links deep; resend the full input to start a new chain`,
                  "invalid_request_error",
                )
              const chained = Completions.chainResponsesInput(parsed.value, parent.responseItems)
              if (!chained.ok) return errorResponse(400, chained.error, "invalid_request_error")
              input = chained.input
            }
            // Pass-through (#1146, spec §3): an unchained request may forward
            // its raw body on a dialect match. A chained request never does —
            // its raw body names a façade-owned previous_response_id and
            // carries only this turn's items, while the provider needs the
            // history the chain resolution just materialized into `input`;
            // the store records no native/translated provenance that would
            // license forwarding the façade-owned id upstream.
            const generateInput = parsed.value.previousResponseId
              ? input
              : { ...input, dialect: "responses" as const, rawBody: raw }
            // Every completed response — streamed or not — is persisted so
            // it can be chained from. A store failure must not lose an
            // answer the provider already produced: it is logged loudly,
            // and the id simply will not resolve for a later chain (404).
            const persist = (
              outputItems: ReadonlyArray<Record<string, unknown>>,
              usage: Record<string, unknown> | undefined,
            ) =>
              store
                .put({
                  id: meta.id,
                  createdAt: meta.created * 1000,
                  ...(parsed.value.previousResponseId ? { previousResponseId: parsed.value.previousResponseId } : {}),
                  depth: parent ? parent.depth + 1 : 0,
                  model: parsed.value.modelLabel,
                  resolvedModel: parsed.value.modelRef,
                  requestItems: parsed.value.items,
                  responseItems: [...(parent?.responseItems ?? []), ...parsed.value.items, ...outputItems],
                  ...(usage ? { usage } : {}),
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to persist façade response for chaining", { cause }),
                  ),
                )
            if (!parsed.value.stream) {
              const result = yield* Effect.result(generate.complete(generateInput))
              if (Result.isFailure(result)) return serviceError(result.failure)
              const responseBody = Completions.responsesBody({
                ...meta,
                response: result.success,
                previousResponseId: parsed.value.previousResponseId,
              })
              yield* persist(responseBody.output, responseBody.usage)
              return HttpServerResponse.jsonUnsafe(responseBody)
            }
            const translator = new Completions.ResponsesStreamTranslator({
              ...meta,
              previousResponseId: parsed.value.previousResponseId,
            })
            const frames = generate
              .stream(generateInput)
              .pipe(
                // On the finish event the translator has accumulated the
                // full text and tool calls; persist before the terminal
                // frame goes out so the id is chainable once the client
                // has seen response.completed.
                Stream.tap((event) =>
                  event.type === "finish"
                    ? persist(translator.outputItems(), Completions.responsesUsageBody(event.usage))
                    : Effect.void,
                ),
                Stream.flatMap((event) => Stream.fromIterable(translator.push(event))),
                // The translator failure frame continues the stream
                // sequence numbers (#1442) instead of restarting them;
                // a quota failure carries the #1441 rate-limit code.
                Stream.catchCause((cause) =>
                  Stream.make(
                    translator.failureFrame(
                      streamErrorMessage(cause),
                      streamIsQuota(cause) ? "rate_limit_exceeded" : undefined,
                    ),
                  ),
                ),
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
      .handleRaw(
        "completions.messages",
        (ctx) =>
          Effect.gen(function* () {
            yield* awaitPlugins
            const { raw, body } = yield* requestBody(ctx)
            const parsed = Completions.parseMessagesRequest(body)
            if (!parsed.ok) return messagesErrorResponse(400, parsed.error, "invalid_request_error")
            const input = { ...parsed.value.input, dialect: "messages" as const, rawBody: raw }
            const generate = yield* Generate.Service
            const meta = { id: Completions.messageId(), model: parsed.value.modelLabel }
            if (!parsed.value.stream) {
              const result = yield* Effect.result(generate.complete(input))
              if (Result.isFailure(result)) return messagesServiceError(result.failure)
              return HttpServerResponse.jsonUnsafe(Completions.messagesBody({ ...meta, response: result.success }))
            }
            const translator = new Completions.MessagesStreamTranslator(meta)
            const frames = generate
              .stream(input)
              .pipe(
                Stream.flatMap((event) => Stream.fromIterable(translator.push(event))),
                Stream.catchCause((cause) =>
                  Stream.make(
                    Completions.messagesErrorFrame(
                      streamErrorMessage(cause),
                      streamIsQuota(cause) ? "rate_limit_error" : "api_error",
                    ),
                  ),
                ),
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
