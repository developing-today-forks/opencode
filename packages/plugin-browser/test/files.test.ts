import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { BrowserFiles } from "../src/files.js"

const fixture = async () => {
  const base = await mkdtemp(join(tmpdir(), "opencode-browser-upload-"))
  const project = join(base, "project")
  const outside = join(base, "outside")
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(project, "notes.txt"), "in-project")
  await writeFile(join(outside, "secret.txt"), "outside-secret")
  return { base, project, outside, secret: join(outside, "secret.txt") }
}

const read = (paths: string[], directory: string) => Effect.runPromiseExit(BrowserFiles.read(paths, directory))

test("upload reads an in-project file", async () => {
  const { base, project } = await fixture()
  try {
    const files = await Effect.runPromise(BrowserFiles.read(["notes.txt"], project))
    expect(files.map((file) => [file.name, file.mime, new TextDecoder().decode(file.data)])).toEqual([
      ["notes.txt", "text/plain", "in-project"],
    ])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("upload rejects an absolute path outside the project before reading bytes", async () => {
  const { base, project, secret } = await fixture()
  try {
    const exit = await read([secret], project)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).not.toContain("outside-secret")
    expect(JSON.stringify(exit)).toContain("inside the project directory")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("upload rejects '..' traversal outside the project before reading bytes", async () => {
  const { base, project } = await fixture()
  try {
    const exit = await read(["../outside/secret.txt"], project)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).not.toContain("outside-secret")
    expect(JSON.stringify(exit)).toContain("inside the project directory")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("upload rejects an in-project symlink whose target is outside the project", async () => {
  const { base, project, secret } = await fixture()
  try {
    await symlink(secret, join(project, "link.txt"))
    const exit = await read(["link.txt"], project)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).not.toContain("outside-secret")
    expect(JSON.stringify(exit)).toContain("inside the project directory")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
