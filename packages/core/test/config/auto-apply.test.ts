import path from "path"
import { describe, expect } from "bun:test"
import { Event } from "@opencode/schema/config"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { ConfigPolicyPlugin } from "@opencode/core/config/plugin/policy"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Bus } from "@opencode/core/bus"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Provider } from "@opencode/core/provider"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Credential } from "@opencode/core/credential"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { AppProcess } from "@opencode/util/process"
import { Effect, Layer, Option, Queue, Stream } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { Job } from "@opencode/core/job"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { ShellSelect } from "@opencode/core/shell/select"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  Layer.merge(
    PluginTestLayer,
    AppNodeBuilder.build(LayerNode.group([AppProcess.node, ShellSelect.node, Job.node, SubagentJob.node])),
  ),
)

describe("config auto-apply", () => {
  it.live("applies a default model edit from disk with no reload call", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const write = (model: string) =>
            Bun.write(
              file,
              JSON.stringify({
                providers: { first: { models: { chat: { name: "Chat" }, second: { name: "Second" } } } },
                model,
              }),
            )
          yield* Effect.promise(() => write("first/chat"))
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const models = yield* Model.Service
            const host = yield* PluginHost.make(plugins)
            yield* ConfigProviderPlugin.Plugin.effect(host)
            yield* waitUntil(
              models
                .default()
                .pipe(Effect.map((model) => model?.providerID === "first" && model?.id === "chat")),
            )
            yield* Effect.promise(() => write("first/second"))
            yield* waitUntil(
              models
                .default()
                .pipe(Effect.map((model) => model?.providerID === "first" && model?.id === "second")),
            )
          }).pipe(Effect.provide(liveConfig(tmp.path)))
        }),
      ),
    ),
  )

  it.live("applies a default agent edit from disk with no reload call", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const write = (default_agent: string) =>
            Bun.write(
              file,
              JSON.stringify({
                agents: {
                  one: { description: "One", mode: "primary" },
                  two: { description: "Two", mode: "primary" },
                },
                default_agent,
              }),
            )
          yield* Effect.promise(() => write("one"))
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const agents = yield* Agent.Service
            const host = yield* PluginHost.make(plugins)
            yield* ConfigAgentPlugin.Plugin.effect(host)
            yield* waitUntil(agents.select().pipe(Effect.map((selection) => selection.id === "one")))
            yield* Effect.promise(() => write("two"))
            yield* waitUntil(agents.select().pipe(Effect.map((selection) => selection.id === "two")))
          }).pipe(Effect.provide(liveConfig(tmp.path)))
        }),
      ),
    ),
  )

  it.live("removes and restores a provider as disabled_providers is edited on disk", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const write = (disabled: boolean) =>
            Bun.write(
              file,
              JSON.stringify({
                providers: { first: { models: { chat: { name: "Chat" } } } },
                ...(disabled ? { disabled_providers: ["first"] } : {}),
              }),
            )
          yield* Effect.promise(() => write(false))
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const providers = yield* Provider.Service
            const host = yield* PluginHost.make(plugins)
            yield* ConfigProviderPlugin.Plugin.effect(host)
            yield* ConfigPolicyPlugin.Plugin.effect(host)
            yield* waitUntil(
              providers.get(Provider.ID.make("first")).pipe(Effect.map((provider) => provider !== undefined)),
            )
            yield* Effect.promise(() => write(true))
            yield* waitUntil(
              providers.get(Provider.ID.make("first")).pipe(Effect.map((provider) => provider === undefined)),
            )
            yield* Effect.promise(() => write(false))
            yield* waitUntil(
              providers.get(Provider.ID.make("first")).pipe(Effect.map((provider) => provider !== undefined)),
            )
          }).pipe(Effect.provide(liveConfig(tmp.path)))
        }),
      ),
    ),
  )

  it.live("publishes no update when a rewrite changes nothing", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const content = JSON.stringify({ shell: "initial" })
          yield* Effect.promise(() => Bun.write(file, content))
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const published = yield* Queue.unbounded<readonly string[]>()
            yield* bus.subscribe(Event.Updated).pipe(
              Stream.runForEach((event) => Queue.offer(published, event.data.sections)),
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* waitUntil(
              config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "initial")),
            )
            // An identical rewrite produces a filesystem event but no value change:
            // the reload it triggers must not publish an update.
            yield* Effect.promise(() => Bun.write(file, content))
            yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "changed" })))
            yield* waitUntil(
              config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "changed")),
            )
            expect(yield* Queue.take(published)).toEqual(["shell"])
            expect(Option.isNone(yield* Queue.poll(published))).toBe(true)
          }).pipe(Effect.provide(liveConfig(tmp.path)))
        }),
      ),
    ),
  )

  it.live("never re-reads config while no filesystem event arrives", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const native = Watcher.Native.of({
          subscribe: () => Effect.sync(() => ({ unsubscribe: () => Promise.resolve() })),
        })
        return Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "initial" })))
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            // Startup fires one readiness rescan reload, which a canary write
            // reveals: while a reload is still pending it picks the canary up.
            // Once a canary survives untouched, no reload is queued, so any later
            // change in the served entries could only come from a new re-read.
            let current = "initial"
            let drained = false
            for (let attempt = 0; attempt < 10 && !drained; attempt++) {
              const canary = `canary-${attempt}`
              yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: canary })))
              yield* Effect.sleep("400 millis")
              const entries = yield* config.entries()
              if (Config.latest(entries, "shell") === canary) current = canary
              else drained = true
            }
            expect(drained).toBe(true)
            const before = yield* config.entries()
            expect(Config.latest(before, "shell")).toBe(current)
            // The watcher never delivers an event for this write, so a watch-driven
            // config service keeps serving the cached entries instead of re-reading.
            yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "changed" })))
            yield* Effect.sleep("400 millis")
            const after = yield* config.entries()
            expect(after).toBe(before)
            expect(Config.latest(after, "shell")).toBe(current)
          }).pipe(Effect.provide(liveConfig(tmp.path, native)))
        })
      }),
    ),
  )
})

function liveConfig(directory: string, native?: Watcher.NativeInterface) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured({ global: false })),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    ...(native
      ? [Watcher.node.replace(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))]
      : []),
  ])
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for config auto-apply")
})
