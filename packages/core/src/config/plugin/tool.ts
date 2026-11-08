export * as ConfigToolPlugin from "./tool.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Directory, type Entry } from "@opencode/schema/config"
import { Tool } from "@opencode/schema/tool"
import { FSUtil } from "@opencode/util/fs-util"
import { createPluginSources } from "@opencode/plugin/source"
import { Cause, Deferred, Effect, FiberSet, PubSub, Stream } from "effect"
import path from "path"
import { stat } from "node:fs/promises"
import { pathToFileURL } from "url"
import { z } from "zod"
import { $ZodType, toJSONSchema } from "zod/v4/core"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Location } from "../../location.js"

/**
 * Loads v1 custom tools from `{tool,tools}/` directories inside every config
 * root (the global config directory and each project `.opencode` directory,
 * in config priority order) and registers them with the v2 tool service.
 *
 * This restores the documented custom-tools feature (#1703): in v2 nothing
 * scanned these directories, so files like the production
 * `~/.config/opencode/tool/session-identity.ts` were silently dropped and
 * every tool call funneled through code mode + MCP projections only.
 *
 * Tool files keep the v1 shape: the default export is one tool named after
 * the file, and each named export is a tool named `<file>_<export>`. A tool
 * is `{ description, args, execute }` as produced by the `tool()` helper
 * from `@opencode-ai/plugin` (which the host now provides as a compatibility
 * alias) or an equivalent plain object. Registrations go through the normal
 * tool transform pipeline after built-in and package tools, so a custom
 * tool overrides a built-in of the same name, exactly as documented, and
 * the usual permission rules still control catalog visibility.
 */

const sourceDirectories = ["tool", "tools"] as const

type LegacyDefinition = {
  readonly description: string
  readonly args?: Record<string, unknown>
  readonly execute: (args: any, context: any) => Promise<unknown> | unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A value counts as an attempted tool when it carries either half of the shape; partial shapes warn instead of vanishing. */
const isAttempted = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && (typeof value.execute === "function" || typeof value.description === "string")

const isDefinition = (value: unknown): value is LegacyDefinition =>
  isRecord(value) &&
  typeof value.description === "string" &&
  value.description.length > 0 &&
  typeof value.execute === "function" &&
  (value.args === undefined || isRecord(value.args))

export const Plugin = define({
  id: "opencode.config.tool",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const scope = yield* Effect.scope
    const runPromise = yield* FiberSet.makeRuntimePromise()

    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)

    // Mirror PluginModule: watch every file a tool module touches so edits
    // to a tool or one of its local imports reload it. The plugin-source
    // cache re-reads only files whose digest changed.
    const watched = new Set<string>()
    const watch = (file: string): Promise<void> =>
      runPromise(
        Effect.gen(function* () {
          if (watched.has(file)) return
          watched.add(file)
          const ready = yield* Deferred.make<void>()
          const target = yield* Effect.promise(() => watchTarget(file))
          const updates = yield* watcher.subscribe(target, Deferred.succeed(ready, undefined))
          yield* updates.pipe(
            Stream.runForEach(() => notify()),
            Effect.ensuring(Deferred.succeed(ready, undefined)),
            Effect.forkIn(scope, { startImmediately: true }),
          )
          yield* Deferred.await(ready)
        }),
      )
    const sources = yield* Effect.acquireRelease(
      Effect.sync(() => createPluginSources(watch)),
      (sources) => Effect.sync(() => sources.dispose()),
    )

    const convert = Effect.fnUntraced(function* (name: string, definition: LegacyDefinition, file: string) {
      const input = inputSchema(definition.args)
      if (input.foreign)
        yield* Effect.logWarning("custom tool argument schemas are not host Zod; registering a permissive object schema", {
          file,
          tool: name,
        })
      return {
        name,
        description: definition.description,
        input: input.schema,
        execute: (input: any, context: Tool.Context) =>
          Effect.tryPromise({
            try: async (signal) => definition.execute(input, legacyContext(location, context, signal)),
            catch: (error) =>
              new Tool.Error({
                message: error instanceof globalThis.Error ? error.message : String(error),
              }),
          }).pipe(Effect.map(normalizeResult)),
      } satisfies Tool.Info
    })

    const loadFile = Effect.fnUntraced(function* (file: string) {
      const base = path.basename(file).replace(/\.[^.]+$/, "")
      const loaded = yield* Effect.promise(() => sources.read(pathToFileURL(file).href)).pipe(
        Effect.map((result) => ({ ok: true as const, module: result.module })),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to load custom tool file", { file, cause: String(Cause.squash(cause)) }).pipe(
            Effect.as({ ok: false as const, module: undefined }),
          ),
        ),
      )
      if (!loaded.ok) return [] as Tool.Info[]
      const module = loaded.module
      if (!isRecord(module)) {
        yield* Effect.logWarning("custom tool file exported no tools", { file })
        return [] as Tool.Info[]
      }
      const tools: Tool.Info[] = []
      for (const [exportName, value] of Object.entries(module)) {
        if (!isAttempted(value)) continue
        const name = exportName === "default" ? base : `${base}_${exportName}`
        if (!isDefinition(value)) {
          yield* Effect.logWarning("skipping invalid custom tool definition", { file, export: exportName })
          continue
        }
        tools.push(yield* convert(name, value, file))
      }
      if (tools.length === 0) yield* Effect.logWarning("custom tool file exported no tools", { file })
      return tools
    })

    const load = Effect.fn("ConfigToolPlugin.load")(function* () {
      const entries = yield* config.entries()
      const files = yield* Effect.forEach(
        entries.filter((entry): entry is Directory => entry.type === "directory"),
        (entry) =>
          fs
            .scan("{tool,tools}/*.{ts,js}", { cwd: entry.path, absolute: true, dot: true, symlink: true })
            .pipe(Effect.orElseSucceed(() => [] as string[])),
      ).pipe(Effect.map((items) => items.flat().toSorted()))
      // Registration order is config priority order: later (project) tools
      // override earlier (global) ones, and all of them override built-ins.
      return yield* Effect.forEach(files, loadFile).pipe(Effect.map((items) => items.flat()))
    })

    const loaded: { tools: Tool.Info[] } = { tools: [] }
    const reload = load().pipe(
      Effect.tap((tools) => Effect.sync(() => (loaded.tools = tools))),
      Effect.andThen(ctx.tool.reload()),
    )

    yield* config
      .changes()
      .pipe(
        Stream.filterEffect((update) =>
          Effect.map(config.entries(), (entries) => isToolSource(entries, update.path)),
        ),
        Stream.runForEach(() => notify()),
        Effect.forkScoped({ startImmediately: true }),
      )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )

    loaded.tools = yield* load()
    yield* ctx.tool.transform((editor) => {
      for (const tool of loaded.tools) editor.add(tool)
    })
  }),
})

function isToolSource(entries: readonly Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

// A missing dependency may have missing parents too. Watch the nearest
// existing ancestor recursively so creating the rest of the path can
// trigger recovery. (Same helper as PluginModule.)
function watchTarget(file: string): Promise<Watcher.WatchInput> {
  return stat(file).then(
    (info) => ({ path: file, type: info.isDirectory() ? "directory" : "file" }),
    (cause) => {
      if (path.dirname(file) === file) throw cause
      return watchTarget(path.dirname(file))
    },
  )
}

function legacyContext(location: Location.Interface, context: Tool.Context, signal: AbortSignal) {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: location.directory,
    worktree: location.project.directory,
    // The real tryPromise interruption signal (#1784): it fires when
    // tool execution is interrupted, replacing the never-aborted stub.
    abort: signal,
  }
}

function normalizeResult(result: unknown): Tool.Result {
  if (typeof result === "string") return { content: result }
  if (isRecord(result) && typeof result.output === "string") {
    const attachments = Array.isArray(result.attachments) ? result.attachments : []
    const files = attachments.flatMap((item): Tool.Content[] =>
      isRecord(item) && typeof item.url === "string" && typeof item.mime === "string"
        ? [
            {
              type: "file" as const,
              uri: item.url,
              mime: item.mime,
              ...(typeof item.filename === "string" ? { name: item.filename } : {}),
            },
          ]
        : [],
    )
    return {
      content: files.length > 0 ? [{ type: "text" as const, text: result.output }, ...files] : result.output,
      ...(isRecord(result.metadata) ? { metadata: result.metadata } : {}),
    }
  }
  if (result === undefined || result === null) return { content: "" }
  return { content: typeof result === "object" ? JSON.stringify(result) : String(result) }
}

/**
 * Build the v2 input schema for a v1 `args` record of Zod schemas. The
 * host's Zod v4 object validates at runtime and renders the JSON schema the
 * model sees. Definitions authored against a foreign Zod (for example a
 * project-pinned v1 plugin package) fall back to a permissive JSON object
 * schema derived per-argument where possible, with a loud warning: the tool
 * stays callable instead of breaking the whole catalog.
 */
function inputSchema(args: Record<string, unknown> | undefined): {
  readonly schema: Tool.ValueSchema<any>
  readonly foreign: boolean
} {
  const record = args ?? {}
  if (Object.keys(record).length === 0) return { schema: z.object({}), foreign: false }
  try {
    const object = z.object(record as Record<string, z.ZodType>)
    // Prove the schema survives both runtime validation and JSON rendering
    // before registering it; a foreign schema throws somewhere in here.
    toJSONSchema(object, { target: "draft-2020-12", io: "input" })
    if (!(object instanceof $ZodType)) throw new Error("not a host Zod schema")
    return { schema: object, foreign: false }
  } catch {
    const properties = Object.fromEntries(
      Object.entries(record).map(([key, value]) => {
        try {
          return [key, toJSONSchema(value as $ZodType, { target: "draft-2020-12", io: "input" })]
        } catch {
          return [key, {}]
        }
      }),
    )
    return { schema: { type: "object", properties, additionalProperties: true }, foreign: true }
  }
}
