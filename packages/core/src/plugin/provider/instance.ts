import type { EventDomain } from "@opencode/plugin/effect/event"
import { define } from "@opencode/plugin/effect/plugin"
import type { Document, Entry } from "@opencode/schema/config"
import { Effect, Exit, Option, Scope, Semaphore } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Integration } from "../../integration.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

/** The provider and integration one copy of a provider plugin serves. */
export type InstanceIDs = {
  readonly providerID: Provider.ID
  readonly integrationID: Integration.ID
}

/**
 * Configured instances, each instance provider ID mapped to the provider it copies. An instance of an instance is
 * ignored: it would copy a definition that is itself only a copy.
 */
export function configuredInstances(entries: readonly Entry[]) {
  const pairs = entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => Object.entries(entry.info.providers ?? {}))
    .flatMap(([id, item]) =>
      item.instanceOf === undefined || item.instanceOf === id
        ? []
        : [[Provider.ID.make(id), Provider.ID.make(item.instanceOf)] as const],
    )
  const instances = new Map(pairs)
  return new Map(Array.from(instances).filter(([, base]) => !instances.has(base)))
}

/** The part of an instance ID that names its account: `work` for `openai.work`, else the whole ID. */
export function instanceLabel(id: string, base: string) {
  return id.startsWith(`${base}.`) ? id.slice(base.length + 1) : id
}

/**
 * Runs a provider plugin's body for `base` and for every configured instance of it, each instance in its own Scope,
 * so a plugin written for one provider serves every signed-in copy. Instances added to config later start their body
 * then, and its transforms run after the configuration ones; removed instances close theirs.
 */
export const eachInstance = Effect.fnUntraced(function* <R>(
  event: EventDomain,
  base: Provider.ID,
  body: (ids: InstanceIDs) => Effect.Effect<void, never, R>,
) {
  yield* body({ providerID: base, integrationID: Integration.ID.make(base) })
  const config = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(config)) return
  const scope = yield* Scope.Scope
  // Instances added later start from the config subscription's fiber, which lacks the plugin's services.
  const services = yield* Effect.context<Exclude<R, Scope.Scope>>()
  const running = new Map<Provider.ID, Scope.Closeable>()
  const lock = Semaphore.makeUnsafe(1)
  const reconcile = (entries: readonly Entry[]) =>
    lock.withPermit(
      Effect.gen(function* () {
        const wanted = new Set(
          Array.from(configuredInstances(entries)).flatMap(([id, from]) => (from === base ? [id] : [])),
        )
        for (const [id, child] of running) {
          if (wanted.has(id)) continue
          running.delete(id)
          yield* Scope.close(child, Exit.void)
        }
        for (const id of wanted) {
          if (running.has(id)) continue
          const child = yield* Scope.fork(scope)
          running.set(id, child)
          yield* body({ providerID: id, integrationID: Integration.ID.make(id) }).pipe(
            Scope.provide(child),
            Effect.provide(services),
          )
        }
      }),
    )
  const loaded = yield* ConfigEntryObserver.observe(
    config.value,
    event,
    config.value.entries().pipe(Effect.flatMap(reconcile)),
    ["providers"],
  )
  yield* reconcile(loaded.entries)
})

/**
 * Adds every configured instance as a copy of its base provider's catalog definition with its own integration.
 * It runs before the provider plugins, so an instance never inherits what they derive from the base's credential.
 */
export const ProviderInstancePlugin = define({
  id: "opencode.provider.instance",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload())),
      ["providers"],
    )
    yield* ctx.integration.transform((integrations) => {
      for (const [id, base] of configuredInstances(loaded.entries)) {
        const source = integrations.get(base)
        integrations.update(id, (integration) => {
          integration.name = `${source?.name ?? base} (${instanceLabel(id, base)})`
        })
      }
    })
    yield* ctx.provider.transform((providers) => {
      for (const [id, base] of configuredInstances(loaded.entries)) {
        const source = providers.get(base)
        if (!source) continue
        providers.add({
          info: {
            ...source.provider,
            id,
            // Packages and plugins keyed by provider name keep treating the copy as its base.
            canonical: source.provider.canonical ?? base,
            integrationID: Integration.ID.make(id),
            instanceOf: base,
            name: `${source.provider.name} (${instanceLabel(id, base)})`,
          },
          models: Array.from(source.models.values()),
        })
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)
