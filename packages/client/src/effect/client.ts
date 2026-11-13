export * as OpenCode from "./client.js"

import { Cause, Context, Effect, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { InvalidRequestError, UnauthorizedError } from "@opencode/protocol/errors"
import { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { SharedEvents } from "../shared-events.js"
import { ClientError, OpenCode } from "./generated/index.js"
import type { EventSubscribeInput } from "./api/api.js"
import { RpcClientRuntime } from "./rpc.js"
import type { RpcCallOptions } from "../promise/rpc.js"

// `event.subscribe` declares no endpoint errors of its own. The API-wide middleware add these two, as the generated
// client's `getErrorSchemas` reads them, so each declared status decodes with the one schema the contract gives it.
// event-subscribe-errors.test.ts checks these statuses against the reflected contract.
const declaredEventErrors = [
  { status: 400, schema: InvalidRequestError },
  { status: 401, schema: UnauthorizedError },
] as const
type DeclaredEventError = (typeof declaredEventErrors)[number]["schema"]["Type"]
type EventFrameError = ClientError | DeclaredEventError

const CurrentHeaders = Context.Reference<RpcCallOptions["headers"]>("@opencode/client/effect/rpc/headers", {
  defaultValue: () => undefined,
})

// Async iterators throw a squashed cause; retain the native typed failures and defects intact.
export class EventFailure {
  constructor(readonly cause: Cause.Cause<EventFrameError>) {}
}

/**
 * Whether a failed event-stream attempt may be retried (#2321). Transport
 * failures and server-side (5xx) HTTP errors are transient; terminal
 * protocol/decode failures and the declared non-retryable HTTP errors
 * (400/401, which arrive as their decoded error objects, not ClientError)
 * stay visible instead of being retried. Anything unrecognised is
 * terminal: an unknown failure is reported, never looped on.
 */
export function eventErrorRetryable(error: unknown): boolean {
  if (!(error instanceof EventFailure)) return false
  const failure = Cause.findErrorOption(error.cause)
  if (failure._tag === "None") return false
  const value = failure.value
  if (!(value instanceof ClientError)) return false
  const cause: unknown = value.cause
  if (!HttpClientError.isHttpClientError(cause)) return false
  switch (cause.reason._tag) {
    case "TransportError":
      return true
    case "StatusCodeError":
      return cause.reason.response.status >= 500
    case "DecodeError":
      // failStatus reports an undeclared status as a DecodeError carrying
      // the response: a 5xx there is a transient server failure, while a
      // DecodeError on a 200 response stays a terminal protocol failure.
      return cause.reason.response.status >= 500
    default:
      return false
  }
}

// Bounded exponential backoff for event reconnects: 250ms doubling to a 5s cap.
const eventReconnectDelay = (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 5_000)

export const make = Effect.fn("OpenCode.make")(function* (options?: { readonly baseUrl?: URL | string }) {
  const httpClient = yield* HttpClient.HttpClient
  const raw = yield* OpenCode.make(options).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.mapRequestEffect(httpClient, (request) =>
        Effect.map(CurrentHeaders, (headers) =>
          headers ? HttpClientRequest.setHeaders(request, new Headers(headers)) : request,
        ),
      ),
    ),
  )
  const context = yield* Effect.context()
  const connect = (input: Parameters<typeof raw.server.connect>[0]) =>
    Effect.map(CurrentHeaders, (headers) => {
      const withAccept = new Headers(headers)
      if (!withAccept.has("accept")) withAccept.set("accept", "application/json")
      return Object.fromEntries(withAccept)
    }).pipe(
      Effect.flatMap((headers) =>
        raw.server.connect(input).pipe(Effect.provideService(CurrentHeaders, headers)),
      ),
    )
  // Same base URL handling as the generated client, which the event stream bypasses to keep SSE ids.
  const eventClient =
    options?.baseUrl === undefined
      ? httpClient
      : HttpClient.mapRequest(httpClient, HttpClientRequest.prependUrl(options.baseUrl.toString()))
  // The cursor outlives any one subscription, so a subscribe after a failure resumes from the last event consumed.
  let lastEventID: string | undefined
  const shared = SharedEvents.make(
    (signal, onActivity, resume) =>
      Stream.toAsyncIterableWith(
        eventFrames(eventClient, { lastEventID: resume.lastEventID, onEventId: resume.onEventId, onActivity }).pipe(
          Stream.interruptWhen(RpcClientRuntime.aborted(signal)),
          Stream.catchCause((cause) => Stream.fail(new EventFailure(cause))),
        ),
        context,
      ),
    // Transient failures and unexpected stream ends reconnect automatically
    // with bounded backoff (#2321); terminal failures complete subscribers.
    { reconnect: { shouldRetry: eventErrorRetryable, delay: eventReconnectDelay } },
  )
  const subscribe = (input?: EventSubscribeInput) => {
    lastEventID = input?.["last-event-id"] ?? lastEventID
    return Stream.fromAsyncIterable(
      shared.subscribe({
        lastEventID,
        onEventId: (id) => {
          lastEventID = id
        },
      }),
      (error) => error,
    ).pipe(
      Stream.catch((error) =>
        Stream.failCause(error instanceof EventFailure ? error.cause : Cause.fail(new ClientError({ cause: error }))),
      ),
    )
  }
  return {
    ...raw,
    server: { ...raw.server, connect },
    event: { ...raw.event, subscribe },
    rpc: Object.assign(
      RpcClientRuntime.make(
        (input, options) => raw.rpc.call(input).pipe(Effect.provideService(CurrentHeaders, options?.headers)),
        () => subscribe(),
      ),
      raw.rpc,
    ),
  }
})

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeEvent))

// Reads `GET /api/event` as SSE and yields each event after reporting its id. The generated client decodes
// the same frames but its event type carries no id, so a reconnect could never resume.
function eventFrames(
  client: HttpClient.HttpClient,
  options: {
    readonly lastEventID?: string
    readonly onEventId: (id: string) => void
    readonly onActivity: () => void
  },
) {
  const request = HttpClientRequest.get("/api/event").pipe(
    HttpClientRequest.setHeaders(options.lastEventID === undefined ? {} : { "last-event-id": options.lastEventID }),
  )
  return Stream.unwrap(
    client.execute(request).pipe(
      Effect.mapError((cause) => new ClientError({ cause })),
      Effect.flatMap((response) => {
        if (response.status !== 200) return failStatus(response)
        const contentType = response.headers["content-type"]
        if (!contentType?.startsWith("text/event-stream"))
          return Effect.fail(
            new ClientError({
              cause: new HttpClientError.HttpClientError({
                reason: new HttpClientError.DecodeError({
                  request: response.request,
                  response,
                  description: `Unsupported response content-type for status ${response.status}: ${
                    contentType || "<missing>"
                  }. Expected one of: text/event-stream`,
                }),
              }),
            }),
          )
        return Effect.succeed(
          response.stream.pipe(
            Stream.tap(() => Effect.sync(options.onActivity)),
            Stream.decodeText,
            Stream.pipeThroughChannel(Sse.decode()),
            Stream.mapEffect((frame) =>
              Effect.gen(function* () {
                const event = yield* decodeEvent(frame.data)
                if (frame.id !== undefined) options.onEventId(frame.id)
                return event
              }),
            ),
            Stream.mapError((cause) => new ClientError({ cause })),
          ),
        )
      }),
    ),
  )
}

// Fails a non-200 response the way the generated client does. A declared status fails with its decoded error object,
// and a body that does not decode fails as a status error that keeps the response. An undeclared status fails with a
// DecodeError on the response, which carries the status and body.
function failStatus(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, ClientError | DeclaredEventError> {
  const schema = declaredEventErrors.find((declared) => declared.status === response.status)?.schema
  if (schema === undefined)
    return Effect.fail(
      new ClientError({
        cause: new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({ request: response.request, response }),
        }),
      }),
    )
  return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(
      (cause) =>
        new ClientError({
          cause: new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({ request: response.request, response, cause }),
          }),
        }),
    ),
    Effect.flatMap((error) => Effect.fail(error)),
  )
}
