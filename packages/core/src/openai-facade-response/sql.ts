import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The Responses façade's private item store (#1149, design
// specs/2026-11-01T04-10-00Z_design_openai-facades.md §4). One row per
// response the façade mints; a chain is a linked list via
// `previous_response_id`. Deliberately façade-private: no foreign keys
// into the session tables, and façade responses never appear there —
// session ids and response ids are different namespaces.
//
// `response_items` is cumulative: the full normalized item list after
// this turn (every earlier turn's request and response items included),
// so chain resolution loads only the referenced row, never ancestors.
// `request_items` keeps just this turn's new input items, for provenance.
export const OpenAIFacadeResponseTable = sqliteTable(
  "openai_facade_response",
  {
    /** The `resp_…` id returned to the caller. */
    id: text().primaryKey(),
    time_created: integer().notNull(),
    /** Epoch ms after which the row is expired: reads delete it and answer 404. */
    time_expires: integer().notNull(),
    previous_response_id: text(),
    /** Parent depth + 1; 0 for a chain root. The 64-link bound reads this, not a traversal. */
    depth: integer().notNull(),
    /** The requested ref/route string, as the caller named it. */
    model: text().notNull(),
    /** The model ref the request was resolved as (`provider/model`). */
    resolved_model: text().notNull(),
    /** This turn's normalized request items, in Responses wire shape. */
    request_items: text({ mode: "json" }).$type<ReadonlyArray<Record<string, unknown>>>().notNull(),
    /** The full normalized item list after this turn (cumulative snapshot). */
    response_items: text({ mode: "json" }).$type<ReadonlyArray<Record<string, unknown>>>().notNull(),
    /** The turn's usage totals, in Responses wire shape, when the provider reported them. */
    usage: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("openai_facade_response_expires_idx").on(table.time_expires),
    index("openai_facade_response_previous_idx").on(table.previous_response_id),
  ],
)
