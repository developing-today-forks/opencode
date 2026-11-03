import { Effect, Option, Schema, Stream } from "effect"
import { HttpClientResponse } from "effect/http"
import { readBoundedResponseText } from "@opencode/util/http-body"

export { readBoundedResponseText }

export const collectBoundedResponseBody = (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number,
  tooLarge: () => Error,
) =>
  Effect.gen(function* () {
    const contentLength = response.headers["content-length"]
    const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
    const declaredSize =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
    if (declaredSize !== undefined && declaredSize > maximumBytes) return yield* Effect.fail(tooLarge())
    let body = Buffer.allocUnsafe(Math.min(maximumBytes, declaredSize || 64 * 1024))
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (chunk.byteLength === 0) return Effect.void
      if (size + chunk.byteLength > maximumBytes) return Effect.fail(tooLarge())
      if (size + chunk.byteLength > body.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(size + chunk.byteLength, body.byteLength * 2)))
        body.copy(grown, 0, 0, size)
        body = grown
      }
      body.set(chunk, size)
      size += chunk.byteLength
      return Effect.void
    })
    return body.subarray(0, size)
  })

/**
 * Effect-side counterpart of `readBoundedResponseText` (design #1127): the
 * same deadline-and-cap contract, for call sites that hold an
 * `HttpClientResponse` instead of a native fetch `Response`. Provider OAuth
 * exchanges read small JSON structs and short error bodies, so callers pass
 * a generous cap (64 KiB) and never buffer an unbounded issuer response
 * (#1029).
 */
export const readBoundedResponseTextEffect = (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number,
  tooLarge: () => Error,
) => Effect.map(collectBoundedResponseBody(response, maximumBytes, tooLarge), (body) => body.toString("utf8"))

/**
 * Bounded JSON read for Effect call sites: collect the body under the cap,
 * then decode it with `schema`. A body over the cap fails with `tooLarge`;
 * malformed or schema-invalid JSON fails with a plain error, which call sites
 * map to their existing "invalid response" message.
 */
export const decodeBoundedResponseJson =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (
    response: HttpClientResponse.HttpClientResponse,
    maximumBytes: number,
    tooLarge: () => Error,
  ): Effect.Effect<A, Error> =>
    Effect.flatMap(readBoundedResponseTextEffect(response, maximumBytes, tooLarge), (text) => {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text)
      return Option.isSome(decoded)
        ? Effect.succeed(decoded.value)
        : Effect.fail(new Error("Response body was not valid JSON for the expected schema"))
    })
