import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Schema } from "effect"

/** A configuration written before pools had matching keys, effort levels or `false` remaps, with a
 * catalog that exercises every older expansion rule: globs inside one provider, case-sensitive ids,
 * disabled models, pinned and inherited variants, remaps to variants a model lacks, nested and
 * self-referencing pools, a pinned nested pool whose members remap levels, time-limited targets,
 * weights, budgets and schedules. The expansion test pins what this produced before the new keys
 * existed. */

const FUTURE = Date.parse("2100-01-01T00:00:00Z")
const PAST = Date.parse("2020-01-01T00:00:00Z")

const model = (providerID: string, id: string, variants: string[] = [], enabled = true) =>
  [
    id,
    {
      ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
      variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
      enabled,
    },
  ] as const

export const catalog = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
  [
    Provider.ID.make("anthropic"),
    new Map([
      model("anthropic", "claude-opus-4-1", ["high", "medium"]),
      model("anthropic", "claude-sonnet-4-5", ["low", "high"]),
      model("anthropic", "claude-haiku-4-5"),
      model("anthropic", "Claude-Sonnet-Upper", ["low", "high"]),
      model("anthropic", "claude-sonnet-old", ["low", "high"], false),
    ]),
  ],
  [
    Provider.ID.make("openai"),
    new Map([
      model("openai", "gpt-6-luna", ["low", "medium", "high", "max"]),
      model("openai", "gpt-6-luna-mini", ["low", "high"]),
      model("openai", "gpt-6-astra", ["high", "max"]),
    ]),
  ],
  [Provider.ID.make("github-copilot"), new Map([model("github-copilot", "gpt-6-luna", ["medium", "high"])])],
  [Provider.ID.make("openrouter"), new Map([model("openrouter", "anthropic/claude-sonnet-4-5", ["high"])])],
])

const raw = {
  "cheap-fast": {
    targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
    selection: "weighted",
    weights: { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
    autonomy: "rules",
    budgets: { "openai/gpt-6-luna": { requestsPerDay: 500, softLimit: 0.8 } },
  },
  "luna-stack": {
    name: "Luna",
    targets: [
      {
        model: "openai/gpt-6-luna",
        defaultVariant: "max",
        variants: { low: "high", medium: "high", xhigh: "ultra" },
      },
      { model: "github-copilot/gpt-6-luna", defaultVariant: "medium" },
    ],
  },
  family: {
    targets: [
      "anthropic/claude-sonnet*",
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-old",
      "openrouter/*sonnet*",
    ],
  },
  pinned: { targets: ["openai/gpt-6-luna#high", "openai/gpt-6-astra"] },
  nested: {
    targets: [
      "opencode-route/cheap-fast#high",
      "opencode-route/family",
      { model: "openai/gpt-6-astra", until: FUTURE },
      { model: "openai/gpt-6-luna-mini", until: PAST },
    ],
    selection: "round-robin",
    autonomy: "rules",
    weights: { "opencode-route/family": 2 },
    budgets: { "github-copilot/gpt-6-luna": { tokensPerDay: 1_000_000 } },
    schedules: [{ targets: ["openai/*"], when: { daysOfWeek: ["sat", "sun"] }, factor: 0.5 }],
  },
  self: { targets: ["opencode-route/self", "openai/gpt-6-luna-mini", "opencode-route/missing"] },
  nothing: { targets: ["anthropic/*mistral*"] },
  // luna-stack's members remap levels, and pinned at high they keep those remaps and default variants.
  "pinned-stack": { targets: ["opencode-route/luna-stack#high", "anthropic/claude-sonnet-4-5"] },
}

/** Decoded the way the config loader decodes each pool, so the shapes match production. */
export const routes = new Map(
  Object.entries(raw).map(([id, route]) => [id, Schema.decodeUnknownSync(ConfigModelRoutes.Route)(route)] as const),
)
