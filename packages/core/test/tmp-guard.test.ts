import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TmpGuard } from "@opencode/core/tmp-guard"
import { tmpdir } from "./fixture/tmpdir"

describe("TmpGuard.findCollisions", () => {
  test("flags .py files whose stem is a Python stdlib module name", () => {
    expect(TmpGuard.findCollisions(["re.py", "os.py", "json.py", "io.py", "sys.py"])).toEqual([
      "io.py",
      "json.py",
      "os.py",
      "re.py",
      "sys.py",
    ])
  })

  test("flags the CPython 3.14 names a hand-maintained list can miss", () => {
    // Verified against sys.stdlib_module_names on CPython 3.14.7 (#760):
    // annotationlib (new in 3.14), antigravity, and the mixed-case cProfile
    // were absent; case sensitivity is deliberate (Re.py stays a
    // non-collision in the next test).
    expect(TmpGuard.findCollisions(["annotationlib.py", "antigravity.py", "cProfile.py"])).toEqual([
      "annotationlib.py",
      "antigravity.py",
      "cProfile.py",
    ])
    expect(TmpGuard.isStdlibPythonFile("cProfile.py")).toBe(true)
  })

  test("ignores non-stdlib names, non-Python files, and extension lookalikes", () => {
    expect(
      TmpGuard.findCollisions(["helper.py", "re.py.bak", "re.pyc", "notes.txt", "reminders.py", "Re.py", "re"]),
    ).toEqual([])
  })
})

describe("TmpGuard.scan", () => {
  test("finds top-level colliding files only and leaves them in place", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "re.py"), "# not the stdlib\n")
    fs.writeFileSync(path.join(tmp.path, "helper.py"), "# fine\n")
    fs.mkdirSync(path.join(tmp.path, "nested"))
    fs.writeFileSync(path.join(tmp.path, "nested", "os.py"), "# nested: not on sys.path\n")
    fs.mkdirSync(path.join(tmp.path, "json.py"))

    expect(TmpGuard.scan(tmp.path)).toEqual(["re.py"])
    expect(fs.existsSync(path.join(tmp.path, "re.py"))).toBe(true)
  })

  test("finds a stdlib package directory, but not a bare stdlib-named directory", async () => {
    await using tmp = await tmpdir()
    fs.mkdirSync(path.join(tmp.path, "json"))
    fs.writeFileSync(path.join(tmp.path, "json", "__init__.py"), "MARKER = 'shadow-json'\n")
    // No __init__.py: a namespace portion only, which the regular stdlib
    // package beats, so this must not be reported.
    fs.mkdirSync(path.join(tmp.path, "email"))

    expect(TmpGuard.scan(tmp.path)).toEqual(["json/"])
    expect(fs.existsSync(path.join(tmp.path, "json", "__init__.py"))).toBe(true)
  })

  const posixTest = process.platform === "win32" ? test.skip : test
  posixTest("finds a symlinked .py file by its link name and skips a broken link", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "target.py"), "MARKER = 'shadow-colorsys'\n")
    fs.symlinkSync(path.join(tmp.path, "target.py"), path.join(tmp.path, "colorsys.py"))
    // A broken symlink imports nothing, so its stdlib name is not a collision.
    fs.symlinkSync(path.join(tmp.path, "missing.py"), path.join(tmp.path, "re.py"))

    expect(TmpGuard.scan(tmp.path)).toEqual(["colorsys.py"])
    expect(fs.lstatSync(path.join(tmp.path, "colorsys.py")).isSymbolicLink()).toBe(true)
  })

  test("is quiet for a clean directory", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "scratch.py"), "# fine\n")
    expect(TmpGuard.scan(tmp.path)).toEqual([])
  })
})

describe("TmpGuard.warn", () => {
  test("returns the collisions and names the python3 -I workaround in the warning", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "re.py"), "# not the stdlib\n")

    const files = await Effect.runPromise(TmpGuard.warn(tmp.path))
    expect(files).toEqual(["re.py"])

    const message = TmpGuard.warning(tmp.path, files)
    expect(message).toContain("re.py")
    expect(message).toContain(tmp.path)
    expect(message).toContain("python3 -I")
    expect(message).toContain("left untouched")
  })

  test("returns no files and warns nothing for a missing directory", async () => {
    const files = await Effect.runPromise(TmpGuard.warn(path.join("/definitely", "missing", "opencode-tmp")))
    expect(files).toEqual([])
  })
})
