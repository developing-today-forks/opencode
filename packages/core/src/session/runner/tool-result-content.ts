import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { Content } from "@opencode/schema/tool"
import type { FileAccess } from "../../file-access.js"

export const MAX_TOOL_URI_BYTES = 20 * 1024 * 1024

const fallback = (uri: string, reason: string): Content => ({
  type: "text",
  text: `[Tool result file could not be materialized: ${uri.length > 512 ? `${uri.slice(0, 256)}…${uri.slice(-128)} (${uri.length} characters)` : uri} (${reason})]`,
})

const malformed = (uri: string) => fallback(uri, "malformed media URI")

const validBase64 = (value: string) => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const dataLength = value.length - padding
  if (value.length % 4 === 1) return false
  if (padding === 2) return dataLength % 4 === 2 && value.length % 4 === 0
  if (padding === 1) return dataLength % 4 === 3 && value.length % 4 === 0
  return true
}

const percentBytes = (value: string) => {
  const bytes = Buffer.alloc(Math.min(MAX_TOOL_URI_BYTES, value.length * 3))
  let length = 0
  for (let index = 0; index < value.length; ) {
    if (value[index] === "%") {
      const hex = value.slice(index + 1, index + 3)
      if (!/^[\da-f]{2}$/i.test(hex)) return undefined
      if (length === MAX_TOOL_URI_BYTES) return "oversized" as const
      bytes[length++] = Number.parseInt(hex, 16)
      index += 3
      continue
    }
    const codePoint = value.codePointAt(index)
    if (codePoint === undefined) return undefined
    const encoded = Buffer.from(String.fromCodePoint(codePoint), "utf8")
    if (length + encoded.byteLength > MAX_TOOL_URI_BYTES) return "oversized" as const
    encoded.copy(bytes, length)
    length += encoded.byteLength
    index += codePoint > 0xffff ? 2 : 1
  }
  return bytes.subarray(0, length)
}

const boundedRead = async (path: string) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("target is not a regular file")
    if (info.size > MAX_TOOL_URI_BYTES) throw new Error(`exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_TOOL_URI_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_TOOL_URI_BYTES + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      total += bytesRead
      chunks.push(buffer.subarray(0, bytesRead))
    }
    if (total > MAX_TOOL_URI_BYTES) throw new Error(`exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

const dataUri = (file: Extract<Content, { type: "file" }>) => {
  const comma = file.uri.indexOf(",")
  if (comma < 0) return malformed(file.uri)
  const metadata = file.uri.slice(5, comma)
  const payload = file.uri.slice(comma + 1)
  const mime = file.mime || metadata.split(";")[0] || "application/octet-stream"
  let bytes: Buffer | undefined
  if (metadata.split(";").includes("base64")) {
    if (payload.length > Math.ceil((MAX_TOOL_URI_BYTES * 4) / 3))
      return fallback(file.uri, `exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
    if (!validBase64(payload)) return malformed(file.uri)
    bytes = Buffer.from(payload, "base64")
  } else {
    if (payload.length > MAX_TOOL_URI_BYTES * 3) return fallback(file.uri, `exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
    const decoded = percentBytes(payload)
    if (decoded === "oversized") return fallback(file.uri, `exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
    if (!decoded) return malformed(file.uri)
    bytes = decoded
  }
  if (bytes.byteLength > MAX_TOOL_URI_BYTES) return fallback(file.uri, `exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
  return { ...file, uri: `data:${mime};base64,${bytes.toString("base64")}`, mime }
}

export const validate = (item: Extract<Content, { type: "file" }>): Content => {
  if (item.uri.startsWith("data:")) return dataUri(item)
  if (item.uri.startsWith("https://") || item.uri.startsWith("http://")) return item
  if (item.uri.startsWith("file:")) return fallback(item.uri, "local file URI was not materialized by an authorized tool")
  if (!validBase64(item.uri)) return fallback(item.uri, "unsupported URI scheme or malformed base64")
  if (item.uri.length > Math.ceil((MAX_TOOL_URI_BYTES * 4) / 3))
    return fallback(item.uri, `exceeds ${MAX_TOOL_URI_BYTES} byte limit`)
  return item
}

/** Snapshots authorized local files before a completed tool result is persisted. */
export const materialize = (
  content: ReadonlyArray<Content>,
  context: FileAccess.Invocation,
  authorizeRead: FileAccess.Interface["authorizeRead"],
): Effect.Effect<ReadonlyArray<Content>, never> =>
  Effect.forEach(content, (item) => {
    if (item.type !== "file") return Effect.succeed(item)
    if (!item.uri.startsWith("file:")) return Effect.succeed(validate(item))
    let path: string
    try {
      path = fileURLToPath(item.uri)
    } catch {
      return Effect.succeed(fallback(item.uri, "invalid local file URI"))
    }
    return authorizeRead(path, context).pipe(
      Effect.flatMap((target) =>
        Effect.tryPromise({
          try: () => boundedRead(target.absolute),
          catch: (error) => error,
        }).pipe(
          Effect.map((bytes) => ({
            ...item,
            uri: `data:${item.mime};base64,${bytes.toString("base64")}`,
          })),
          Effect.catch((error) => Effect.succeed(fallback(item.uri, error instanceof Error ? error.message : "read failed"))),
        ),
      ),
      Effect.catch((error) => Effect.succeed(fallback(item.uri, error instanceof Error ? error.message : "read not authorized"))),
    )
  })
