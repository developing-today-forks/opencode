import { Database } from "@tursodatabase/database/compat"
import { Clock, Context, Effect, Layer, Schedule, Semaphore, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, Statement } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

// SQLite busy waits are in milliseconds; the database layer also sets a
// 5-second busy timeout after the backend connects.
const NANOS_PER_MILLI = BigInt(1_000_000)
const BUSY_TIMEOUT_MILLIS = 5_000

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
// loadExtension() are "not implemented" in the driver, so this backend exposes
// no export/loadExtension extensions — nothing in the repo calls them. MVCC
// stays off (driver default): it is a merit decision tracked on the issue, not
// a default to flip inside a backend.

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

interface Config {
  readonly filename: string
  readonly readonly?: boolean | undefined
  readonly create?: boolean | undefined
  readonly readwrite?: boolean | undefined
  readonly disableWAL?: boolean | undefined
}

const openError = (cause: unknown) =>
  new SqlError({ reason: classifySqliteError(cause, { message: "Failed to open database", operation: "connect" }) })

const configureError = (cause: unknown) =>
  new SqlError({
    reason: classifySqliteError(cause, { message: "Failed to configure database", operation: "connect" }),
  })

const executeError = (operation: "execute" | "executeValues") => (cause: unknown) =>
  new SqlError({ reason: classifySqliteError(cause, { message: "Failed to execute statement", operation }) })

const makeConnection = (options: Config) =>
  Effect.gen(function* () {
    const readonly = options.readonly === true
    const native = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new Database(options.filename, {
            readonly,
            // bun's `create: false` maps to fileMustExist; readwrite has no compat-API equivalent.
            fileMustExist: options.create === false ? true : undefined,
            // index_method gates the Tantivy FTS index messaging search uses on this
            // engine (issue #2492). Triggers, views and generated columns need no flag
            // in driver 0.8.3 (probed); MVCC is deliberately not enabled.
            experimental: ["index_method"],
          }),
        catch: openError,
      }),
      (database) => Effect.sync(() => database.close()),
    )

    const exec = (query: string) =>
      Effect.try({
        try: () => native.exec(query),
        catch: configureError,
      })
    yield* exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLIS};`)

    if (options.disableWAL !== true && !readonly) {
      // Switching to WAL can fail with SQLITE_BUSY without invoking the busy
      // handler, so retry it until the busy timeout has elapsed. Mirrors
      // @effect/sql-sqlite-bun's connection setup.
      const deadline = (yield* Clock.monotonicTimeNanos) + BigInt(BUSY_TIMEOUT_MILLIS) * NANOS_PER_MILLI
      const remainingMillis = Effect.map(Clock.monotonicTimeNanos, (now) =>
        Math.max(0, Number((deadline - now) / NANOS_PER_MILLI)),
      )
      yield* remainingMillis.pipe(
        Effect.flatMap((remaining) => exec(`PRAGMA busy_timeout = ${remaining}`)),
        Effect.andThen(exec("PRAGMA journal_mode = WAL;")),
        Effect.retry({
          while: (error) =>
            error.reason._tag === "LockTimeoutError" && Effect.map(remainingMillis, (remaining) => remaining > 0),
          schedule: Schedule.spaced("10 millis"),
        }),
      )
      yield* exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLIS}`)
    }

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        try {
          const statement = native.prepare(query)
          statement.safeIntegers(Context.get(fiber.context, SqlClient.SafeIntegers))
          return Effect.succeed(statement.all(...params) ?? [])
        } catch (cause) {
          return Effect.fail(executeError("execute")(cause))
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Array<unknown>>, SqlError>((fiber) => {
        try {
          const statement = native.prepare(query)
          statement.safeIntegers(Context.get(fiber.context, SqlClient.SafeIntegers))
          return Effect.succeed(statement.raw(true).all(...params) ?? [])
        } catch (cause) {
          return Effect.fail(executeError("executeValues")(cause))
        }
      })

    const connection: Connection = {
      execute: (query, params, transformRows) =>
        transformRows ? Effect.map(run(query, params), transformRows) : run(query, params),
      executeRaw: (query, params) => run(query, params),
      executeValues: (query, params) => runValues(query, params),
      executeValuesUnprepared: (query, params) => runValues(query, params),
      executeUnprepared: (query, params, transformRows) =>
        transformRows ? Effect.map(run(query, params), transformRows) : run(query, params),
      executeStream: () => Stream.die("executeStream not implemented"),
    }

    return {
      isTransaction: () => native.inTransaction,
      ...connection,
    }
  })

const make = (options: Config) =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite(undefined)
    const connection = yield* makeConnection(options)
    const { acquirer, borrower, isTransaction, onCommitFailure, transactionAcquirer } =
      SqlClient.makeSqliteAcquirers({
        connection: Effect.succeed(connection),
        semaphore: yield* Semaphore.make(1),
        isTransaction: (conn) => conn.isTransaction(),
      })

    return yield* SqlClient.make({
      driver: "sqlite-turso",
      acquirer,
      borrower,
      compiler,
      transactionAcquirer,
      onCommitFailure,
      isTransaction,
      beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
      spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
      transformRows: undefined,
    })
  })

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal.
export const sqliteLayer = (config: Config): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(
    Layer.effectContext(Effect.map(make(config), (client) => Context.make(SqlClient.SqlClient, client))),
  ).pipe(Layer.provide(Reactivity.layer))
