import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem } from "effect"
import { Config } from "../../src/config"

const [mode, directory, started, release, ready] = process.argv.slice(2)
if (!mode || !directory || !started || !release || !ready) throw new Error("missing config concurrency arguments")
if (mode !== "migrate" && mode !== "update") throw new Error(`unknown mode: ${mode}`)

const node = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
const state = { writes: 0 }
const open: FileSystem.FileSystem["open"] = (target, options) =>
  node.open(target, options).pipe(
    Effect.map((handle) => {
      state.writes++
      if (mode !== "migrate" || state.writes !== 1) return handle
      return new Proxy(handle, {
        get(target_, property, receiver) {
          if (property === "writeAll")
            return (buffer: Uint8Array) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => Bun.write(started, ""))
                while (!(yield* Effect.promise(() => Bun.file(release).exists()))) yield* Effect.sleep("10 millis")
                yield* target_.writeAll(buffer)
              })
          // oxlint-disable-next-line no-restricted-globals -- Proxy forwarding requires receiver-aware property access.
          return Reflect.get(target_, property, receiver)
        },
      })
    }),
  )
const fs = new Proxy(node, {
  get(target, property, receiver) {
    if (property === "open") return open
    // oxlint-disable-next-line no-restricted-globals -- Proxy forwarding requires receiver-aware property access.
    return Reflect.get(target, property, receiver)
  },
})
const service = await Effect.runPromise(
  Config.Service.pipe(
    Effect.provide(Config.layer),
    Effect.provide(Global.layerWith({ config: directory, state: directory })),
    Effect.provide(FSUtil.layer),
    Effect.provideService(FileSystem.FileSystem, fs),
  ),
)

await Bun.write(ready, "")
if (mode === "migrate") await Effect.runPromise(service.get())
if (mode === "update")
  await Effect.runPromise(
    service.update((draft) => {
      draft.mouse = false
    }),
  )
