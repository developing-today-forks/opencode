import { expect, test } from "bun:test"
import path from "path"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { createJsonlFile } from "../../src/prompt/jsonl"
import { MAX_FRECENCY_ENTRIES, parseFrecency } from "../../src/prompt/frecency"
import { MAX_STASH_ENTRIES, parsePromptStash } from "../../src/prompt/stash"

test("stash JSONL skips corruption and retains newest entries", () => {
  const entries = Array.from({ length: MAX_STASH_ENTRIES + 2 }, (_, index) =>
    JSON.stringify({ prompt: { text: String(index), files: [], agents: [], pasted: [] }, timestamp: index }),
  )
  entries.splice(2, 0, "broken")
  const result = parsePromptStash(entries.join("\n"))
  expect(result).toHaveLength(MAX_STASH_ENTRIES)
  expect(result[0]?.prompt.text).toBe("2")
})

test("frecency JSONL skips corruption, keeps latest path state, and limits entries", () => {
  const entries = Array.from({ length: MAX_FRECENCY_ENTRIES + 1 }, (_, index) =>
    JSON.stringify({ path: String(index), frequency: 1, lastOpen: index }),
  )
  entries.push("broken", JSON.stringify({ path: "1000", frequency: 2, lastOpen: 2000 }))
  const result = parseFrecency(entries.join("\n"))
  expect(result).toHaveLength(MAX_FRECENCY_ENTRIES)
  expect(result[0]).toEqual({ path: "1000", frequency: 2, lastOpen: 2000 })
  expect(result.some((entry) => entry.path === "0")).toBe(false)
})

test("frecency JSONL drops entries with an invalid shape", () => {
  const entries = [
    "null",
    "123",
    '"hello"',
    "[1,2]",
    JSON.stringify({ path: 42, frequency: 1, lastOpen: 1 }),
    JSON.stringify({ path: "/wrong-frequency", frequency: "1", lastOpen: 1 }),
    JSON.stringify({ path: "/wrong-last-open", frequency: 1, lastOpen: "1" }),
    JSON.stringify({ path: "/missing-frequency", lastOpen: 1 }),
    JSON.stringify({ path: "/missing-last-open", frequency: 1 }),
    '{"path":"/infinite-frequency","frequency":1e400,"lastOpen":1}',
    '{"path":"/infinite-last-open","frequency":1,"lastOpen":-1e400}',
    JSON.stringify({ path: "/valid", frequency: 1.5, lastOpen: 2 }),
  ]

  expect(parseFrecency(entries.join("\n"))).toEqual([{ path: "/valid", frequency: 1.5, lastOpen: 2 }])
})

const testParse = (text: string) => text.split("\n").filter(Boolean)
const testSerialize = (entries: string[]) => (entries.length > 0 ? entries.join("\n") + "\n" : "")

test("missing JSONL file initializes as an empty store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-jsonl-"))
  try {
    const file = path.join(root, "store.jsonl")
    const store = createJsonlFile({
      file,
      locks: path.join(root, "locks"),
      parse: testParse,
      serialize: testSerialize,
    })

    expect(await store.read()).toEqual([])
    // A self-heal no-op on a missing file resolves empty without creating it.
    expect(await store.update(() => undefined)).toEqual([])
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    expect(await store.update((current) => [...current, "a"])).toEqual(["a"])
    expect(await readFile(file, "utf8")).toBe("a\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a read failure followed by an update does not replace the existing file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-jsonl-"))
  try {
    const file = path.join(root, "store.jsonl")
    await writeFile(file, "one\ntwo\n")
    const writes: string[] = []
    const readFailure = async (_file: string): Promise<string> => {
      const error = new Error("permission denied") as Error & { code: string }
      error.code = "EACCES"
      throw error
    }
    const store = createJsonlFile({
      file,
      locks: path.join(root, "locks"),
      parse: testParse,
      serialize: testSerialize,
      readText: readFailure,
      writeText: async (_file, content) => void writes.push(content),
    })

    await expect(store.read()).rejects.toThrow("permission denied")
    await expect(store.update((current) => [...current, "three"])).rejects.toThrow("permission denied")

    expect(writes).toEqual([])
    expect(await readFile(file, "utf8")).toBe("one\ntwo\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
