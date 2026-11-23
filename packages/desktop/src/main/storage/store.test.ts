import { describe, expect, spyOn, test } from "bun:test"
import fs, { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSettingsStore } from "./store"

const dir = () => mkdtempSync(path.join(tmpdir(), "opencode-settings-"))

describe("settings store", () => {
  test("reads the tab-indented file electron-store wrote and rewrites it in the same shape", () => {
    const file = path.join(dir(), "opencode.settings")
    writeFileSync(file, JSON.stringify({ windowIds: ["a"], backgroundColor: "#121212" }, null, "\t"))
    const store = createSettingsStore(file)
    expect(store.get("windowIds")).toEqual(["a"])
    store.set("backgroundColor", "#ffffff")
    expect(readFileSync(file, "utf8")).toBe(
      JSON.stringify({ windowIds: ["a"], backgroundColor: "#ffffff" }, null, "\t"),
    )
    expect(createSettingsStore(file).get("backgroundColor")).toBe("#ffffff")
  })

  test("starts empty without a file, creates it on the first write, and refuses undefined", () => {
    const file = path.join(dir(), "nested", "opencode.updater")
    const store = createSettingsStore(file)
    expect(store.get("ready")).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    store.set("ready", { version: "1.0.0" })
    // Like electron-store, undefined is refused instead of treated as a delete.
    // @ts-expect-error undefined is not a JSON value; an untyped caller still gets the TypeError.
    expect(() => store.set("ready", undefined)).toThrow(TypeError)
    expect(store.get("ready")).toEqual({ version: "1.0.0" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ready: { version: "1.0.0" } })
    store.delete("ready")
    expect(store.get("ready")).toBeUndefined()
    expect(readFileSync(file, "utf8")).toBe("{}")
  })

  test("retries a transient rename failure so the setting still lands", () => {
    const file = path.join(dir(), "opencode.settings")
    const store = createSettingsStore(file)
    const rename = fs.renameSync
    let calls = 0

    const spy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      calls += 1

      if (calls === 1) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      rename(source, destination)
    })

    try {
      store.set("backgroundColor", "#ffffff")
      expect(calls).toBe(2)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ backgroundColor: "#ffffff" })
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("a rename that keeps failing transiently throws and leaves no temp file", () => {
    const file = path.join(dir(), "opencode.settings")
    const store = createSettingsStore(file)
    let calls = 0

    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    })

    try {
      expect(() => store.set("backgroundColor", "#ffffff")).toThrow("operation not permitted")
      expect(calls).toBe(5)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("sets an unreadable file aside instead of failing", () => {
    const file = path.join(dir(), "opencode.settings")
    writeFileSync(file, "{ not json")
    const store = createSettingsStore(file)
    expect(store.get("anything")).toBeUndefined()
    expect(existsSync(`${file}.corrupt`)).toBe(true)
    store.set("firstLaunchOnboardingComplete", true)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ firstLaunchOnboardingComplete: true })
  })
})
