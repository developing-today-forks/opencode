export * as FileSystem from "./filesystem.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Option, PlatformError, Schema, Stream } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "./location.js"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { pageLimit, pageOffset } from "./util/number.js"
import { Entry, FileSystem, FindInput, Write } from "@opencode/schema/filesystem"
export { Entry, Match, Submatch } from "@opencode/schema/filesystem"

export interface ReadInput {
  readonly path: RelativePath
}

export interface WriteInput {
  /** Absolute, or relative to the location directory. */
  readonly path: string
  readonly data: Uint8Array
}

/**
 * Write size cap (#2502): one fs.write body never exceeds 10 MiB — the same bound the
 * shell capture and VCS patch paths use. The check runs before any parent directory or
 * file is created, so a rejected write leaves no residue; the server maps it to 413.
 */
export const MAX_WRITE_BYTES = 10 * 1024 * 1024

/**
 * List page bounds (#2508): one fs.list response never carries more than
 * 200 entries — the page ceiling fs.find and session.list settled on
 * (#2488) — and defaults to 100 when the caller does not page explicitly.
 * The page is sliced from the sorted directory entries before `Entry`
 * construction, so a huge directory costs a name sort, not a full
 * materialisation of every entry.
 */
export const DEFAULT_LIST_LIMIT = 100
export const MAX_LIST_LIMIT = 200

export class WriteTooLargeError extends Schema.TaggedError<WriteTooLargeError>()("FileSystem.WriteTooLargeError", {
  path: Schema.String,
  size: Schema.Number,
  max: Schema.Number,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("FileSystem.NotFoundError", {
  path: RelativePath,
}) {}

export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
  "FileSystem.DirectoryNotFoundError",
  {
    directory: AbsolutePath,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Directory not found: ${this.directory}`
  }
}

export class DirectoryAccessDeniedError extends Schema.TaggedError<DirectoryAccessDeniedError>()(
  "FileSystem.DirectoryAccessDeniedError",
  {
    directory: AbsolutePath,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Access denied to directory: ${this.directory}`
  }
}

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export interface ListInput {
  readonly path?: string
  /** Page size, clamped to the 200-entry ceiling; defaults to 100. */
  readonly limit?: number
  /** Entries to skip in the directories-first sorted order; defaults to 0. */
  readonly offset?: number
}

export { FindInput, Write }

export const DEFAULT_SEARCH_LIMIT = 100
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  hidden: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  include: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export const Event = FileSystem.Event

export interface File {
  readonly mime: string
  readonly size: number
  readonly mtime: Option.Option<Date>
  readonly stream: (options?: {
    readonly offset?: number
    readonly bytesToRead?: number
  }) => Stream.Stream<Uint8Array, PlatformError.PlatformError>
}

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<File, NotFoundError>
  /** Fails with `NotFoundError` when the path is missing or is not a directory. */
  readonly list: (input?: ListInput) => Effect.Effect<Entry[], NotFoundError>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
  /** Writes inside the location or advertised OpenCode temp root; rejects every other target. */
  readonly write: (input: WriteInput) => Effect.Effect<Write, WriteTooLargeError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const search = yield* FileSystemSearch.Service
    // Workspace-placed directories exist only inside the workspace, so a host
    // realpath probe at boot consults the wrong filesystem and would block
    // construction on servers without a matching local directory. Treat the
    // configured directory as canonical; local placements keep symlink
    // canonicalization. This skip is boot-only: resolve/read/list below still
    // access the host filesystem per operation (tracked in #44568).
    const root = location.workspaceID
      ? location.directory
      : yield* fs.realPath(location.directory).pipe(
          // Linux realpath succeeds on an unreadable directory, so probe readability explicitly.
          Effect.tap((real) => fs.access(real, { readable: true })),
          Effect.catch((cause): Effect.Effect<never, DirectoryNotFoundError | DirectoryAccessDeniedError> => {
            if (cause.reason._tag === "NotFound")
              return Effect.fail(new DirectoryNotFoundError({ directory: location.directory, cause }))
            if (FSUtil.isAccessDenied(cause))
              return Effect.fail(new DirectoryAccessDeniedError({ directory: location.directory, cause }))
            return Effect.die(cause)
          }),
        )
    const resolve = Effect.fnUntraced(function* (input: RelativePath) {
      if (input.includes("\u0000")) return yield* Effect.fail(new NotFoundError({ path: input }))
      const absolute = path.resolve(location.directory, input)
      if (!FSUtil.contains(location.directory, absolute)) return yield* Effect.fail(new NotFoundError({ path: input }))
      const real = yield* fs.realPath(absolute).pipe(
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          () => Effect.fail(new NotFoundError({ path: input })),
          (_, error) => Effect.die(error),
        ),
      )
      if (!FSUtil.contains(root, real)) return yield* Effect.fail(new NotFoundError({ path: input }))
      return { absolute, real, directory: location.directory }
    })
    const realPathOrExistingParent = (candidate: string): Effect.Effect<string> =>
      fs.realPath(candidate).pipe(
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          () => {
            const parent = path.dirname(candidate)
            return parent === candidate ? Effect.succeed(candidate) : realPathOrExistingParent(parent)
          },
          (_, error) => Effect.die(error),
        ),
      )
    return Service.of({
      find: search.find,
      read: Effect.fn("FileSystem.read")(function* (input) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: input.path })),
            (_, error) => Effect.die(error),
          ),
        )
        if (info.type !== "File") return yield* Effect.fail(new NotFoundError({ path: input.path }))
        return {
          mime: FSUtil.mimeType(target.real),
          size: Number(info.size),
          mtime: info.mtime,
          // The stream is lazy: it runs at response time, after this check.
          // Opening by name then would serve whatever the path names at that
          // moment, so a symlink swapped in after read() returns escapes the
          // confinement resolve() just enforced. Bind the stream to the
          // checked object instead: re-canonicalize when the stream opens,
          // open the file, and compare the handle's identity with the object
          // checked above, refusing before any bytes are served. The same
          // binding BrowserFiles.read applies to uploads (#2647). fs.watch's
          // confinement check calls read() and discards the result, so it
          // shares the check and never opens a handle.
          stream: (options) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const refuse = (description: string) =>
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "stream",
                      pathOrDescriptor: target.real,
                      description,
                    }),
                  )
                const real = yield* fs.realPath(target.absolute)
                if (real !== target.real || !FSUtil.contains(root, real))
                  return yield* refuse("The path resolves somewhere other than the file read checked.")
                const handle = yield* fs.open(real)
                const opened = yield* handle.stat
                if (
                  opened.type !== "File" ||
                  opened.dev !== info.dev ||
                  Option.getOrNull(opened.ino) !== Option.getOrNull(info.ino)
                )
                  return yield* refuse("The file was replaced after read checked it.")
                const offset = options?.offset ?? 0
                if (offset > 0) yield* handle.seek(BigInt(offset), "start")
                return Stream.unfold(options?.bytesToRead ?? Number.POSITIVE_INFINITY, (remaining) =>
                  remaining <= 0
                    ? Effect.succeed(undefined)
                    : handle.readAlloc(Math.min(64 * 1024, remaining)).pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => undefined,
                            onSome: (bytes) => [bytes, remaining - bytes.length] as const,
                          }),
                        ),
                      ),
                )
              }),
            ),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        // Navigation can leave the cwd without activating another Location.
        const directory = path.resolve(location.directory, input.path ?? ".")
        const missing = new NotFoundError({ path: RelativePath.make(input.path ?? ".") })
        const info = yield* fs.stat(directory).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(missing),
            (_, error) => Effect.die(error),
          ),
        )
        if (info.type !== "Directory") return yield* missing
        return yield* fs.readDirectoryEntries(directory).pipe(
          Effect.orDie,
          Effect.map((items) => {
            const limit = pageLimit(input.limit, { default: DEFAULT_LIST_LIMIT, max: MAX_LIST_LIMIT })
            const offset = pageOffset(input.offset)
            return items
              .filter((item) => item.type === "File" || item.type === "Directory")
              .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "Directory" ? -1 : 1))
              .slice(offset, offset + limit)
              .map((item) => {
                const type = item.type === "Directory" ? ("directory" as const) : ("file" as const)
                const absolute = path.join(directory, item.name)
                const relative = path.relative(location.directory, absolute) || "."
                return Entry.make({
                  path: RelativePath.make(relative + (type === "directory" ? path.sep : "")),
                  type,
                })
              })
          }),
        )
      }),
      // Unlike read, write reaches outside the location so clients can stage files in the
      // server tmp directory, which the model is already told to prefer and permitted to access.
      write: Effect.fn("FileSystem.write")(function* (input) {
        if (input.data.byteLength > MAX_WRITE_BYTES)
          return yield* new WriteTooLargeError({
            path: input.path,
            size: input.data.byteLength,
            max: MAX_WRITE_BYTES,
          })
        const target = path.resolve(location.directory, input.path)
        if (!FSUtil.contains(location.directory, target) && !FSUtil.contains(global.tmp, target))
          return yield* new NotFoundError({ path: RelativePath.make(input.path) })
        // Check the nearest existing path before creating parents. This rejects
        // an in-root lexical path whose existing symlink component redirects
        // the eventual write outside both allowed roots.
        if (!location.workspaceID) {
          const realTarget = yield* realPathOrExistingParent(target)
          if (!FSUtil.contains(root, realTarget) && !FSUtil.contains(global.tmp, realTarget))
            return yield* new NotFoundError({ path: RelativePath.make(input.path) })
        }
        yield* fs.writeWithDirs(target, input.data).pipe(Effect.orDie)
        return Write.make({ path: AbsolutePath.make(target) })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node, Global.node],
})
