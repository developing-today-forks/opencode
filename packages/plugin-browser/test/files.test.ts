import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, open, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BrowserFiles, readWith } from "../src/files.js"

let base: string
let project: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "plugin-browser-files-"))
  project = join(base, "project")
  outside = join(base, "outside")
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(project, "inside.txt"), "inside")
  await writeFile(join(outside, "secret.txt"), "secret")
  await symlink(join(outside, "secret.txt"), join(project, "escape.txt"))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

test("reads an in-project file", async () => {
  const files = await Effect.runPromise(BrowserFiles.read(["inside.txt"], project))
  expect(files).toHaveLength(1)
  expect(new TextDecoder().decode(files[0]!.data)).toBe("inside")
})

test("allows an absolute path that stays inside the project", async () => {
  const files = await Effect.runPromise(BrowserFiles.read([join(project, "inside.txt")], project))
  expect(new TextDecoder().decode(files[0]!.data)).toBe("inside")
})

test("rejects an absolute path outside the project before reading", async () => {
  await expect(Effect.runPromise(BrowserFiles.read([join(outside, "secret.txt")], project))).rejects.toThrow(
    "outside the project directory",
  )
})

test("rejects .. traversal outside the project", async () => {
  await expect(Effect.runPromise(BrowserFiles.read(["../outside/secret.txt"], project))).rejects.toThrow(
    "outside the project directory",
  )
})

test("rejects an in-project symlink whose target is outside the project", async () => {
  await expect(Effect.runPromise(BrowserFiles.read(["escape.txt"], project))).rejects.toThrow(
    "outside the project directory",
  )
})

test("rejects an outside file opened during a path replacement even if the path is restored", async () => {
  const path = join(project, "inside.txt")
  const moved = join(project, "inside-original.txt")
  const fileSystem = {
    realpath,
    stat,
    open: async (target: string, flags: string) => {
      await rename(path, moved)
      await symlink(join(outside, "secret.txt"), path)
      const handle = await open(target, flags)
      await unlink(path)
      await rename(moved, path)
      return handle
    },
  }

  await expect(readWith(["inside.txt"], project, fileSystem)).rejects.toThrow("changed")
})
