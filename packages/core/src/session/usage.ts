export * as SessionUsage from "./usage.js"

import type { Usage } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Model } from "@opencode/schema/model"

const finite = (value: number) => (Number.isFinite(value) ? value : 0)
const safe = (value: number | undefined) => Math.max(0, finite(value ?? 0))

export const tokens = (usage: Usage | undefined): TokenUsage.Info => ({
  input: safe(usage?.nonCachedInputTokens),
  output: safe(usage?.visibleOutputTokens),
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    read: safe(usage?.cacheReadInputTokens),
    write: safe(usage?.cacheWriteInputTokens),
  },
})

const selectCost = (costs: Model.Info["cost"], usage: TokenUsage.Info) => {
  const context = usage.input + usage.cache.read + usage.cache.write
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  return tier ?? costs.find((cost) => cost.tier === undefined)
}

// Catalog pricing is the fallback for endpoints that don't report what they charged (`Usage.cost`).
export function calculateCost(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  const cost = selectCost(costs, usage)
  if (!cost) return Money.USD.zero
  return Money.USD.make(
    (usage.input * finite(cost.input) +
      (usage.output + usage.reasoning) * finite(cost.output) +
      usage.cache.read * finite(cost.cache.read) +
      usage.cache.write * finite(cost.cache.write)) /
      1_000_000,
  )
}

/**
 * What prompt caching saved on this usage: the counterfactual cost of the cache-read tokens at the
 * full input price minus what they actually cost at the cache-read price, using the same catalog
 * tier selection as `calculateCost`. Zero when nothing was read from cache or no price applies.
 */
export function calculateCacheSavings(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  const cost = selectCost(costs, usage)
  if (!cost) return Money.USD.zero
  return Money.USD.make((usage.cache.read * (finite(cost.input) - finite(cost.cache.read))) / 1_000_000)
}

export type Recorded = {
  readonly tokens: TokenUsage.Info
  readonly cost: Money.USD
}

/**
 * A reported cost is authoritative only when it is finite and non-negative, mirroring the
 * `billedAmount` rule on network ingress. `Usage.cost` is a plain `Schema.Number`, so it can
 * carry NaN/±Infinity (which `Money.USD.make` throws on) or a negative amount; callers fall
 * back — to catalog pricing in `record`, to omitting the cost on the decision path — instead.
 */
export const reportedCost = (usage: Usage | undefined): Money.USD | undefined =>
  usage?.cost !== undefined && Number.isFinite(usage.cost) && usage.cost >= 0 ? Money.USD.make(usage.cost) : undefined

export const record = (usage: Usage | undefined, costs: Model.Info["cost"]): Recorded => {
  const normalized = tokens(usage)
  return {
    tokens: normalized,
    // What an endpoint says it charged beats the catalog, which can't see its peak pricing, subscriptions or routing.
    // A reported zero is authoritative. A non-finite or negative reported cost falls back to the catalog.
    cost: reportedCost(usage) ?? calculateCost(costs, normalized),
  }
}

export const add = (a: Recorded, b: Recorded): Recorded => ({
  cost: Money.USD.make(a.cost + b.cost),
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      read: a.tokens.cache.read + b.tokens.cache.read,
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
  },
})
