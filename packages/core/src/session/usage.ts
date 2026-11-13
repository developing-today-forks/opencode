export * as SessionUsage from "./usage.js"

import type { Usage } from "@opencode/ai"
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

// TODO(#35765): Use Copilot's reported billed amount once billing has a dedicated typed runtime contract.
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

export type Recorded = { readonly tokens: TokenUsage.Info; readonly cost: Money.USD }

export const record = (usage: Usage | undefined, costs: Model.Info["cost"]): Recorded => {
  const normalized = tokens(usage)
  return { tokens: normalized, cost: calculateCost(costs, normalized) }
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
