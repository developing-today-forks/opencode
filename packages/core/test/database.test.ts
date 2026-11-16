import { describe, expect, test } from "bun:test"
import { chmod, stat, writeFile } from "node:fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { tmpdir } from "./fixture/tmpdir"

// Read while the connection is open: SQLite may remove the sidecars on close.
// TursoDB never creates a -shm file, so a missing sidecar is layout, not a
// failure, on that engine (#2505). Modes are owner-only wherever a file exists.
const TURSO = process.env.OPENCODE_DB_ENGINE === "turso"
const openModes = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(Database.layer({ path: filename }))
      return yield* Effect.promise(() =>
        Promise.all(
          ["", "-wal", "-shm"].map(async (suffix) => {
            try {
              return (await stat(filename + suffix)).mode & 0o777
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
              throw error
            }
          }),
        ),
      )
    }).pipe(Effect.scoped, Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) }))),
  )

describe.skipIf(process.platform === "win32")("Database file permissions", () => {
  test("creates the database and sidecars readable only by the owner", async () => {
    await using tmp = await tmpdir()

    const [main, wal, shm] = await openModes(path.join(tmp.path, "opencode.db"))
    expect(main).toEqual(0o600)
    expect(wal).toEqual(0o600)
    // TursoDB runs without a -shm file; every sidecar it does create is owner-only.
    if (TURSO) expect(shm === null || shm === 0o600).toBe(true)
    else expect(shm).toEqual(0o600)
  })

  test("tightens an existing database and sidecars", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode.db")
    await Promise.all(
      ["", "-wal", "-shm"].map(async (suffix) => {
        await writeFile(filename + suffix, "")
        await chmod(filename + suffix, 0o644)
      }),
    )

    expect(await openModes(filename)).toEqual([0o600, 0o600, 0o600])
  })
})
