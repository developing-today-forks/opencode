import { Effect, Stream } from "effect"
import { HttpClientResponse } from "effect/http"
import { readBoundedResponseText, readExcerptResponseText } from "@opencode/util/http-body"

export { readBoundedResponseText, readExcerptResponseText }

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
 * The native fetch reader is the shared `@opencode/util` implementation
 * (design #1127 phase 1, #1128): one implementation per layer, never per
 * call site. It is re-exported here so existing core/cli call sites keep
 * importing it from this module, next to the Effect variant above.
 */
