import { HonoRequest } from "hono"
import { HTTPException } from "hono/http-exception"

// The legacy service's one request-size policy for JSON request bodies,
// mirroring the server's readBoundedJsonBody (packages/server, #2314). A
// declared Content-Length over the limit is refused before any of the body
// is consumed; a body with no declared length (chunked) is cut off while
// streaming the moment its running total crosses the limit. Both refusals
// are a deterministic 413 raised before parsing, so no side effect (Durable
// Object call, R2 write, secret comparison) ever runs on an oversized
// payload. In-limit bodies parse exactly as c.req.json() did.
export async function readBoundedJson<T>(req: HonoRequest, limit: number): Promise<T> {
  const declared = Number(req.header("content-length") ?? "")
  if (Number.isFinite(declared) && declared > limit)
    throw new HTTPException(413, { message: `Request body exceeds the ${limit}-byte limit` })
  const chunks: Uint8Array[] = []
  let total = 0
  if (req.raw.body) {
    const reader = req.raw.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new HTTPException(413, { message: `Request body exceeds the ${limit}-byte limit` })
      }
      chunks.push(chunk.value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}
