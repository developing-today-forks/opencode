import { afterEach, expect, test } from "bun:test"
import { readFile, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createEditorStagingFile, normalizePromptContent, openEditor, parseEditorPort } from "../src/editor"
import { tmpdir } from "./fixture/fixture"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

function renderer(events: string[] = []) {
  return {
    async suspend() {
      events.push("suspend")
    },
    async resume() {
      events.push("resume")
    },
  }
}

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"

  await expect(openEditor({ value: "original", renderer: renderer() as never })).rejects.toThrow()
})

test.skipIf(process.platform === "win32")("returns the edited prompt and resumes the renderer", async () => {
  await using tmp = await tmpdir()
  const script = path.join(tmp.path, "editor.sh")
  await writeFile(script, '#!/bin/sh\nprintf edited >> "$1"\n', { mode: 0o755 })
  delete process.env.VISUAL
  process.env.EDITOR = script
  const events: string[] = []

  expect(await openEditor({ value: "original ", renderer: renderer(events) as never })).toBe("original edited")
  expect(events).toEqual(["suspend", "resume"])
})

test("says which variable to set when no external editor is configured", async () => {
  delete process.env.VISUAL
  delete process.env.EDITOR
  let suspended = false
  const renderer = {
    suspend() {
      suspended = true
    },
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow("$EDITOR")
  expect(suspended).toBe(false)
})

test("parseEditorPort accepts only canonical decimal ports in range", () => {
  expect(parseEditorPort("8080")).toBe(8080)
  expect(parseEditorPort("1")).toBe(1)
  expect(parseEditorPort("65535")).toBe(65535)
  expect(parseEditorPort("8080abc")).toBeUndefined()
  expect(parseEditorPort("8080.9")).toBeUndefined()
  expect(parseEditorPort("+8080")).toBeUndefined()
  expect(parseEditorPort(" 8080")).toBeUndefined()
  expect(parseEditorPort("")).toBeUndefined()
  expect(parseEditorPort("0")).toBeUndefined()
  expect(parseEditorPort("65536")).toBeUndefined()
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

test.skipIf(process.platform === "win32")("concurrent stagings get distinct files", async () => {
  await using tmp = await tmpdir()
  const [first, second] = await Promise.all([
    createEditorStagingFile("one", tmp.path),
    createEditorStagingFile("two", tmp.path),
  ])
  expect(first).not.toBe(second)
  expect(await readFile(first, "utf8")).toBe("one")
  expect(await readFile(second, "utf8")).toBe("two")
})

test.skipIf(process.platform === "win32")("staging never follows a pre-planted symlink", async () => {
  await using tmp = await tmpdir()
  const victim = path.join(tmp.path, "victim.txt")
  await writeFile(victim, "precious")
  await symlink(victim, path.join(tmp.path, "planted.md"))
  const names = ["planted.md", "fresh.md"]
  const file = await createEditorStagingFile("draft", tmp.path, () => names.shift()!)
  expect(path.basename(file)).toBe("fresh.md")
  expect(await readFile(victim, "utf8")).toBe("precious")
  expect(await readFile(file, "utf8")).toBe("draft")
})

test.skipIf(process.platform === "win32")("staging file is created with mode 0o600", async () => {
  await using tmp = await tmpdir()
  const file = await createEditorStagingFile("draft", tmp.path)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})
