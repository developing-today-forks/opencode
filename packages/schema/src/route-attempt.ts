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
 * (content-policy rejections counted separately, never as failures, #1084), latency and token
 * averages, token totals, cost, and the distinct-session count that is the target's coverage. */
export const TargetTotal = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  attempts: Schema.Number,
  avgFirstTokenMs: Schema.NullOr(Schema.Number),
  avgTokensPerSecond: Schema.NullOr(Schema.Number),
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

/** Failures grouped by exact tag, code and HTTP status. Provider messages are excluded because
 * they can contain raw upstream details. */
export const ErrorBreakdown = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  tag: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Number),
  count: Schema.Number,
  lastTime: Schema.Number,
}).annotate({ identifier: "RouteAttempt.ErrorBreakdown" })
export type ErrorBreakdown = typeof ErrorBreakdown.Type

export const HedgeAccuracy = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  hedges: Schema.Number,
  wins: Schema.Number,
}).annotate({ identifier: "RouteAttempt.HedgeAccuracy" })
export type HedgeAccuracy = typeof HedgeAccuracy.Type

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

/** The aggregate view over a window: per-target totals and latency, hedge outcomes, redacted
 * error groups, and coverage. */
export const Stats = Schema.Struct({
  targets: Schema.Array(TargetTotal),
  hedges: Schema.Array(HedgeAccuracy),
  errors: Schema.Array(ErrorBreakdown),
  coverage: Coverage,
}).annotate({ identifier: "RouteAttempt.Stats" })
export type Stats = typeof Stats.Type
