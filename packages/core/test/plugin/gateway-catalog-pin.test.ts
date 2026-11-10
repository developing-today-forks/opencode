import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { ModelsDev } from "@opencode/core/models-dev"
import { testEffect } from "../lib/effect"

const values = new Map<string, KV.Value>()

const layer = Layer.fresh(
  AppNodeBuilder.build(LayerNode.group([ModelsDev.node, Bus.node]), [
    ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
    KV.node.replace(
      Layer.mock(KV.Service, {
        get: (key) => Effect.sync(() => values.get(key)),
        set: (key, value) => Effect.sync(() => values.set(key, value)).pipe(Effect.asVoid),
        remove: (key) => Effect.sync(() => values.delete(key)).pipe(Effect.asVoid),
      }),
    ),
  ]),
)

const it = testEffect(layer)

// #1706/#1708: the seated OpenCode Go models must keep both their provider
// package and their model API family. A models.dev refresh that flips either
// value silently changes the wire dialect (OpenAI Chat vs Anthropic Messages vs
// Google), so the pin fails with a deliberate diff instead.
//
// API family is read off the model's own `settings.baseURL` when models.dev
// routes a single model to a different family endpoint (…/go/anthropic/v1,
// …/go/google/v1beta); otherwise the provider-level baseURL applies.
const seated: ReadonlyArray<{
  readonly model: string
  readonly package: string
  readonly api: "openai-chat" | "anthropic-messages" | "google"
}> = [
  { model: "beam-free", package: "@opencode/ai/providers/openai-compatible", api: "openai-chat" },
  { model: "claude-haiku-5-5", package: "@opencode/ai/providers/anthropic", api: "anthropic-messages" },
  { model: "deepseek-v4.1-flash", package: "@opencode/ai/providers/openai-compatible", api: "openai-chat" },
  { model: "deepseek-v4-pro", package: "@opencode/ai/providers/openai-compatible", api: "openai-chat" },
  { model: "gemini-4-argon", package: "@opencode/ai/providers/google", api: "google" },
  { model: "gpt-6-luna", package: "@opencode/ai/providers/openai", api: "openai-chat" },
  { model: "mimo-v2.6-flash", package: "@opencode/ai/providers/openai-compatible", api: "openai-chat" },
  {
    model: "muse-spark-1.3-contributor",
    package: "@opencode/ai/providers/openai",
    api: "openai-chat",
  },
]

const family = (baseURL: string | undefined): "openai-chat" | "anthropic-messages" | "google" | undefined => {
  if (baseURL === undefined) return undefined
  if (baseURL.includes("/anthropic/")) return "anthropic-messages"
  if (baseURL.includes("/google/")) return "google"
  if (baseURL.includes("/openai/")) return "openai-chat"
  return undefined
}

describe("gateway catalog pin", () => {
  it.effect("pins every seated opencode-go model's package and API family", () =>
    Effect.gen(function* () {
      const snapshots = yield* ModelsDev.Service.use((service) => service.get())
      const provider = snapshots.find((item) => item.info.id === "opencode-go")
      expect(provider).toBeDefined()
      const providerAPI = provider?.info.settings?.baseURL

      const seen = seated.map((entry) => {
        const model = provider?.models.find((item) => item.id === entry.model)
        expect(model).toBeDefined()
        // A model that overrides its package reports it on the model; otherwise it inherits the provider's.
        const pkg = model?.package ?? provider?.info.package
        const api = family(model?.settings?.baseURL) ?? family(providerAPI)
        return { model: entry.model, package: pkg, api }
      })

      expect(seen).toEqual(seated.map((entry) => ({ model: entry.model, package: entry.package, api: entry.api })))
    }),
  )
})
