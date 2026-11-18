import { Database } from "@opencode/core/database/database"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"

const DAY_MS = 24 * 3_600_000

/** Ledger nulls are absent fields on the wire (the schema's optional fields). */
const attempt = (row: Effect.Success<ReturnType<typeof ModelRouteLog.filteredAttempts>>[number]) => ({
  ...row,
  sessionID: row.sessionID ?? undefined,
  variant: row.variant ?? undefined,
  errorTag: row.errorTag ?? undefined,
  errorCode: row.errorCode ?? undefined,
  errorStatus: row.errorStatus ?? undefined,
  errorMessage: row.errorMessage ?? undefined,
  retryable: row.retryable ?? undefined,
  hedged: row.hedged ?? undefined,
  firstTokenMs: row.firstTokenMs ?? undefined,
  responseMs: row.responseMs ?? undefined,
  tokensPerSecond: row.tokensPerSecond ?? undefined,
  tokensInput: row.tokensInput ?? undefined,
  tokensOutput: row.tokensOutput ?? undefined,
  tokensReasoning: row.tokensReasoning ?? undefined,
  tokensCacheRead: row.tokensCacheRead ?? undefined,
  tokensCacheWrite: row.tokensCacheWrite ?? undefined,
  costUsd: row.costUsd ?? undefined,
  cacheSavingsUsd: row.cacheSavingsUsd ?? undefined,
})

const decision = (row: Effect.Success<ReturnType<typeof ModelRouteLog.filteredDecisions>>[number]) => ({
  ...row,
  sessionID: row.sessionID ?? undefined,
  chosen: row.chosen ?? undefined,
  detail: row.detail ?? undefined,
})

export const RouteHandler = HttpApiBuilder.group(Api, "server.route", (handlers) =>
  handlers
    .handle(
      "route.override.list",
      Effect.fn(function* () {
        return { data: ModelRouteOverrides.current() }
      }),
    )
    .handle(
      "route.override.add",
      Effect.fn(function* (ctx) {
        // Core's parse is the canonical validator — the same one routing applies when it
        // reads the store. An entry it drops (no expiry and no schedule, no provider or
        // model named, a malformed scope list) is rejected here instead of being stored
        // where routing would silently ignore or widen it.
        const parsed = ModelRouteOverrides.parse({ overrides: [ctx.payload] })
        const item = parsed.find((entry) => entry.id === ctx.payload.id)
        if (!item)
          return yield* new InvalidRequestError({
            message: `Route override is malformed and was not stored: ${ctx.payload.id}`,
          })
        // The store's save() drops entries that are already expired, and parse() keeps a finite
        // `until` regardless of now — so accepting the POST would answer 200 with the entry
        // silently missing from the returned list.
        if (item.until !== undefined && item.until <= Date.now())
          return yield* new InvalidRequestError({
            message: `Route override is already expired and was not stored: ${ctx.payload.id}`,
          })
        ModelRouteOverrides.add(item)
        return { data: ModelRouteOverrides.current() }
      }),
    )
    .handle(
      "route.override.remove",
      Effect.fn(function* (ctx) {
        ModelRouteOverrides.remove(ctx.params.overrideID)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "route.attempt.list",
      Effect.fn(function* (ctx) {
        const db = (yield* Database.Service).db
        const rows = yield* ModelRouteLog.filteredAttempts(db, {
          since: ctx.query.since ?? Date.now() - DAY_MS,
          until: ctx.query.until,
          providerID: ctx.query.provider,
          modelID: ctx.query.model,
          sessionID: ctx.query.session,
          routeID: ctx.query.route,
          limit: ctx.query.limit,
        }).pipe(Effect.orDie)
        return { data: rows.map(attempt) }
      }),
    )
    .handle(
      "route.attempt.stats",
      Effect.fn(function* (ctx) {
        const db = (yield* Database.Service).db
        const since = ctx.query.since ?? Date.now() - DAY_MS
        const until = ctx.query.until
        const targets = yield* ModelRouteLog.targetTotals(db, since, until).pipe(Effect.orDie)
        const errors = yield* ModelRouteLog.errorBreakdown(db, since, until).pipe(Effect.orDie)
        const coverage = yield* ModelRouteLog.ledgerCoverage(db, since, until).pipe(Effect.orDie)
        return {
          data: {
            targets,
            errors,
            coverage: coverage ?? {
              attempts: 0,
              providers: 0,
              models: 0,
              sessions: 0,
              routes: 0,
              first: null,
              last: null,
            },
          },
        }
      }),
    )
    .handle(
      "route.decision.list",
      Effect.fn(function* (ctx) {
        const db = (yield* Database.Service).db
        const rows = yield* ModelRouteLog.filteredDecisions(db, {
          since: ctx.query.since ?? Date.now() - DAY_MS,
          until: ctx.query.until,
          routeID: ctx.query.route,
          limit: ctx.query.limit,
        }).pipe(Effect.orDie)
        return { data: rows.map(decision) }
      }),
    ),
)
