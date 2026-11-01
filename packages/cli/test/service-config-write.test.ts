import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

async function mode(file: string) {
  return (await fs.stat(file)).mode & 0o777
}

function runService<A>(
  config: string,
  state: string,
  effect: Effect.Effect<A, unknown, Global.Service | FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(Global.Service, Global.make({ config, state })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

describe("service config write", () => {
  test("creates a fresh service config owner-only via temp file and rename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-"))
    const configDir = path.join(root, "config")
    const stateDir = path.join(root, "state")
    const file = path.join(configDir, ServiceConfig.filename())

    await runService(configDir, stateDir, ServiceConfig.password("secret-token"))

    const content = JSON.parse(await fs.readFile(file, "utf8")) as ServiceConfig.Info
    expect(content.password).toBe("secret-token")
    // The temp file is renamed over the config, never left behind.
    expect(await fs.readdir(configDir)).toEqual([ServiceConfig.filename()])
    if (process.platform !== "win32") expect(await mode(file)).toBe(0o600)
  })

  test("updates an existing config without widening its permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-"))
    const configDir = path.join(root, "config")
    const stateDir = path.join(root, "state")
    const file = path.join(configDir, ServiceConfig.filename())
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(file, JSON.stringify({ hostname: "127.0.0.1" }) + "\n")
    await fs.chmod(file, 0o644)

    await runService(configDir, stateDir, ServiceConfig.password("secret"))

    const content = JSON.parse(await fs.readFile(file, "utf8")) as ServiceConfig.Info
    expect(content.hostname).toBe("127.0.0.1")
    expect(content.password).toBe("secret")
    expect(await fs.readdir(configDir)).toEqual([ServiceConfig.filename()])
    if (process.platform !== "win32") expect(await mode(file) & 0o077).toBe(0)
  })

  test("preserves a symlinked config and updates its target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-"))
    const configDir = path.join(root, "config")
    const stateDir = path.join(root, "state")
    const target = path.join(root, "dotfiles", "service.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "{}\n")
    await fs.mkdir(configDir, { recursive: true })
    const file = path.join(configDir, ServiceConfig.filename())
    await fs.symlink(target, file)

    await runService(configDir, stateDir, ServiceConfig.password("symlink-secret"))

    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    const content = JSON.parse(await fs.readFile(target, "utf8")) as ServiceConfig.Info
    expect(content.password).toBe("symlink-secret")
    expect(await fs.readdir(path.dirname(target))).toEqual(["service.json"])
  })

  test("concurrent writes to the same service config do not consume each other's temp file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-"))
    const configDir = path.join(root, "config")
    const stateDir = path.join(root, "state")
    const file = path.join(configDir, ServiceConfig.filename())

    await Promise.all([
      runService(configDir, stateDir, ServiceConfig.password("one")),
      runService(configDir, stateDir, ServiceConfig.password("two")),
      runService(configDir, stateDir, ServiceConfig.password("three")),
    ])

    const content = JSON.parse(await fs.readFile(file, "utf8")) as ServiceConfig.Info
    expect(["one", "two", "three"]).toContain(content.password ?? "")
    expect(await fs.readdir(configDir)).toEqual([ServiceConfig.filename()])
  })

  test("keeps a read-only existing service config read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-"))
    const configDir = path.join(root, "config")
    const stateDir = path.join(root, "state")
    const file = path.join(configDir, ServiceConfig.filename())
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(file, "{}\n")
    await fs.chmod(file, 0o400)

    await runService(configDir, stateDir, ServiceConfig.password("secret-readonly"))

    const content = JSON.parse(await fs.readFile(file, "utf8")) as ServiceConfig.Info
    expect(content.password).toBe("secret-readonly")
    if (process.platform !== "win32") expect(await mode(file)).toBe(0o400)
  })
})
