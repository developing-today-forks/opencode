import { Cause, Clock, Duration, Effect, Layer, Stream } from "effect"
import { Text } from "@opencode/util/text"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import {
  AIError,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  HttpContext,
  HttpRateLimitDetails,
  timeoutConfig,
  TransportError,
  type ClientTls,
  type HttpTimeout,
  type RequestTimeout,
} from "../schema/index.js"
import { classifyProviderFailure, providerErrorMessage } from "../provider-error.js"
import {
  composeMiddleware,
  CurrentMiddleware,
  CurrentTimeout,
  CurrentTls,
  headerDetails,
  httpError,
  responseStream,
  rootCause,
  Service,
  type HttpMiddleware,
  type HttpOperation,
  type Interface,
} from "./executor-service.js"

export {
  composeMiddleware,
  CurrentMiddleware,
  CurrentTimeout,
  CurrentTls,
  responseBytes,
  responseHttp,
  responseStream,
  responseText,
  Service,
  withMiddleware,
} from "./executor-service.js"
export type { HttpHandler, HttpMiddleware, Interface, RequestExecutorService } from "./executor-service.js"

const normalizedHeaders = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const clampRetryAfterMs = (millis: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(millis)))

// retry-after is RFC 9110 delay-seconds, `1*DIGIT`. retry-after-ms is the
// de-facto millisecond variant and takes an unsigned decimal: digits with an
// optional fraction. Both reject the other spellings Number() accepts (hex,
// exponent, signs), so a malformed header falls through instead of becoming an
// invented wait.
const DELAY_SECONDS = /^\d+$/
const MILLISECONDS = /^\d+(?:\.\d+)?$/

// Date.parse with a calendar check, the local equivalent of core's
// ModelRouteLimits.parseAbsoluteTime (#713; ai does not depend on core, and
// this file already keeps local guards for its sibling parsers): Date.parse
// silently rolls overflow days such as Feb 30 into the next month instead of
// returning NaN, so an ISO date's components must round-trip through a real
// calendar date before the parsed instant is trusted.
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Calendar components of a non-ISO date whose parts are named or ordered unambiguously
 * (#798): "Feb 30 2026", "30 Feb 2026", "2026/02/30". Ambiguous numeric forms (02/03/2026)
 * and shapes without named components keep the lenient bare-parse behaviour. */
function namedDateParts(text: string): readonly [number, number, number] | undefined {
  const ymd = /(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?!\d)/.exec(text)
  if (ymd) return [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  const monthFirst =
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/i.exec(text)
  if (monthFirst)
    return [Number(monthFirst[3]), MONTH_NUMBERS[monthFirst[1].toLowerCase()], Number(monthFirst[2])]
  const dayFirst =
    /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})(?!\d)/i.exec(text)
  if (dayFirst) return [Number(dayFirst[3]), MONTH_NUMBERS[dayFirst[2].toLowerCase()], Number(dayFirst[1])]
  return undefined
}

const parseHttpDate = (text: string): number | undefined => {
  const date = Date.parse(text)
  if (Number.isNaN(date)) return undefined
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  const parts = iso ? ([Number(iso[1]), Number(iso[2]), Number(iso[3])] as const) : namedDateParts(text)
  if (parts) {
    const [year, month, day] = parts
    const probe = new Date(0)
    probe.setUTCFullYear(year, month - 1, day)
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day)
      return undefined
  }
  // V8 rolls hour 24 into the next day instead of returning NaN (minutes/seconds 60+ are
  // Invalid), so a time part must not carry hour > 23 (RFC 3339 time-hour is 00-23).
  const time = /[T ](\d{2}):\d{2}/i.exec(text)
  if (time && Number(time[1]) > 23) return undefined
  return date
}

const retryAfterMs = (headers: Record<string, string>) => {
  // A blank header value is absent, not an authored 0: Number("") === 0 would
  // otherwise discard a valid retry-after carried by the same response.
  const millisHeader = headers["retry-after-ms"]?.trim()
  if (millisHeader && MILLISECONDS.test(millisHeader)) {
    const millis = Number(millisHeader)
    if (Number.isFinite(millis)) return clampRetryAfterMs(millis)
  }

  const value = headers["retry-after"]?.trim()
  if (!value) return undefined

  if (DELAY_SECONDS.test(value)) {
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return clampRetryAfterMs(seconds * 1000)
  }

  const date = parseHttpDate(value)
  if (date !== undefined) return clampRetryAfterMs(date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0)
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })

  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined

  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

/** Rate-limit details a response advertises, on success as well as failure. Undefined when it
 * carries none. Header names are expected lower-cased, as `Headers` holds them. */
export const responseRateLimit = (headers: Record<string, string>) =>
  rateLimitDetails(
    normalizedHeaders(Headers.fromInput(headers)),
    retryAfterMs(normalizedHeaders(Headers.fromInput(headers))),
  )

const MAX_BODY_CHARS = 2000
const MAX_ERROR_BODY_BYTES = 64 * 1024

// Without a recognized message, show the raw body so the provider's explanation is never dropped.
export const providerMessage = (status: number, body: string | void) => {
  const fallback = `Provider request failed with HTTP ${status}`
  const text = body?.trim() ?? ""
  const message = providerErrorMessage(text)
  if (message) return message
  // Gateway and proxy HTML error pages are markup, not an explanation.
  if (!text || /^<(?:!doctype|html)/i.test(text)) return fallback
  return `${fallback}: ${text.length > MAX_BODY_CHARS ? `${Text.truncate(text, MAX_BODY_CHARS)}…` : text}`
}

const statusError = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status < 400) return response
    // Classification sees only the prefix when a provider sends an oversized error body.
    let remaining = MAX_ERROR_BODY_BYTES
    const decoder = new TextDecoder()
    const result = yield* response.stream.pipe(
      Stream.map((chunk) => {
        const bytes = chunk.subarray(0, remaining)
        remaining -= bytes.byteLength
        return { bytes, done: remaining === 0 }
      }),
      Stream.takeUntil((chunk) => chunk.done),
      Stream.runFold(() => "", (text, chunk) => text + decoder.decode(chunk.bytes, { stream: true })),
      Effect.map((text) => text + decoder.decode()),
      Effect.result,
    )
    return yield* httpFailure({
      message: providerMessage(response.status, result._tag === "Success" ? result.success : undefined),
      url: response.request.url,
      status: response.status,
      responseHeaders: headerDetails(response.headers),
      responseBody: result._tag === "Success" ? result.success : undefined,
      cause: result._tag === "Failure" ? rootCause(result.failure) : undefined,
    })
  })

/** Preserve HTTP diagnostics for executor and externally captured failures alike. */
export const httpFailure = (input: {
  readonly message: string
  readonly url?: string | undefined
  readonly status?: number | undefined
  readonly data?: unknown
  readonly responseHeaders?: Record<string, string> | undefined
  readonly responseBody?: string | undefined
  readonly cause?: unknown
}) => {
  const headers = normalizedHeaders(Headers.fromInput(input.responseHeaders))
  const retryAfter = retryAfterMs(headers)
  const rateLimit = rateLimitDetails(headers, retryAfter)
  return new AIError({
    reason: classifyProviderFailure({
      message: input.message,
      status: input.status,
      data: input.data,
      rawBody: input.responseBody,
      retryAfterMs: retryAfter,
      rateLimit,
      cause: input.cause,
      http:
        input.status === undefined || input.url === undefined
          ? undefined
          : new HttpContext({ url: input.url, status: input.status, headers }),
    }),
  })
}

const timeoutDuration = (value: HttpTimeout | undefined, fallback = DEFAULT_HTTP_TIMEOUT_MS) =>
  value === false ? Duration.infinity : Duration.millis(value ?? fallback)

const timeoutError = (url: string, operation: HttpOperation, message: string, http?: HttpContext) =>
  new AIError({
    reason: new TransportError({
      message,
      transport: "http",
      operation,
      code: "Timeout",
      url,
      http,
    }),
  })

const bodyTimeoutError = (response: HttpClientResponse.HttpClientResponse, message: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({
      request: response.request,
      response,
      cause: new Cause.TimeoutError(message),
    }),
  })

// A response with one of these statuses has no body to re-wrap.
const NO_BODY = new Set([101, 204, 205, 304])

/**
 * Re-wraps the body behind the chunk and whole-request limits, so every way of reading it (`stream`, `text`, `json`,
 * `formData`, ...) fails cleanly once it stalls.
 */
const withBodyTimeouts = (
  raw: HttpClientResponse.HttpClientResponse,
  limits: { readonly chunk: Duration.Duration; readonly deadline: number | undefined },
): Effect.Effect<HttpClientResponse.HttpClientResponse> => {
  if (NO_BODY.has(raw.status) || (!Duration.isFinite(limits.chunk) && limits.deadline === undefined))
    return Effect.succeed(raw)
  const chunked = raw.stream.pipe(
    Stream.catchIf(
      (error) => error.reason._tag === "EmptyBodyError",
      () => Stream.empty,
    ),
    Stream.timeoutOrElse({
      duration: limits.chunk,
      orElse: () => Stream.fail(bodyTimeoutError(raw, "Timed out waiting for response data")),
    }),
  )
  const deadline = limits.deadline
  const body =
    deadline === undefined
      ? chunked
      : Stream.unwrap(
          Effect.map(Clock.currentTimeMillis, (now) =>
            chunked.pipe(
              Stream.interruptWhen(
                Effect.sleep(Duration.millis(Math.max(0, deadline - now))).pipe(
                  Effect.andThen(Effect.fail(bodyTimeoutError(raw, "Timed out waiting for the response to complete"))),
                ),
              ),
            ),
          ),
        )
  return Stream.toReadableStreamEffect(body).pipe(
    Effect.map((readable) =>
      HttpClientResponse.fromWeb(raw.request, new Response(readable, { status: raw.status, headers: raw.headers })),
    ),
  )
}

export const stream = (
  executor: Interface,
  request: HttpClientRequest.HttpClientRequest,
  middleware?: HttpMiddleware,
): Stream.Stream<Uint8Array, AIError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const response = yield* executor.execute(request, middleware)
      return responseStream(response)
    }),
  )

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const executeOnce = (
      request: HttpClientRequest.HttpClientRequest,
      middleware: HttpMiddleware | undefined,
      timeout: RequestTimeout | undefined,
    ) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        const limits = timeoutConfig(timeout)
        // Unlike the header and chunk limits, the whole-request budget has no default.
        const total = limits.total ? Duration.millis(limits.total) : Duration.infinity
        const headersLimit = Duration.min(timeoutDuration(limits.headers), total)
        const send = !middleware
          ? http.execute(request).pipe(Effect.mapError((error) => httpError({ error, request, operation: "request" })))
          : middleware(request, (input) =>
              http
                .execute(input)
                .pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause))))),
            ).pipe(Effect.mapError((error) => httpError({ error, request, operation: "request" })))
        const raw = yield* send.pipe(
          Effect.timeoutOrElse({
            duration: headersLimit,
            orElse: () => Effect.fail(timeoutError(request.url, "request", "Timed out waiting for response headers")),
          }),
        )
        const deadline = Duration.isFinite(total) ? started + Duration.toMillis(total) : undefined
        const response = yield* withBodyTimeouts(raw, {
          chunk: timeoutDuration(limits.chunk, DEFAULT_CHUNK_TIMEOUT_MS),
          deadline,
        })
        return yield* statusError(response)
      })
    return Service.of({
      // Scoped middleware and timeouts are cleared while the request runs, so a request a middleware makes itself
      // isn't wrapped again and starts with default timeouts.
      execute: (request, next) =>
        Effect.gen(function* () {
          const middleware = composeMiddleware(yield* CurrentMiddleware, next)
          const timeout = yield* CurrentTimeout
          return yield* executeOnce(request, middleware, timeout).pipe(
            Effect.provideService(CurrentMiddleware, undefined),
            Effect.provideService(CurrentTimeout, undefined),
          )
        }),
    })
  }),
)

export const fetchLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Sends through `execute`, presenting `tls` on each request. Apply it only where a provider request is sent, so
 * downloads made through the plain executor never carry the certificate. The executor's HTTP client reads `CurrentTls`.
 */
export const withTls = (execute: Interface["execute"], tls: ClientTls | undefined): Interface["execute"] =>
  tls ? (request, middleware) => execute(request, middleware).pipe(Effect.provideService(CurrentTls, tls)) : execute

/** Sends through `execute` with `timeout` applied to the request and its response body. */
export const withTimeout = (
  execute: Interface["execute"],
  timeout: RequestTimeout | undefined,
): Interface["execute"] =>
  timeout === undefined
    ? execute
    : (request, middleware) => execute(request, middleware).pipe(Effect.provideService(CurrentTimeout, timeout))

/**
 * Per-call middleware that sends through `fetch` instead of the executor's HTTP client. Executor middleware and
 * `middleware` still wrap the call, and status classification still applies.
 */
export const withFetch = (
  fetch: typeof globalThis.fetch | undefined,
  middleware?: HttpMiddleware,
): HttpMiddleware | undefined => {
  if (fetch === undefined) return middleware
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClient.execute(request).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    )
  return middleware === undefined ? send : (request) => middleware(request, send)
}

/**
 * Run `fn` on every request: it sees the raw response before status classification, inside middleware already on
 * `executor`, and outside per-call and scoped ({@link withMiddleware}) middleware.
 */
export const middleware = (fn: HttpMiddleware, executor: Layer.Layer<Service> = fetchLayer): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const inner = yield* Service
      return Service.of({
        // Scoped middleware sits where per-call middleware does, inside `fn`; it is read here and cleared so the
        // executors below don't apply it again.
        execute: (request, next) =>
          Effect.gen(function* () {
            const scoped = composeMiddleware(yield* CurrentMiddleware, next)
            return yield* inner
              .execute(request, composeMiddleware(fn, scoped))
              .pipe(Effect.provideService(CurrentMiddleware, undefined))
          }),
      })
    }),
  ).pipe(Layer.provide(executor))

export * as RequestExecutor from "./executor.js"
