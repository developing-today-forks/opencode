import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Append-only routing telemetry. Deliberately no foreign keys: rows outlive the sessions they describe,
// and `session_id` / `assistant_message_id` are join keys into the event-sourced session tables, which
// already hold per-step usage, cost and errors. Prompts and response contents are never stored here.

/** One target selection for a session turn: what was eligible, what was drawn, and why. */
export const RouteDecisionTable = sqliteTable(
  "route_decision",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    session_id: text(),
    route_id: text().notNull(),
    selection: text().notNull(),
    variant: text(),
    /** Eligible `provider/model` targets in the order they would be tried. */
    candidates: text({ mode: "json" }).$type<string[]>().notNull(),
    chosen: text(),
    /** `ordered`, `adjusted`, `sticky`, `drawn` or `no-candidates`. */
    reason: text().notNull(),
    /** Overrides and cooldowns that shaped this decision. */
    detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("route_decision_route_time_idx").on(table.route_id, table.time),
    index("route_decision_session_idx").on(table.session_id, table.time),
  ],
)

/** One provider request against one concrete target, with its exact outcome. */
export const RouteAttemptTable = sqliteTable(
  "route_attempt",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time_started: integer().notNull(),
    time_ended: integer().notNull(),
    session_id: text(),
    assistant_message_id: text(),
    route_id: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    /** The stored credential that served this attempt, when the call site knows it (#1106). Null for
     * env-served requests and for attempts recorded before this column existed: unattributed usage
     * that the quota gate must never assign to a credential. */
    credential_id: text(),
    /** `success`, `failure`, `timeout`, `interrupted`, `hedged-out` or `resolution-failure`. */
    outcome: text().notNull(),
    error_tag: text(),
    error_code: text(),
    error_status: integer(),
    error_message: text(),
    /** The provider's own explanation, kept only when the caller opts in. */
    error_body: text(),
    retryable: integer({ mode: "boolean" }),
    output_started: integer({ mode: "boolean" }).notNull(),
    failed_over_to: text(),
    /** True for both legs of a hedged attempt: the winner and the one cancelled. */
    hedged: integer({ mode: "boolean" }),
    first_token_ms: real(),
    response_ms: real(),
    tokens_per_second: real(),
    tokens_input: integer(),
    /** True when a request was cancelled before the provider returned usage. */
    tokens_estimated: integer({ mode: "boolean" }),
    tokens_output: integer(),
    tokens_reasoning: integer(),
    tokens_cache_read: integer(),
    tokens_cache_write: integer(),
    /** What the request cost in USD, from the model's catalog prices and the tokens it used. Null when the request
     * did not finish with usage. Stored with the attempt so the cost outlives the session it belongs to. */
    cost_usd: real(),
    /** What prompt caching saved on this request in USD: cache-read tokens at the input price minus their
     * cache-read price, from the same catalog prices as `cost_usd`. Null for attempts recorded before this
     * column existed or without usage — historical rows carry no pricing snapshot, so their savings are
     * never reconstructed by guessing later prices. */
    cache_savings_usd: real(),
    /** The attempt that started the response this request continued, when a response hit the output token limit and
     * the session runner asked for the rest. Null for a request that stands on its own. A turn is a root attempt plus
     * every attempt that names it here, so its tokens and cost can be read as one figure. */
    continuation_of: integer(),
    /** 0 for a standalone request, then 1, 2, … for each chunk that continues the root attempt. */
    continuation_index: integer().default(0),
    /** Provider rate-limit and quota headers or fields, when the error carried them. */
    quota: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("route_attempt_target_time_idx").on(table.provider_id, table.model_id, table.time_started),
    index("route_attempt_route_time_idx").on(table.route_id, table.time_started),
    index("route_attempt_session_idx").on(table.session_id, table.time_started),
    index("route_attempt_continuation_idx").on(table.continuation_of),
  ],
)

/** Cooldown and degradation transitions of a target. */
export const RouteHealthTable = sqliteTable(
  "route_health",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    route_id: text(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    /** `cooldown-start` or `cooldown-end`. */
    kind: text().notNull(),
    reason: text(),
    until: integer(),
    credential_id: text(),
  },
  (table) => [index("route_health_target_time_idx").on(table.provider_id, table.model_id, table.time)],
)

/** Free-form operator input that the routing layer turns into expiring adjustments. */
export const RouteNoteTable = sqliteTable(
  "route_note",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    /** The note as written, untouched. */
    text: text().notNull(),
    /** Structured interpretation: skip, prefer, weight, quota, or an explanation of a past failure. */
    interpreted: text({ mode: "json" }).$type<Record<string, unknown>>(),
    expires: integer(),
  },
  (table) => [index("route_note_time_idx").on(table.time)],
)
