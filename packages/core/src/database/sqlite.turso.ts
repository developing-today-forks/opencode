import { Database } from "@tursodatabase/database/compat"
import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import { Sqlite } from "./sqlite.js"

const TypeId = "~@opencode/core/database/SqliteTurso" as const

// TursoDB (the Rust SQLite rewrite, issue #2492) behind the same seam as the
// bun/node/workerd backends. Selected at runtime with OPENCODE_DB_ENGINE=turso
// (see database.ts); the default backends are untouched. The driver is the
// synchronous better-sqlite3-shaped "compat" API of @tursodatabase/database,
// so run/runValues stay synchronous like bun:sqlite's. Probed against driver
// 0.8.3 under bun: WAL + every tuning pragma the database layer sets works,
// foreign keys toggle per connection, JSON functions and savepoints work.
//
// The compat driver prepares eagerly, so prepare() is inside the try in
// run/runValues: a parse error (e.g. the FTS5 DDL messaging issues on this
// engine before its Tantivy rewrite) must surface as a typed SqlError, never
// a defect — bun:sqlite prepares lazily inside its own try for the same reason.
//
// Known driver gaps (probed, issue #2492): serialize()/backup() and
// loadExtension() are "not implemented" in the driver, so the connection's
// export/loadExtension extensions fail loudly below — nothing in the repo
// calls them. MVCC stays off (driver default): it is a merit decision tracked
// on the issue, not a default to flip inside a backend.

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

interface Config extends Sqlite.ClientConfig {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
}

const unsupported = (operation: string, message: string) =>
  Effect.fail(
    new SqlError({
      reason: classifySqliteError(new Error(message), { message, operation }),
    }),
  )

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        try {
          const statement = native.prepare(query)
          statement.safeIntegers(Context.get(fiber.context, SqlClient.SafeIntegers))
          return Effect.succeed(statement.all(...(params as Array<unknown>)) ?? [])
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        try {
          const statement = native.prepare(query)
          statement.safeIntegers(Context.get(fiber.context, SqlClient.SafeIntegers))
          return Effect.succeed(statement.raw(true).all(...(params as Array<unknown>)) ?? [])
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = Sqlite.makeConnection(run, runValues, {
      export: unsupported(
        "export",
        "TursoDB backend: database export is not implemented by @tursodatabase/database (serialize/backup throw 'not implemented')",
      ),
      loadExtension: (_path: string) =>
        unsupported(
          "loadExtension",
          "TursoDB backend: loadExtension is not implemented by @tursodatabase/database",
        ),
    })

    return yield* Sqlite.makeClient(options, connection, TypeId, (acquirer) => ({
      export: Effect.flatMap(acquirer, (_) => _.export),
      loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
    }))
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        // bun's `create: false` maps to fileMustExist; readwrite has no compat-API equivalent.
        fileMustExist: config.create === false ? true : undefined,
        // index_method gates the Tantivy FTS index messaging search uses on this
        // engine (issue #2492). Triggers, views and generated columns need no flag
        // in driver 0.8.3 (probed); MVCC is deliberately not enabled.
        experimental: ["index_method"],
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true)
        yield* Effect.try({
          try: () => native.exec("PRAGMA journal_mode = WAL;"),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to set WAL journal mode", operation: "execute" }),
            }),
        }).pipe(Sqlite.retryBusy, Effect.orDie)
      return native
    }),
  )

const clientLayer = (config: Config) => Layer.effect(SqlClient.SqlClient, make(config))

export const sqliteLayer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, clientLayer(config).pipe(Layer.provide(native))).pipe(Layer.provide(Reactivity.layer))
}
