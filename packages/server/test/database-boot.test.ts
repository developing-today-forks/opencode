import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { HttpServer } from "effect/http"
import { SqlError } from "effect/sql/SqlError"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

const options = (database: string) => ({
  hostname: "127.0.0.1",
  port: 0,
  password: "secret",
  app: { version: "test-version" },
  database: { path: database },
  models: { fetch: false },
})

it.live(
  "a database another connection holds during boot opens once the lock clears",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("opencode-server-busy-")
      const file = path.join(tmp.path, "opencode.db")
      const setup = new Database(file)
      setup.run("PRAGMA journal_mode = WAL")
      setup.close()
      // An exclusive lock makes a new connection's first statement fail as busy, like a predecessor still closing.
      // The lock lives in another process, as a predecessor's would: SQLite's busy wait blocks the thread that
      // opens the database, so an in-process holder could not release its lock until that wait gave up.
      const holder = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `const { Database } = require("bun:sqlite")
const db = new Database(${JSON.stringify(file)})
db.run("PRAGMA locking_mode = EXCLUSIVE")
db.query("select count(*) from sqlite_master").get()
console.log("locked")
await Bun.sleep(1000)
db.close()`,
        ],
        stdout: "pipe",
      })
      const reader = holder.stdout.getReader()
      const first = yield* Effect.promise(() => reader.read())
      expect(new TextDecoder().decode(first.value)).toContain("locked")

      const server = yield* ServerProcess.start<never, never>(options(file))
      expect(yield* Effect.promise(() => holder.exited)).toBe(0)

      const info = yield* Effect.promise(() =>
        fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), {
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }),
      )
      expect(info.status).toBe(200)
    }),
  30_000,
)

it.live("a database file that is not a database fails boot with its own error", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-server-corrupt-")
    const file = path.join(tmp.path, "opencode.db")
    yield* Effect.promise(() => Bun.write(file, "x".repeat(4096)))

    const exit = yield* ServerProcess.start<never, never>(options(file)).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(SqlError)
    expect((error as SqlError).reason._tag).toBe("UnknownError")
  }),
)
