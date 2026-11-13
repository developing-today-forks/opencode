import path from "path"
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "fs/promises"
import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Bus } from "@opencode/core/bus"
import { Reference } from "@opencode/core/reference"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ShellSelect } from "@opencode/core/shell/select"
import { Job } from "@opencode/core/job"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Credential } from "@opencode/core/credential"
import { WellKnown } from "@opencode/core/wellknown"
import { AppProcess } from "@opencode/util/process"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
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

describe("config update write target", () => {
  it.live("writes the patch into the explicit config file when one is configured", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalFile = path.join(tmp.path, "global", "opencode.jsonc")
          const runtimeFile = path.join(tmp.path, "runtime.jsonc")
          const globalText = '{\n  "shell": "/bin/bash"\n}\n'
          yield* Effect.promise(() => mkdir(path.dirname(globalFile), { recursive: true }))
          yield* Effect.promise(() => writeFile(globalFile, globalText))
          yield* Effect.promise(() => writeFile(runtimeFile, "{}\n"))

          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          yield* config.update({ shell: "/bin/zsh" })

          // The runtime layer carries the write; the global file is untouched.
          const runtime = JSON.parse(yield* Effect.promise(() => readFile(runtimeFile, "utf8")))
          expect(runtime.shell).toBe("/bin/zsh")
          expect(yield* Effect.promise(() => readFile(globalFile, "utf8"))).toBe(globalText)
          // The write triggers an async reload; poll until it is visible.
          yield* waitUntil(
            config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "/bin/zsh")),
          )
        }).pipe(Effect.provide(liveConfig(tmp.path, { file: path.join(tmp.path, "runtime.jsonc") }))),
      ),
    ),
  )

  it.live("creates the explicit config file on first update when it does not exist yet", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalFile = path.join(tmp.path, "global", "opencode.jsonc")
          const runtimeFile = path.join(tmp.path, "state", "runtime.jsonc")
          yield* Effect.promise(() => mkdir(path.dirname(globalFile), { recursive: true }))
          yield* Effect.promise(() => writeFile(globalFile, "{}\n"))

          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          yield* config.update({ shell: "/bin/zsh" })

          const runtime = JSON.parse(yield* Effect.promise(() => readFile(runtimeFile, "utf8")))
          expect(runtime.shell).toBe("/bin/zsh")
          expect(yield* Effect.promise(() => readFile(globalFile, "utf8"))).toBe("{}\n")
        }).pipe(Effect.provide(liveConfig(tmp.path, { file: path.join(tmp.path, "state", "runtime.jsonc") }))),
      ),
    ),
  )

  it.live("writes the patch into the global config file when no explicit file is configured", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalFile = path.join(tmp.path, "global", "opencode.jsonc")
          yield* Effect.promise(() => mkdir(path.dirname(globalFile), { recursive: true }))
          yield* Effect.promise(() => writeFile(globalFile, "{}\n"))

          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          yield* config.update({ shell: "/bin/zsh" })

          const global = JSON.parse(yield* Effect.promise(() => readFile(globalFile, "utf8")))
          expect(global.shell).toBe("/bin/zsh")
        }).pipe(Effect.provide(liveConfig(tmp.path))),
      ),
    ),
  )
})

describe("config update write path (#998)", () => {
  it.live("replaces the global config atomically, preserving its mode", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalFile = path.join(tmp.path, "global", "opencode.jsonc")
          yield* Effect.promise(() => mkdir(path.dirname(globalFile), { recursive: true }))
          yield* Effect.promise(() => writeFile(globalFile, "{}\n"))
          yield* Effect.promise(() => chmod(globalFile, 0o640))
          const before = yield* Effect.promise(() => stat(globalFile))

          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          yield* config.update({ shell: "/bin/zsh" })

          const global = JSON.parse(yield* Effect.promise(() => readFile(globalFile, "utf8")))
          expect(global.shell).toBe("/bin/zsh")
          const after = yield* Effect.promise(() => stat(globalFile))
          // Atomic replace: the file is a new inode (temp + rename), never a
          // truncated in-place rewrite, and its permissions survive.
          expect(after.ino).not.toBe(before.ino)
          expect(after.mode & 0o777).toBe(0o640)
        }).pipe(Effect.provide(liveConfig(tmp.path))),
      ),
    ),
  )

  it.live("creates a fresh global config at 0o600 when none exists", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalFile = path.join(tmp.path, "global", "opencode.jsonc")
          yield* Effect.promise(() => mkdir(path.dirname(globalFile), { recursive: true }))

          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          yield* config.update({ shell: "/bin/zsh" })

          const global = JSON.parse(yield* Effect.promise(() => readFile(globalFile, "utf8")))
          expect(global.shell).toBe("/bin/zsh")
          expect((yield* Effect.promise(() => stat(globalFile))).mode & 0o777).toBe(0o600)
        }).pipe(Effect.provide(liveConfig(tmp.path))),
      ),
    ),
  )

  it.live("keeps a symlinked global config linked and updates its target", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalFile = path.join(tmp.path, "global", "opencode.jsonc")
          const target = path.join(tmp.path, "dotfiles", "opencode.jsonc")
          yield* Effect.promise(() => mkdir(path.dirname(globalFile), { recursive: true }))
          yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }))
          yield* Effect.promise(() => writeFile(target, "{}\n"))
          yield* Effect.promise(() => chmod(target, 0o640))
          yield* Effect.promise(() => symlink(target, globalFile))

          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          yield* config.update({ shell: "/bin/zsh" })

          // The link survives (not replaced by a regular file), the target
          // carries the patch, and the target mode is preserved.
          expect((yield* Effect.promise(() => lstat(globalFile))).isSymbolicLink()).toBe(true)
          const updated = JSON.parse(yield* Effect.promise(() => readFile(target, "utf8")))
          expect(updated.shell).toBe("/bin/zsh")
          expect((yield* Effect.promise(() => stat(target))).mode & 0o777).toBe(0o640)
        }).pipe(Effect.provide(liveConfig(tmp.path))),
      ),
    ),
  )
})

function liveConfig(directory: string, options: Config.Options = {}) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Reference.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
  ])
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for config update to apply")
})
