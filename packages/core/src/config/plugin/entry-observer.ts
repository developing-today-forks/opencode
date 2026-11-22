export * as ConfigEntryObserver from "./entry-observer.js"

import type { EventDomain } from "@opencode/plugin/effect/event"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, PubSub, Stream } from "effect"
import path from "path"
import { Config, reloadsSections } from "../../config.js"

/**
 * Keeps `entries` current and runs `reload` on `config.updated`. With `sections`, an update that touches none of
 * those top-level keys refreshes the entries without reloading.
 */
export const observe = Effect.fnUntraced(function* (
  config: Config.Interface,
  event: EventDomain,
  reload: Effect.Effect<void>,
  sections?: readonly string[],
) {
  const loaded = { entries: yield* config.entries() }
  yield* event.subscribe({ types: ["config.updated"] }).pipe(
    Stream.runForEach((update) =>
      config.entries().pipe(
        Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
        Effect.andThen(sections === undefined || reloadsSections(update, sections) ? reload : Effect.void),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  // Close the race between the first read and establishing the subscription.
  loaded.entries = yield* config.entries()
  return loaded
})

/**
 * Loads documents from config entries and reloads them when config is updated or a file changes
 * under one of `directories` in a config directory.
 */
export const observeSources = Effect.fnUntraced(function* <A>(input: {
  readonly config: Config.Interface
  readonly event: EventDomain
  readonly directories: readonly string[]
  readonly load: () => Effect.Effect<A[]>
  readonly reload: Effect.Effect<void>
  /** With these top-level keys, a `config.updated` that touches none of them does not reload. */
  readonly sections?: readonly string[]
}) {
  const config = input.config
  const loaded = { documents: [] as A[] }
  const reload = input.load().pipe(
    Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
    Effect.andThen(input.reload),
  )
  // One trigger feed serializes reloads and shares one debounce window;
  // subscribing before the initial scan means updates racing the scan still
  // trigger a rebuild. Each source is subscribed eagerly on its own fiber
  // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
  // so no update slips through while the debounce starts its pull.
  const changes = yield* PubSub.sliding<void>(1)
  const notify = () => PubSub.publish(changes, undefined)
  yield* config.changes().pipe(
    Stream.filterEffect((update) =>
      Effect.map(config.entries(), (entries) => isDirectorySource(entries, update.path, input.directories)),
    ),
    Stream.runForEach(notify),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* input.event.subscribe({ types: ["config.updated"] }).pipe(
    Stream.filter((update) => input.sections === undefined || reloadsSections(update, input.sections)),
    Stream.runForEach(notify),
    Effect.forkScoped({ startImmediately: true }),
  )
  const updates = yield* PubSub.subscribe(changes)
  yield* Stream.fromSubscription(updates).pipe(
    Stream.debounce("100 millis"),
    Stream.runForEach(() => reload),
    Effect.forkScoped({ startImmediately: true }),
  )
  loaded.documents = yield* input.load()
  return loaded
})

// Matches anything at or under <root>/<name> for a config directory. No file-suffix
// check: directory-level events such as renames carry no per-file paths.
export function isDirectorySource(entries: readonly Entry[], file: string, names: readonly string[]) {
  return entries.some(
    (entry) => entry.type === "directory" && names.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}
