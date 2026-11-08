import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, FileSystem } from "effect"
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, readlink, readdir, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../../test/fixture/tmpdir"
import { cleanShellConfig, writeShellConfig } from "./uninstall"

describe("cleanShellConfig", () => {
  test("removes the opencode PATH entry and its marker line", () => {
    const content = ["# opencode", 'export PATH="$HOME/.opencode/bin:$PATH"', "alias ll='ls -l'", ""].join("\n")
    expect(cleanShellConfig(content)).toBe(["alias ll='ls -l'", ""].join("\n"))
  })

  test("removes a fish_add_path entry", () => {
    const content = ["fish_add_path $HOME/.opencode/bin", "set -g theme dark", ""].join("\n")
    expect(cleanShellConfig(content)).toBe(["set -g theme dark", ""].join("\n"))
  })

  test("keeps unrelated PATH lines and a marker not followed by an entry", () => {
    const content = ["# opencode", "# a hand-written note", 'export PATH="$HOME/.local/bin:$PATH"', ""].join("\n")
    expect(cleanShellConfig(content)).toBe(content)
  })

  test("leaves content without an opencode entry unchanged", () => {
    const content = ["export EDITOR=vim", ""].join("\n")
    expect(cleanShellConfig(content)).toBe(content)
  })
})

describe("writeShellConfig", () => {
  const write = (file: string, content: string) =>
    Effect.runPromise(
      writeShellConfig(file, content).pipe(Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer)),
    )

  test("replaces a regular file's content and keeps its mode", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, ".bashrc")
    await writeFile(file, "old\n")
    await chmod(file, 0o640)

    await write(file, "new\n")

    expect(await readFile(file, "utf8")).toBe("new\n")
    expect((await stat(file)).mode & 0o777).toBe(0o640)
    expect(await readdir(directory.path)).toEqual([".bashrc"])
  })

  test("never touches a pre-existing file at the fixed sibling temp name", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, ".bashrc")
    const sibling = path.join(directory.path, ".bashrc.tmp")
    await writeFile(file, "old\n")
    await writeFile(sibling, "keep me\n")

    await write(file, "new\n")

    expect(await readFile(file, "utf8")).toBe("new\n")
    expect(await readFile(sibling, "utf8")).toBe("keep me\n")
    expect((await readdir(directory.path)).sort()).toEqual([".bashrc", ".bashrc.tmp"])
  })

  test("chowns the temp file to the target's uid/gid before renaming it over the target", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, ".bashrc")
    await writeFile(file, "old\n")
    const target = await stat(file)
    const node = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
    const calls: string[] = []
    const fs = new Proxy(node, {
      get(target_, property, receiver) {
        if (property === "chown")
          return (temp: string, uid: number, gid: number) => {
            calls.push(`chown:${temp}:${uid}:${gid}`)
            return node.chown(temp, uid, gid)
          }
        if (property === "rename")
          return (from: string, to: string) => {
            calls.push(`rename:${from}:${to}`)
            return node.rename(from, to)
          }
        // oxlint-disable-next-line no-restricted-globals -- Proxy forwarding requires receiver-aware property access.
        return Reflect.get(target_, property, receiver)
      },
    })

    await Effect.runPromise(
      writeShellConfig(file, "new\n").pipe(
        Effect.provide(FSUtil.layer),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    )

    expect(calls).toHaveLength(2)
    const temp = calls[0].slice("chown:".length, -(`:${target.uid}:${target.gid}`).length)
    expect(path.dirname(temp)).toBe(directory.path)
    expect(path.basename(temp)).toMatch(/^\.tmp-/)
    expect(calls[1]).toBe(`rename:${temp}:${file}`)
    expect(calls[0]).toBe(`chown:${temp}:${target.uid}:${target.gid}`)
    expect(await readFile(file, "utf8")).toBe("new\n")
    expect(await readdir(directory.path)).toEqual([".bashrc"])
  })

  test("fails without replacing the target when the chown fails", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, ".bashrc")
    await writeFile(file, "old\n")
    const node = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
    const fs = new Proxy(node, {
      get(target_, property, receiver) {
        if (property === "chown") return () => Effect.die(new Error("chown denied"))
        // oxlint-disable-next-line no-restricted-globals -- Proxy forwarding requires receiver-aware property access.
        return Reflect.get(target_, property, receiver)
      },
    })

    await expect(
      Effect.runPromise(
        writeShellConfig(file, "new\n").pipe(
          Effect.provide(FSUtil.layer),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      ),
    ).rejects.toThrow()

    expect(await readFile(file, "utf8")).toBe("old\n")
    expect(await readdir(directory.path)).toEqual([".bashrc"])
  })

  test("writes through a symlink to its target and keeps the target's mode", async () => {
    await using directory = await tmpdir()
    const target = path.join(directory.path, "dotfiles", "bashrc")
    const link = path.join(directory.path, ".bashrc")
    await mkdir(path.join(directory.path, "dotfiles"))
    await writeFile(target, "old\n")
    await chmod(target, 0o600)
    await symlink(target, link)

    await write(link, "new\n")

    expect(await readlink(link)).toBe(target)
    expect(await readFile(target, "utf8")).toBe("new\n")
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect((await readdir(path.join(directory.path, "dotfiles"))).sort()).toEqual(["bashrc"])
  })
})
