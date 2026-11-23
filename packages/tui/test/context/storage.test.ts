import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "fs"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createStorage } from "../../src/context/storage"

afterEach(() => {
  spyOn(fs, "watch").mockRestore()
})

test("refuses to overwrite an unparseable storage.store file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "storage-test-"))
  const file = path.join(dir, "next", "tui", "kv.json")
  const corrupt = `{"count":1`
  try {
    const result = createStorage(dir, "next")
    const [store, update] = result.storage.store("kv", { initial: { count: 0 } })
    expect(store.count).toBe(0)
    writeFileSync(file, corrupt)

    await expect(update((draft) => {
      draft.count = 2
    })).rejects.toThrow(/is not valid JSON/)
    expect(readFileSync(file, "utf8")).toBe(corrupt)
    result.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("starts storage.store from its initial value when its file is missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "storage-test-"))
  try {
    const result = createStorage(dir, "next")
    const [store, update] = result.storage.store("kv", { initial: { count: 0 } })
    expect(store.count).toBe(0)
    await update((draft) => {
      draft.count = 1
    })
    expect(store.count).toBe(1)
    expect(readFileSync(path.join(dir, "next", "tui", "kv.json"), "utf8")).toContain('"count":1')
    result.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("createStorage degrades gracefully when fs.watch throws (e.g. ENOSPC)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "storage-test-"))
  // fs.watch throws synchronously when inotify_add_watch fails (e.g. the watch
  // limit is exhausted). Simulate that scoped to this test only.
  spyOn(fs, "watch").mockImplementation(() => {
    throw Object.assign(new Error("ENOSPC: no space left on device, watch '/some/dir'"), { code: "ENOSPC" })
  })

  try {
    let result: ReturnType<typeof createStorage> | undefined
    expect(() => {
      result = createStorage(dir, "next")
    }).not.toThrow()

    // storage should still be usable even though the live-reload watcher failed to attach
    const [store, update] = result!.storage.store("kv", { initial: { count: 0 } })
    expect(store.count).toBe(0)
    await update((draft) => {
      draft.count = 1
    })
    expect(store.count).toBe(1)
    expect(() => result!.close()).not.toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
