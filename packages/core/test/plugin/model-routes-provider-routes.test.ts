import { Document, Info, type Entry } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigModelRoutesPlugin } from "@opencode/core/config/plugin/model-routes"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelRoute } from "@opencode/core/model-route"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ChatGPTPlugin } from "@opencode/core/plugin/provider/chatgpt"
import { ProviderInstancePlugin } from "@opencode/core/plugin/provider/instance"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

// The production config shape from the 2026-11-01 provider-routes collapse
// (developing-today/code commit 3f40508e, rolled back by 7e20d975): the GPT pair are
// an instance provider and a models-only block with no package/options of their own,
// the pair is named once as an experimental.provider_routes group, and the plan
// routes consume it with string targets — luna-plan and sol-plan as weighted seats
// in round-robin pools, terra-plan as the group's sole seat. In production the group
// never candidated: zero route decisions named it while the explicit per-model
// routes on the same build resumed candidacy in seconds.
const raw = {
  provider: {
    openai: {
      models: {
        "gpt-6-luna": { limit: { context: 1050000, output: 128000 } },
        "gpt-6.1-terra": { limit: { context: 1050000, output: 128000 } },
        "gpt-6.1-sol": { limit: { context: 1050000, output: 128000 } },
      },
    },
    "openai.alternate": { instanceOf: "openai", name: "OpenAI Alternate (Student - popesdrew)" },
    opendesign: {
      models: {
        "gpt-6-luna": { limit: { context: 1050000, output: 128000 } },
        "gpt-6.1-sol": { limit: { context: 1050000, output: 128000 } },
      },
    },
    "opencode-go": {
      models: {
        "gpt-6-luna": { limit: { context: 1050000, output: 128000 } },
      },
    },
  },
  experimental: {
    provider_routes: {
      "openai-plan": { providers: ["openai.alternate", "openai"], selection: "ordered" },
    },
    model_routes: {
      "terra-plan": {
        targets: ["openai-plan/gpt-6.1-terra"],
        selection: "round-robin",
        autonomy: "rules",
      },
      "sol-plan": {
        targets: ["openai-plan/gpt-6.1-sol", { model: "opendesign/gpt-6.1-sol" }],
        selection: "round-robin",
        autonomy: "rules",
        weights: { "openai-plan/gpt-6.1-sol": 3 },
      },
      "luna-plan": {
        targets: [
          "openai-plan/gpt-6-luna",
          { model: "opendesign/gpt-6-luna", variants: { xhigh: "high", max: "high" } },
          "opencode-go/gpt-6-luna",
        ],
        selection: "round-robin",
        autonomy: "rules",
        weights: { "openai-plan/gpt-6-luna": 2.5 },
      },
    },
  },
}

// Entries the way the config loader builds them: the raw document is normalized
// first, and only the normalized encoding is decoded into a config Entry.
const entries = (): Entry[] => {
  const result = ConfigNormalize.normalize(raw)
  if (result.type !== "normalized") throw new Error("the production-shaped config must normalize")
  return [new Document({ type: "document", info: Schema.decodeUnknownSync(Info)(result.encoded) })]
}

const unavailableModels = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }))),
)

// Stands in for the models.dev catalog entry every OpenAI connection starts from:
// the gpt-6 family is catalogued, exactly as the live catalog lists it.
const seedCatalog = Effect.fn(function* () {
  const providers = yield* Provider.Service
  const integrations = yield* Integration.Service
  yield* integrations.transform((editor) => {
    editor.update(Integration.ID.make("openai"), (integration) => {
      integration.name = "OpenAI"
    })
    editor.method.update({ integrationID: Integration.ID.make("openai"), method: { type: "key" } })
    editor.method.update({
      integrationID: Integration.ID.make("openai"),
      method: { type: "env", names: ["OPENAI_API_KEY"] },
    })
  })
  yield* providers.transform((editor) => {
    editor.update(Provider.ID.openai, (provider) => {
      provider.name = "OpenAI"
      provider.package = "@opencode/ai/providers/openai"
      provider.integrationID = Integration.ID.make("openai")
    })
    editor.models.update(Provider.ID.openai, Model.ID.make("gpt-5.5"), () => {})
    editor.models.update(Provider.ID.openai, Model.ID.make("gpt-6-luna"), () => {})
    editor.models.update(Provider.ID.openai, Model.ID.make("gpt-6.1-terra"), () => {})
    editor.models.update(Provider.ID.openai, Model.ID.make("gpt-6.1-sol"), () => {})
  })
})

const chatgpt = (access: string) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt-token-sharing"),
    access,
    refresh: "refresh",
    expires: Date.now() + 60 * 60_000,
    metadata: { clientID: "oaiapp_issued" },
  })

// The production plugin order for this slice: catalog seed, instance copies,
// per-instance ChatGPT serving, config providers, then model routes last.
const addPlugins = Effect.fn(function* (configEntries: Entry[]) {
  const plugin = yield* Plugin.Service
  const config = Config.testLayer(configEntries)
  yield* seedCatalog()
  yield* ProviderInstancePlugin.effect(yield* PluginHost.make(plugin, ProviderInstancePlugin.id)).pipe(
    Effect.provide(config),
  )
  yield* ChatGPTPlugin.effect(yield* PluginHost.make(plugin, ChatGPTPlugin.id)).pipe(
    Effect.provideService(HttpClient.HttpClient, unavailableModels),
    Effect.provide(config),
  )
  yield* ConfigProviderPlugin.Plugin.effect(yield* PluginHost.make(plugin)).pipe(Effect.provide(config))
  yield* ConfigModelRoutesPlugin.Plugin.effect(yield* PluginHost.make(plugin)).pipe(Effect.provide(config))
})

const definitionOf = Effect.fn(function* (routeID: string) {
  const models = yield* Model.Service
  const model = yield* models.get(ModelRoute.PROVIDER_ID, Model.ID.make(routeID))
  return model ? ModelRoute.definition(model) : undefined
})

const refs = (definition: ModelRoute.Definition) =>
  definition.targets.map((target) => `${target.providerID}/${target.id}`)

const groupSeat = (definition: ModelRoute.Definition) => {
  const index = definition.nodes.findIndex((node) => node.providerRoute === "openai-plan")
  const position = definition.nodes[0].children.findIndex((child) => child.node === index)
  return { index, position, weight: position >= 0 ? definition.nodes[0].weights[position] : undefined }
}

describe("provider routes in the plugin pipeline (production collapse shape)", () => {
  it.effect("the group candidated as a weighted seat: both members' leaves under one group node", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({ integrationID: Integration.ID.make("openai"), value: chatgpt("main-token") })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai.alternate"),
        value: chatgpt("alternate-token"),
      })
      yield* addPlugins(entries())

      const luna = yield* definitionOf("luna-plan")
      expect(luna).toBeDefined()
      expect(refs(luna!)).toContain("openai.alternate/gpt-6-luna")
      expect(refs(luna!)).toContain("openai/gpt-6-luna")
      expect(refs(luna!)).toContain("opendesign/gpt-6-luna")
      expect(refs(luna!)).toContain("opencode-go/gpt-6-luna")
      const lunaSeat = groupSeat(luna!)
      expect(lunaSeat.index).toBeGreaterThan(0)
      expect(lunaSeat.weight).toBe(2.5)
      // The group's own selection is the provider route's: ordered, alternate first.
      expect(luna!.nodes[lunaSeat.index].selection).toBe("ordered")
      expect(luna!.nodes[lunaSeat.index].children).toHaveLength(2)

      const sol = yield* definitionOf("sol-plan")
      expect(sol).toBeDefined()
      expect(refs(sol!)).toContain("openai.alternate/gpt-6.1-sol")
      expect(refs(sol!)).toContain("openai/gpt-6.1-sol")
      expect(groupSeat(sol!).weight).toBe(3)
    }),
  )

  it.effect("a route whose sole seat is the group still candidated the group", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({ integrationID: Integration.ID.make("openai"), value: chatgpt("main-token") })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai.alternate"),
        value: chatgpt("alternate-token"),
      })
      yield* addPlugins(entries())

      const terra = yield* definitionOf("terra-plan")
      expect(terra).toBeDefined()
      expect(refs(terra!)).toContain("openai/gpt-6.1-terra")
      expect(groupSeat(terra!).index).toBeGreaterThan(0)
    }),
  )

  // #1720: a provider route is addressable as a provider of its own, not only as a seat.
  it.effect("registers each member-offered model under the route id with the seat-identical group", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({ integrationID: Integration.ID.make("openai"), value: chatgpt("main-token") })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai.alternate"),
        value: chatgpt("alternate-token"),
      })
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
      yield* addPlugins(entries()).pipe(Effect.ensuring(Effect.sync(() => (console.warn = warn))))

      const models = yield* Model.Service
      const direct = yield* models.get(Provider.ID.make("openai-plan"), Model.ID.make("gpt-6-luna"))
      expect(direct).toBeDefined()
      const definition = ModelRoute.definition(direct!)
      expect(definition).toBeDefined()
      expect(definition!.id).toBe(Model.ID.make("openai-plan/gpt-6-luna"))
      expect(refs(definition!)).toEqual(["openai.alternate/gpt-6-luna", "openai/gpt-6-luna"])
      expect(definition!.nodes.some((node) => node.providerRoute === "openai-plan")).toBe(true)
      expect(definition!.nodes.find((node) => node.providerRoute === "openai-plan")?.selection).toBe("ordered")
      // The route's own models do not include one no member offers.
      expect(yield* models.get(Provider.ID.make("openai-plan"), Model.ID.make("not-a-model"))).toBeUndefined()
      // The synthetic route provider must not read as a concrete provider colliding with the
      // route that created it when the model transform re-expands the seats.
      expect(warnings.filter((line) => line.includes("openai-plan"))).toEqual([])
      expect(refs((yield* definitionOf("terra-plan"))!)).toContain("openai/gpt-6.1-terra")
    }),
  )
})
