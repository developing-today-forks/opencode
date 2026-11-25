export * as RouteAttempt from "./route-attempt.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

/** One route_attempt ledger row as the read API serves it (#2497). Deliberately narrower than the
 * stored row: no credential_id, no provider error body, no quota snapshot — the surface exposes
 * attempts and aggregates, never credentials and never prompt/response content (the ledger
 * stores none). Nulls from the ledger are served as absent fields. */
export const Attempt = Schema.Struct({
  id: Schema.Number,
  timeStarted: Schema.Number,
  timeEnded: Schema.Number,
  sessionID: optional(Schema.String),
  routeID: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  variant: optional(Schema.String),
  outcome: Schema.String,
  errorTag: optional(Schema.String),
  errorCode: optional(Schema.String),
  errorStatus: optional(Schema.Number),
  errorMessage: optional(Schema.String),
  retryable: optional(Schema.Boolean),
  outputStarted: Schema.Boolean,
  hedged: optional(Schema.Boolean),
  firstTokenMs: optional(Schema.Number),
  responseMs: optional(Schema.Number),
  tokensPerSecond: optional(Schema.Number),
  tokensInput: optional(Schema.Number),
  tokensOutput: optional(Schema.Number),
  tokensReasoning: optional(Schema.Number),
  tokensCacheRead: optional(Schema.Number),
  tokensCacheWrite: optional(Schema.Number),
  costUsd: optional(Schema.Number),
  cacheSavingsUsd: optional(Schema.Number),
}).annotate({ identifier: "RouteAttempt.Attempt" })
export type Attempt = typeof Attempt.Type

/** Per provider/model totals over a window: attempt counts in the ledger's own failure semantics
 * (content-policy rejections counted separately, never as failures, #1084), token totals, cost,
 * and the distinct-session count that is the target's coverage of the window. */
export const TargetTotal = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  attempts: Schema.Number,
  successes: Schema.Number,
  failures: Schema.Number,
  policyRejections: Schema.Number,
  timeouts: Schema.Number,
  tokensInput: Schema.Number,
  tokensOutput: Schema.Number,
  tokensReasoning: Schema.Number,
  tokensCacheRead: Schema.Number,
  tokensCacheWrite: Schema.Number,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  sessions: Schema.Number,
  first: Schema.NullOr(Schema.Number),
  last: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "RouteAttempt.TargetTotal" })
export type TargetTotal = typeof TargetTotal.Type

/** Failures grouped by exact tag, code and HTTP status, with the latest message of each group —
 * the same shape core's errorBreakdown computes for the route_stats tool. */
export const ErrorBreakdown = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  tag: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Number),
  count: Schema.Number,
  lastTime: Schema.Number,
  lastMessage: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RouteAttempt.ErrorBreakdown" })
export type ErrorBreakdown = typeof ErrorBreakdown.Type

/** What part of the ledger a window covers: totals and distinct dimensions, so a reader can tell
 * a complete window from a partial one without opening the database file. */
export const Coverage = Schema.Struct({
  attempts: Schema.Number,
  providers: Schema.Number,
  models: Schema.Number,
  sessions: Schema.Number,
  routes: Schema.Number,
  first: Schema.NullOr(Schema.Number),
  last: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "RouteAttempt.Coverage" })
export type Coverage = typeof Coverage.Type

/** One route_decision ledger row as the read API serves it (#2497): what was eligible, what
 * was chosen, and why. `detail` is core's own structured interpretation (weights/exclusions);
 * it carries no credentials and no prompt/response content. */
export const Decision = Schema.Struct({
  id: Schema.Number,
  time: Schema.Number,
  sessionID: optional(Schema.String),
  routeID: Schema.String,
  selection: Schema.String,
  candidates: Schema.Array(Schema.String),
  chosen: optional(Schema.String),
  reason: Schema.String,
  detail: optional(Schema.Unknown),
}).annotate({ identifier: "RouteAttempt.Decision" })
export type Decision = typeof Decision.Type

/** The aggregate view over a window: per-target totals, the error breakdown, and coverage. */
export const Stats = Schema.Struct({
  targets: Schema.Array(TargetTotal),
  errors: Schema.Array(ErrorBreakdown),
  coverage: Coverage,
}).annotate({ identifier: "RouteAttempt.Stats" })
export type Stats = typeof Stats.Type

/** One bucket of the rollup read (#2795): attempt and token totals for a time bucket and the
 * dimensions the request grouped by. Dimensions the request did not group by are absent. A
 * credential is served only as `credentialKey`, a digest a reader that already holds the id can
 * match; the id itself is never served. */
export const RollupRow = Schema.Struct({
  bucket: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  providerID: optional(Schema.String),
  modelID: optional(Schema.String),
  variant: optional(Schema.NullOr(Schema.String)),
  credentialKey: optional(Schema.NullOr(Schema.String)),
  attempts: Schema.Number,
  successes: Schema.Number,
  tokensInput: Schema.Number,
  tokensOutput: Schema.Number,
  tokensReasoning: Schema.Number,
  tokensCacheRead: Schema.Number,
  tokensCacheWrite: Schema.Number,
  tokensCombined: Schema.Number,
  costUsd: Schema.Number,
  costRows: Schema.Number,
  credentialRows: Schema.Number,
  first: Schema.NullOr(Schema.Number),
  last: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "RouteAttempt.RollupRow" })
export type RollupRow = typeof RollupRow.Type
