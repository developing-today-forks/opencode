import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("confines fs.write to the location or advertised temp root before creating parents", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const location = path.join(tmp.path, "project")
    const outside = path.join(tmp.path, "project-outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(location, { recursive: true }), fs.mkdir(outside)]))
    expect(FSUtil.contains(Global.Path.tmp, outside)).toBe(false)

    const server = yield* startServer(path.join(tmp.path, "config"))
    const write = (target: string, contents: string) =>
      Effect.promise(() => {
        const url = new URL("/api/experimental/fs/write", server.base)
        url.searchParams.set("location[directory]", location)
        url.searchParams.set("path", target)
        return fetch(url, {
          method: "POST",
          headers: { ...server.headers, "content-type": "application/octet-stream" },
          body: Buffer.from(contents),
        })
      })
    const exists = (target: string) => fs.access(target).then(() => true, () => false)

    const relativeTarget = path.join("nested", "relative.txt")
    const relative = yield* write(relativeTarget, "location relative")
    expect(relative.status).toBe(200)
    expect(yield* Effect.promise(() => fs.readFile(path.join(location, relativeTarget), "utf8"))).toBe("location relative")

    const absoluteTarget = path.join(location, "absolute", "target.txt")
    const absolute = yield* write(absoluteTarget, "location absolute")
    expect(absolute.status).toBe(200)
    expect(yield* Effect.promise(() => fs.readFile(absoluteTarget, "utf8"))).toBe("location absolute")

    const tempDirectory = path.join(Global.Path.tmp, "uploads", `fs-write-${randomUUID()}`)
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(tempDirectory, { recursive: true, force: true })))
    const tempTarget = path.join(tempDirectory, "attachment.txt")
    const temp = yield* write(tempTarget, "advertised temp")
    expect(temp.status).toBe(200)
    expect(yield* Effect.promise(() => fs.readFile(tempTarget, "utf8"))).toBe("advertised temp")

    const deniedAbsolute = path.join(outside, "absolute", "nested.txt")
    const absoluteRejected = yield* write(deniedAbsolute, "must not be written")
    expect(absoluteRejected.status).toBe(404)
    expect(yield* Effect.promise(() => exists(path.join(outside, "absolute")))).toBe(false)

    const escapedTarget = path.relative(location, path.join(outside, "traversal", "nested.txt"))
    const traversalRejected = yield* write(escapedTarget, "must not be written")
    expect(traversalRejected.status).toBe(404)
    expect(yield* Effect.promise(() => exists(path.join(outside, "traversal")))).toBe(false)

    const sibling = `${location}-other`
    const siblingRejected = yield* write(path.join(sibling, "nested", "sibling.txt"), "must not be written")
    expect(siblingRejected.status).toBe(404)
    expect(yield* Effect.promise(() => exists(sibling))).toBe(false)

    const link = path.join(location, "outside-link")
    yield* Effect.promise(() => fs.symlink(outside, link, "junction"))
    const symlinkRejected = yield* write(path.join(link, "symlink", "escape.txt"), "must not be written")
    expect(symlinkRejected.status).toBe(404)
    expect(yield* Effect.promise(() => exists(path.join(outside, "symlink")))).toBe(false)
  }),
)
