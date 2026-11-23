import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { tmpdirScoped, withTempDir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

function provide(directory: string, projectDirectory = directory, environment?: Environment.Driver) {
  return Effect.provide(
    LayerNode.compile(FileAccess.node, {
      replacements: [
        ...(environment
          ? [
              Environment.node.replace(
                Layer.succeed(Environment.Service, Environment.make(Environment.localID, environment)),
              ),
            ]
          : []),
        Permission.node.replace(permissionLayer()),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(directory) },
                { projectDirectory: AbsolutePath.make(projectDirectory) },
              ),
            ),
          ),
        ),
      ],
    }),
  )
}

const invocation: FileAccess.Invocation = {
  sessionID: "ses_file_access_test",
  agent: "build",
  messageID: "msg_file_access_test",
  id: "call_file_access_test",
} as FileAccess.Invocation

function provideRecording(directory: string, assertions: Permission.AssertInput[]) {
  return Effect.provide(
    LayerNode.compile(FileAccess.node, {
      replacements: [
        Permission.node.replace(
          permissionLayer({
            assert: (input) => Effect.sync(() => assertions.push(input)),
          }),
        ),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
            ),
          ),
        ),
      ],
    }),
  )
}

describe("FileAccess.resolve", () => {
  it.live("resolves an active relative existing file target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "hello"))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "hello.txt" })

        expect(target).toMatchObject({
          absolute: targetPath,
          resource: "hello.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("resolves an active relative prospective file target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src")))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: path.join("src", "new.txt") })
        expect(target).toMatchObject({
          absolute: path.join(directory, "src", "new.txt"),
          resource: "src/new.txt",
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires external-directory authorization for a relative lexical escape", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "../outside.txt" })
        const root = path.dirname(directory)
        expect(target).toMatchObject({
          absolute: path.join(root, "outside.txt"),
          resource: path.join(root, "outside.txt").replaceAll("\\", "/"),
        })
        expect(target.externalDirectory).toMatchObject({
          directory: root,
          resource: path.join(root, "*").replaceAll("\\", "/"),
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("allows a relative path outside the Location but inside the project worktree", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const active = path.join(directory, "packages", "opencode")
        yield* Effect.promise(() => fs.mkdir(active, { recursive: true }))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "../../README.md" })
        expect(target).toMatchObject({
          absolute: path.join(directory, "README.md"),
          resource: "../../README.md",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(path.join(directory, "packages", "opencode"), directory)),
    ),
  )

  it.live("does not treat a filesystem-root project sentinel as an internal boundary", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "../outside.txt" })
        expect(target.externalDirectory).toBeDefined()
      }).pipe(provide(directory, path.parse(directory).root)),
    ),
  )

  it.live("classifies a prospective target below an external symlink by its canonical location", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const outside = yield* tmpdirScoped()
        yield* Effect.promise(() => fs.symlink(outside.path, path.join(directory, "escape")))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: path.join("escape", "new.txt") })
        // #2286: the not-yet-existing name cannot be a symlink, but its
        // symlinked ancestor redirects it outside, so the canonical
        // location decides: this is an external target.
        expect(target).toMatchObject({
          absolute: path.join(outside.path, "new.txt"),
          resource: path.join(outside.path, "new.txt").replaceAll("\\", "/"),
        })
        expect(target.externalDirectory).toMatchObject({
          directory: outside.path,
          resource: path.join(outside.path, "*").replaceAll("\\", "/"),
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires external-directory authorization for an existing file reached through an in-location symlink", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          if (process.platform === "win32") return
          const secret = path.join(outside, "secret.txt")
          yield* Effect.promise(async () => {
            await fs.writeFile(secret, "secret")
            await fs.symlink(secret, path.join(directory, "secret.txt"))
          })
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: "secret.txt" })
          // #2286: the lexical path is inside the location, but the file
          // the filesystem opens is outside it, so the read needs
          // external-directory approval and operates on the canonical
          // (authorized) path.
          expect(target).toMatchObject({ absolute: secret, resource: secret.replaceAll("\\", "/") })
          expect(target.externalDirectory).toMatchObject({
            directory: outside,
            resource: path.join(outside, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("preserves internal access for an existing file reached through an in-location symlink", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const real = path.join(directory, "real.txt")
        yield* Effect.promise(async () => {
          await fs.writeFile(real, "real")
          await fs.symlink(real, path.join(directory, "link.txt"))
        })
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "link.txt" })
        // Classification is internal (the canonical location is inside),
        // and resolve() preserves the lexical path for its consumers.
        expect(target).toMatchObject({ absolute: path.join(directory, "link.txt"), resource: "link.txt" })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("authorizeRead asks external-directory approval before reading through an external symlink", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) => {
        const assertions: Permission.AssertInput[] = []
        return Effect.gen(function* () {
          if (process.platform === "win32") return
          const secret = path.join(outside, "secret.txt")
          yield* Effect.promise(async () => {
            await fs.writeFile(secret, "secret")
            await fs.symlink(secret, path.join(directory, "secret.txt"))
          })
          const access = yield* FileAccess.Service
          const target = yield* access.authorizeRead("secret.txt", invocation)
          // Approval order: external_directory for the canonical
          // location first, then the read itself; the returned target
          // is the canonical path, so the authorized file is the file
          // that gets read.
          expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])
          expect(assertions[0]?.resources).toEqual([path.join(outside, "*").replaceAll("\\", "/")])
          expect(assertions[1]?.resources).toEqual([secret.replaceAll("\\", "/")])
          expect(target.absolute).toBe(AbsolutePath.make(secret))
        }).pipe(provideRecording(directory, assertions))
      }),
    ),
  )

  it.live("authorizeRead reads an in-location symlink target by its canonical path without external approval", () =>
    withTempDir(({ path: directory }) => {
      const assertions: Permission.AssertInput[] = []
      return Effect.gen(function* () {
        if (process.platform === "win32") return
        const real = path.join(directory, "real.txt")
        yield* Effect.promise(async () => {
          await fs.writeFile(real, "real")
          await fs.symlink(real, path.join(directory, "link.txt"))
        })
        const access = yield* FileAccess.Service
        const target = yield* access.authorizeRead("link.txt", invocation)
        expect(assertions.map((input) => input.action)).toEqual(["read"])
        expect(assertions[0]?.resources).toEqual(["real.txt"])
        expect(target.absolute).toBe(AbsolutePath.make(real))
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provideRecording(directory, assertions))
    }),
  )

  it.live("follows an in-location symlink using ordinary filesystem semantics", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, "actual"))
          await fs.symlink(path.join(directory, "actual"), path.join(directory, "linked"))
        })

        const access = yield* FileAccess.Service
        expect(yield* access.resolve({ path: "linked/new.txt" })).toMatchObject({
          absolute: path.join(directory, "linked", "new.txt"),
          resource: "linked/new.txt",
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("accepts an explicit absolute in-location target without external approval", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "new.txt")
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: targetPath })
        expect(target).toMatchObject({
          absolute: targetPath,
          resource: "new.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires external-directory authorization for an explicit external absolute target", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "new.txt")
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          const root = outside
          expect(target).toMatchObject({
            absolute: path.join(root, "new.txt"),
            resource: path.join(root, "new.txt").replaceAll("\\", "/"),
          })
          expect(target.externalDirectory).toMatchObject({
            directory: root,
            resource: path.join(root, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("resolves an existing external file target", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "existing.txt")
          yield* Effect.promise(() => fs.writeFile(targetPath, "existing"))
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          expect(target).toMatchObject({ absolute: targetPath })
          expect(target.externalDirectory?.directory).toBe(AbsolutePath.make(outside))
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("uses an explicit file kind without treating an existing directory as the target boundary", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: outside, kind: "file" })
          expect(target.externalDirectory).toMatchObject({
            directory: path.dirname(outside),
            resource: path.join(path.dirname(outside), "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("authorizes prospective external descendants at their lexical parent", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "new", "nested", "file.txt")
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          const parent = path.dirname(targetPath)
          expect(target.externalDirectory).toMatchObject({
            directory: parent,
            resource: path.join(parent, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("saves external approval at the enclosing repository on the host filesystem", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const src = path.join(outside, "src")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(outside, ".git"))
            await fs.mkdir(src)
          })
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: src })
          expect(target.externalDirectory).toMatchObject({
            directory: src,
            save: path.join(outside, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("stats and finds the repository through the Location's Environment driver", () => {
    if (process.platform === "win32") return Effect.void
    const driver = Environment.makeMemoryDriver()
    const files = Environment.makeFiles(driver)
    return Effect.gen(function* () {
      yield* files.mkdir("/project")
      yield* files.mkdir("/remote/repo/.git")
      yield* files.mkdir("/remote/repo/src")
      yield* driver.symlink("/remote/repo/src", "/remote/repo/linked")
      const access = yield* FileAccess.Service

      // These paths exist only in the memory driver, so the host filesystem would see neither the directory nor the repository.
      expect((yield* access.resolve({ path: "/remote/repo/src" })).externalDirectory).toMatchObject({
        directory: "/remote/repo/src",
        save: "/remote/repo/*",
      })
      expect((yield* access.resolve({ path: "/remote/repo/linked" })).externalDirectory).toMatchObject({
        directory: "/remote/repo/linked",
        save: "/remote/repo/*",
      })
      expect((yield* access.resolve({ path: "/remote/repo/src/new.txt" })).externalDirectory).toMatchObject({
        directory: "/remote/repo/src",
        save: "/remote/repo/*",
      })
    }).pipe(provide("/project", "/project", driver))
  })

  test("ignores unknown path input fields", () => {
    expect(Schema.decodeUnknownSync(FileAccess.ResolveInput)({ path: "README.md", reference: "docs" })).toEqual({
      path: "README.md",
    })
  })

  test("expands a leading tilde against the home directory", () => {
    const home = path.resolve("/Users/aiden")
    expect(FileAccess.resolvePath("/project", "~", home)).toBe(home)
    expect(FileAccess.resolvePath("/project", "~/notes.md", home)).toBe(path.resolve(home, "notes.md"))
    expect(FileAccess.resolvePath("/project", "~draft.md", home)).toBe(path.resolve("/project", "~draft.md"))
    expect(FileAccess.resolvePath("/project", "~\\notes.md", home)).toBe(
      process.platform === "win32" ? path.resolve(home, "notes.md") : path.resolve("/project", "~\\notes.md"),
    )
  })

  test.each([
    ["/c/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
    ["/C:/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
    ["/cygdrive/c/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
    ["/mnt/c/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
  ])("normalizes Windows shell drive path %s before resolution", (input, windows) => {
    expect(FileAccess.resolvePath("/project", input)).toBe(
      process.platform === "win32" ? path.resolve(windows) : path.resolve(input),
    )
  })

  it.live("resolves a tilde path as an external home target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "~/notes.md" })
        const absolute = path.resolve(Global.Path.home, "notes.md")
        expect(target).toMatchObject({
          absolute,
          resource: absolute.replaceAll("\\", "/"),
        })
        expect(target.externalDirectory).toMatchObject({
          directory: Global.Path.home,
          resource: path.join(Global.Path.home, "*").replaceAll("\\", "/"),
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("treats a tilde path as in-location when the location is home", () =>
    Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const target = yield* access.resolve({ path: "~/notes.md" })
      expect(target).toMatchObject({
        absolute: path.resolve(Global.Path.home, "notes.md"),
        resource: "notes.md",
      })
      expect(target.externalDirectory).toBeUndefined()
    }).pipe(provide(Global.Path.home)),
  )
})
