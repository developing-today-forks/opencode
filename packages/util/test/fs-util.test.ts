import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FSUtil } from "../src/fs-util.js"

// Conformance suite for the design #1345 atomic-replace contract (phase 1,
// #1346): one table-driven pass over the shared probe matrix. Every row is a
// test: round-trip replace, fresh create under both mode policies, existing
// mode under both policies (including 0o400 under preserve), symlink target
// preserved, wx collision refused, injected-EPERM rename retry, and a failing
// write leaving the target intact with no temp behind.

type Overrides = Partial<FileSystem.FileSystem>

async function realFileSystem() {
  const context = await Effect.runPromise(Effect.scoped(Layer.build(NodeFileSystem.layer)))
  return Context.get(context, FileSystem.FileSystem)
}

async function run<A>(effect: (service: FSUtil.Interface) => Effect.Effect<A, FSUtil.Error>, overrides?: Overrides) {
  if (overrides === undefined) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* FSUtil.Service
        return yield* effect(service)
      }).pipe(Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer)),
    )
  }
  const real = await realFileSystem()
  const custom = Layer.succeed(FileSystem.FileSystem, { ...real, ...overrides })
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      return yield* effect(service)
    }).pipe(Effect.provide(FSUtil.layer), Effect.provide(custom)),
  )
}

function writeAtomic(file: string, content: string | Uint8Array, options?: FSUtil.WriteAtomicOptions) {
  return run((service) => service.writeAtomic(file, content, options))
}

async function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-fs-util-atomic-"))
}

async function mode(file: string) {
  return fs.statSync(file).mode & 0o777
}

const transientRenameError = () =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "rename",
    syscall: "rename",
    cause: Object.assign(new Error("rename EPERM: operation not permitted"), { code: "EPERM" }),
  })

describe("FSUtil.writeAtomic conformance (design #1345 probe matrix)", () => {
  // Mode-policy rows: [name, setup, options, expected mode]
  const rows: Array<{
    name: string
    existing?: { content: string; mode: number }
    options?: FSUtil.WriteAtomicOptions
    expectedMode: number
  }> = [
    { name: "fresh create under preserve (default fresh mode)", options: { modePolicy: "preserve" }, expectedMode: 0o600 },
    {
      name: "fresh create under preserve with a stated freshMode",
      options: { modePolicy: "preserve", freshMode: 0o640 },
      expectedMode: 0o640,
    },
    { name: "fresh create under owner-capped", options: { modePolicy: "owner-capped" }, expectedMode: 0o600 },
    {
      name: "fresh create under owner-capped ignores a wider freshMode",
      options: { modePolicy: "owner-capped", freshMode: 0o644 },
      expectedMode: 0o600,
    },
    {
      name: "existing mode under preserve",
      existing: { content: "before", mode: 0o644 },
      options: { modePolicy: "preserve" },
      expectedMode: 0o644,
    },
    {
      name: "existing mode under owner-capped is masked to owner-only",
      existing: { content: "before", mode: 0o644 },
      options: { modePolicy: "owner-capped" },
      expectedMode: 0o600,
    },
    {
      name: "read-only 0o400 file stays 0o400 under preserve",
      existing: { content: "before", mode: 0o400 },
      options: { modePolicy: "preserve" },
      expectedMode: 0o400,
    },
    {
      name: "read-only 0o400 file stays 0o400 under owner-capped",
      existing: { content: "before", mode: 0o400 },
      options: { modePolicy: "owner-capped" },
      expectedMode: 0o400,
    },
    {
      name: "existing owner-only mode under preserve (defaults when no options given)",
      existing: { content: "before", mode: 0o600 },
      expectedMode: 0o600,
    },
  ]

  for (const row of rows) {
    test(row.name, async () => {
      const directory = await dir()
      const file = path.join(directory, "target.txt")
      if (row.existing) {
        fs.writeFileSync(file, row.existing.content)
        fs.chmodSync(file, row.existing.mode)
      }
      await writeAtomic(file, "after", row.options)
      expect(fs.readFileSync(file, "utf8")).toBe("after")
      if (process.platform !== "win32") expect(await mode(file)).toBe(row.expectedMode)
      // No temp file is left behind.
      expect(fs.readdirSync(directory)).toEqual(["target.txt"])
      fs.rmSync(directory, { recursive: true, force: true })
    })
  }

  test("round-trip replace of an existing file (string and bytes)", async () => {
    const directory = await dir()
    const file = path.join(directory, "target.txt")
    fs.writeFileSync(file, "one")
    await writeAtomic(file, "two")
    expect(fs.readFileSync(file, "utf8")).toBe("two")
    await writeAtomic(file, new TextEncoder().encode("three"))
    expect(fs.readFileSync(file, "utf8")).toBe("three")
    expect(fs.readdirSync(directory)).toEqual(["target.txt"])
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("symlinked target: link preserved, content lands on the real file", async () => {
    const root = await dir()
    const realDir = path.join(root, "dotfiles")
    const linkDir = path.join(root, "home")
    fs.mkdirSync(realDir)
    fs.mkdirSync(linkDir)
    const real = path.join(realDir, "config.txt")
    fs.writeFileSync(real, "before")
    const link = path.join(linkDir, "config.txt")
    fs.symlinkSync(real, link)

    await writeAtomic(link, "after")

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, "utf8")).toBe("after")
    expect(fs.readdirSync(realDir)).toEqual(["config.txt"])
    expect(fs.readdirSync(linkDir)).toEqual(["config.txt"])
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("temp-name collision is refused by wx and the other writer's file is untouched", async () => {
    const directory = await dir()
    const file = path.join(directory, "target.txt")
    fs.writeFileSync(file, "before")
    let collided: string | undefined
    // Pre-create whatever temp name the implementation chooses, the moment it
    // tries to open it exclusively: the wx open must fail rather than overwrite.
    const real = await realFileSystem()
    const outcome = await run(
      (service) => service.writeAtomic(file, "after"),
      {
        open: (temp, options) => {
          if (options?.flag === "wx" && collided === undefined) {
            collided = temp
            fs.writeFileSync(temp, "sentinel")
          }
          return real.open(temp, options)
        },
      },
    ).then(
      () => "succeeded",
      () => "failed",
    )
    expect(outcome).toBe("failed")
    expect(collided).toBeDefined()
    // The pre-existing temp-named file is not ours: cleanup must not remove it,
    // and the target is byte-identical.
    expect(fs.readFileSync(collided!, "utf8")).toBe("sentinel")
    expect(fs.readFileSync(file, "utf8")).toBe("before")
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("rename retry succeeds on an injected transient EPERM", async () => {
    const directory = await dir()
    const file = path.join(directory, "target.txt")
    fs.writeFileSync(file, "before")
    const real = await realFileSystem()
    let renames = 0
    await run(
      (service) => service.writeAtomic(file, "after"),
      {
        rename: (from, to) => {
          renames++
          if (renames === 1) return Effect.fail(transientRenameError())
          return real.rename(from, to)
        },
      },
    )
    expect(renames).toBe(2)
    expect(fs.readFileSync(file, "utf8")).toBe("after")
    expect(fs.readdirSync(directory)).toEqual(["target.txt"])
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("a failing write leaves the target byte-identical and no temp behind", async () => {
    const directory = await dir()
    const file = path.join(directory, "target.txt")
    fs.writeFileSync(file, "before")
    const outcome = await run(
      (service) => service.writeAtomic(file, "after"),
      {
        rename: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "rename",
              syscall: "rename",
              cause: Object.assign(new Error("rename EIO: input/output error"), { code: "EIO" }),
            }),
          ),
      },
    ).then(
      () => "succeeded",
      () => "failed",
    )
    expect(outcome).toBe("failed")
    expect(fs.readFileSync(file, "utf8")).toBe("before")
    expect(fs.readdirSync(directory)).toEqual(["target.txt"])
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("preserveOwnership carries the existing uid/gid through the replace", async () => {
    const directory = await dir()
    const file = path.join(directory, "target.txt")
    fs.writeFileSync(file, "before")
    const before = fs.statSync(file)
    await writeAtomic(file, "after", { preserveOwnership: true })
    const after = fs.statSync(file)
    expect(fs.readFileSync(file, "utf8")).toBe("after")
    expect(after.uid).toBe(before.uid)
    expect(after.gid).toBe(before.gid)
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("writeJsonAtomic writes the writeJson formatting atomically", async () => {
    const directory = await dir()
    const file = path.join(directory, "target.json")
    fs.writeFileSync(file, "{}")
    await run((service) => service.writeJsonAtomic(file, { a: 1, nested: { b: [true, null] } }))
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify({ a: 1, nested: { b: [true, null] } }, null, 2))
    expect(fs.readdirSync(directory)).toEqual(["target.json"])
    fs.rmSync(directory, { recursive: true, force: true })
  })
})
