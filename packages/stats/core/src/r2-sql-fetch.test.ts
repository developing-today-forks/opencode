import { Effect } from "effect"
import { expect, test } from "bun:test"
import { readR2SqlResponseBody, R2SqlQueryError, R2_SQL_MAX_RESPONSE_BYTES } from "./r2-sql"

test("reads a normal-sized response body as text", async () => {
  const body = await Effect.runPromise(readR2SqlResponseBody(new Response('{"success":true}')))
  expect(body).toBe('{"success":true}')
})

test("fails a declared-oversize response as R2SqlQueryError naming the cap", async () => {
  const error = await Effect.runPromise(
    readR2SqlResponseBody(
      new Response("{}", { status: 200, headers: { "Content-Length": String(R2_SQL_MAX_RESPONSE_BYTES + 1) } }),
    ).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(R2SqlQueryError)
  expect(error.message).toContain(`${R2_SQL_MAX_RESPONSE_BYTES} byte limit`)
})

test("fails a streamed-oversize response as R2SqlQueryError naming the cap", async () => {
  const chunk = new Uint8Array(1024 * 1024)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    }),
    { status: 200 },
  )
  const error = await Effect.runPromise(readR2SqlResponseBody(response).pipe(Effect.flip))
  expect(error).toBeInstanceOf(R2SqlQueryError)
  expect(error.message).toContain(`${R2_SQL_MAX_RESPONSE_BYTES} byte limit`)
})
