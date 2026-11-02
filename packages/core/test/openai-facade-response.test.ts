import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { OpenAIFacadeResponse } from "@opencode/core/openai-facade-response"
import { OpenAIFacadeResponseTable } from "@opencode/core/openai-facade-response/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([OpenAIFacadeResponse.node, Database.node])))

const userItem = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
})
const assistantItem = (text: string) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
})

const put = (store: OpenAIFacadeResponse.Interface, overrides: Partial<OpenAIFacadeResponse.PutInput> = {}) =>
  store.put({
    id: "resp_1",
    createdAt: 1_000_000,
    depth: 0,
    model: "workhorse",
    resolvedModel: "opencode-route/workhorse",
    requestItems: [userItem("hi")],
    responseItems: [userItem("hi"), assistantItem("hello")],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    ...overrides,
  })

describe("OpenAIFacadeResponse store", () => {
  it.live("persists a response and reads it back with a 24h expiry", () =>
    Effect.gen(function* () {
      const store = yield* OpenAIFacadeResponse.Service
      const stored = yield* put(store)
      expect(stored.expiresAt).toBe(1_000_000 + OpenAIFacadeResponse.TTL_MS)
      expect(OpenAIFacadeResponse.TTL_MS).toBe(24 * 3_600_000)

      const row = yield* store.get("resp_1", 1_000_001)
      expect(row?.id).toBe("resp_1")
      expect(row?.depth).toBe(0)
      expect(row?.model).toBe("workhorse")
      expect(row?.resolvedModel).toBe("opencode-route/workhorse")
      expect(row?.requestItems).toEqual([userItem("hi")])
      expect(row?.responseItems).toEqual([userItem("hi"), assistantItem("hello")])
      expect(row?.usage).toEqual({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })
    }),
  )

  it.live("records the chain link and depth of a chained response", () =>
    Effect.gen(function* () {
      const store = yield* OpenAIFacadeResponse.Service
      yield* put(store)
      yield* put(store, {
        id: "resp_2",
        createdAt: 1_100_000,
        previousResponseId: "resp_1",
        depth: 1,
        requestItems: [userItem("again")],
        responseItems: [userItem("hi"), assistantItem("hello"), userItem("again"), assistantItem("world")],
      })
      const row = yield* store.get("resp_2", 1_100_001)
      expect(row?.previousResponseId).toBe("resp_1")
      expect(row?.depth).toBe(1)
      // The cumulative snapshot carries the whole history after the turn:
      // chain resolution loads this row alone, never its ancestors.
      expect(row?.responseItems).toHaveLength(4)
    }),
  )

  it.live("an unknown id reads as undefined", () =>
    Effect.gen(function* () {
      const store = yield* OpenAIFacadeResponse.Service
      expect(yield* store.get("resp_nope", 1_000_000)).toBeUndefined()
    }),
  )

  it.live("an expired id reads as undefined and is deleted on read", () =>
    Effect.gen(function* () {
      const store = yield* OpenAIFacadeResponse.Service
      const db = (yield* Database.Service).db
      yield* put(store)
      const expiredAt = 1_000_000 + OpenAIFacadeResponse.TTL_MS
      expect(yield* store.get("resp_1", expiredAt)).toBeUndefined()
      // Gone, not just hidden: even a read at an earlier clock finds nothing.
      expect(yield* store.get("resp_1", 1_000_001)).toBeUndefined()
      const rows = yield* db.select().from(OpenAIFacadeResponseTable)
      expect(rows).toHaveLength(0)
    }),
  )

  it.live("writes sweep rows that have since expired", () =>
    Effect.gen(function* () {
      const store = yield* OpenAIFacadeResponse.Service
      const db = (yield* Database.Service).db
      yield* put(store)
      yield* put(store, { id: "resp_2", createdAt: 1_000_000 + OpenAIFacadeResponse.TTL_MS + 1, depth: 1 })
      const rows = yield* db.select().from(OpenAIFacadeResponseTable)
      expect(rows.map((row) => row.id)).toEqual(["resp_2"])
    }),
  )

  it.live("façade rows never touch the session tables", () =>
    Effect.gen(function* () {
      const store = yield* OpenAIFacadeResponse.Service
      const db = (yield* Database.Service).db
      yield* put(store)
      yield* put(store, { id: "resp_2", previousResponseId: "resp_1", depth: 1 })
      const sessions = yield* db.all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_v2`)
      const messages = yield* db.all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_message`)
      expect(sessions[0]?.count).toBe(0)
      expect(messages[0]?.count).toBe(0)
    }),
  )
})
