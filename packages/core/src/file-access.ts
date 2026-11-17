export * as FileAccess from "./file-access.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Array, Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { Location } from "./location.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { AbsolutePath } from "./schema.js"
import type { SessionErrors } from "./session/error.js"
import type { Tool } from "./tool.js"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical directory used as the external approval boundary. */
  readonly directory: AbsolutePath
  readonly resource: string
  readonly save: string
}

export interface Target {
  readonly absolute: AbsolutePath
  /** Location-relative for internal paths, absolute for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export type Invocation = Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">

export interface ReadOptions {
  /** A target already authorized by this invocation, used for filename recovery. */
  readonly siblingOf: Target
}

export interface Interface {
  /** Resolve a path and its permission resources, without requesting approval. Classification is by canonical (symlink-resolved) location, per the symlink policy in the layer. */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, FSUtil.Error>
  /** Approve external directories in one batch, preserving first-seen resource order. */
  readonly authorizeExternal: (
    targets: readonly Target[],
    context: Invocation,
    metadata?: Permission.AssertInput["metadata"],
  ) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /** Resolve a read target and obtain external-directory approval before read approval. */
  readonly authorizeRead: (
    file: string,
    context: Invocation,
    options?: ReadOptions,
  ) => Effect.Effect<Target, FSUtil.Error | Error | SessionErrors.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileAccess") {}

/** Expand a leading ~ and normalize Windows shell paths before lexical resolution. */
export const resolvePath = (directory: string, input: string, home = Global.Path.home) => {
  const normalized = FSUtil.windowsPath(input)
  return path.resolve(
    directory,
    normalized === "~"
      ? home
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(home, normalized.slice(2))
        : normalized,
  )
}

const slash = (value: string) => value.replaceAll("\\", "/")
const invocation = (context: Invocation) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    // Symlink policy (#2286): classification uses the canonical path —
    // the path the filesystem will actually open — never the lexical
    // spelling alone. An existing path is fully canonicalized
    // (realpath, via fs.resolve). A path that does not exist yet
    // canonicalizes its nearest existing ancestor and appends the
    // remaining segments lexically: the missing name cannot itself be
    // a symlink, but a symlinked ancestor directory can still redirect
    // it across the boundary, and the ancestor decides classification.
    // A dangling final symlink counts as not-yet-existing: it cannot
    // be read, and creation through it is the mutation layer's own
    // link walk. resolve() preserves the lexical absolute for internal
    // targets (mutation consumers operate on the path as given, and
    // their own link walks apply); external targets are reported by
    // their canonical path, which is where their approval boundary
    // sits. authorizeRead goes one step further: for an existing
    // target it returns the canonical path, so the file that was
    // authorized is the file that is read — swapping a symlink after
    // authorization cannot redirect an already-authorized read to a
    // different file. The location and worktree roots are
    // canonicalized on the same basis, so the containment checks
    // compare like with like.
    const canonicalize = Effect.fn("FileAccess.canonicalize")(function* (absolute: string) {
      let current = absolute
      const tail: string[] = []
      while (true) {
        // Any stat failure (missing, ENOTDIR through a file component,
        // ELOOP, EACCES) means this prefix is not a resolvable existing
        // path; keep walking up. Classification only needs the nearest
        // resolvable ancestor — the caller's own operation surfaces the
        // real filesystem error if the path is genuinely unusable.
        const info = yield* fs.stat(current).pipe(Effect.orElseSucceed(() => undefined))
        if (info) {
          const resolved = yield* fs.resolve(current)
          return {
            canonical: tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse()),
            exists: tail.length === 0,
          }
        }
        const parent = path.dirname(current)
        if (parent === current) return { canonical: absolute, exists: false }
        tail.push(path.basename(current))
        current = parent
      }
    })

    const resolveTarget = Effect.fn("FileAccess.resolveTarget")(function* (input: ResolveInput) {
      const lexical = resolvePath(location.directory, input.path)
      const target = yield* canonicalize(lexical)
      const locationRoot = yield* canonicalize(path.resolve(location.directory))
      const worktree = yield* canonicalize(path.resolve(location.project.directory))
      const internal =
        FSUtil.contains(locationRoot.canonical, target.canonical) ||
        (worktree.canonical !== path.parse(worktree.canonical).root &&
          FSUtil.contains(worktree.canonical, target.canonical))
      if (internal) {
        return {
          target: {
            absolute: AbsolutePath.make(lexical),
            resource: slash(path.relative(location.directory, lexical) || "."),
          } satisfies Target,
          canonical: target.canonical,
          exists: target.exists,
          locationCanonical: locationRoot.canonical,
        }
      }
      const absolute = AbsolutePath.make(target.canonical)
      const type =
        input.kind === "directory"
          ? "Directory"
          : input.kind === "file"
            ? "File"
            : (yield* fs.stat(absolute).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)))
                ?.type
      const directory = AbsolutePath.make(type === "Directory" ? absolute : path.dirname(absolute))
      return {
        target: {
          absolute,
          resource: slash(absolute),
          externalDirectory: {
            action: "external_directory",
            directory,
            resource: slash(path.join(directory, "*")),
            save: slash(path.join((yield* Project.root(fs, directory)) ?? directory, "*")),
          },
        } satisfies Target,
        canonical: target.canonical,
        exists: target.exists,
        locationCanonical: locationRoot.canonical,
      }
    })

    const resolve = Effect.fn("FileAccess.resolve")(function* (input: ResolveInput) {
      return (yield* resolveTarget(input)).target
    })

    const authorizeExternal = Effect.fn("FileAccess.authorizeExternal")(function* (
      targets: readonly Target[],
      context: Invocation,
      metadata?: Permission.AssertInput["metadata"],
    ) {
      const external = Array.dedupeWith(
        targets.flatMap((target) => (target.externalDirectory ? [target.externalDirectory] : [])),
        (left, right) => left.resource === right.resource,
      )
      if (external.length === 0) return
      yield* permission.assert({
        action: "external_directory",
        resources: external.map((item) => item.resource),
        save: external.map((item) => item.save),
        ...(metadata === undefined ? {} : { metadata }),
        ...invocation(context),
      })
    })

    const authorizeRead = Effect.fn("FileAccess.authorizeRead")(function* (
      file: string,
      context: Invocation,
      options?: ReadOptions,
    ) {
      const resolved = yield* resolveTarget({ path: file, kind: options ? "file" : undefined })
      // For an existing target the read operates on the canonical path:
      // the file that was authorized is the file that is read (#2286).
      const target: Target = resolved.exists
        ? {
            ...resolved.target,
            absolute: AbsolutePath.make(resolved.canonical),
            resource: resolved.target.externalDirectory
              ? resolved.target.resource
              : slash(path.relative(resolved.locationCanonical, resolved.canonical) || "."),
          }
        : resolved.target
      const sibling = options && path.dirname(target.absolute) === path.dirname(options.siblingOf.absolute)

      // Filename recovery shares the directory approval, but checks the recovered file's own read rules.
      if (!sibling) yield* authorizeExternal([target], context)
      yield* permission.assert({
        action: "read",
        resources: [target.resource],
        save: ["*"],
        ...invocation(context),
      })
      return target
    })

    return Service.of({ resolve, authorizeExternal, authorizeRead })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Location.node, Permission.node] })
