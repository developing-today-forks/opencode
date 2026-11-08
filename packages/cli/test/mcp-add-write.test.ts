import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { writeMcpConfig } from "../src/commands/handlers/mcp/add"

const remote = { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } }

async function mode(file: string) {
  return (await fs.stat(file)).mode & 0o777
}

function write(effect: ReturnType<typeof writeMcpConfig>) {
  return Effect.runPromise(effect.pipe(Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer)))
}

describe("mcp add config write", () => {
  test("creates a fresh config owner-only via temp file and rename", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-add-"))
    const config = path.join(directory, "opencode.json")

    await write(writeMcpConfig(config, "example", remote))

    const configObject = parse(await fs.readFile(config, "utf8")) as {
      mcp: { servers: Record<string, unknown> }
    }
    expect(configObject.mcp.servers.example).toEqual(remote)
    // The temp file is renamed over the config, never left behind.
    expect(await fs.readdir(directory)).toEqual(["opencode.json"])
    // A fresh config can hold Authorization headers: never world-readable.
    if (process.platform !== "win32") expect(await mode(config)).toBe(0o600)
  })

  test("updates an existing config without widening its permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-add-"))
    const config = path.join(directory, "opencode.jsonc")
    await fs.writeFile(config, '{ // keep me\n  "theme": "opencode" }\n')
    await fs.chmod(config, 0o644)

    await write(writeMcpConfig(config, "example", remote))

    const text = await fs.readFile(config, "utf8")
    expect(text).toContain("// keep me")
    const configObject = parse(text) as { theme: string; mcp: { servers: Record<string, unknown> } }
    expect(configObject.theme).toBe("opencode")
    expect(configObject.mcp.servers.example).toEqual(remote)
    expect(await fs.readdir(directory)).toEqual(["opencode.jsonc"])
    if (process.platform !== "win32") expect(await mode(config) & 0o077).toBe(0)
  })

  test("preserves a symlinked config and updates its target", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-add-"))
    const target = path.join(directory, "dotfiles", "opencode.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "{}\n")
    const config = path.join(directory, "opencode.json")
    await fs.symlink(target, config)

    await write(writeMcpConfig(config, "example", remote))

    expect((await fs.lstat(config)).isSymbolicLink()).toBe(true)
    const configObject = parse(await fs.readFile(target, "utf8")) as {
      mcp: { servers: Record<string, unknown> }
    }
    expect(configObject.mcp.servers.example).toEqual(remote)
    expect(await fs.readdir(path.dirname(target))).toEqual(["opencode.json"])
  })

  test("concurrent writes to the same config do not consume each other's temp file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-add-"))
    const config = path.join(directory, "opencode.json")

    await Promise.all([
      write(writeMcpConfig(config, "one", remote)),
      write(writeMcpConfig(config, "two", remote)),
      write(writeMcpConfig(config, "three", remote)),
    ])

    const configObject = parse(await fs.readFile(config, "utf8")) as {
      mcp: { servers: Record<string, unknown> }
    }
    expect(Object.keys(configObject.mcp.servers)).toHaveLength(1)
    expect(await fs.readdir(directory)).toEqual(["opencode.json"])
  })

  test("keeps a read-only existing config read-only", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-add-"))
    const config = path.join(directory, "opencode.json")
    await fs.writeFile(config, "{}\n")
    await fs.chmod(config, 0o400)

    await write(writeMcpConfig(config, "example", remote))

    const configObject = parse(await fs.readFile(config, "utf8")) as {
      mcp: { servers: Record<string, unknown> }
    }
    expect(configObject.mcp.servers.example).toEqual(remote)
    if (process.platform !== "win32") expect(await mode(config)).toBe(0o400)
  })
})
