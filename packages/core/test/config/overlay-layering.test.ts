import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function layer(directory: string, globalDirectory: string, options?: Config.Options) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(directory) },
      ),
    ),
  )
  const built = AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
    Config.node.replace(Config.configured({ system: false, ...options })),
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
  return Layer.mergeAll(built, Watcher.testLayer)
}

const setup = (globalText: string, explicitText: string) =>
  Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
    Effect.flatMap((tmp) => {
      const global = path.join(tmp.path, "global")
      const project = path.join(tmp.path, "project")
      const explicit = path.join(tmp.path, "overlay.jsonc")
      return Effect.promise(async () => {
        await fs.mkdir(global, { recursive: true })
        await fs.mkdir(project, { recursive: true })
        await fs.writeFile(path.join(global, "opencode.jsonc"), globalText)
        await fs.writeFile(explicit, explicitText)
      }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const config = yield* Config.Service
            return yield* config.entries()
          }).pipe(Effect.provide(layer(project, global, { file: explicit }))),
        ),
      )
    }),
  )

const json = (value: unknown) => JSON.stringify(value)

describe("Config explicit overlay layering", () => {
  it.live("base keys survive an explicit overlay that does not mention them", () =>
    setup(json({ shell: "global", disabled_providers: ["first"] }), json({})).pipe(
      Effect.map((entries) => {
        expect(Config.latest(entries, "shell")).toBe("global")
        const statements = ManagedPolicy.statements(entries)
        expect(ManagedPolicy.decision(statements, "provider.use", "first")).toBe("deny")
      }),
    ),
  )

  it.live("the overlay wins for keys it sets and leaves other base keys in place", () =>
    setup(json({ shell: "global", disabled_providers: ["first"] }), json({ shell: "explicit" })).pipe(
      Effect.map((entries) => {
        expect(Config.latest(entries, "shell")).toBe("explicit")
        const statements = ManagedPolicy.statements(entries)
        expect(ManagedPolicy.decision(statements, "provider.use", "first")).toBe("deny")
      }),
    ),
  )

  // Regression for #2928: a base config with one malformed region (here a
  // merge-conflict hunk, the shape that hit the standing server) must still
  // contribute the keys it sets. Dropping the whole document left the overlay
  // as the only word, so providers the base config disables stayed enabled.
  it.live("a base config with a malformed region still contributes its keys", () =>
    setup(
      [
        "{",
        '  "shell": "global",',
        '  "disabled_providers": ["first"],',
        "<<<<<<< Updated upstream",
        '  "username": "upstream"',
        "=======",
        '  "username": "stashed"',
        ">>>>>>> Stashed changes",
        "}",
      ].join("\n"),
      json({}),
    ).pipe(
      Effect.map((entries) => {
        expect(Config.latest(entries, "shell")).toBe("global")
        const statements = ManagedPolicy.statements(entries)
        expect(ManagedPolicy.decision(statements, "provider.use", "first")).toBe("deny")
      }),
    ),
  )

  it.live("a base config with no recoverable object root contributes nothing", () =>
    setup("{{{ not json at all", json({ shell: "explicit" })).pipe(
      Effect.map((entries) => {
        expect(Config.latest(entries, "shell")).toBe("explicit")
        const documents = entries.filter((entry) => entry.type === "document")
        expect(documents.every((entry) => entry.info.shell !== "global")).toBe(true)
      }),
    ),
  )
})
