export * as GitHubFiles from "./files.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface Target {
  readonly absolute: string
  /** Relative to the working directory inside the project, absolute outside it. */
  readonly resource: string
  /** Set outside the project: the directory whose `external_directory` approval covers the target. */
  readonly external?: string
}

/** Approvals for local files, using the same permission actions as the read and write tools. */
export interface Interface {
  readonly resolve: (input: { readonly path: string; readonly kind?: "file" | "directory" }) => Effect.Effect<Target>
  readonly authorizeExternal: (targets: ReadonlyArray<Target>, context: Tool.Context) => Effect.Effect<void, Tool.Error>
  readonly authorizeRead: (file: string, context: Tool.Context) => Effect.Effect<Target, Tool.Error>
}

// Symlink policy (#2286, #2641): classification uses the canonical path —
// the path the filesystem will actually open — never the lexical spelling
// alone, mirroring `packages/core/src/file-access.ts`. An existing path is
// fully canonicalized (realpath). A path that does not exist yet
// canonicalizes its nearest existing ancestor and appends the remaining
// segments lexically: the missing name cannot itself be a symlink, but a
// symlinked ancestor directory can still redirect it across the boundary,
// and the ancestor decides classification. A dangling final symlink counts
// as not-yet-existing: it cannot be read, and creation through it is the
// caller's own concern. resolve() preserves the lexical absolute for
// internal targets (callers operate on the path as given); external
// targets are reported by their canonical path, which is where their
// approval boundary sits. The working-directory and project roots are
// canonicalized on the same basis, so the containment checks compare
// like with like.
const canonicalize = (absolute: string): string => {
  let current = absolute
  const tail: string[] = []
  while (true) {
    // Any stat failure (missing, ENOTDIR through a file component, ELOOP,
    // EACCES) means this prefix is not a resolvable existing path; keep
    // walking up. Classification only needs the nearest resolvable
    // ancestor — the caller's own operation surfaces the real filesystem
    // error if the path is genuinely unusable.
    let resolvable = true
    try {
      fs.statSync(current)
    } catch {
      resolvable = false
    }
    if (resolvable) {
      try {
        const resolved = fs.realpathSync(current)
        return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse())
      } catch {
        return absolute
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return absolute
    tail.push(path.basename(current))
    current = parent
  }
}

export function make(input: {
  readonly location: Context["location"]
  readonly permission: Pick<Context["permission"], "assert">
}): Interface {
  const directory = input.location.directory
  const project = path.resolve(input.location.project.directory)
  const canonicalDirectory = canonicalize(directory)
  const canonicalProject = canonicalize(project)
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    // `..cache` is a child named that way; only `..` itself or `../…` leaves the parent.
    const leaves = relative === ".." || relative.startsWith(`..${path.sep}`)
    return relative === "" || (!leaves && !path.isAbsolute(relative))
  }
  const source = (context: Tool.Context) => ({
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool" as const, messageID: context.messageID, id: context.id },
  })
  const resolve: Interface["resolve"] = (target) =>
    Effect.sync(() => {
      const expanded =
        target.path === "~"
          ? os.homedir()
          : target.path.startsWith("~/")
            ? path.join(os.homedir(), target.path.slice(2))
            : target.path
      const absolute = path.resolve(directory, expanded)
      const canonical = canonicalize(absolute)
      const internal =
        inside(canonicalDirectory, canonical) ||
        (canonicalProject !== path.parse(canonicalProject).root && inside(canonicalProject, canonical))
      if (internal) return { absolute, resource: (path.relative(directory, absolute) || ".").replaceAll("\\", "/") }
      return {
        absolute: canonical,
        resource: canonical.replaceAll("\\", "/"),
        external: target.kind === "directory" ? canonical : path.dirname(canonical),
      }
    })
  const authorizeExternal: Interface["authorizeExternal"] = (targets, context) => {
    const resources = Array.from(
      new Set(targets.flatMap((target) => (target.external ? [`${target.external.replaceAll("\\", "/")}/*`] : []))),
    )
    if (resources.length === 0) return Effect.void
    return input.permission.assert({ action: "external_directory", resources, save: resources, ...source(context) })
  }
  return {
    resolve,
    authorizeExternal,
    authorizeRead: (file, context) =>
      Effect.gen(function* () {
        const target = yield* resolve({ path: file, kind: "file" })
        yield* authorizeExternal([target], context)
        yield* input.permission.assert({
          action: "read",
          resources: [target.resource],
          save: ["*"],
          ...source(context),
        })
        return target
      }),
  }
}
