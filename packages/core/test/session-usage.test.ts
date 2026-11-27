import { expect, test } from "bun:test"
import { Usage } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import { SessionUsage } from "@opencode/core/session/usage"

// $1 per million fresh input tokens, so a million of them price at $1 from the catalog.
const costs = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
  },
]

test("prices the tokens from the catalog when the endpoint reports no cost", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000 }), costs).cost).toBe(Money.USD.make(1))
})

test("records the cost the endpoint reports instead of the catalog price", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0.25 }), costs).cost).toBe(
    Money.USD.make(0.25),
  )
})

test("falls back to the catalog price instead of throwing on a non-finite reported cost", () => {
  for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost }), costs).cost).toBe(
      Money.USD.make(1),
    )
    // The decision-generate path shares this guard: a non-finite cost yields no reported cost, not a throw.
    expect(SessionUsage.reportedCost(new Usage({ cost }))).toBeUndefined()
  }
})

test("falls back to the catalog price on a negative reported cost", () => {
  // Chosen rule: a negative reported cost is not authoritative (mirroring billedAmount's >= 0 rule);
  // it falls back to catalog pricing rather than persisting as negative session spend.
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: -0.25 }), costs).cost).toBe(
    Money.USD.make(1),
  )
  expect(SessionUsage.reportedCost(new Usage({ cost: -0.25 }))).toBeUndefined()
  expect(SessionUsage.reportedCost(new Usage({ cost: 0.25 }))).toBe(Money.USD.make(0.25))
})

test("keeps a reported zero cost, as for a request a subscription covered", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0 }), costs)).toEqual({
    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: Money.USD.zero,
  })
})
