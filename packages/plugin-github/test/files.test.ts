import { describe, expect } from "bun:test"
import fs from "node:fs"
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
import { it, tmpdirScoped } from "./lib"

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

// External targets are reported by their canonical path (#2641), which differs
// from the lexical spelling where an existing ancestor is a symlink (for
// example /tmp on macOS). Expectations for outside paths are stated canonically.
const canonical = (absolute: string): string => {
  let current = absolute
  const tail: string[] = []
  while (true) {
    try {
      const resolved = fs.realpathSync(current)
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return absolute
      tail.push(path.basename(current))
      current = parent
    }
  }
}

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
      const shot = canonical(path.join(outside, "shot.png"))
      const canonicalOutside = canonical(outside)
      const downloads = canonical(path.join(path.parse(root).root, "tmp", "downloads"))
      const file = yield* files.authorizeRead(path.join(outside, "shot.png"), context)
      expect(file).toEqual({ absolute: shot, resource: shot.replaceAll("\\", "/"), external: canonicalOutside })
      const directory = yield* files.resolve({ path: downloads, kind: "directory" })
      yield* files.authorizeExternal([directory], context)
      expect(asserted).toEqual([
        { action: "external_directory", resources: [`${canonicalOutside.replaceAll("\\", "/")}/*`] },
        { action: "read", resources: [shot.replaceAll("\\", "/")] },
        { action: "external_directory", resources: [`${downloads.replaceAll("\\", "/")}/*`] },
      ])
    }),
  )
})

describe("GitHubFiles canonical classification", () => {
  const makeAt = (directory: string) => {
    const asserted: Array<{ action: string; resources: ReadonlyArray<string> }> = []
    const files = GitHubFiles.make({
      location: new Location.Info({
        directory: AbsolutePath.make(directory),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make(directory),
          canonical: AbsolutePath.make(directory),
        },
      }),
      permission: {
        assert: (input) => Effect.sync(() => void asserted.push({ action: input.action, resources: input.resources })),
      },
    })
    return { files, asserted }
  }

  it.live(
    "an in-project symlink to a file outside the project needs external-directory approval for the canonical directory",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const project = path.join(tmp.path, "project")
        const outsideDir = path.join(tmp.path, "outside")
        fs.mkdirSync(project, { recursive: true })
        fs.mkdirSync(outsideDir, { recursive: true })
        const secret = path.join(outsideDir, "secret.txt")
        fs.writeFileSync(secret, "secret\n")
        fs.symlinkSync(secret, path.join(project, "linked.txt"))
        const { files, asserted } = makeAt(project)
        const target = yield* files.resolve({ path: "linked.txt", kind: "file" })
        expect(target).toEqual({
          absolute: secret,
          resource: secret.replaceAll("\\", "/"),
          external: outsideDir,
        })
        const read = yield* files.authorizeRead("linked.txt", context)
        // The path handed back is the canonical file, so the file that was authorized is the file that is read.
        expect(read.absolute).toBe(secret)
        expect(asserted).toEqual([
          { action: "external_directory", resources: [`${outsideDir.replaceAll("\\", "/")}/*`] },
          { action: "read", resources: [secret.replaceAll("\\", "/")] },
        ])
      }),
  )

  it.live("a path through a symlinked in-project directory to an outside file is external", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const project = path.join(tmp.path, "project")
      const outsideDir = path.join(tmp.path, "outside")
      fs.mkdirSync(project, { recursive: true })
      fs.mkdirSync(outsideDir, { recursive: true })
      const secret = path.join(outsideDir, "secret.txt")
      fs.writeFileSync(secret, "secret\n")
      fs.symlinkSync(outsideDir, path.join(project, "links"), "dir")
      const { files } = makeAt(project)
      const target = yield* files.resolve({ path: "links/secret.txt", kind: "file" })
      expect(target).toEqual({
        absolute: secret,
        resource: secret.replaceAll("\\", "/"),
        external: outsideDir,
      })
    }),
  )

  it.live("an in-project symlink to another in-project file stays internal", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const project = path.join(tmp.path, "project")
      fs.mkdirSync(project, { recursive: true })
      const real = path.join(project, "real.txt")
      fs.writeFileSync(real, "real\n")
      fs.symlinkSync(real, path.join(project, "inner.txt"))
      const { files, asserted } = makeAt(project)
      const read = yield* files.authorizeRead("inner.txt", context)
      expect(asserted).toEqual([{ action: "read", resources: ["inner.txt"] }])
      // The read is authorized on the lexical resource; the path handed back is the canonical file.
      expect(read).toEqual({ absolute: real, resource: "inner.txt" })
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
