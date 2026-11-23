import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { GitHubFiles } from "../src/files.js"
import { GitHubProcess } from "../src/process.js"
import { it } from "./lib"

const context: Tool.Context = {
  sessionID: Session.ID.make("ses_files"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_files"),
  id: Tool.CallID.make("call_files"),
  progress: () => Effect.void,
}

// Fixture paths are built with the platform path module: `absolute` and
// `external` are native paths by contract, so a POSIX literal only matches
// on POSIX hosts. `resource` values are forward-slash normalized by the
// source and keep their literal form in the expectations below.
const root = path.resolve("/work/repo")
const outside = path.join(path.parse(root).root, "tmp", "out")

const make = () => {
  const asserted: Array<{ action: string; resources: ReadonlyArray<string> }> = []
  const files = GitHubFiles.make({
    location: new Location.Info({
      directory: AbsolutePath.make(path.join(root, "packages", "app")),
      project: {
        id: Project.ID.global,
        directory: AbsolutePath.make(root),
        canonical: AbsolutePath.make(root),
      },
    }),
    permission: {
      assert: (input) => Effect.sync(() => void asserted.push({ action: input.action, resources: input.resources })),
    },
  })
  return { files, asserted }
}

describe("GitHubFiles", () => {
  it.live("paths in the project are relative resources and need no external approval", () =>
    Effect.gen(function* () {
      const { files, asserted } = make()
      const sibling = yield* files.resolve({ path: "../lib/shot.png", kind: "file" })
      expect(sibling).toEqual({
        absolute: path.join(root, "packages", "lib", "shot.png"),
        resource: "../lib/shot.png",
      })
      yield* files.authorizeRead("assets/shot.png", context)
      expect(asserted).toEqual([{ action: "read", resources: ["assets/shot.png"] }])
    }),
  )

  it.live("a directory named ..cache at the project root is inside the project, not above it", () =>
    Effect.gen(function* () {
      const { files, asserted } = make()
      const cached = path.join(root, "..cache", "file")
      const file = yield* files.authorizeRead(cached, context)
      expect(file).toEqual({ absolute: cached, resource: "../../..cache/file" })
      expect(asserted).toEqual([{ action: "read", resources: ["../../..cache/file"] }])
    }),
  )

  it.live("paths outside the project need external-directory approval for their directory first", () =>
    Effect.gen(function* () {
      const { files, asserted } = make()
      const shot = path.join(outside, "shot.png")
      const downloads = path.join(path.parse(root).root, "tmp", "downloads")
      const file = yield* files.authorizeRead(shot, context)
      expect(file).toEqual({ absolute: shot, resource: shot.replaceAll("\\", "/"), external: outside })
      const directory = yield* files.resolve({ path: downloads, kind: "directory" })
      yield* files.authorizeExternal([directory], context)
      expect(asserted).toEqual([
        { action: "external_directory", resources: [`${outside.replaceAll("\\", "/")}/*`] },
        { action: "read", resources: [shot.replaceAll("\\", "/")] },
        { action: "external_directory", resources: [`${downloads.replaceAll("\\", "/")}/*`] },
      ])
    }),
  )
})

describe("GitHubProcess.run", () => {
  it.live("returns output and exit codes without failing, including for a missing program", () =>
    Effect.gen(function* () {
      const ok = yield* GitHubProcess.run("git", ["--version"])
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toStartWith("git version")
      const echoed = yield* GitHubProcess.run("git", ["hash-object", "--stdin"], { input: "secret\n" })
      // The blob ID of "secret\n", so stdin really reached the program.
      expect(echoed.stdout.trim()).toBe("d97c5eada5d8c52079031eef0107a4430a9617c5")
      const missing = yield* GitHubProcess.run("opencode-no-such-program", [])
      expect(missing.exitCode).toBe(127)
      expect(missing.stderr).toContain("opencode-no-such-program")
    }),
  )
})

describe("GitHubFiles canonical classification", () => {
  const makeAt = (directory: string, projectDirectory: string) => {
    const asserted: Array<{ action: string; resources: ReadonlyArray<string> }> = []
    const files = GitHubFiles.make({
      location: new Location.Info({
        directory: AbsolutePath.make(directory),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make(projectDirectory),
          canonical: AbsolutePath.make(projectDirectory),
        },
      }),
      permission: {
        assert: (input) => Effect.sync(() => void asserted.push({ action: input.action, resources: input.resources })),
      },
    })
    return { files, asserted }
  }

  // Real fixture tree under a canonicalized temp root: <base>/project/app is
  // the working directory, <base>/outside holds what the symlinks name.
  const fixture = () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "github-files-")))
    const app = path.join(base, "project", "app")
    const outside = path.join(base, "outside")
    fs.mkdirSync(app, { recursive: true })
    fs.mkdirSync(outside)
    return { base, app, project: path.join(base, "project"), outside }
  }
  const cleanup = (base: string) => Effect.sync(() => fs.rmSync(base, { recursive: true, force: true }))

  it.live(
    "an in-project symlink to an outside file needs external-directory approval for the canonical directory",
    () => {
      const { base, app, project, outside } = fixture()
      return Effect.gen(function* () {
        const secret = path.join(outside, "secret.txt")
        fs.writeFileSync(secret, "secret\n")
        fs.symlinkSync(secret, path.join(app, "link.txt"))
        const { files, asserted } = makeAt(app, project)
        const target = yield* files.authorizeRead("link.txt", context)
        expect(target).toEqual({
          absolute: secret,
          resource: secret.replaceAll("\\", "/"),
          external: outside,
        })
        expect(asserted).toEqual([
          { action: "external_directory", resources: [`${outside.replaceAll("\\", "/")}/*`] },
          { action: "read", resources: [secret.replaceAll("\\", "/")] },
        ])
      }).pipe(Effect.ensuring(cleanup(base)))
    },
  )

  it.live("an in-project symlink to an in-project file stays internal", () => {
    const { base, app, project } = fixture()
    return Effect.gen(function* () {
      const real = path.join(app, "real.txt")
      fs.writeFileSync(real, "real\n")
      fs.symlinkSync(real, path.join(app, "alias.txt"))
      const { files, asserted } = makeAt(app, project)
      const target = yield* files.authorizeRead("alias.txt", context)
      expect(target).toEqual({ absolute: path.join(app, "alias.txt"), resource: "alias.txt" })
      expect(asserted).toEqual([{ action: "read", resources: ["alias.txt"] }])
    }).pipe(Effect.ensuring(cleanup(base)))
  })

  it.live("a not-yet-existing file under a symlinked in-project directory is classified by the ancestor", () => {
    const { base, app, project, outside } = fixture()
    return Effect.gen(function* () {
      fs.symlinkSync(outside, path.join(app, "linked-dir"), "dir")
      const { files } = makeAt(app, project)
      const target = yield* files.resolve({ path: "linked-dir/new.txt", kind: "file" })
      expect(target).toEqual({
        absolute: path.join(outside, "new.txt"),
        resource: path.join(outside, "new.txt").replaceAll("\\", "/"),
        external: outside,
      })
    }).pipe(Effect.ensuring(cleanup(base)))
  })
})
