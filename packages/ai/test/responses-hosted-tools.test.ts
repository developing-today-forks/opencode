import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { OpenResponses } from "../src/protocols/open-responses.js"
import { ResponsesHostedTools } from "../src/protocols/utils/responses-hosted-tools.js"
import { it } from "./lib/effect.js"

const tools = {
  web_search_call: { name: "web_search", input: (item: ResponsesHostedTools.Item) => item.action ?? {} },
} satisfies ResponsesHostedTools.Definitions

const item = (type: string) =>
  ({
    type,
    id: "item_1",
    status: "completed",
    action: { type: "search", query: "effect" },
  }) as unknown as OpenResponses.OutputItem

// Regression (#927): membership must be own-property only. `in` reads through the
// prototype chain, so these names classified as hosted-tool items and `onDone` died
// with a TypeError defect (`tool.input is not a function`) on the inherited member.
const PROTOTYPE_NAMES = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]

describe("ResponsesHostedTools.isItem", () => {
  test("classifies a known hosted-tool item type (control)", () => {
    expect(ResponsesHostedTools.isItem(item("web_search_call"), tools)).toBe(true)
  })

  test("does not classify Object prototype member names as hosted-tool items", () => {
    for (const type of PROTOTYPE_NAMES) expect(ResponsesHostedTools.isItem(item(type), tools)).toBe(false)
  })

  test("does not classify unknown item types as hosted-tool items", () => {
    expect(ResponsesHostedTools.isItem(item("future_hosted_call"), tools)).toBe(false)
  })
})

describe("ResponsesHostedTools.onDone", () => {
  it.effect("returns no events for Object prototype member names instead of dying", () =>
    Effect.gen(function* () {
      for (const type of PROTOTYPE_NAMES) {
        // The guard returns before touching state, so a bare state stand-in is enough:
        // reaching for a Definition here is exactly the defect being pinned.
        const [, events] = yield* ResponsesHostedTools.onDone(
          {} as OpenResponses.ParserState,
          item(type) as ResponsesHostedTools.Item,
          tools,
        )
        expect(events).toEqual([])
      }
    }),
  )
})
