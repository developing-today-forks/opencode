import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { Driver } from "./driver.js"
import {
  Failed,
  MAX_WHOLE_FILE_BYTES,
  NotFound,
  WrongKind,
  type FileInfo,
  type FilesImpl,
  type FileType,
} from "./files.js"

/**
 * The host filesystem binding. Deliberately raw node:fs rather than effect's
 * FileSystem service or FSUtil: the contract needs lstat semantics (stat
 * reports "symlink"), and effect's node FileSystem stat always follows
 * symlinks. Nothing above the environment seam touches node:fs.
 */
export const makeLocalDriver = (spawner: ChildProcessSpawner["Service"]): Driver => {
  const overrides: FilesImpl = {
    read: (value, range) =>
      Effect.gen(function* () {
        const info = yield* stat(value, true)
        if (info.type !== "file") return yield* new WrongKind({ path: value, actual: info.type })
        if (range === undefined) {
          if (info.size > MAX_WHOLE_FILE_BYTES) {
            return yield* new Failed({ path: value, cause: wholeFileTooLarge(value, info.size) })
          }
          const bytes = yield* attempt(
            value,
            async () => {
              const handle = await fs.open(value, "r")
              try {
                const chunks: Array<Uint8Array> = []
                let total = 0
                for (;;) {
                  const buffer = new Uint8Array(READ_CHUNK_BYTES)
                  const result = await handle.read(buffer, 0, buffer.length, null)
                  if (result.bytesRead === 0) break
                  total += result.bytesRead
                  if (total > MAX_WHOLE_FILE_BYTES) throw wholeFileTooLarge(value, total)
                  chunks.push(buffer.subarray(0, result.bytesRead))
                }
                const bytes = new Uint8Array(total)
                let offset = 0
                for (const chunk of chunks) {
                  bytes.set(chunk, offset)
                  offset += chunk.byteLength
                }
                return bytes
              } finally {
                await handle.close()
              }
            },
            true,
          )
          return { info, bytes }
        }
        const bytes = yield* attempt(
          value,
          async () => {
            const handle = await fs.open(value, "r")
            try {
              const buffer = new Uint8Array(range.length)
              const result = await handle.read(buffer, 0, range.length, range.offset)
              return buffer.subarray(0, result.bytesRead)
            } finally {
              await handle.close()
            }
          },
          true,
        )
        return { info, bytes }
      }),
    stat: (value) => stat(value, false),
    list: (value) =>
      Effect.gen(function* () {
        const info = yield* stat(value, true)
        if (info.type !== "directory") return yield* new WrongKind({ path: value, actual: info.type })
        const entries = yield* attempt(value, () => fs.readdir(value, { withFileTypes: true }), true)
        return entries.map((entry) => ({ name: entry.name, type: fileType(entry) }))
      }),
    write: (value, bytes) =>
      attempt(value, async () => {
        await fs.mkdir(path.dirname(value), { recursive: true })
        await fs.writeFile(value, bytes)
      }),
    remove: (value) => attempt(value, () => fs.rm(value, { recursive: true, force: true })),
    move: (from, to) =>
      Effect.gen(function* () {
        yield* stat(from, false)
        const destination = yield* stat(to, false).pipe(
          Effect.map((info) => (info.type === "directory" ? path.join(to, path.basename(from)) : to)),
          Effect.catchIf(
            (error) => error instanceof NotFound,
            () => Effect.succeed(to),
          ),
        )
        yield* attempt(from, () => fs.rename(from, destination))
      }),
    mkdir: (value) => attempt(value, () => fs.mkdir(value, { recursive: true }).then(() => undefined)),
    append: (value, bytes) => attempt(value, () => fs.appendFile(value, bytes)),
  }

  return { spawner, overrides }
}

const READ_CHUNK_BYTES = 1024 * 1024

const wholeFileTooLarge = (value: string, size: number) =>
  new Error(`File of ${size} bytes exceeds the whole-file read limit of ${MAX_WHOLE_FILE_BYTES} bytes: ${value}`)

const stat = (value: string, follow: boolean) =>
  attempt(value, () => (follow ? fs.stat(value) : fs.lstat(value)), true).pipe(
    Effect.map((stats): FileInfo => ({ type: fileType(stats), size: stats.size, mtimeMs: stats.mtimeMs })),
  )

const fileType = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

function attempt<A>(value: string, run: () => Promise<A>): Effect.Effect<A, Failed>
function attempt<A>(value: string, run: () => Promise<A>, missing: true): Effect.Effect<A, NotFound | Failed>
function attempt<A>(value: string, run: () => Promise<A>, missing = false) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      missing && isMissing(cause) ? new NotFound({ path: value }) : new Failed({ path: value, cause }),
  })
}

const isMissing = (cause: unknown) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

export * as EnvironmentLocal from "./local.js"
