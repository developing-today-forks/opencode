import { describe, expect, test } from "bun:test"
import { copyFile, mkdir } from "node:fs/promises"
import path from "path"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { KVTable } from "@opencode/core/kv/sql"
import { Global } from "@opencode/util/global"
import { tmpdir } from "./fixture/tmpdir"

// Slice 2 of #2492: a populated database file created through the stock
// SQLite backend opens as an isolated copy under the ambient engine and
// reads back every existing row — no recreate, no loss.
//
// Run this file twice through Fleet dispatch: stock (no env override) and
// OPENCODE_DB_ENGINE=turso. The creation phase always forces the stock
// backend; the verification phase follows the ambient engine, so the turso
// leg proves existing-file compatibility and the stock leg proves the
// fixture itself is faithful.

const ROWS = [
  { key: "slice2/alpha", value: { id: "alpha", status: "completed", output: "all green", nested: {} } },
  { key: "slice2/beta", value: { id: "beta", status: "running", output: "lorem ipsum ünïcodé ✓", nested: {} } },
  {
    key: "slice2/gamma",
    value: { id: "gamma", status: "failed", output: "", nested: { attempts: [1, 2, 3] } },
  },
]

const withDatabase = <A, E>(filename: string, body: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(Database.layer({ path: filename })),
      Effect.scoped,
      Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) })),
    ),
  )

describe("Database existing-file compatibility", () => {
  test("opens a populated stock copy and reads every row", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "source", "opencode.db")
    const isolated = path.join(tmp.path, "isolated", "opencode-copy.db")
    await mkdir(path.dirname(source), { recursive: true })
    await mkdir(path.dirname(isolated), { recursive: true })

    // Creation always runs on stock, regardless of the ambient engine.
    const saved = process.env.OPENCODE_DB_ENGINE
    delete process.env.OPENCODE_DB_ENGINE
    try {
      await withDatabase(
        source,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          for (const row of ROWS) yield* db.insert(KVTable).values({ key: row.key, value: row.value }).run()
          // Flush WAL content into the main file so the copy carries every row.
          yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        }),
      )
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_DB_ENGINE
      else process.env.OPENCODE_DB_ENGINE = saved
    }

    await copyFile(source, isolated)

    const rows = await withDatabase(
      isolated,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.select().from(KVTable).all()
      }),
    )

    const actual = rows.map(({ key, value }) => ({ key, value })).sort((a, b) => (a.key < b.key ? -1 : 1))
    expect(actual).toEqual(ROWS)
  })
})
