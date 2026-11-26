export * as FileWatch from "./file-watch.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { FileSystem } from "@opencode/schema/filesystem"
import type { Location } from "@opencode/schema/location"
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { Bus } from "../bus.js"
import { Watcher } from "./watcher.js"
import { realpathSync } from "node:fs"
import path from "path"

export const TTL = Duration.hours(24)
export const SWEEP_INTERVAL = Duration.minutes(5)
export const MAX_PER_LOCATION = 256

export class DisabledError extends Schema.TaggedError<DisabledError>()("FileWatch.DisabledError", {}) {
  override get message() {
    return "File watching is disabled"
  }
}

export type Input = {
  readonly location: Location.Ref
  /** Absolute path of the file to watch. */
  readonly file: string
}

export interface Interface {
  /** Starts watching a file, or resets its expiry when it is already watched. */
  readonly watch: (input: Input) => Effect.Effect<void, DisabledError>
  readonly unwatch: (input: Input) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatch") {}

export const Options = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

type Entry = { expires: number; scope: Scope.Closeable }

// Global rather than location-scoped so watches outlive idle location eviction.
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (options?.enabled === false) {
        return Service.of({ watch: () => Effect.fail(new DisabledError()), unwatch: () => Effect.void })
      }
      const watcher = yield* Watcher.Service
      const bus = yield* Bus.Service
      const fs = yield* FSUtil.Service
      const scope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const locations = new Map<string, Map<string, Entry>>()
      const locationKey = (location: Location.Ref) => JSON.stringify([location.directory, location.workspaceID])

      // Symlink-swap confinement (#2830): fs.watch checks confinement with
      // FileSystem.read, then subscribes by lexical path. A parent directory
      // swapped for an outside symlink in between subscribes outside the
      // location. Canonicalize best-effort — realpath of the nearest existing
      // ancestor with missing components reattached, so a swapped parent
      // still fails closed — and require containment in the canonical
      // location directory anchored when the watch starts, so a later root
      // replacement cannot move the check along with the target. The native
      // subscription uses the canonical path while published events keep the
      // requested filename. Nothing existing falls back to the lexical path,
      // preserving synthetic (non-existent) watch paths.
      const canonical = (input: string) => {
        const absolute = path.resolve(input)
        const missing: string[] = []
        let current = absolute
        while (true) {
          try {
            return path.join(realpathSync(current), ...missing.reverse())
          } catch {
            const parent = path.dirname(current)
            if (parent === current) return absolute
            missing.push(path.basename(current))
            current = parent
          }
        }
      }
      const confined = (root: string, file: string) => {
        const real = canonical(file)
        return FSUtil.contains(root, real) ? real : undefined
      }

      const refuse = (file: string) =>
        Effect.logWarning("file watch refused outside location", { file })

      const remove = (key: string, file: string) => {
        const files = locations.get(key)
        const entry = files?.get(file)
        if (!files || !entry) return
        files.delete(file)
        if (files.size === 0) locations.delete(key)
        return entry
      }

      const stop = (key: string, file: string) =>
        Effect.suspend(() => {
          const entry = remove(key, file)
          if (!entry) return Effect.void
          return Scope.close(entry.scope, Exit.void)
        })

      const start = Effect.fnUntraced(function* (key: string, input: Input, root: string, target: string) {
        const child = yield* Scope.fork(scope)
        yield* Effect.gen(function* () {
          // Revalidate immediately before subscribing: the handler's read
          // check may predate a parent symlink swap.
          if (!confined(root, input.file)) {
            yield* refuse(input.file)
            return
          }
          const updates = yield* watcher.subscribe({ path: target, type: "file" })
          yield* Stream.runForEach(updates, () =>
            Effect.gen(function* () {
              // A swap after subscribing must not publish outside events.
              if (!confined(root, input.file)) return
              const exists = yield* fs.existsSafe(input.file)
              yield* bus.publish(
                FileSystem.Event.Changed,
                { file: input.file, event: exists ? "change" : "unlink" },
                { location: input.location },
              )
            }),
          )
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("file watch failed", { file: input.file, cause }),
          ),
          // The watch ended or failed (e.g. its directory vanished): forget it so the next watch starts a new one.
          // Interrupts skip this. The scope closes from another fiber because closing it interrupts this one.
          Effect.andThen(
            lock.withPermit(
              Effect.suspend(() => {
                if (locations.get(key)?.get(input.file)?.scope !== child) return Effect.void
                remove(key, input.file)
                return Scope.close(child, Exit.void).pipe(Effect.forkIn(scope), Effect.asVoid)
              }),
            ),
          ),
          Effect.forkIn(child, { startImmediately: true }),
        )
        return child
      })

      const sweep = lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const expired = [...locations].flatMap(([key, files]) =>
            [...files].filter(([, entry]) => entry.expires <= now).map(([file]) => [key, file] as const),
          )
          yield* Effect.forEach(expired, ([key, file]) => stop(key, file), { discard: true })
        }),
      )
      yield* sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.forkScoped)

      return Service.of({
        watch: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              const key = locationKey(input.location)
              const expires = (yield* Clock.currentTimeMillis) + Duration.toMillis(TTL)
              const existing = locations.get(key)?.get(input.file)
              if (existing) {
                existing.expires = expires
                return
              }
              // Refuse synchronously when the path already resolves outside,
              // so no subscription is established for a swapped parent.
              const root = canonical(input.location.directory)
              const target = confined(root, input.file)
              if (!target) {
                yield* refuse(input.file)
                return
              }
              const full = locations.get(key)
              if (full && full.size >= MAX_PER_LOCATION) {
                const soonest = [...full].reduce((a, b) => (b[1].expires < a[1].expires ? b : a))
                yield* stop(key, soonest[0])
              }
              const entry = { expires, scope: yield* start(key, input, root, target) }
              const files = locations.get(key) ?? new Map<string, Entry>()
              files.set(input.file, entry)
              locations.set(key, files)
            }),
          ),
        unwatch: (input) => lock.withPermit(stop(locationKey(input.location), input.file)),
      })
    }),
  )

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [Watcher.node, Bus.node, FSUtil.node] })
}

export const node = configured()
