import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { writePluginConfig } from "../src/commands/handlers/plugin/add"
import { removePluginConfig } from "../src/commands/handlers/plugin/remove"

async function mode(file: string) {
  return (await fs.stat(file)).mode & 0o777
}

describe("plugin config write", () => {
  test("add creates a fresh config owner-only via temp file and rename", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const config = path.join(directory, "opencode.json")

    const changed = await writePluginConfig(config, "example-plugin")

    expect(changed).toBe(true)
    const configObject = parse(await fs.readFile(config, "utf8")) as { plugins: unknown[] }
    expect(configObject.plugins).toEqual(["example-plugin"])
    // The temp file is renamed over the config, never left behind.
    expect(await fs.readdir(directory)).toEqual(["opencode.json"])
    if (process.platform !== "win32") expect(await mode(config)).toBe(0o600)
  })

  test("add updates an existing config without widening its permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const config = path.join(directory, "opencode.jsonc")
    await fs.writeFile(config, '{ // keep me\n  "theme": "opencode" }\n')
    await fs.chmod(config, 0o644)

    await writePluginConfig(config, "example-plugin")

    const text = await fs.readFile(config, "utf8")
    expect(text).toContain("// keep me")
    const configObject = parse(text) as { theme: string; plugins: unknown[] }
    expect(configObject.theme).toBe("opencode")
    expect(configObject.plugins).toEqual(["example-plugin"])
    expect(await fs.readdir(directory)).toEqual(["opencode.jsonc"])
    if (process.platform !== "win32") expect(await mode(config) & 0o077).toBe(0)
  })

  test("add preserves a symlinked config and updates its target", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const target = path.join(directory, "dotfiles", "opencode.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "{}\n")
    const config = path.join(directory, "opencode.json")
    await fs.symlink(target, config)

    await writePluginConfig(config, "example-plugin")

    expect((await fs.lstat(config)).isSymbolicLink()).toBe(true)
    const configObject = parse(await fs.readFile(target, "utf8")) as { plugins: unknown[] }
    expect(configObject.plugins).toEqual(["example-plugin"])
    expect(await fs.readdir(path.dirname(target))).toEqual(["opencode.json"])
  })

  test("concurrent adds to the same config do not consume each other's temp file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const config = path.join(directory, "opencode.json")

    await Promise.all([
      writePluginConfig(config, "one"),
      writePluginConfig(config, "two"),
      writePluginConfig(config, "three"),
    ])

    const configObject = parse(await fs.readFile(config, "utf8")) as { plugins: unknown[] }
    expect(configObject.plugins).toHaveLength(1)
    expect(await fs.readdir(directory)).toEqual(["opencode.json"])
  })

  test("add keeps a read-only existing config read-only", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const config = path.join(directory, "opencode.json")
    await fs.writeFile(config, "{}\n")
    await fs.chmod(config, 0o400)

    await writePluginConfig(config, "example-plugin")

    const configObject = parse(await fs.readFile(config, "utf8")) as { plugins: unknown[] }
    expect(configObject.plugins).toEqual(["example-plugin"])
    if (process.platform !== "win32") expect(await mode(config)).toBe(0o400)
  })

  test("remove preserves a symlinked config and updates its target", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const target = path.join(directory, "dotfiles", "opencode.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ plugins: ["example-plugin"] }) + "\n")
    const config = path.join(directory, "opencode.json")
    await fs.symlink(target, config)

    const removed = await removePluginConfig(config, "example-plugin")

    expect(removed).toBe(true)
    expect((await fs.lstat(config)).isSymbolicLink()).toBe(true)
    const configObject = parse(await fs.readFile(target, "utf8")) as { plugins: unknown[] }
    expect(configObject.plugins).toEqual([])
    expect(await fs.readdir(path.dirname(target))).toEqual(["opencode.json"])
  })

  test("remove keeps a read-only existing config read-only", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-config-"))
    const config = path.join(directory, "opencode.json")
    await fs.writeFile(config, JSON.stringify({ plugins: ["example-plugin"] }) + "\n")
    await fs.chmod(config, 0o400)

    const removed = await removePluginConfig(config, "example-plugin")

    expect(removed).toBe(true)
    const configObject = parse(await fs.readFile(config, "utf8")) as { plugins: unknown[] }
    expect(configObject.plugins).toEqual([])
    if (process.platform !== "win32") expect(await mode(config)).toBe(0o400)
  })
})
