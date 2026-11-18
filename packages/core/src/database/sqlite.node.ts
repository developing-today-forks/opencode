<<<<<<< HEAD
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Context, Effect, Layer, Predicate } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { classifySqliteError, LockTimeoutError, SqlError } from "effect/sql/SqlError"
import { Sqlite } from "./sqlite.js"

const TypeId = "~@opencode/core/database/SqliteNode" as const
=======
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Layer, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
>>>>>>> upstream-anomalyco/dev

export const supportsTuningPragmas = true

// Foreign keys default ON in node:sqlite and can be toggled per connection.
export const supportsForeignKeyToggle = true

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal.
export const sqliteLayer = (config: SqliteClient.SqliteClientConfig): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(SqliteClient.layer(config))

// node:sqlite has no error class: SQLite failures are an Error marked ERR_SQLITE_ERROR that carries SQLite's extended
// result code in errcode.
const decodeDriverError = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.Literal("ERR_SQLITE_ERROR"), errcode: Schema.Number }),
)

<<<<<<< HEAD
    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, SqlClient.SafeIntegers))
        try {
          return Effect.succeed(statement.all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, SqlClient.SafeIntegers))
        statement.setReturnArrays(true)
        try {
          return Effect.succeed(
            statement.all(...(params as SQLInputValue[])) as unknown as ReadonlyArray<ReadonlyArray<unknown>>,
          )
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = Sqlite.makeConnection(run, runValues, {
      loadExtension: (path: string) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    return yield* Sqlite.makeClient(options, connection, TypeId, (acquirer) => ({
      loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
    }))
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new DatabaseSync(config.filename, {
        readOnly: config.readonly,
        timeout: config.timeout,
        allowExtension: config.allowExtension,
        enableForeignKeyConstraints: true,
        open: true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true && config.readonly !== true)
        yield* Effect.try({
          try: () => native.exec("PRAGMA journal_mode = WAL;"),
          catch: (cause) =>
            new SqlError({
              reason: nodeLocked(cause)
                ? new LockTimeoutError({ cause, message: "Failed to set WAL journal mode", operation: "execute" })
                : classifySqliteError(cause, { message: "Failed to set WAL journal mode", operation: "execute" }),
            }),
        }).pipe(Sqlite.retryBusy, Effect.orDie)
      return native
    }),
  )

// effect's classifier reads errno, but node:sqlite reports the SQLite result code (5 busy, 6 locked) as errcode, so a
// busy or locked node error would otherwise classify as unknown and never be retried.
const nodeLocked = (cause: unknown) =>
  Predicate.hasProperty(cause, "errcode") && (cause.errcode === 5 || cause.errcode === 6)

const clientLayer = (config: Config) => Layer.effect(SqlClient.SqlClient, make(config))

export const sqliteLayer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, clientLayer(config).pipe(Layer.provide(native))).pipe(Layer.provide(Reactivity.layer))
}
=======
export const resultCode = (cause: unknown) =>
  decodeDriverError(cause).pipe(
    Option.map((error) => error.errcode),
    Option.getOrUndefined,
  )
>>>>>>> upstream-anomalyco/dev
