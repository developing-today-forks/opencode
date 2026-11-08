import { describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { renameSyncWithRetry, renameWithRetry, writeFileAtomic, writeFileSyncAtomic } from "./atomic-write"

const dir = () => mkdtempSync(path.join(tmpdir(), "opencode-atomic-write-"))

const transient = (code: string) => Object.assign(new Error(`rename failed: ${code}`), { code })

describe("renameSyncWithRetry", () => {
  test("retries EPERM, EACCES and EBUSY until the rename lands", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const root = dir()
      const source = path.join(root, "source")
      const destination = path.join(root, "destination")
      fs.writeFileSync(source, "content")
      const rename = fs.renameSync
      let calls = 0

      const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        calls += 1

        if (calls < 3) throw transient(code)
        rename(from, to)
      })

      try {
        renameSyncWithRetry(source, destination)
        expect(calls).toBe(3)
        expect(readFileSync(destination, "utf8")).toBe("content")
      } finally {
        spy.mockRestore()
      }
    }
  })

  test("a non-transient error throws on the first attempt", () => {
    let calls = 0

    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1
      throw transient("ENOENT")
    })

    try {
      expect(() => renameSyncWithRetry("source", "destination")).toThrow("rename failed: ENOENT")
      expect(calls).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  test("a transient error that never clears throws after five attempts", () => {
    let calls = 0

    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1
      throw transient("EPERM")
    })

    try {
      expect(() => renameSyncWithRetry("source", "destination")).toThrow("rename failed: EPERM")
      expect(calls).toBe(5)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("writeFileSyncAtomic", () => {
  test("writes the content and leaves no temp file", () => {
    const root = dir()
    const file = path.join(root, "nested", "state.json")
    writeFileSyncAtomic(file, '{"ready":true}')
    expect(readFileSync(file, "utf8")).toBe('{"ready":true}')
    expect(readdirSync(path.dirname(file))).toEqual(["state.json"])
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  test("preserves an existing mode and writes through a symlink", () => {
    const root = dir()
    const file = path.join(root, "state.json")
    const link = path.join(root, "state-link.json")
    fs.writeFileSync(file, "before")
    fs.chmodSync(file, 0o640)
    fs.symlinkSync(file, link)

    writeFileSyncAtomic(link, "after")

    expect(readFileSync(file, "utf8")).toBe("after")
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o640)
    expect(readdirSync(root).sort()).toEqual(["state-link.json", "state.json"])
  })

  test("refuses a colliding exclusive temp without changing either file", () => {
    const root = dir()
    const file = path.join(root, "state.json")
    const temporary = path.join(root, `.tmp-${process.pid}-616263646566`)
    fs.writeFileSync(file, "before")
    fs.writeFileSync(temporary, "sentinel")
    const randomBytes = spyOn(crypto, "randomBytes").mockReturnValue(Buffer.from("abcdef"))

    try {
      expect(() => writeFileSyncAtomic(file, "after")).toThrow()
      expect(readFileSync(file, "utf8")).toBe("before")
      expect(readFileSync(temporary, "utf8")).toBe("sentinel")
    } finally {
      randomBytes.mockRestore()
    }
  })

  test("a rename that keeps failing throws, preserves the target, and leaves no temp file", () => {
    const root = dir()
    const file = path.join(root, "state.json")
    fs.writeFileSync(file, "before")

    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw transient("EPERM")
    })

    try {
      expect(() => writeFileSyncAtomic(file, "{}")).toThrow("rename failed: EPERM")
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, "utf8")).toBe("before")
      expect(readdirSync(root)).toEqual(["state.json"])
    } finally {
      spy.mockRestore()
    }
  })
})

describe("renameWithRetry", () => {
  test("retries EPERM, EACCES and EBUSY until the rename lands", async () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const root = dir()
      const source = path.join(root, "source")
      const destination = path.join(root, "destination")
      fs.writeFileSync(source, "content")
      const rename = fs.promises.rename
      let calls = 0

      const spy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        calls += 1

        if (calls < 3) throw transient(code)
        await rename(from, to)
      })

      try {
        await renameWithRetry(source, destination)
        expect(calls).toBe(3)
        expect(readFileSync(destination, "utf8")).toBe("content")
      } finally {
        spy.mockRestore()
      }
    }
  })
})

describe("writeFileAtomic", () => {
  test("replaces an existing file completely and leaves no temp file", async () => {
    const root = dir()
    const file = path.join(root, "export.txt")
    fs.writeFileSync(file, "ORIGINAL-CONTENT")
    await writeFileAtomic(file, "replacement content that is longer")
    expect(readFileSync(file, "utf8")).toBe("replacement content that is longer")
    expect(readdirSync(root)).toEqual(["export.txt"])
  })

  test("a write that fails partway leaves the previous content intact", async () => {
    const root = dir()
    const file = path.join(root, "export.txt")
    fs.writeFileSync(file, "ORIGINAL-CONTENT")
    const write = fs.promises.writeFile

    const spy = spyOn(fs.promises, "writeFile").mockImplementation(async (target, data, options) => {
      await write(target, "PARTIAL-", {})
      throw Object.assign(new Error("write failed: EFBIG"), { code: "EFBIG" })
    })

    try {
      await expect(writeFileAtomic(file, "replacement content")).rejects.toThrow("write failed: EFBIG")
      expect(readFileSync(file, "utf8")).toBe("ORIGINAL-CONTENT")
      expect(readdirSync(root)).toEqual(["export.txt"])
    } finally {
      spy.mockRestore()
    }
  })

  test("preserves an existing file's mode across the replace", async () => {
    if (process.platform === "win32") return
    const root = dir()
    const file = path.join(root, "export.txt")
    fs.writeFileSync(file, "ORIGINAL-CONTENT")
    fs.chmodSync(file, 0o640)
    await writeFileAtomic(file, "new")
    expect(readFileSync(file, "utf8")).toBe("new")
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
  })
})
