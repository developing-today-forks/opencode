import { describe, expect, test } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { AISDK } from "@opencode/core/aisdk"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { Integration } from "@opencode/core/integration"
import { ID, Info, Model, Ref, VariantID } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Info as ConfigInfo } from "@opencode/schema/config"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const catalog = Info.make({
  ...Info.default(Provider.ID.make("deepseek"), ID.make("deepseek-chat")),
  package: Provider.aisdk("@ai-sdk/openai"),
  variants: [{ id: VariantID.make("high") }, { id: VariantID.make("low") }],
})
const runtime = LanguageModel.make({ id: "deepseek-chat", provider: "deepseek", route: OpenAIChat.route })

const configInfo = Schema.decodeUnknownSync(ConfigInfo, { errors: "all", onExcessProperty: "ignore" })({
  aliases: {
    models: {
      flash: "deepseek/deepseek-chat#high",
    },
  },
})
const config = Layer.mock(Config.Service)({
  entries: () => Effect.succeed([{ type: "document", info: configInfo }]),
})
const resolver = ModelResolver.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Provider.Service, { get: () => Effect.undefined }),
      Layer.mock(Model.Service, {
        get: () => Effect.succeed(catalog),
        // #1547 made resolve judge alias precedence against the full
        // enabled model list via all() (#230); the mock must implement
        // it or Layer.mock throws UnimplementedError before the bare-
        // alias tests assert anything (#1584). The catalog entry is in
        // the real all() shape (enabled, providerID, id), so the
        // resolver's exists check is genuinely exercised.
        all: () => Effect.succeed([catalog]),
        available: () => Effect.succeed([catalog]),
      }),
      Layer.mock(Integration.Service, {
        revision: () => 0,
        connection: { active: () => Effect.undefined },
      } as never),
      Layer.mock(Npm.Service, {}),
      Layer.mock(AISDK.Service, { model: () => Effect.succeed(runtime) } as never),
      config,
    ),
  ),
)
const it = testEffect(SessionRunnerModel.layer.pipe(Layer.provide(Layer.mergeAll(resolver, config))))

const session = (model: Ref) =>
  // The runner only reads the session's id and model selection.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  ({ id: SessionSchema.ID.make("ses_runner_model_test"), model }) as unknown as SessionSchema.Info

describe("SessionRunnerModel bare aliases", () => {
  it.effect("expands a bare-alias target with an empty model id through the configured aliases", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(
        session(Ref.make({ providerID: Provider.ID.make("flash"), id: ID.make("") })),
        () => Effect.succeed([catalog]),
      )
      expect(resolved.ref).toEqual(
        Ref.make({
          providerID: Provider.ID.make("deepseek"),
          id: ID.make("deepseek-chat"),
          variant: VariantID.make("high"),
        }),
      )
    }),
  )

  it.effect("expands a bare-alias target that carries its own variant", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      // The target's variant ("low") deliberately differs from the alias
      // target's variant ("high" in flash -> deepseek/deepseek-chat#high):
      // the user's variant must win, not be replaced by the alias's.
      const resolved = yield* models.resolve(
        session(Ref.make({ providerID: Provider.ID.make("flash"), id: ID.make(""), variant: VariantID.make("low") })),
        () => Effect.succeed([catalog]),
      )
      expect(resolved.ref).toEqual(
        Ref.make({
          providerID: Provider.ID.make("deepseek"),
          id: ID.make("deepseek-chat"),
          variant: VariantID.make("low"),
        }),
      )
    }),
  )

  it.effect("names the original bare input when it is neither an alias nor a model", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const error = yield* models
        .resolve(session(Ref.make({ providerID: Provider.ID.make("nope"), id: ID.make("") })), () =>
          Effect.succeed([catalog]),
        )
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      expect(error.message).toBe("Model unavailable: nope")
    }),
  )
})

// A config that declares a provider route no catalog provider backs, as normalized from the
// raw `experimental.provider_routes` shape.
const routedInfo = (() => {
  const result = ConfigNormalize.normalize({
    experimental: { provider_routes: { "mistral-plan": { providers: ["mistral"], selection: "ordered" } } },
  })
  if (result.type !== "normalized") throw new Error("the provider-route config must normalize")
  return Schema.decodeUnknownSync(ConfigInfo, { errors: "all", onExcessProperty: "ignore" })(result.encoded)
})()
const routedConfig = Layer.mock(Config.Service)({
  entries: () => Effect.succeed([{ type: "document", info: routedInfo }]),
})
const itRouted = testEffect(SessionRunnerModel.layer.pipe(Layer.provide(Layer.mergeAll(resolver, routedConfig))))

describe("SessionRunnerModel provider-route diagnostics (#1720)", () => {
  const declared = new Set(["mistral-plan", "openai-plan"])
  const other = [{ providerID: Provider.ID.make("openai-plan") }]

  test("names a configured route that has no eligible member offering the model", () => {
    expect(
      SessionRunnerModel.providerRouteDetail(
        { providerID: "openai-plan", id: "gpt-9" },
        declared,
        other,
      ),
    ).toBe('Provider route "openai-plan" has no eligible member offering "gpt-9".')
  })

  test("names a configured route that never became active", () => {
    expect(
      SessionRunnerModel.providerRouteDetail({ providerID: "mistral-plan", id: "m" }, declared, other),
    ).toContain('Provider route "mistral-plan" is configured but not active')
  })

  test("lists the configured routes for an unknown provider, and stays generic without any", () => {
    expect(
      SessionRunnerModel.providerRouteDetail({ providerID: "mistral-pln", id: "m" }, declared, other),
    ).toBe('No provider or provider route is named "mistral-pln". Configured provider routes: mistral-plan, openai-plan.')
    expect(SessionRunnerModel.providerRouteDetail({ providerID: "x", id: "m" }, new Set(), other)).toBeUndefined()
    // A present concrete provider missing only the model keeps the generic miss.
    expect(
      SessionRunnerModel.providerRouteDetail({ providerID: "openai-plan2", id: "m" }, declared, [
        { providerID: Provider.ID.make("openai-plan2") },
      ]),
    ).toBeUndefined()
  })

  itRouted.effect("carries the route-specific cause in the unavailable-model message", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const error = yield* models
        .resolve(session(Ref.make({ providerID: Provider.ID.make("mistral-plan"), id: ID.make("m") })), () =>
          Effect.succeed([catalog]),
        )
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      expect(error.message).toBe(
        'Model unavailable: mistral-plan/m. Provider route "mistral-plan" is configured but not active: it needs at least one member provider, and its id must not match a provider or a model route (experimental.routes.providers).',
      )
    }),
  )
})

const itResolver = testEffect(resolver)

describe("ModelResolver bare aliases", () => {
  itResolver.effect("expands a bare-alias target that carries its own variant", () =>
    Effect.gen(function* () {
      const resolverService = yield* ModelResolver.Service
      // Same discriminating case as the SessionRunnerModel test above: the
      // target's variant ("low") differs from the alias target's variant
      // ("high" in flash -> deepseek/deepseek-chat#high); the user's variant
      // must win through ModelResolver.resolve too (issue #391).
      const resolved = yield* resolverService.resolve(
        Ref.make({ providerID: Provider.ID.make("flash"), id: ID.make(""), variant: VariantID.make("low") }),
      )
      expect(resolved?.ref).toEqual(
        Ref.make({
          providerID: Provider.ID.make("deepseek"),
          id: ID.make("deepseek-chat"),
          variant: VariantID.make("low"),
        }),
      )
    }),
  )

  itResolver.effect("expands a bare-alias target without a variant to the alias target's variant", () =>
    Effect.gen(function* () {
      const resolverService = yield* ModelResolver.Service
      const resolved = yield* resolverService.resolve(
        Ref.make({ providerID: Provider.ID.make("flash"), id: ID.make("") }),
      )
      expect(resolved?.ref).toEqual(
        Ref.make({
          providerID: Provider.ID.make("deepseek"),
          id: ID.make("deepseek-chat"),
          variant: VariantID.make("high"),
        }),
      )
    }),
  )
})

describe("SessionRunnerModel requestTokens threading (#891)", () => {
  const seen: Array<number | undefined> = []
  const stub = SessionRunnerModel.resolved(runtime, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 100, output: 20 },
  })
  const resolveSeen: Array<number | undefined> = []
  const mockResolver = Layer.mock(ModelResolver.Service)({
    resolve: (_requested, requestTokens) => {
      resolveSeen.push(requestTokens)
      return Effect.succeed(stub)
    },
    resolveModel: (_selected, _variant, _sessionID, requestTokens) => {
      seen.push(requestTokens)
      return Effect.succeed(stub)
    },
  })
  const itThreading = testEffect(SessionRunnerModel.layer.pipe(Layer.provide(Layer.mergeAll(mockResolver, config))))

  itThreading.effect("passes the live request size through to the resolver, and undefined when unknown", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const ref = Ref.make({ providerID: Provider.ID.make("deepseek"), id: ID.make("deepseek-chat") })
      const sized = yield* models.resolve(session(ref), () => Effect.succeed([catalog]), 123_456)
      expect(sized).toBe(stub)
      const unsized = yield* models.resolve(session(ref), () => Effect.succeed([catalog]))
      expect(unsized).toBe(stub)
      // The known size reaches route resolution, where per-target ceilings can skip
      // over-limit leaves; an unknown size stays undefined so it never filters.
      expect(seen).toEqual([123_456, undefined])
    }),
  )

  itThreading.effect("passes the live request size to the default resolution when the session selects no model", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      // A session with no explicit model delegates to ModelResolver.resolve (the global
      // default); the size must follow it there too, or a default route's per-target
      // ceilings never filter (#891).
      const sized = yield* models.resolve(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        { id: SessionSchema.ID.make("ses_runner_model_test") } as unknown as SessionSchema.Info,
        () => Effect.succeed([catalog]),
        98_765,
      )
      expect(sized).toBe(stub)
      expect(resolveSeen).toEqual([98_765])
    }),
  )
})
