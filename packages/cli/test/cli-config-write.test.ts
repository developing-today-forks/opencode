import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "../src/config"

async function mode(file: string) {
  return (await fs.stat(file)).mode & 0o777
}

function runConfig<A>(directory: string, effect: Effect.Effect<A, unknown, Config.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory, state: directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

describe("cli config write", () => {
  test("creates a fresh cli config owner-only via temp file and rename", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cli-config-"))
    const file = path.join(directory, "cli.json")

    await runConfig(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        yield* service.update((draft) => {
          draft.animations = false
        })
      }),
    )

    const content = JSON.parse(await fs.readFile(file, "utf8")) as Config.Info
    expect(content.animations).toBe(false)
    expect((await fs.readdir(directory)).sort()).toEqual(["cli.json", "locks"])
    if (process.platform !== "win32") expect(await mode(file)).toBe(0o600)
  })

  test("preserves a symlinked cli config and updates its target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cli-config-"))
    const configDir = path.join(root, "config")
    const target = path.join(root, "dotfiles", "cli.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "{}\n")
    await fs.mkdir(configDir, { recursive: true })
    const file = path.join(configDir, "cli.json")
    await fs.symlink(target, file)

    await runConfig(
      configDir,
      Effect.gen(function* () {
        const service = yield* Config.Service
        yield* service.update((draft) => {
          draft.animations = false
        })
      }),
    )

    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    const content = JSON.parse(await fs.readFile(target, "utf8")) as Config.Info
    expect(content.animations).toBe(false)
    expect(await fs.readdir(path.dirname(target))).toEqual(["cli.json"])
  })

  test("keeps a read-only existing cli config read-only", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cli-config-"))
    const file = path.join(directory, "cli.json")
    await fs.writeFile(file, "{}\n")
    await fs.chmod(file, 0o400)

    await runConfig(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        yield* service.update((draft) => {
          draft.animations = false
        })
      }),
    )

    const content = JSON.parse(await fs.readFile(file, "utf8")) as Config.Info
    expect(content.animations).toBe(false)
    if (process.platform !== "win32") expect(await mode(file)).toBe(0o400)
  })
})
