import path, { dirname, isAbsolute, join, relative, sep } from "path"
import { realpathSync } from "fs"
import { readdir } from "fs/promises"
import { lookup } from "mime-types"
import { randomBytes } from "crypto"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./glob.js"
import { serviceUse } from "./effect/service-use.js"
import { makeGlobalNode } from "./effect/app-node.js"
import { filesystem } from "./effect/app-node-platform.js"
import { sameDirectory } from "./path.js"

export namespace FSUtil {
  export class FileSystemError extends Schema.TaggedError<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
      return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
    }
  }

  export type Error = PlatformError | FileSystemError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface WriteAtomicOptions {
    /** Mode policy for the replaced file (design #1345 rule 4). Default "preserve". */
    readonly modePolicy?: "preserve" | "owner-capped"
    /** Mode for a newly created file under "preserve". Default 0o600. Ignored under
     * "owner-capped", whose fresh mode is always 0o600. */
    readonly freshMode?: number
    /** Carry the existing file's uid/gid onto the temp file before the rename
     * (design #1345 rule 7, the uninstall writer's chown-before-rename). Default false. */
    readonly preserveOwnership?: boolean
  }

  export interface UpOptions {
    readonly targets: string[]
    readonly start: string
    readonly stop?: string
    readonly mode?: "all" | "first"
    /** Only match regular files or directories (following symlinks). By default any existing path matches. */
    readonly type?: "file" | "directory"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly writeAtomic: (
      path: string,
      content: string | Uint8Array,
      options?: WriteAtomicOptions,
    ) => Effect.Effect<void, Error>
    readonly writeJsonAtomic: (path: string, data: unknown, options?: WriteAtomicOptions) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly resolve: (path: string) => Effect.Effect<string>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: UpOptions) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly scan: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FSUtil") {}

  export const use = serviceUse(Service)

  // Exported so simulation can wrap this layer and override the methods that
  // bypass the injected FileSystem (readDirectoryEntries, scan, globUp).
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        return yield* fs.readFileString(path).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.undefined),
        )
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await readdir(dirPath, { withFileTypes: true })
            return entries.map(
              (e): DirEntry => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
              }),
            )
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      const resolve = Effect.fn("FileSystem.resolve")(function* (input: string) {
        const resolved = path.resolve(windowsPath(input))
        return yield* fs.realPath(resolved).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(resolved)),
          Effect.orDie,
        )
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new FileSystemError({ method: "readJson", cause }),
        })
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true }).pipe(
          // Bun on Windows can throw EEXIST here despite recursive mode.
          // https://github.com/oven-sh/bun/issues/21901
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            (error) => isDir(path).pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
          ),
        )
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })


      // Design #1345 (phase 1, #1346): the shared atomic-replace contract.
      // Replace, never truncate: content lands in a temp file beside the
      // resolved target and is renamed over it, so no partial file is ever
      // observed and a symlinked target's link survives.
      const renameRetryDelays = [10, 25, 50, 100]
      const transientRenameTags = new Set(["PermissionDenied", "Busy"])

      const isTransientRenameError = (error: PlatformError) => {
        const reason = error.reason as { _tag?: string; cause?: unknown }
        const code = (reason.cause as NodeJS.ErrnoException | undefined)?.code
        if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return true
        // Node/Bun platform layers normalise EPERM/EACCES to PermissionDenied
        // and EBUSY to Busy when no raw errno survives on the cause.
        return reason._tag !== undefined && transientRenameTags.has(reason._tag)
      }

      const renameWithRetry = (from: string, to: string, attempt = 0): Effect.Effect<void, PlatformError> =>
        fs.rename(from, to).pipe(
          Effect.catch((error: PlatformError) => {
            const delay = renameRetryDelays[attempt]
            if (delay === undefined || !isTransientRenameError(error)) return Effect.fail(error)
            return Effect.sleep(delay).pipe(Effect.flatMap(() => renameWithRetry(from, to, attempt + 1)))
          }),
        )

      const writeAtomic = Effect.fn("FileSystem.writeAtomic")(function* (
        path: string,
        content: string | Uint8Array,
        options?: WriteAtomicOptions,
      ) {
        // Symlinks are walked from the path as given, not from resolve():
        // resolve()'s realpath collapses a destination's `..` lexically,
        // which selects the wrong file when a component before the `..`
        // is itself a symlink, and a dangling link falls back to the
        // link's own path, where a rename would replace the link instead
        // of creating its referent.
        // The input path is rejected when a `..` in it traverses a
        // symlinked component: resolve() collapses that `..` lexically
        // before realpath runs, selecting a different file than
        // filesystem semantics dictate.
        const inputSegments = path.split(/[\/]/).filter((segment) => segment !== "" && segment !== ".")
        let inputPrefix = isAbsolute(path) ? "/" : "."
        let inputUnsafe = false
        for (let index = 0; index < inputSegments.length && !inputUnsafe; index++) {
          if (inputSegments[index] === "..") continue
          inputPrefix = join(inputPrefix, inputSegments[index])
          if (inputSegments.slice(index + 1).includes(".."))
            inputUnsafe =
              (yield* fs.readLink(inputPrefix).pipe(Effect.orElseSucceed(() => undefined))) !== undefined
        }
        if (inputUnsafe)
          return yield* Effect.fail(
            new FileSystemError({
              method: "writeAtomic",
              cause: new Error(`Path traverses a symbolic link: ${path}`),
            }),
          )
        let target = yield* resolve(path)
        if ((yield* fs.readLink(path).pipe(Effect.orElseSucceed(() => undefined))) !== undefined) {
          let hopTarget: string = path
          for (let hop = 0; hop < 8; hop++) {
            const link = yield* fs.readLink(hopTarget).pipe(Effect.orElseSucceed(() => undefined))
            if (link === undefined) break
            // A relative destination is interpreted against the link's
            // canonical parent, not the path it was reached through: the
            // parent itself may be a symlink.
            const parent = yield* resolve(dirname(hopTarget))
            // A `..` in the destination applies through the filesystem,
            // not lexically: when a component before a `..` is a symlink,
            // the traversal belongs to that link's target directory.
            // Such destinations cannot be resolved safely here, so
            // reject them rather than write to a guessed referent.
            const segments = link.split("/").filter((segment) => segment !== "" && segment !== ".")
            let prefix = isAbsolute(link) ? "/" : parent
            let unsafe = false
            for (let index = 0; index < segments.length && !unsafe; index++) {
              if (segments[index] === "..") continue
              prefix = join(prefix, segments[index])
              if (segments.slice(index + 1).includes(".."))
                unsafe = (yield* fs.readLink(prefix).pipe(Effect.orElseSucceed(() => undefined))) !== undefined
            }
            if (unsafe)
              return yield* Effect.fail(
                new FileSystemError({
                  method: "writeAtomic",
                  cause: new Error(`Symbolic link destination cannot be resolved safely: ${link}`),
                }),
              )
            hopTarget = isAbsolute(link) ? link : join(parent, link)
          }
          // A chain longer than the walk (or a loop) leaves the target
          // still a link: fail rather than rename over it and destroy it.
          if ((yield* fs.readLink(hopTarget).pipe(Effect.orElseSucceed(() => undefined))) !== undefined)
            return yield* Effect.fail(
              new FileSystemError({
                method: "writeAtomic",
                cause: new Error(`Too many levels of symbolic links: ${path}`),
              }),
            )
          target = yield* resolve(hopTarget)
        }
        yield* ensureDir(dirname(target))
        // One stat carries the existing mode (and ownership, when preserving):
        // the temp file renamed over the target must take both.
        const info = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => undefined))
        const existingMode = info === undefined ? undefined : info.mode & 0o7777
        const mode =
          options?.modePolicy === "owner-capped"
            ? existingMode === undefined
              ? 0o600
              : existingMode & 0o600
            : existingMode ?? options?.freshMode ?? 0o600
        // The temp is private and unique: a short pid + random basename in
        // the target's directory (its length never depends on the target's
        // name, so a near-limit basename still fits), created exclusively
        // (wx) at 0o600, so concurrent writers cannot consume each other's
        // rename source and secret-bearing content is never briefly
        // world-readable. Cleanup removes only a temp this invocation
        // actually created — a wx collision leaves the other writer's
        // file untouched.
        const temp = join(dirname(target), `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`)
        let created = false
        const write = Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(temp, { flag: "wx", mode: 0o600 })
              created = true
              yield* handle.writeAll(typeof content === "string" ? new TextEncoder().encode(content) : content)
            }),
          )
          if (options?.preserveOwnership && info !== undefined) {
            const uid = Option.getOrUndefined(info.uid)
            const gid = Option.getOrUndefined(info.gid)
            if (uid !== undefined && gid !== undefined) yield* fs.chown(temp, uid, gid)
          }
          // The final mode is applied unconditionally, and after ownership:
          // the creation mode is still cut by the process umask, and chown
          // clears setuid/setgid bits, so only a last chmod makes the
          // computed mode the file's actual mode.
          yield* fs.chmod(temp, mode)
          yield* renameWithRetry(temp, target)
          created = false
        })
        yield* write.pipe(
          Effect.onError(() => (created ? fs.remove(temp, { force: true }).pipe(Effect.ignore) : Effect.void)),
        )
      })

      const writeJsonAtomic = Effect.fn("FileSystem.writeJsonAtomic")(function* (
        path: string,
        data: unknown,
        options?: WriteAtomicOptions,
      ) {
        yield* writeAtomic(path, JSON.stringify(data, null, 2), options)
      })

      const scan = Effect.fn("FileSystem.scan")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const up = Effect.fn("FileSystem.up")(function* (options: UpOptions) {
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            const found =
              options.type === "file"
                ? yield* isFile(search)
                : options.type === "directory"
                  ? yield* isDir(search)
                  : yield* fs.exists(search)
            if (found) {
              result.push(search)
              if (options.mode === "first") return result
            }
          }
          if (options.stop && sameDirectory(options.stop, current)) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const findUp = Effect.fn("FileSystem.findUp")((target: string, start: string, stop?: string) =>
        up({ targets: [target], start, stop }),
      )

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* scan(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          )
          result.push(...matches)
          if (stop && sameDirectory(stop, current)) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        resolve,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        writeAtomic,
        writeJsonAtomic,
        findUp,
        up,
        globUp,
        scan,
        globMatch: Glob.match,
      })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [filesystem] })

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = path.resolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = path.resolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return normalizePath(resolved)
      throw e
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  export function overlaps(a: string, b: string) {
    return contains(a, b) || contains(b, a)
  }

  export function contains(parent: string, child: string) {
    const result = relative(parent, child)
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  }
}
