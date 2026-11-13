import { expect, test } from "bun:test"
import { Cause } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ClientError } from "../src/effect/generated/index"
import { EventFailure, eventErrorRetryable } from "../src/effect/client"

// Oracle: issue #2321's acceptance — transient transport failures and
// server-side HTTP errors reconnect; terminal protocol/decode failures
// and non-retryable HTTP errors stay visible.

const request = HttpClientRequest.get("http://localhost/api/event")

const failure = (cause: unknown) => new EventFailure(Cause.fail(cause as never))
const clientFailure = (cause: unknown) => failure(new ClientError({ cause }))

test("transport errors are retryable", () => {
  expect(
    eventErrorRetryable(
      clientFailure(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("connection reset") }),
        }),
      ),
    ),
  ).toBeTrue()
})

test("5xx status errors are retryable, 4xx are terminal", async () => {
  const status = (code: number) =>
    clientFailure(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
          request,
          response: HttpClientResponse.fromWeb(request, new Response("err", { status: code })),
        }),
      }),
    )
  expect(eventErrorRetryable(status(503))).toBeTrue()
  expect(eventErrorRetryable(status(400))).toBeFalse()
  expect(eventErrorRetryable(status(401))).toBeFalse()
})

test("an undeclared 5xx arrives as a DecodeError carrying the status and is retryable", () => {
  const decode = (code: number) =>
    clientFailure(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request,
          response: HttpClientResponse.fromWeb(request, new Response("err", { status: code })),
        }),
      }),
    )
  expect(eventErrorRetryable(decode(503))).toBeTrue()
  expect(eventErrorRetryable(decode(400))).toBeFalse()
})

test("decode errors and non-ClientError failures are terminal", () => {
  expect(
    eventErrorRetryable(
      clientFailure(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request,
            response: HttpClientResponse.fromWeb(request, new Response("x")),
            description: "bad frame",
          }),
        }),
      ),
    ),
  ).toBeFalse()
  // A frame decode failure arrives as a ClientError over a non-HTTP cause.
  expect(eventErrorRetryable(clientFailure(new Error("parse error")))).toBeFalse()
  // Declared 400/401 errors arrive as their decoded objects, not ClientError.
  expect(eventErrorRetryable(failure({ _tag: "UnauthorizedError" }))).toBeFalse()
})

test("defects and foreign errors are terminal", () => {
  expect(eventErrorRetryable(new EventFailure(Cause.die(new Error("defect"))))).toBeFalse()
  expect(eventErrorRetryable(new Error("not an event failure"))).toBeFalse()
})
