export * as ModelRouteLog from "./model-route-log.js"

import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm" 
import { Effect, Layer, Queue } from "effect"
import { AIError, isRetryable, type HttpContext } from "@opencode/ai"
import { RequestExecutor, type StreamOptions } from "@opencode/ai/route"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { snapshot as takeSnapshot, type Snapshot } from "./model-route-limits.js"
import { Database } from "./database/database.js"
import { RouteAttemptTable, RouteDecisionTable, RouteHealthTable, RouteNoteTable } from "./model-route-log/sql.js"

export type Decision = typeof RouteDecisionTable.$inferInsert
export type Attempt = typeof RouteAttemptTable.$inferInsert
export type Health = typeof RouteHealthTable.$inferInsert
export type Note = typeof RouteNoteTable.$inferInsert

export type Event =
  | { readonly kind: "decision"; readonly row: Decision }
  | {
      readonly kind: "attempt"
      readonly row: Attempt
      /** The assistant message of the attempt this request continues. The writer resolves it to that attempt's row id
       * when it persists the row, because the id only exists after the root was inserted. */
      readonly continuationOfMessageID?: string
    }
  | { readonly kind: "health"; readonly row: Health }
  | { readonly kind: "note"; readonly row: Note }

type Sink = (event: Event) => void

// Routing runs on the hot path of every turn. Call sites only hand over a plain row; persistence is
// asynchronous, batched and never able to fail a request. Without an installed sink events are dropped.
let sink: Sink | undefined

export const record = (event: Event) => {
  try {
    sink?.(event)
  } catch {
    // Telemetry must never affect routing.
  }
}

/** Installs the writer and returns the function that removes it again. Test seam and node wiring. */
export const setSink = (next: Sink | undefined) => {
  sink = next
}

/** Flattens an `AIError.reason` into the exact tag, code, status, message and body, plus any
 * rate-limit detail the provider reported. */
/** Observe one request to a target: read what its response says about rate limits as soon as the
 * provider answers, and produce the attempt row when it ends. Shared by the runner step and the
 * background calls (title generation, generate, compaction), so no request is invisible. */
export interface RequestObservation {
  readonly routeID: string
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  /** The credential that served this request, when the call site knows it authoritatively (the
   * serving credential captured at resolution, never a pre-load snapshot of the active one).
   * Omitted when an env connection served or the site cannot know: the attempt is then recorded
   * unattributed and its usage feeds no credential's quota snapshot (#1106). */
  readonly credentialID?: string
  readonly sessionID?: string
  readonly assistantMessageID?: string
  readonly startedAt: number
  readonly inputTokens?: number
  /** True for both legs of a hedged attempt. */
  readonly hedged?: boolean
  /** Keeps the provider's error body for this request, overriding the `captureErrorBodies` setting. */
  readonly captureBody?: boolean
}

export type RateLimitSnapshot = {
  readonly at: number
  readonly limit?: Record<string, string>
  readonly remaining?: Record<string, string>
  readonly reset?: Record<string, string>
  readonly retryAfterMs?: number
}

export const observer = (
  request: RequestObservation,
  onRateLimit: (snapshot: RateLimitSnapshot) => void = () => {},
) => {
  const seen = observeRateLimits(onRateLimit)
  return {
    get snapshot() {
      return seen.snapshot
    },
    options: (base: StreamOptions): StreamOptions => ({
      ...base,
      onResponse: (http: HttpContext) => {
        base.onResponse?.(http)
        seen.options({}).onResponse?.(http)
      },
    }),
    /** Records the attempt. `failure` is the reason the request failed, if it did. */
    done: (
      outcome: "success" | "failure" | "timeout" | "interrupted" | "hedged-out",
      result: {
        readonly failure?: unknown
        readonly outputStarted: boolean
        readonly firstOutputAt?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly tokensEstimated?: boolean
      },
    ) => {
      const at = Date.now()
      const fields: Partial<ReturnType<typeof failureFields>> = result.failure
        ? failureFields(reasonOf(result.failure), { captureBody: request.captureBody })
        : {}
      const tokens = result.tokens
      record({
        kind: "attempt",
        row: {
          time_started: request.startedAt,
          time_ended: at,
          session_id: request.sessionID,
          assistant_message_id: request.assistantMessageID,
          route_id: request.routeID,
          provider_id: request.providerID,
          model_id: request.modelID,
          variant: request.variant,
          credential_id: request.credentialID,
          outcome,
          ...fields,
          // A failed request's own details win; a successful one keeps what its response said.
          quota: fields.quota ?? (seen.snapshot && { ...seen.snapshot }),
          retryable: result.failure ? observerRetryable(result.failure) : undefined,
          output_started: result.outputStarted,
          hedged: request.hedged,
          first_token_ms: result.firstOutputAt === undefined ? undefined : result.firstOutputAt - request.startedAt,
          response_ms: at - request.startedAt,
          tokens_per_second:
            tokens && result.firstOutputAt !== undefined
              ? ((tokens.output + tokens.reasoning) * 1_000) / Math.max(1, at - result.firstOutputAt)
              : undefined,
          tokens_input: tokens ? tokens.input : request.inputTokens,
          tokens_estimated: result.tokensEstimated ?? (tokens === undefined && request.inputTokens !== undefined),
          tokens_output: tokens?.output,
          tokens_reasoning: tokens?.reasoning,
          tokens_cache_read: tokens?.cache.read,
          tokens_cache_write: tokens?.cache.write,
        },
      })
    },
  }
}

/** Reads a response's rate-limit headers as it arrives, with a place to see the latest snapshot.
 * Used directly by the background calls; the runner step uses `observer`. */
export const observeRateLimits = (onRateLimit: (snapshot: RateLimitSnapshot) => void = () => {}) => {
  let snapshot: RateLimitSnapshot | undefined
  return {
    get snapshot() {
      return snapshot
    },
    options: (base: StreamOptions): StreamOptions => ({
      ...base,
      onResponse: (http: HttpContext) => {
        base.onResponse?.(http)
        const value = rateLimitSnapshot(RequestExecutor.responseRateLimit(http.headers), Date.now())
        if (!value) return
        snapshot = value
        onRateLimit(value)
      },
      // A rejection's own headers are worth as much as a success's: a mid-stream 429 should move
      // traffic just like a slow success does.
      onRejected: (error: AIError) => {
        base.onRejected?.(error)
        const reason = (error as { reason?: { rateLimit?: RateLimitSnapshot } }).reason
        const value = rateLimitSnapshot(reason?.rateLimit, Date.now())
        if (!value) return
        snapshot = value
        onRateLimit(value)
      },
    }),
  }
}

const rateLimitSnapshot = (
  details:
    | {
        readonly limit?: Record<string, string>
        readonly remaining?: Record<string, string>
        readonly reset?: Record<string, string>
        readonly retryAfterMs?: number
      }
    | undefined,
  at: number,
): RateLimitSnapshot | undefined => {
  if (!details) return undefined
  const present = (value: Record<string, string> | undefined) =>
    value && Object.keys(value).length > 0 ? value : undefined
  const limit = present(details.limit)
  const remaining = present(details.remaining)
  const reset = present(details.reset)
  if (!limit && !remaining && !reset && details.retryAfterMs === undefined) return undefined
  return {
    at,
    ...(limit ? { limit } : {}),
    ...(remaining ? { remaining } : {}),
    ...(reset ? { reset } : {}),
    ...(details.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
  }
}

/** A failure arrives as an `AIError` or as its `reason`; the reason is what carries the details. */
const reasonOf = (failure: unknown) => {
  const value = (failure ?? {}) as { reason?: unknown }
  return value.reason ?? failure
}

/** The observer's retryable column follows the same canonical classifier the session runner uses
 * (`@opencode/ai` isRetryable, re-exported as SessionRunnerRetry.isRetryable), so the two columns
 * cannot disagree. A failure that is not an `AIError` carries no provider classification, so it is
 * stored as not retryable instead of being guessed from the presence of a tag. */
const observerRetryable = (failure: unknown) => (failure instanceof AIError ? isRetryable(failure) : false)

/** Whether failed requests keep their provider error body: `experimental.model_route_log`, read live. */
let captureErrorBodies: () => boolean = () => false

export const onCaptureErrorBodies = (read: () => boolean) => {
  captureErrorBodies = read
}

/** Scrubs what looks like a credential from a provider error body before it is stored: bearer and
 * basic auth, key-like fields, `sk-`-style keys, and the published GitHub, AWS, Slack, Google and
 * JWT token formats, plus passwords in URL userinfo. A heuristic, which is why keeping bodies is opt-in. */
const redactBody = (body: string) =>
  body
    .replace(/\bbearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .replace(/\bbasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|authorization|access[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1[REDACTED]@")

export const failureFields = (reason: unknown, options?: { readonly captureBody?: boolean }) => {
  const value = (reason ?? {}) as Record<string, unknown>
  const http = value.http as { status?: unknown; headers?: unknown } | undefined
  const rateLimit = value.rateLimit as Record<string, unknown> | undefined
  const headers = http?.headers as Record<string, unknown> | undefined
  const quotaHeaders = headers
    ? Object.fromEntries(
        Object.entries(headers).filter(([name]) => /^(?:x-)?ratelimit-|^retry-after(?:-|$)/i.test(name)),
      )
    : undefined
  const retryAfterMs = typeof value.retryAfterMs === "number" ? value.retryAfterMs : undefined
  const quota =
    rateLimit || retryAfterMs !== undefined || Object.keys(quotaHeaders ?? {}).length > 0
      ? {
          ...rateLimit,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(quotaHeaders ? { headers: quotaHeaders } : {}),
        }
      : undefined
  return {
    error_tag: typeof value._tag === "string" ? value._tag : undefined,
    error_code: typeof value.code === "string" ? value.code : undefined,
    error_status: typeof http?.status === "number" ? http.status : undefined,
    error_message: typeof value.message === "string" ? value.message : undefined,
    // Kept only when configured: a provider body can echo the request, so it is opt-in and redacted.
    error_body:
      (options?.captureBody ?? captureErrorBodies()) && typeof value.body === "string"
        ? redactBody(value.body).slice(0, 2_000)
        : undefined,
    quota,
  }
}

const persist = (db: Database.Interface["db"], events: readonly Event[]) =>
  Effect.gen(function* () {
    const decisions = events.flatMap((event) => (event.kind === "decision" ? [event.row] : []))
    const attempts = events.flatMap((event) => (event.kind === "attempt" ? [event] : []))
    const health = events.flatMap((event) => (event.kind === "health" ? [event.row] : []))
    if (decisions.length) yield* db.insert(RouteDecisionTable).values(decisions).run()
    // One statement per attempt: a continuation resolves its root from the row inserted just before it.
    for (const attempt of attempts) yield* persistAttempt(db, attempt)
    if (health.length) yield* db.insert(RouteHealthTable).values(health).run()
    const notes = events.flatMap((event) => (event.kind === "note" ? [event.row] : []))
    if (notes.length) yield* db.insert(RouteNoteTable).values(notes).run()
  })

/** Inserts one attempt and, for a continuation, points `continuation_of` at the attempt that started the response.
 * The root is read back by its assistant message, so the link survives the root having been persisted in an earlier
 * batch and stays correct across a restart. Retries and hedge losers share that message, so the newest standalone row
 * is the attempt that actually answered — the one whose response hit the output token limit. */
const persistAttempt = (db: Database.Interface["db"], event: Extract<Event, { kind: "attempt" }>) =>
  Effect.gen(function* () {
    const inserted = yield* db
      .insert(RouteAttemptTable)
      .values(event.row)
      .returning({ id: RouteAttemptTable.id })
      .get()
    if (event.continuationOfMessageID === undefined) return
    yield* db
      .update(RouteAttemptTable)
      .set({
        continuation_of: sql`(select root.id from route_attempt root where root.session_id = ${event.row.session_id} and root.assistant_message_id = ${event.continuationOfMessageID} and root.continuation_index = 0 order by root.id desc limit 1)`,
      })
      .where(eq(RouteAttemptTable.id, inserted.id))
      .run()
  })

/** Receives the still-active adjustments stored by earlier runs. Set by the routing module, which
 * this one cannot import without a cycle. */
let restore: ((notes: readonly Record<string, unknown>[]) => void) | undefined

export const onRestore = (next: typeof restore) => {
  restore = next
}

type UsageRow = { time: number; providerID: string; modelID: string; tokens: number }
let restoreUsage: ((rows: readonly UsageRow[]) => void) | undefined

export const onRestoreUsage = (next: typeof restoreUsage) => {
  restoreUsage = next
}

type CooldownRow = { providerID: string; modelID: string; until: number; credentialID?: string }
let restoreCooldowns: ((rows: readonly CooldownRow[]) => void) | undefined

export const onRestoreCooldowns = (next: typeof restoreCooldowns) => {
  restoreCooldowns = next
}

let restoreLimits: ((rows: readonly CooldownRow[]) => void) | undefined

export const onRestoreLimits = (next: typeof restoreLimits) => {
  restoreLimits = next
}

/** Cooldowns still in force, rebuilt from the health history so a restart does not send traffic
 * straight back to a target that was just failing. */
export const restoreCooldownsFrom = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const now = Date.now()
    const rows = yield* db
      .select()
      .from(RouteHealthTable)
      .where(
        and(
          gte(RouteHealthTable.time, now - 86_400_000),
          or(
            eq(RouteHealthTable.kind, "cooldown-start"),
            eq(RouteHealthTable.kind, "cooldown-end"),
            eq(RouteHealthTable.kind, "rate-limit-window"),
          ),
        ),
      )
      .orderBy(asc(RouteHealthTable.time), asc(RouteHealthTable.id))
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    const latest = new Map<string, CooldownRow>()
    const windows = new Map<string, CooldownRow & { snapshot?: Snapshot }>()
    for (const row of rows) {
      // A credential-scoped health row carries its credential in `credential_id`: it restores
      // onto that credential only, never onto the whole target (#870). Rows written before the
      // column existed name it in the reason ("... credential:<id>"), so those still fall back
      // to the reason regex. A `provider:<id>` reason is a different dimension (provider quota)
      // and never a credential.
      const credentialID = row.credential_id ?? /credential:(\S+)/.exec(row.reason ?? "")?.[1]
      const id = credentialID ? `${row.provider_id}/${row.model_id}#${credentialID}` : `${row.provider_id}/${row.model_id}`
      const entry = {
        providerID: row.provider_id,
        modelID: row.model_id,
        until: row.until ?? 0,
        ...(credentialID ? { credentialID } : {}),
      }
      if (row.kind === "rate-limit-window") windows.set(id, entry)
      else if (row.kind === "cooldown-end") latest.delete(id)
      else if (row.until !== null) latest.set(id, entry)
    }
    // Cold targets get the provider's last word back too: the newest stored attempt snapshot.
    const snapshots = yield* db
      .select({
        providerID: RouteAttemptTable.provider_id,
        modelID: RouteAttemptTable.model_id,
        quota: RouteAttemptTable.quota,
        time: RouteAttemptTable.time_ended,
      })
      .from(RouteAttemptTable)
      .where(
        and(
          gte(RouteAttemptTable.time_ended, now - 86_400_000),
          sql`${RouteAttemptTable.quota} is not null`,
        ),
      )
      .orderBy(asc(RouteAttemptTable.time_ended))
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    for (const row of snapshots) {
      const id = `${row.providerID}/${row.modelID}`
      const stored = (row.quota ?? {}) as Partial<Snapshot>
      const parsed =
        typeof stored !== "object" || stored === null
          ? undefined
          : takeSnapshot(
              {
                limit: stored.limit,
                remaining: stored.remaining,
                reset: stored.reset,
                retryAfterMs: stored.retryAfterMs,
              },
              row.time,
            )
      const current = windows.get(id)
      if (!parsed) continue
      if (current) windows.set(id, { ...current, snapshot: parsed })
      else windows.set(id, { providerID: row.providerID, modelID: row.modelID, until: 0, snapshot: parsed })
    }
    restoreCooldowns?.([...latest.values()].filter((row) => row.until > now))
    restoreLimits?.(
      [...windows.values()].filter((row) => row.until > now || row.snapshot !== undefined),
    )
  })

/** Usage of the last day, so budgets survive a restart. */
export const restoreUsageFrom = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({
        time: RouteAttemptTable.time_ended,
        providerID: RouteAttemptTable.provider_id,
        modelID: RouteAttemptTable.model_id,
        input: RouteAttemptTable.tokens_input,
        output: RouteAttemptTable.tokens_output,
        reasoning: RouteAttemptTable.tokens_reasoning,
      })
      .from(RouteAttemptTable)
      // A request that never went out is not counted live, so it is not restored either.
      .where(
        and(
          gte(RouteAttemptTable.time_ended, Date.now() - 86_400_000),
          ne(RouteAttemptTable.outcome, "resolution-failure"),
        ),
      )
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    restoreUsage?.(
      rows.map((row) => ({
        time: row.time,
        providerID: row.providerID,
        modelID: row.modelID,
        tokens: (row.input ?? 0) + (row.output ?? 0) + (row.reasoning ?? 0),
      })),
    )
  })

/** Hands still-active stored notes to the routing module. Runs when the node starts. */
export const restoreNotes = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const stored = yield* db
      .select()
      .from(RouteNoteTable)
      .where(or(isNull(RouteNoteTable.expires), gt(RouteNoteTable.expires, Date.now())))
      .orderBy(asc(RouteNoteTable.time))
      .all()
      .pipe(Effect.orElseSucceed(() => []))
    restore?.(stored.flatMap((row) => (row.interpreted ? [row.interpreted] : [])))
  })

let activeDb: Database.Interface["db"] | undefined

/** Runs a read against the routing database, or yields nothing when no database is attached. */
export const withDb = <A, E>(use: (db: Database.Interface["db"]) => Effect.Effect<A, E>) =>
  activeDb ? Effect.asSome(use(activeDb)) : Effect.succeedNone

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    activeDb = db
    yield* Effect.addFinalizer(() => Effect.sync(() => void (activeDb = undefined)))
    yield* restoreNotes(db)
    yield* restoreUsageFrom(db)
    yield* restoreCooldownsFrom(db)
    const queue = yield* Queue.unbounded<Event>()
    setSink((event) => void Queue.offerUnsafe(queue, event))
    yield* Effect.addFinalizer(() => Effect.sync(() => setSink(undefined)))
    yield* Queue.takeAll(queue).pipe(
      Effect.flatMap((events) =>
        persist(db, events).pipe(
          Effect.catchCause((cause) => Effect.logWarning("failed to persist model route telemetry", { cause })),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
  }),
)

/** Global so every location shares one writer; the resolver depends on it so it starts with routing. */
export const node = makeGlobalNode({ name: "model-route-log", layer, deps: [Database.node] })

export interface TargetStats {
  readonly providerID: string
  readonly modelID: string
  readonly attempts: number
  readonly failures: number
  readonly timeouts: number
  readonly avgFirstTokenMs: number | null
  readonly avgResponseMs: number | null
  readonly avgTokensPerSecond: number | null
}

/** Per-target reliability and latency since `since` (ms epoch): the view a tuning agent reads. */
export const targetStats = (db: Database.Interface["db"], since: number, routeID?: string) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      attempts: count(),
      failures: sql<number>`sum(case when ${RouteAttemptTable.outcome} in ('failure','timeout') then 1 else 0 end)`,
      timeouts: sql<number>`sum(case when ${RouteAttemptTable.outcome} = 'timeout' then 1 else 0 end)`,
      avgFirstTokenMs: sql<number | null>`avg(${RouteAttemptTable.first_token_ms})`,
      avgResponseMs: sql<number | null>`avg(${RouteAttemptTable.response_ms})`,
      avgTokensPerSecond: sql<number | null>`avg(${RouteAttemptTable.tokens_per_second})`,
    })
    .from(RouteAttemptTable)
    .where(
      and(gte(RouteAttemptTable.time_started, since), routeID ? eq(RouteAttemptTable.route_id, routeID) : undefined),
    )
    .groupBy(RouteAttemptTable.provider_id, RouteAttemptTable.model_id)
    .all()

export interface HedgeAccuracy {
  readonly providerID: string
  readonly modelID: string
  /** Attempts where this target was one leg of a hedged pair. */
  readonly hedges: number
  /** Times it was the leg that answered. */
  readonly wins: number
}

/**
 * How often each target won the race when it was hedged against another, from the pairs of
 * `hedged` rows that share an assistant message: one `hedged-out` loser and one `success` winner.
 * This is the record of what hedging predicted against how it turned out.
 */
export const hedgeAccuracy = (db: Database.Interface["db"], since: number, routeID?: string) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      hedges: count(),
      wins: sql<number>`sum(case when ${RouteAttemptTable.outcome} = 'success' then 1 else 0 end)`,
    })
    .from(RouteAttemptTable)
    .where(
      and(
        gte(RouteAttemptTable.time_started, since),
        sql`${RouteAttemptTable.hedged} is true`,
        sql`${RouteAttemptTable.assistant_message_id} is not null`,
        sql`exists (select 1 from route_attempt rival where rival.assistant_message_id = ${RouteAttemptTable.assistant_message_id} and rival.hedged is true and (rival.provider_id != ${RouteAttemptTable.provider_id} or rival.model_id != ${RouteAttemptTable.model_id}))`,
        routeID ? eq(RouteAttemptTable.route_id, routeID) : undefined,
      ),
    )
    .groupBy(RouteAttemptTable.provider_id, RouteAttemptTable.model_id)
    .all()

export interface HourlyStat {
  readonly providerID: string
  readonly modelID: string
  readonly hour: number
  readonly attempts: number
  readonly failures: number
}

/** Failure counts by hour of day, so a target that only fails at certain times can be told apart
 * from one that fails all the time. */
export const hourlyStats = (db: Database.Interface["db"], since: number) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      hour: sql<number>`cast(strftime('%H', ${RouteAttemptTable.time_started} / 1000, 'unixepoch') as integer)`,
      attempts: count(),
      failures: sql<number>`sum(case when ${RouteAttemptTable.outcome} in ('failure','timeout') then 1 else 0 end)`,
    })
    .from(RouteAttemptTable)
    .where(gte(RouteAttemptTable.time_started, since))
    .groupBy(
      RouteAttemptTable.provider_id,
      RouteAttemptTable.model_id,
      sql`cast(strftime('%H', ${RouteAttemptTable.time_started} / 1000, 'unixepoch') as integer)`,
    )
    .all()

/** Most recent failures with their exact code and message, newest first. */
export const recentFailures = (db: Database.Interface["db"], since: number, limit = 100) =>
  db
    .select()
    .from(RouteAttemptTable)
    .where(and(gte(RouteAttemptTable.time_started, since), sql`${RouteAttemptTable.outcome} != 'success'`))
    .orderBy(desc(RouteAttemptTable.time_started))
    .limit(limit)
    .all()

export interface ErrorBreakdown {
  readonly providerID: string
  readonly modelID: string
  readonly tag: string | null
  readonly code: string | null
  readonly status: number | null
  readonly count: number
  readonly lastTime: number
  readonly lastMessage: string | null
}

/** Failures grouped by exact tag, code and HTTP status, with the latest message of each group. */
export const errorBreakdown = (db: Database.Interface["db"], since: number) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      tag: RouteAttemptTable.error_tag,
      code: RouteAttemptTable.error_code,
      status: RouteAttemptTable.error_status,
      count: count(),
      lastTime: sql<number>`max(${RouteAttemptTable.time_started})`,
      lastMessage: sql<
        string | null
      >`(select e.error_message from route_attempt e where e.provider_id = ${RouteAttemptTable.provider_id} and e.model_id = ${RouteAttemptTable.model_id} and e.error_tag is ${RouteAttemptTable.error_tag} and e.error_code is ${RouteAttemptTable.error_code} and e.error_status is ${RouteAttemptTable.error_status} order by e.time_started desc limit 1)`,
    })
    .from(RouteAttemptTable)
    .where(and(gte(RouteAttemptTable.time_started, since), sql`${RouteAttemptTable.outcome} != 'success'`))
    .groupBy(
      RouteAttemptTable.provider_id,
      RouteAttemptTable.model_id,
      RouteAttemptTable.error_tag,
      RouteAttemptTable.error_code,
      RouteAttemptTable.error_status,
    )
    .orderBy(desc(count()))
    .all()

/** Most rows a per-pool read takes. The newest rows are the ones a review needs, so older ones are dropped. */
const ROW_LIMIT = 20_000

/** Request attempts in the window, newest first, with what the per-pool view needs. */
export const attemptRows = (db: Database.Interface["db"], since: number, routeID?: string) =>
  db
    .select({
      routeID: RouteAttemptTable.route_id,
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      sessionID: RouteAttemptTable.session_id,
      outcome: RouteAttemptTable.outcome,
      errorTag: RouteAttemptTable.error_tag,
      firstTokenMs: RouteAttemptTable.first_token_ms,
      tokensPerSecond: RouteAttemptTable.tokens_per_second,
      tokensInput: RouteAttemptTable.tokens_input,
    })
    .from(RouteAttemptTable)
    .where(
      and(gte(RouteAttemptTable.time_started, since), routeID ? eq(RouteAttemptTable.route_id, routeID) : undefined),
    )
    .orderBy(desc(RouteAttemptTable.time_started))
    .limit(ROW_LIMIT)
    .all()

/** Attempt rows in the window with their continuation link, so a response split by output-token-limit
 * continuations can be rolled up as one turn. Newest first; `ModelUsage.turns` does the arithmetic. */
export const turnAttempts = (db: Database.Interface["db"], since: number, sessionID?: string) =>
  db
    .select({
      id: RouteAttemptTable.id,
      continuationOf: RouteAttemptTable.continuation_of,
      continuationIndex: RouteAttemptTable.continuation_index,
      assistantMessageID: RouteAttemptTable.assistant_message_id,
      sessionID: RouteAttemptTable.session_id,
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      timeStarted: RouteAttemptTable.time_started,
      timeEnded: RouteAttemptTable.time_ended,
      outcome: RouteAttemptTable.outcome,
      input: RouteAttemptTable.tokens_input,
      output: RouteAttemptTable.tokens_output,
      reasoning: RouteAttemptTable.tokens_reasoning,
      cacheRead: RouteAttemptTable.tokens_cache_read,
      cacheWrite: RouteAttemptTable.tokens_cache_write,
      costUsd: RouteAttemptTable.cost_usd,
      cacheSavedUsd: RouteAttemptTable.cache_savings_usd,
    })
    .from(RouteAttemptTable)
    .where(
      and(
        gte(RouteAttemptTable.time_started, since),
        sessionID === undefined ? undefined : eq(RouteAttemptTable.session_id, sessionID),
      ),
    )
    .orderBy(desc(RouteAttemptTable.time_started))
    .limit(ROW_LIMIT)
    .all()

/** Selections in the window, newest first: who was eligible, the weights and exclusions behind each, and who was chosen. */
export const decisionRows = (db: Database.Interface["db"], since: number, routeID?: string) =>
  db
    .select({
      routeID: RouteDecisionTable.route_id,
      sessionID: RouteDecisionTable.session_id,
      candidates: RouteDecisionTable.candidates,
      chosen: RouteDecisionTable.chosen,
      reason: RouteDecisionTable.reason,
      detail: RouteDecisionTable.detail,
    })
    .from(RouteDecisionTable)
    .where(and(gte(RouteDecisionTable.time, since), routeID ? eq(RouteDecisionTable.route_id, routeID) : undefined))
    .orderBy(desc(RouteDecisionTable.time))
    .limit(ROW_LIMIT)
    .all()

/** The usage columns every rollup below shares: request and failure counts, tokens by kind, and cost. */
const usageColumns = {
  requests: count(),
  failures: sql<number>`coalesce(sum(case when ${RouteAttemptTable.outcome} in ('failure','timeout') then 1 else 0 end), 0)`,
  input: sql<number>`coalesce(sum(${RouteAttemptTable.tokens_input}), 0)`,
  output: sql<number>`coalesce(sum(${RouteAttemptTable.tokens_output}), 0)`,
  reasoning: sql<number>`coalesce(sum(${RouteAttemptTable.tokens_reasoning}), 0)`,
  cacheRead: sql<number>`coalesce(sum(${RouteAttemptTable.tokens_cache_read}), 0)`,
  cacheWrite: sql<number>`coalesce(sum(${RouteAttemptTable.tokens_cache_write}), 0)`,
  costUsd: sql<number>`coalesce(sum(${RouteAttemptTable.cost_usd}), 0)`,
  cacheSavedUsd: sql<number>`coalesce(sum(${RouteAttemptTable.cache_savings_usd}), 0)`,
}

/** Totals per session that made a request since `since`, most recently active first. */
export const sessionUsage = (db: Database.Interface["db"], since: number, limit: number, sessionID?: string) =>
  db
    .select({
      sessionID: RouteAttemptTable.session_id,
      first: sql<number>`min(${RouteAttemptTable.time_started})`,
      last: sql<number>`max(${RouteAttemptTable.time_ended})`,
      ...usageColumns,
    })
    .from(RouteAttemptTable)
    .where(
      and(
        gte(RouteAttemptTable.time_started, since),
        isNotNull(RouteAttemptTable.session_id),
        sessionID === undefined ? undefined : eq(RouteAttemptTable.session_id, sessionID),
      ),
    )
    .groupBy(RouteAttemptTable.session_id)
    .orderBy(desc(sql`max(${RouteAttemptTable.time_ended})`))
    .limit(limit)
    .all()

/** Totals per session, pool and target, for the sessions named, counting only attempts started at or after `since`. */
export const sessionTargetUsage = (db: Database.Interface["db"], since: number, sessionIDs: readonly string[]) =>
  sessionIDs.length === 0
    ? Effect.succeed([])
    : db
        .select({
          sessionID: RouteAttemptTable.session_id,
          routeID: RouteAttemptTable.route_id,
          providerID: RouteAttemptTable.provider_id,
          modelID: RouteAttemptTable.model_id,
          ...usageColumns,
        })
        .from(RouteAttemptTable)
        .where(
          and(gte(RouteAttemptTable.time_started, since), inArray(RouteAttemptTable.session_id, [...sessionIDs])),
        )
        .groupBy(
          RouteAttemptTable.session_id,
          RouteAttemptTable.route_id,
          RouteAttemptTable.provider_id,
          RouteAttemptTable.model_id,
        )
        .all()

/** Totals per provider, model and serving credential since `since`, with how many sessions used
 * each. `credentialID` is null for unattributed attempts (env-served, or recorded before the
 * column existed): consumers summing per-credential usage must exclude those rows, never assign
 * them to a credential (#1106). */
export const targetUsage = (db: Database.Interface["db"], since: number) =>
  db
    .select({
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      credentialID: RouteAttemptTable.credential_id,
      sessions: sql<number>`count(distinct ${RouteAttemptTable.session_id})`,
      first: sql<number>`min(${RouteAttemptTable.time_started})`,
      last: sql<number>`max(${RouteAttemptTable.time_ended})`,
      ...usageColumns,
    })
    .from(RouteAttemptTable)
    .where(gte(RouteAttemptTable.time_started, since))
    .groupBy(RouteAttemptTable.provider_id, RouteAttemptTable.model_id, RouteAttemptTable.credential_id)
    .all()

const DAY = sql`strftime('%Y-%m-%d', ${RouteAttemptTable.time_started} / 1000, 'unixepoch')`

/** Totals per UTC day, provider and model since `since`, oldest day first. */
export const dailyUsage = (db: Database.Interface["db"], since: number) =>
  db
    .select({
      day: sql<string>`${DAY}`,
      providerID: RouteAttemptTable.provider_id,
      modelID: RouteAttemptTable.model_id,
      ...usageColumns,
    })
    .from(RouteAttemptTable)
    .where(gte(RouteAttemptTable.time_started, since))
    .groupBy(DAY, RouteAttemptTable.provider_id, RouteAttemptTable.model_id)
    .orderBy(asc(DAY))
    .all()

/** How often each route offered each target in its selections since `since`, and how often it chose it. The
 * candidates of every selection are read from its JSON list, so a target that was never chosen still shows. */
export const offerUsage = (db: Database.Interface["db"], since: number, routeID?: string) =>
  db.all(
    sql`select d.route_id as "routeID", j.value as "target", count(*) as "offered", sum(case when d.chosen = j.value then 1 else 0 end) as "chosen" from route_decision as d, json_each(d.candidates) as j where d.time >= ${since}${
      routeID === undefined ? sql`` : sql` and d.route_id = ${routeID}`
    } group by d.route_id, j.value`,
  )
