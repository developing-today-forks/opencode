import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { MessagingSearch } from "@opencode/core/messaging/search"
import { it } from "./lib/effect"

describe("MessagingSearch.tantivyQuery", () => {
  it.live("builds a whole-word OR query, or undefined when there are no words", () =>
    Effect.sync(() => {
      expect(MessagingSearch.tantivyQuery("hello world")).toEqual('"hello" OR "world"')
      expect(MessagingSearch.tantivyQuery("Hello HELLO hello")).toEqual('"hello"')
      expect(MessagingSearch.tantivyQuery("pizza!")).toEqual('"pizza"')
      expect(MessagingSearch.tantivyQuery("pizz?a")).toEqual('"pizz" OR "a"')
      expect(MessagingSearch.tantivyQuery("")).toBeUndefined()
      expect(MessagingSearch.tantivyQuery("!!!")).toBeUndefined()
      expect(MessagingSearch.tantivyQuery("  ")).toBeUndefined()
    }),
  )
})

describe("MessagingSearch.regexFilter", () => {
  it.live("matches complete text in order across worker batches and treats invalid patterns as literals", () =>
    Effect.gen(function* () {
      const items = Array.from({ length: 130 }, (_, index) => ({ text: index % 2 === 0 ? "Pizza" : "other", index }))
      expect(yield* MessagingSearch.regexFilter("pizz?a", items, (item) => item.text)).toEqual({
        matched: items.filter((item) => item.index % 2 === 0),
        unchecked: 0,
      })
      expect(yield* MessagingSearch.regexFilter("[", ["literal [ bracket", "other"], (item) => item)).toEqual({
        matched: ["literal [ bracket"],
        unchecked: 0,
      })
      expect(yield* MessagingSearch.regexFilter("anything", [], (item: string) => item)).toEqual({
        matched: [],
        unchecked: 0,
      })
    }),
  )

  it.live("terminates pathological regex work while the caller's event loop keeps running", () =>
    Effect.gen(function* () {
      const completed: string[] = []
      const [result] = yield* Effect.all(
        [
          MessagingSearch.regexFilter(
            "^(a+)+$",
            Array.from({ length: 1000 }, () => "a".repeat(1000) + "!"),
            (item) => item,
            100,
          ).pipe(Effect.tap(() => Effect.sync(() => completed.push("search")))),
          Effect.sleep("1 millis").pipe(Effect.tap(() => Effect.sync(() => completed.push("heartbeat")))),
        ],
        { concurrency: "unbounded" },
      )
      expect(completed).toEqual(["heartbeat", "search"])
      expect(result.unchecked).toBeGreaterThan(0)
      expect(result.matched).toEqual([])
    }),
  )
})
