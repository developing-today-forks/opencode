export * as Watcher from "./watcher.js"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper.js"
import type ParcelWatcher from "@parcel/watcher"
import { FileSystem } from "@opencode/schema/filesystem"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Cause, Context, Effect, Layer, Option, PubSub, RcMap, Schema, Stream } from "effect"
import { Bus } from "../bus.js"
import { lazy } from "../util/lazy.js"
import { existsSync, watch } from "node:fs"
import path from "path"
import loadBinding from "./watcher-binding.js"

const SUBSCRIBE_TIMEOUT_MS = 10_000
export const Event = { Updated: FileSystem.Event.Changed, Degraded: FileSystem.Event.Degraded }

/** Why a directory watch could not be established, in user-presentable classes (#797). */
export type DegradedCause = "timeout" | "inotify-limit" | "unsupported" | "error"

export function classifySubscribeFailure(cause: Cause.Cause<unknown>): DegradedCause {
  const pretty = Cause.pretty(cause)
  if (pretty.includes("TimeoutException") || pretty.includes("TimeoutError")) return "timeout"
  if (pretty.includes("ENOSPC") || /inotify/i.test(pretty)) return "inotify-limit"
  return "error"
}

const watcher = lazy((): typeof ParcelWatcher | undefined => {
  try {
    return createWrapper(loadBinding()) as typeof ParcelWatcher
  } catch {
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

export const hasNativeBinding = () => !!watcher()
export type Update = ParcelWatcher.Event

export type WatchInput =
  | { readonly path: string; readonly type: "file" }
  | { readonly path: string; readonly type: "entries"; readonly names: readonly string[] }
  | { readonly path: string; readonly type: "directory"; readonly ignore?: readonly string[] }

export type Subscription = {
  readonly unsubscribe: () => Promise<void>
  /** Backend name for logging, e.g. "node" or "fs-events". */
  readonly backend?: string
}

type Target = {
  readonly target: string
  readonly ignore: readonly string[]
} & (
  | { readonly type: "entries"; readonly names: readonly string[] }
  | { readonly type: "file" | "directory"; readonly names?: readonly string[] }
)

export interface NativeInterface {
  readonly subscribe: (
    input: Target & {
      readonly publish: (update: Update) => void
      /** Called once when no watch could be established for a directory, with the failure class. */
      readonly degraded?: (cause: DegradedCause) => void
    },
  ) => Effect.Effect<Subscription | undefined>
}

/** Uses fs.watch for immediate entries and Parcel for recursive directories. */
export class Native extends Context.Service<Native, NativeInterface>()("@opencode/Watcher/Native") {}

export interface Interface {
  /** onReady runs after native acquisition and listener registration, when the stream is consumed. */
  readonly subscribe: (input: WatchInput, onReady?: Effect.Effect<void>) => Effect.Effect<Stream.Stream<Update>>
}

export const Options = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/Watcher") {}

export interface TestInterface extends Interface {
  /** Delivers one update to every active watch whose target covers `update.path`. */
  readonly emit: (update: Update) => Effect.Effect<void>
  /** Returns every subscribe call observed so far, in order. */
  readonly subscriptions: () => Effect.Effect<readonly WatchInput[]>
}

export class Test extends Context.Service<Test, TestInterface>()("@opencode/Watcher/Test") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (options?.enabled === false) {
        return Service.of({ subscribe: () => Effect.succeed(Stream.empty) })
      }
      const native = yield* Native

      // A directory that cannot be watched at all is a user-visible state, not
      // just a log line (#797): publish it on the Bus in the FileSystem event
      // family, the channel LocationWatcher already uses for filesystem.changed.
      // The Bus is captured when this layer is built (the RcMap lookup runs in
      // a build-time context, so a runtime serviceOption there would never see
      // it); contexts built without one keep the log line only.
      const bus = yield* Effect.serviceOption(Bus.Service)
      const publishDegraded = (directory: string, cause: DegradedCause) =>
        Option.isNone(bus)
          ? Effect.void
          : bus.value.publish(FileSystem.Event.Degraded, { directory, cause }).pipe(Effect.ignoreCause)

      // Keys compare structurally (effect Equal), so equivalent watches share one entry.
      const watchers = yield* RcMap.make({
        lookup: (key: Target) =>
          Effect.gen(function* () {
            const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Update>(), (pubsub) => PubSub.shutdown(pubsub))
            const subscription = yield* Effect.acquireRelease(
              native.subscribe({
                ...key,
                publish: (update) => PubSub.publishUnsafe(pubsub, update),
                degraded: (cause) => Effect.runFork(publishDegraded(key.target, cause)),
              }),
              (subscription) =>
                subscription
                  ? Effect.promise(() => subscription.unsubscribe()).pipe(
                      Effect.ignoreCause,
                      Effect.andThen(Effect.logInfo("watcher stopped", { path: key.target, type: key.type })),
                    )
                  : Effect.void,
              // Native subscription may stay pending up to SUBSCRIBE_TIMEOUT_MS;
              // scope shutdown must not wait behind an uninterruptible acquisition.
              { interruptible: true },
            )
            if (!subscription) {
              // Unsupported backend: end subscriber streams instead of hanging them.
              yield* PubSub.shutdown(pubsub)
              return pubsub
            }
            yield* Effect.logInfo("watcher started", {
              path: key.target,
              type: key.type,
              backend: subscription.backend,
              ignores: key.ignore.length,
            })
            return pubsub
          }),
      })

      const subscribe = Effect.fnUntraced(function* (input: WatchInput, onReady: Effect.Effect<void> = Effect.void) {
        const target = path.resolve(input.path)
        const ignore = [...new Set(input.type === "directory" ? (input.ignore ?? []) : [])].toSorted()
        const names = [...new Set(input.type === "entries" ? input.names : [])].toSorted()
        yield* Effect.logInfo("watcher subscribe", {
          path: target,
          type: input.type,
          ignores: ignore.length,
        })
        return Stream.unwrap(
          Effect.gen(function* () {
            const pubsub = yield* RcMap.get(watchers, { type: input.type, target, ignore, names })
            const subscription = yield* PubSub.subscribe(pubsub)
            if (yield* PubSub.isShutdown(pubsub)) return Stream.empty
            yield* onReady
            return Stream.fromSubscription(subscription)
          }),
        )
      })

      return Service.of({ subscribe })
    }),
  )

/** Real subscription lifecycle with in-memory, path-filtered event delivery. */
export const testLayer = Layer.effectContext(
  Effect.gen(function* () {
    const subscriptions: WatchInput[] = []
    const active = new Map<(update: Update) => void, (path: string) => boolean>()
    const native = Native.of({
      subscribe: (input) =>
        Effect.sync(() => {
          subscriptions.push(
            input.type === "file"
              ? { path: input.target, type: "file" }
              : input.type === "entries"
                ? { path: input.target, type: "entries", names: input.names }
                : input.ignore.length > 0
                  ? { path: input.target, type: "directory", ignore: input.ignore }
                  : { path: input.target, type: "directory" },
          )
          // Ignore entries resolve against the target like the parcel wrapper's
          // literal paths. Glob entries resolve to paths nothing lives under, so
          // they are inert here rather than compiled the way parcel compiles them.
          const ignored = input.ignore.map((entry) => path.resolve(input.target, entry))
          active.set(input.publish, (target) => {
            if (input.type === "file") return target === input.target
            if (input.type === "entries")
              return path.dirname(target) === input.target && input.names.includes(path.basename(target))
            return FSUtil.contains(input.target, target) && !ignored.some((entry) => FSUtil.contains(entry, target))
          })
          return {
            unsubscribe: () => {
              active.delete(input.publish)
              return Promise.resolve()
            },
          }
        }),
    })
    const context = yield* Layer.build(layer().pipe(Layer.provide(Layer.succeed(Native, native))))
    const test = Test.of({
      subscribe: Context.get(context, Service).subscribe,
      emit: (update) =>
        Effect.sync(() => {
          const target = path.resolve(update.path)
          active.forEach((matches, publish) => {
            if (matches(target)) publish(update)
          })
        }),
      subscriptions: () => Effect.sync(() => [...subscriptions]),
    })
    return Context.empty().pipe(Context.add(Service, test), Context.add(Test, test))
  }),
)

export const nativeLayer = Layer.succeed(
  Native,
  Native.of({
    subscribe: (input) => {
      if (input.type === "file" || input.type === "entries") {
        return Effect.sync(() => {
          const directory = input.type === "file" ? path.dirname(input.target) : input.target
          const names = new Set(input.type === "file" ? [path.basename(input.target)] : input.names)
          const subscription = watch(directory, { recursive: false }, (_event, file) => {
            if (file && !names.has(file)) return
            for (const name of file ? [file] : names) {
              input.publish({ path: path.join(directory, name), type: "update" })
            }
          })
          subscription.on("error", (error: unknown) =>
            Effect.runFork(Effect.logError("watcher callback failed", { path: directory, error })),
          )
          return { unsubscribe: () => Promise.resolve(subscription.close()), backend: "node" }
        })
      }
      return subscribeDirectory(watcher(), getBackend(), input.target, input.ignore, input.publish, input.degraded)
    },
  }),
)

export const nativeNode = makeGlobalNode({ service: Native, layer: nativeLayer, deps: [] })

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [nativeNode, Bus.node] })
}

export const node = configured()

function subscribeDirectory(
  native: typeof ParcelWatcher | undefined,
  backend: ParcelWatcher.BackendType | undefined,
  directory: string,
  ignore: readonly string[],
  publish: (update: Update) => void,
  degraded?: (cause: DegradedCause) => void,
): Effect.Effect<Subscription | undefined> {
  if (!native || !backend) {
    // The Parcel binding can be unavailable even on supported platforms
    // (e.g. its native library fails to load), which must not silently end
    // every directory watch: fall back to node's recursive fs.watch (#773).
    return fallBackToNode(directory, ignore, publish, degraded, "unsupported")
  }

  const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
    if (error) Effect.runFork(Effect.logError("watcher callback failed", { error }))
    for (const update of updates) publish(update)
  }
  // Copy `ignore`: it aliases the RcMap key, whose structural hash is cached,
  // so the array handed to native code must never be the mutable original.
  const pending = native.subscribe(directory, callback, { ignore: [...ignore], backend })
  return Effect.promise(() => pending).pipe(
    Effect.map((subscription) => ({ unsubscribe: () => subscription.unsubscribe(), backend })),
    // Interruption (including the timeout below) abandons the pending native
    // subscription, so close it once it eventually resolves.
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
      }),
    ),
    Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
    Effect.catchCause((cause) => {
      // Scope shutdown interrupting a pending subscribe is not a failure:
      // no fallback, no degraded signal.
      if (
        Cause.hasInterrupts(cause) &&
        !Cause.pretty(cause).includes("TimeoutException") &&
        !Cause.pretty(cause).includes("TimeoutError")
      )
        return Effect.succeed(undefined)
      const reason = classifySubscribeFailure(cause)
      return Effect.logError("failed to subscribe", {
        directory,
        cause: Cause.pretty(cause),
      }).pipe(Effect.andThen(fallBackToNode(directory, ignore, publish, degraded, reason)))
    }),
  )
}

/** The #773 node fallback, tried whenever the Parcel subscribe cannot be used or
 * fails (missing binding, timeout, inotify exhaustion, ...). When it also cannot
 * watch, the failure is surfaced through `degraded` instead of ending silently. */
function fallBackToNode(
  directory: string,
  ignore: readonly string[],
  publish: (update: Update) => void,
  degraded: ((cause: DegradedCause) => void) | undefined,
  reason: DegradedCause,
): Effect.Effect<Subscription | undefined> {
  return Effect.gen(function* () {
    let failure = reason
    const subscription = yield* Effect.sync(() => subscribeDirectoryWithNode(directory, ignore, publish)).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          failure = classifySubscribeFailure(cause)
        }).pipe(
          Effect.andThen(
            Effect.logError("watcher node fallback failed", { directory, cause: Cause.pretty(cause) }),
          ),
          Effect.as(undefined),
        ),
      ),
    )
    if (subscription) {
      yield* Effect.logInfo("watcher using node fallback", { directory, reason })
      return subscription
    }
    degraded?.(failure)
    return undefined
  })
}

/** Recursive directory watch on node's fs.watch, used when Parcel is unavailable.
 * Exported so tests can pin the fallback's delivery semantics directly (#968);
 * production subscriptions reach it through fallBackToNode. */
export function subscribeDirectoryWithNode(
  directory: string,
  ignore: readonly string[],
  publish: (update: Update) => void,
): Subscription | undefined {
  // Parcel ignore entries are literal names ("node_modules") or subtree
  // globs ("**/{node_modules,.git}/**"); both reduce to segment names here.
  const ignored = new Set<string>()
  for (const entry of ignore) {
    const braces = entry.match(/\*\*\/\{([^}]+)\}\/\*\*/)
    if (braces) {
      for (const name of braces[1].split(",")) ignored.add(name)
      continue
    }
    const name = entry.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")
    if (name && !/[*{}]/.test(name)) ignored.add(name)
  }
  let subscription: ReturnType<typeof watch>
  try {
    subscription = watch(directory, { recursive: true }, (event, file) => {
      if (!file) return
      const relative = file.toString()
      if (relative.split(path.sep).some((segment) => ignored.has(segment))) return
      const full = path.join(directory, relative)
      // fs.watch cannot distinguish create from delete on a rename; the
      // path's existence at delivery time is the available signal.
      publish({ path: full, type: event === "rename" ? (existsSync(full) ? "create" : "delete") : "update" })
    })
  } catch {
    // Recursive watching is unavailable on this platform/runtime.
    return undefined
  }
  subscription.on("error", (error: unknown) =>
    Effect.runFork(Effect.logError("watcher callback failed", { path: directory, error })),
  )
  return { unsubscribe: () => Promise.resolve(subscription.close()), backend: "node" }
}
