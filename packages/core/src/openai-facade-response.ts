export * as OpenAIFacadeResponse from "./openai-facade-response.js"

/**
 * The Responses façade's item store (#1149, design §4): persists one
 * `openai_facade_response` row per response so a later
 * `POST /v1/responses` call can chain with `previous_response_id`
 * instead of resending history. The store is cumulative — a row's
 * `response_items` are the full normalized item list after its turn —
 * so resolving a chain loads exactly one row.
 *
 * Bounds: a chain's depth is recorded on the row (parent depth + 1);
 * the door refuses to extend a chain whose parent is already at
 * {@link MAX_CHAIN_DEPTH}. Rows expire {@link TTL_MS} after creation;
 * an expired row is deleted opportunistically on read (and swept on
 * write), and a read of an expired or unknown id yields `undefined`,
 * which the door answers as 404 `response_not_found` — OpenAI's own
 * behaviour, so clients fall back to a full resend.
 *
 * No session is created, read or written here: the façade stays
 * session-free and this table is its only state.
 */
import { eq, lte } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "./database/database.js"
import { OpenAIFacadeResponseTable } from "./openai-facade-response/sql.js"

export const MAX_CHAIN_DEPTH = 64
export const TTL_MS = 24 * 3_600_000

export interface Stored {
  readonly id: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly previousResponseId?: string
  readonly depth: number
  /** The requested ref/route string, as the caller named it. */
  readonly model: string
  /** The model ref the request was resolved as (`provider/model`). */
  readonly resolvedModel: string
  /** This turn's normalized request items, in Responses wire shape. */
  readonly requestItems: ReadonlyArray<Record<string, unknown>>
  /** The full normalized item list after this turn (cumulative snapshot). */
  readonly responseItems: ReadonlyArray<Record<string, unknown>>
  readonly usage?: Record<string, unknown>
}

export interface PutInput {
  readonly id: string
  readonly createdAt: number
  readonly previousResponseId?: string
  readonly depth: number
  readonly model: string
  readonly resolvedModel: string
  readonly requestItems: ReadonlyArray<Record<string, unknown>>
  readonly responseItems: ReadonlyArray<Record<string, unknown>>
  readonly usage?: Record<string, unknown>
}

export interface Interface {
  /** The stored row, or undefined when the id is unknown or expired (expired rows are deleted on read). */
  readonly get: (id: string, now?: number) => Effect.Effect<Stored | undefined>
  /** Persists a completed response; also sweeps rows that have since expired. Returns the stored row. */
  readonly put: (input: PutInput) => Effect.Effect<Stored>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OpenAIFacadeResponse") {}

type Row = typeof OpenAIFacadeResponseTable.$inferSelect

const toStored = (row: Row): Stored => ({
  id: row.id,
  createdAt: row.time_created,
  expiresAt: row.time_expires,
  ...(row.previous_response_id ? { previousResponseId: row.previous_response_id } : {}),
  depth: row.depth,
  model: row.model,
  resolvedModel: row.resolved_model,
  requestItems: row.request_items,
  responseItems: row.response_items,
  ...(row.usage ? { usage: row.usage } : {}),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const get: Interface["get"] = (id, now = Date.now()) =>
      Effect.gen(function* () {
        const row = yield* db.select().from(OpenAIFacadeResponseTable).where(eq(OpenAIFacadeResponseTable.id, id)).get()
        if (!row) return undefined
        if (row.time_expires <= now) {
          // Opportunistic eviction: an expired chain head is gone, and the
          // door answers the read as response_not_found.
          yield* db.delete(OpenAIFacadeResponseTable).where(eq(OpenAIFacadeResponseTable.id, id))
          return undefined
        }
        return toStored(row)
      }).pipe(Effect.orDie)

    const put: Interface["put"] = (input) =>
      Effect.gen(function* () {
        const stored: Stored = { ...input, expiresAt: input.createdAt + TTL_MS }
        yield* db.delete(OpenAIFacadeResponseTable).where(lte(OpenAIFacadeResponseTable.time_expires, input.createdAt))
        yield* db.insert(OpenAIFacadeResponseTable).values({
          id: stored.id,
          time_created: stored.createdAt,
          time_expires: stored.expiresAt,
          previous_response_id: stored.previousResponseId ?? null,
          depth: stored.depth,
          model: stored.model,
          resolved_model: stored.resolvedModel,
          request_items: [...stored.requestItems],
          response_items: [...stored.responseItems],
          usage: stored.usage ?? null,
        })
        return stored
      }).pipe(Effect.orDie)

    return Service.of({ get, put })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node] })
