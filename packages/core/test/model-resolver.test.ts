import { describe, expect } from "bun:test"
import { LLM, LanguageModel, Message } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/route/client"
import { ConfigProvider, Effect, Layer } from "effect"
import { Headers } from "effect/http"
import { AISDKNative } from "@opencode/core/aisdk-native"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Database } from "@opencode/core/database/database"
import { Compatibility, ID, Info, Model, VariantID } from "@opencode/core/model"
import { ModelPlan } from "@opencode/core/model-plan"
import { Provider } from "@opencode/core/provider"
import { Variant } from "@opencode/core/variant"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ModelRoute } from "@opencode/core/model-route"
import type { QuotaSnapshot } from "@opencode/core/quota-snapshot"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { RouteAttemptTable } from "@opencode/core/model-route-log/sql"
import { ModelRouteAutonomy } from "@opencode/core/model-route-autonomy"
import { AISDK } from "@opencode/core/aisdk"
import { Npm } from "@opencode/util/npm"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { it, testEffect } from "./lib/effect"
import { withTempDir } from "./fixture/tmpdir"

const itWithRouteLog = testEffect(LayerNode.compile(LayerNode.group([ModelRouteLog.node, Database.node])))

interface ModelOptions {
  readonly providerID?: Provider.ID
  readonly canonical?: Provider.ID
  readonly modelID?: string
  readonly compatibility?: Compatibility
  readonly settings?: Info["settings"]
  readonly headers?: Info["headers"]
  readonly body?: Info["body"]
  readonly variants?: Info["variants"]
  readonly limit?: Info["limit"]
}

function model(packageName: string | undefined, options: ModelOptions = {}) {
  const info: Model.MutableInfo = {
    id: ID.make("test-model"),
    modelID: ID.make(options.modelID ?? "api-test-model"),
    providerID: options.providerID ?? Provider.ID.make("test-provider"),
    canonical: options.canonical,
    name: "Test model",
    compatibility: options.compatibility,
    package: packageName,
    settings: options.settings ?? {},
    headers: options.headers ?? { "x-test": "header" },
    body: options.body ?? { custom_extension: { enabled: true } },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: structuredClone(options.variants ?? []) as Model.MutableInfo["variants"],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: options.limit ?? { context: 100, output: 20 },
  }
  AISDKNative.rewrite(info, {
    specifier: packageName,
    providerID: info.providerID,
    canonical: info.canonical,
    modelID: info.modelID,
  })
  return Info.make(info)
}

function withEnv<A, E, R>(variables: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
      Object.entries(variables).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

function withConfigEnv<A, E, R>(env: Record<string, string>, effect: () => Effect.Effect<A, E, R>) {
  return effect().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
}

describe("ModelResolver", () => {
  it.effect("constructs native Azure requests with deployment IDs and projected resource URLs", () =>
    Effect.gen(function* () {
      const responses = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "responses-deployment",
          settings: { resourceName: "modern-resource", apiVersion: "2025-01-01-preview" },
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const chat = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "chat-deployment",
          settings: { resourceName: "modern-resource", useCompletionUrls: true },
        }),
      )
      const deployment = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "legacy-url-deployment",
          settings: {
            resourceName: "modern-resource",
            apiVersion: "2025-01-01-preview",
            useDeploymentBasedUrls: true,
          },
        }),
      )
      const compatible = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          providerID: Provider.ID.azure,
          modelID: "legacy-deployment",
          settings: {
            resourceName: "legacy-resource",
            baseURL: "https://legacy-resource.cognitiveservices.azure.com/openai",
          },
        }),
      )

      expect(responses).toMatchObject({ id: "responses-deployment", provider: "azure" })
      expect(responses.route).toMatchObject({
        id: "azure-openai-responses",
        endpoint: {
          baseURL: "https://modern-resource.openai.azure.com/openai/v1",
          query: { "api-version": "2025-01-01-preview" },
        },
      })
      expect(chat).toMatchObject({ id: "chat-deployment", provider: "azure" })
      expect(chat.route.id).toBe("azure-openai-chat")
      expect(deployment).toMatchObject({ id: "legacy-url-deployment", provider: "azure" })
      expect(deployment.route.endpoint).toMatchObject({
        baseURL: "https://modern-resource.openai.azure.com/openai/deployments/legacy-url-deployment",
        query: { "api-version": "2025-01-01-preview" },
      })
      expect(compatible).toMatchObject({ id: "legacy-deployment", provider: "azure" })
      expect(compatible.route.endpoint.baseURL).toBe("https://legacy-resource.cognitiveservices.azure.com/openai")
    }),
  )

  it.effect("routes compatible packages to the host's dedicated package when one exists", () =>
    Effect.gen(function* () {
      const routes = {
        "alibaba-coding-plan-cn": "alibaba-chat",
        baseten: "baseten-chat",
        deepseek: "deepseek-chat",
        "fireworks-ai": "fireworks-chat",
        "moonshotai-cn": "moonshot-chat",
        zhipuai: "zai-chat",
        "zhipuai-coding-plan": "zai-coding-chat",
        cerebras: "openai-compatible-chat",
        deepinfra: "openai-compatible-chat",
        groq: "openai-compatible-chat",
        togetherai: "openai-compatible-chat",
      }
      for (const [providerID, route] of Object.entries(routes)) {
        const selected = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai-compatible"), {
            providerID: Provider.ID.make(providerID),
            settings: { baseURL: "https://provider.example/v1/openai", apiKey: "fixture" },
          }),
        )
        expect(String(selected.provider)).toBe(providerID)
        expect(selected.route.id).toBe(route)
        expect(selected.route.endpoint.baseURL).toBe("https://provider.example/v1/openai")
        const prepared = yield* compileRequest(LLM.request({ model: selected, prompt: "Hello" }))
        expect(prepared.body.messages).toEqual([{ role: "user", content: "Hello" }])
        expect(prepared.body).not.toHaveProperty("apiKey")
      }
    }),
  )

  it.effect("resolves environment templates before native providers inspect endpoints", () =>
    withEnv({ AZURE_HOST: "resource.openai.azure.com" }, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/azure"), {
            providerID: Provider.ID.azure,
            settings: { baseURL: "https://${AZURE_HOST}/openai" },
          }),
        )

        expect(resolved.route.endpoint).toMatchObject({
          baseURL: "https://resource.openai.azure.com/openai/v1",
          query: { "api-version": "v1" },
        })
      }),
    ),
  )

  it.effect("maps Bedrock Mantle GPT-OSS models to Chat and other models to Responses", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "secret" })
      const responses = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          modelID: "openai.gpt-5.5",
          settings: { region: "us-east-2" },
        }),
        credential,
      )
      const chat = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          modelID: "openai.gpt-oss-20b",
          settings: { region: "us-east-2" },
        }),
        credential,
      )

      expect(responses.route).toMatchObject({
        id: "bedrock-mantle-responses",
        endpoint: { baseURL: "https://bedrock-mantle.us-east-2.api.aws/v1" },
      })
      expect(chat.route).toMatchObject({
        id: "bedrock-mantle-chat",
        endpoint: { baseURL: "https://bedrock-mantle.us-east-2.api.aws/v1" },
      })
    }),
  )

  it.effect("resolves Bedrock Mantle catalog endpoints from the configured region", () =>
    withEnv({ AWS_REGION: undefined }, () =>
      Effect.gen(function* () {
        const catalog = model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          providerID: Provider.ID.amazonBedrock,
          modelID: "openai.gpt-5.5",
          settings: {
            region: "us-west-2",
            baseURL: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1",
          },
        })
        const resolved = yield* ModelResolver.fromCatalogModel(catalog)

        expect(resolved.route).toMatchObject({
          id: "bedrock-mantle-responses",
          endpoint: { baseURL: "https://bedrock-mantle.us-west-2.api.aws/openai/v1" },
        })
        expect(catalog.settings?.baseURL).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1")
      }),
    ),
  )

  it.effect("prefers the configured Mantle region over the environment", () =>
    withEnv({ AWS_REGION: "us-east-1" }, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
            modelID: "openai.gpt-5.5",
            settings: {
              region: "us-west-2",
              baseURL: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1",
            },
          }),
        )

        expect(resolved.route.endpoint.baseURL).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1")
      }),
    ),
  )

  it.effect("uses the API modelID instead of the catalog ID for native OpenAI routes", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
        limit: { context: 100, input: 80, output: 20 },
      })
      const resolved = yield* ModelResolver.fromCatalogModel(
        catalog,
        Credential.Key.make({ type: "key", key: "secret" }),
      )

      expect(catalog.id).toBe(ID.make("test-model"))
      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        providerMetadataKey: "openai",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body.max_output_tokens).toBeUndefined()
      expect(JSON.stringify(prepared.body)).not.toContain("max_output_tokens")
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { apiKey: "secret", baseURL: "https://openai.example/v1" },
        }),
      )
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("treats an empty configured API key as omitted", () =>
    withConfigEnv({ OPENAI_API_KEY: "environment-key" }, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai"), {
            settings: { apiKey: "", baseURL: "https://openai.example/v1" },
          }),
        )
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        })

        expect(headers.authorization).toBe("Bearer environment-key")
      }),
    ),
  )

  it.effect("uses no native API-key auth for explicitly enabled providers without credentials", () => {
    const selected = model(Provider.aisdk("@ai-sdk/google"), {
      providerID: Provider.ID.make("gateway"),
      canonical: Provider.ID.google,
      settings: { baseURL: "https://gateway.example.com/v1" },
      headers: { "cf-access-token": "access-token" },
    })
    const selections = [
      selected,
      model(Provider.aisdk("@ai-sdk/mistral"), {
        providerID: Provider.ID.make("gateway"),
        settings: { baseURL: "https://mistral.example.com/v1" },
        headers: { "cf-access-token": "access-token" },
      }),
      model("@opencode/ai/providers/mistral", {
        providerID: Provider.ID.make("gateway"),
        settings: { baseURL: "https://native-mistral.example.com/v1" },
        headers: { "cf-access-token": "access-token" },
      }),
      ...["baseten", "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks"].map((name) =>
        model(`@opencode/ai/providers/${name}`, {
          providerID: Provider.ID.make("gateway"),
          settings: { baseURL: `https://${name}.example.com/v1` },
          headers: { "cf-access-token": "access-token" },
        }),
      ),
    ]
    const provider = Provider.Info.make({
      ...Provider.Info.empty(selected.providerID),
      activation: "enabled",
      package: selected.package ?? "",
      settings: selected.settings,
      headers: selected.headers,
    })
    const providers = Layer.mock(Provider.Service, {
      get: () => Effect.succeed(provider),
    })
    const models = Layer.mock(Model.Service, {
      get: () => Effect.succeed(selected),
    })
    const integrations = Layer.mock(Integration.Service, {
      revision: () => 0,
      connection: {
        active: (id) => {
          expect(id).toBe(Integration.ID.make("gateway"))
          return Effect.undefined
        },
        resolve: () => Effect.die("unused"),
        key: () => Effect.die("unused"),
        external: () => Effect.die("unused"),
        activate: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
      },
      oauth: {
        connect: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      },
      command: {
        connect: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      },
    })
    const npm = Layer.mock(Npm.Service, {
      add: () => Effect.die("unused"),
      which: () => Effect.die("unused"),
    })
    const aisdk = Layer.mock(AISDK.Service, {
      hook: {
        sdk: () => Effect.die("unused"),
        language: () => Effect.die("unused"),
      },
      model: () => Effect.die("unused"),
    })
    const layer = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))

    return withConfigEnv({}, () =>
      Effect.gen(function* () {
        const resolver = yield* ModelResolver.Service
        yield* Effect.forEach(selections, (selection) =>
          Effect.gen(function* () {
            const resolved = yield* resolver.resolveModel(selection)
            const headers = yield* resolved.model.route.auth.apply({
              request: LLM.request({ model: resolved.model, prompt: "Hello" }),
              method: "POST",
              url: resolved.model.route.endpoint.baseURL ?? "",
              body: "{}",
              headers: Headers.fromInput(resolved.model.route.defaults.headers),
            })

            expect(resolved.limit).toEqual(selection.limit)
            expect(resolved.ref.providerID).toBe(selection.providerID)
            expect(String(resolved.model.provider)).toBe(selection.canonical ?? selection.providerID)
            expect(headers["cf-access-token"]).toBe("access-token")
            expect(headers.authorization).toBeUndefined()
            expect(headers["x-goog-api-key"]).toBeUndefined()
          }),
        )
      }).pipe(Effect.provide(layer)),
    )
  })

  it.effect("keeps native provider environment auth strict when no API key is configured", () =>
    withConfigEnv({}, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/google"), {
            settings: { baseURL: "https://google.example.com/v1" },
          }),
        )
        const exit = yield* Effect.exit(
          resolved.route.auth.apply({
            request: LLM.request({ model: resolved, prompt: "Hello" }),
            method: "POST",
            url: "https://google.example.com/v1",
            body: "{}",
            headers: Headers.empty,
          }),
        )

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          canonical: Provider.ID.make("deepseek"),
          compatibility: {
            reasoningField: "vendor_reasoning",
            requireReasoning: true,
            maxTokensField: "max_completion_tokens",
            requireFinishReason: false,
            requireAssistantAfterTool: true,
          },
          settings: {
            apiKey: "settings-secret",
            baseURL: "https://compatible.example/v1",
            compatibility: "strict",
          },
          headers: {},
          body: {},
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello", generation: { maxTokens: 10 } })
      const prepared = yield* compileRequest(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.id).toBe("openai-compatible-chat")
      expect(String(resolved.provider)).toBe("deepseek")
      expect(resolved.route.providerMetadataKey).toBe("deepseek")
      expect(resolved.compatibility?.reasoningField).toBe("vendor_reasoning")
      expect(resolved.compatibility?.requireReasoning).toBe(true)
      expect(resolved.compatibility?.maxTokensField).toBe("max_completion_tokens")
      expect(resolved.compatibility?.requireFinishReason).toBe(false)
      expect(resolved.compatibility?.requireAssistantAfterTool).toBe(true)
      expect(prepared.body).toMatchObject({ max_completion_tokens: 10 })
      expect(prepared.body).not.toHaveProperty("max_tokens")
      expect(resolved.route.endpoint.baseURL).toBe("https://compatible.example/v1")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("resolves provider URLs from environment without mutating the catalog model", () =>
    withEnv({ ACME_HOST: "api.acme.test" }, () =>
      Effect.gen(function* () {
        const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          settings: { baseURL: "https://${ACME_HOST}/v1" },
        })
        const resolved = yield* ModelResolver.fromCatalogModel(catalog)

        expect(resolved.route.endpoint.baseURL).toBe("https://api.acme.test/v1")
        expect(catalog.settings?.baseURL).toBe("https://${ACME_HOST}/v1")
      }),
    ),
  )

  it.effect("rejects unresolved variables in constructed provider routes", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai-compatible"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/${REQUIRED_PATH}/v1" },
          }),
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          providerID: "test-provider",
          modelID: "test-model",
          variables: ["REQUIRED_HOST", "REQUIRED_PATH"],
        })
        expect(failure.message).toBe(
          "Cannot initialize test-provider/test-model: REQUIRED_HOST, REQUIRED_PATH are required to resolve the provider endpoint",
        )
      }),
    ),
  )

  it.effect("overlays selected OpenAI variant settings and bodies", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
        variants: [
          {
            id: VariantID.make("xhigh"),
            settings: {
              reasoningEffort: "xhigh",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            headers: { "x-variant": "high" },
            body: {
              store: false,
              service_tier: "priority",
              temperature: 0.2,
            },
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(
        catalog,
        VariantID.make("xhigh"),
        Credential.Key.make({ type: "key", key: "secret" }),
      )

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        service_tier: "priority",
        temperature: 0.2,
      })
      expect(resolved.route.defaults.providerOptions).toEqual({
        store: false,
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body).toMatchObject({
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "xhigh", summary: "auto" },
      })
    }),
  )

  it.effect("sends xAI Responses effort variants with reasoning summaries", () =>
    Effect.gen(function* () {
      const base = model("@opencode/ai/providers/xai", { providerID: Provider.ID.make("xai"), modelID: "grok-4.6" })
      const catalog = Info.make({
        ...base,
        variants: Variant.resolve(base, [{ type: "effort", values: ["low", "high"] }]),
      })
      const resolved = yield* ModelResolver.resolveModel(
        catalog,
        VariantID.make("high"),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.id).toBe("xai-responses")
      expect(prepared.body).toMatchObject({
        reasoning: { effort: "high", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      })
      expect(prepared.body).not.toHaveProperty("reasoning_effort")
    }),
  )

  it.effect("overlays selected OpenAI-compatible variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
        settings: { baseURL: "https://compatible.example/v1" },
        variants: [
          {
            id: VariantID.make("high"),
            settings: {},
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(catalog, VariantID.make("high"))

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      })
    }),
  )

  it.effect("rejects an explicit unavailable variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
      })
      const failure = yield* ModelResolver.resolveModel(catalog, VariantID.make("unknown")).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
      expect(failure.message).toBe("Variant unavailable for test-provider/test-model: unknown")
    }),
  )

  it.effect("overlays selected Anthropic variant settings", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/anthropic"), {
        settings: { baseURL: "https://anthropic.example/v1" },
        variants: [
          {
            id: VariantID.make("high"),
            settings: { thinking: { type: "enabled", budgetTokens: 12000 } },
            headers: {},
            body: {},
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(catalog, VariantID.make("high"))

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
      })
      expect(resolved.route.defaults.providerOptions).toEqual({
        thinking: { type: "enabled", budgetTokens: 12000 },
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/anthropic"), {
          settings: { baseURL: "https://anthropic.example/v1" },
        }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        providerMetadataKey: "anthropic",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "stored-secret" })
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { apiKey: "configured-secret", baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
    }),
  )

  it.effect("lets Azure CLI requests past package auth for the Azure plugin to authorize", () =>
    withConfigEnv({}, () =>
      Effect.gen(function* () {
        const credential = Credential.External.make({
          type: "external",
          methodID: Integration.MethodID.make("azure-cli"),
          metadata: { resourceName: "cli-resource" },
        })
        const azure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/azure"), { providerID: Provider.ID.azure, headers: {}, body: {} }),
          credential,
        )
        const foundry = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/anthropic"), {
            providerID: Provider.ID.azure,
            settings: { baseURL: "https://cli-resource.services.ai.azure.com/anthropic/v1" },
            headers: {},
            body: {},
          }),
          credential,
        )
        const authorize = (resolved: LanguageModel) =>
          resolved.route.auth.apply({
            request: LLM.request({ model: resolved, prompt: "Hello" }),
            method: "POST",
            url: "https://cli-resource.openai.azure.com/openai/v1/responses",
            body: "{}",
            headers: Headers.empty,
          })

        expect(azure.route.endpoint.baseURL).toBe("https://cli-resource.openai.azure.com/openai/v1")
        expect((yield* authorize(azure))["api-key"]).toBe("azure-cli")
        expect((yield* authorize(foundry)).authorization).toBe("Bearer azure-cli")
      }),
    ),
  )

  it.effect("does not project API key metadata into the request body", () =>
    Effect.gen(function* () {
      // V1 auth.json stored connect-form answers as API key metadata, and the legacy import preserves them there.
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "responses-deployment",
          settings: { apiVersion: "2025-01-01-preview" },
          headers: {},
          body: {},
        }),
        Credential.Key.make({ type: "key", key: "secret", metadata: { resourceName: "migrated-resource" } }),
      )

      expect(resolved.route.endpoint.baseURL).toBe("https://migrated-resource.openai.azure.com/openai/v1")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("does not project OAuth account metadata into the request body", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { server: "https://console.example", orgID: "org_123" },
        }),
      )

      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("applies plugin-projected OpenAI endpoint and headers", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/openai", {
          settings: { baseURL: "https://chatgpt.com/backend-api/codex" },
          headers: { "chatgpt-account-id": "acct_123" },
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      )
      const request = LLM.request({
        model: resolved,
        system: [
          { type: "text", text: "Base instructions." },
          { type: "text", text: "Project instructions." },
        ],
        messages: [Message.user("Hello"), Message.system("Updated instructions.")],
      })
      const prepared = yield* compileRequest(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://chatgpt.com/backend-api/codex/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://chatgpt.com/backend-api/codex" },
      })
      expect(resolved.route.defaults.headers).toMatchObject({ "chatgpt-account-id": "acct_123" })
      expect(headers.authorization).toBe("Bearer chatgpt-token")
      expect(prepared.body).toMatchObject({
        instructions: "Base instructions.\nProject instructions.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Hello" }] },
          { role: "developer", content: "Updated instructions." },
        ],
      })
    }),
  )

  it.effect("does not route native OpenAI-compatible packages to the codex backend", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/openai-compatible", {
          settings: { baseURL: "https://compatible.example/v1" },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      )

      expect(resolved.route.id).toBe("openai-compatible-chat")
      expect(resolved.route.endpoint.baseURL).toBe("https://compatible.example/v1")
    }),
  )

  it.effect("maps legacy OpenAI organization and project settings to headers", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { organization: "org_123", project: "proj_123" },
        }),
      )

      expect(resolved.route.defaults.headers).toMatchObject({
        "OpenAI-Organization": "org_123",
        "OpenAI-Project": "proj_123",
      })
    }),
  )

  it.effect("keeps non-ChatGPT OAuth credentials on the configured endpoint", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "oauth-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(resolved.route.endpoint.baseURL).toBe("https://openai.example/v1")
      expect(headers.authorization).toBe("Bearer oauth-token")
      expect(headers["chatgpt-account-id"]).toBeUndefined()
    }),
  )

  it.effect("loads dynamic native provider packages through the injected package loader", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      const resolved = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/custom", {
          settings: { region: "test" },
          headers: { "x-package": "header" },
          body: { custom: true },
        }),
        undefined,
        {
          loadPackage: (specifier) => {
            expect(specifier).toBe("@opencode/ai/providers/custom")
            return Effect.succeed({
              model: (modelID, settings) => {
                expect(modelID).toBe("api-test-model")
                expect(settings).toEqual({
                  region: "test",
                  headers: { "x-package": "header" },
                  body: { custom: true },
                })
                return LanguageModel.make({ id: modelID, provider: "package-provider", route: native.route })
              },
            })
          },
        },
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
    }),
  )

  it.effect("maps OAuth credentials to native provider auth settings", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      const credential = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "oauth-token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      })
      const packages = [
        ["@opencode/ai/providers/google-vertex", "accessToken"],
        ["@opencode/ai/providers/google-vertex/gemini", "accessToken"],
        ["@opencode/ai/providers/google-vertex/interactions", "accessToken"],
        ["@opencode/ai/providers/google-vertex/chat", "accessToken"],
        ["@opencode/ai/providers/google-vertex/responses", "accessToken"],
        ["@opencode/ai/providers/google-vertex/messages", "accessToken"],
        ["@opencode/ai/providers/anthropic", "authToken"],
        ["@opencode/ai/providers/anthropic-compatible", "authToken"],
      ] as const

      yield* Effect.forEach(packages, ([specifier, key]) =>
        ModelResolver.fromCatalogModel(model(specifier, { settings: { apiKey: "configured-key" } }), credential, {
          loadPackage: () =>
            Effect.succeed({
              model: (modelID, settings) => {
                expect(settings).toMatchObject({ [key]: "oauth-token" })
                expect(settings).not.toHaveProperty("apiKey")
                return LanguageModel.make({ id: modelID, provider: "package-provider", route: native.route })
              },
            }),
        }),
      )
    }),
  )

  it.effect("routes supported AISDK catalog packages through native provider packages", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/openai")))
      const packages = [
        [
          "@ai-sdk/openai",
          "@opencode/ai/providers/openai",
          {
            reasoningEffort: "xhigh",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
          {
            reasoningEffort: "xhigh",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ],
        [
          "@ai-sdk/anthropic",
          "@opencode/ai/providers/anthropic",
          { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
          { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
        ],
        [
          "@ai-sdk/cerebras",
          "@opencode/ai/providers/cerebras",
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
        ],
        [
          "@ai-sdk/deepinfra",
          "@opencode/ai/providers/deepinfra",
          { reasoningEffort: "none" },
          { reasoningEffort: "none" },
        ],
        [
          "@ai-sdk/openai-compatible",
          "@opencode/ai/providers/openai-compatible",
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
        ],
        [
          "@ai-sdk/google",
          "@opencode/ai/providers/google",
          { thinkingConfig: { thinkingLevel: "high" } },
          { thinkingConfig: { thinkingLevel: "high" } },
        ],
        [
          "@ai-sdk/google-vertex",
          "@opencode/ai/providers/google-vertex",
          { thinkingConfig: { thinkingLevel: "high" } },
          { thinkingConfig: { thinkingLevel: "high" } },
        ],
        [
          "@openrouter/ai-sdk-provider",
          "@opencode/ai/providers/openrouter",
          { reasoning: { effort: "high" } },
          { reasoning: { effort: "high" } },
        ],
        [
          "@ai-sdk/groq",
          "@opencode/ai/providers/groq",
          { reasoningEffort: "high", parallelToolCalls: false },
          { reasoningEffort: "high", parallelToolCalls: false },
        ],
        [
          "@ai-sdk/mistral",
          "@opencode/ai/providers/mistral",
          {
            safePrompt: true,
            documentImageLimit: 4,
            promptCacheKey: "session-123",
            promptMode: "reasoning",
            reasoningEffort: "high",
          },
          {
            safePrompt: true,
            documentImageLimit: 4,
            promptCacheKey: "session-123",
            promptMode: "reasoning",
            reasoningEffort: "high",
          },
        ],
        [
          "@ai-sdk/togetherai",
          "@opencode/ai/providers/togetherai",
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
        ],
        ["@ai-sdk/xai", "@opencode/ai/providers/xai", { reasoningEffort: "high" }, { reasoningEffort: "high" }],
      ] as const

      yield* Effect.forEach(packages, ([catalogPackage, nativePackage, sourceOptions, providerOptions]) =>
        ModelResolver.fromCatalogModel(
          model(Provider.aisdk(catalogPackage), {
            modelID: "api-model",
            settings: { baseURL: "https://provider.example/v1", ...sourceOptions },
            headers: { "x-provider": "header" },
            body: { custom: true },
          }),
          Credential.Key.make({ type: "key", key: "secret" }),
          {
            loadPackage: (specifier) => {
              expect(specifier).toBe(nativePackage)
              return Effect.succeed({
                model: (modelID, settings) => {
                  expect(modelID).toBe("api-model")
                  expect(settings).toMatchObject({
                    apiKey: "secret",
                    baseURL: "https://provider.example/v1",
                    headers: { "x-provider": "header" },
                    body: { custom: true },
                    ...providerOptions,
                  })
                  return LanguageModel.make({ id: modelID, provider: "native-provider", route: native.route })
                },
              })
            },
            loadAISDK: () => Effect.die("AI SDK loader should not be called"),
          },
        ),
      )
    }),
  )

  it.effect("never loads the AI SDK for packages with native implementations", () =>
    Effect.gen(function* () {
      const packages = [
        ["@ai-sdk/alibaba", "@opencode/ai/providers/alibaba/chat", "api-model"],
        ["@ai-sdk/anthropic", "@opencode/ai/providers/anthropic", "api-model"],
        ["@ai-sdk/amazon-bedrock", "@opencode/ai/providers/amazon-bedrock", "api-model"],
        ["@ai-sdk/amazon-bedrock/mantle", "@opencode/ai/providers/amazon-bedrock/mantle/chat", "openai.gpt-oss-120b"],
        ["@ai-sdk/azure", "@opencode/ai/providers/azure/responses", "api-model"],
        ["@ai-sdk/cerebras", "@opencode/ai/providers/cerebras", "api-model"],
        ["@ai-sdk/deepinfra", "@opencode/ai/providers/deepinfra", "api-model"],
        ["@ai-sdk/google", "@opencode/ai/providers/google", "api-model"],
        ["@ai-sdk/google-vertex", "@opencode/ai/providers/google-vertex", "api-model"],
        ["@ai-sdk/google-vertex/anthropic", "@opencode/ai/providers/google-vertex/messages", "claude-sonnet-4-6"],
        ["@ai-sdk/groq", "@opencode/ai/providers/groq", "api-model"],
        ["@ai-sdk/mistral", "@opencode/ai/providers/mistral", "api-model"],
        ["@ai-sdk/openai", "@opencode/ai/providers/openai", "api-model"],
        ["@ai-sdk/openai-compatible", "@opencode/ai/providers/openai-compatible", "api-model"],
        ["@openrouter/ai-sdk-provider", "@opencode/ai/providers/openrouter", "api-model"],
        ["@ai-sdk/togetherai", "@opencode/ai/providers/togetherai", "api-model"],
        ["@ai-sdk/gateway", "@opencode/ai/providers/vercel-ai-gateway", "openai/gpt-5.4"],
        ["@ai-sdk/xai", "@opencode/ai/providers/xai", "api-model"],
        ["ai-gateway-provider", "@opencode/ai/providers/cloudflare-ai-gateway", "xai/grok-4.6"],
      ] as const

      yield* Effect.forEach(packages, ([catalogPackage, nativePackage, modelID]) =>
        ModelResolver.fromCatalogModel(
          model(Provider.aisdk(catalogPackage), {
            modelID,
            settings: { baseURL: "https://provider.example/v1", region: "us-east-1" },
          }),
          undefined,
          {
            loadPackage: (specifier) => {
              expect(specifier).toBe(nativePackage)
              return Effect.succeed({
                model: (id) => LanguageModel.make({ id, provider: "native-provider", route: OpenAIChat.route }),
              })
            },
            loadAISDK: () => Effect.die(`AI SDK loader called for ${catalogPackage}`),
          },
        ),
      )
    }),
  )

  it.effect("routes Vertex Anthropic catalog models through native Messages", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/openai")))
      const credential = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "vertex-token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      })

      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/google-vertex/anthropic"), {
          modelID: "claude-sonnet-4-6",
          settings: {
            location: "eu",
            project: "vertex-project",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
          },
        }),
        credential,
        {
          loadPackage: (specifier) => {
            expect(specifier).toBe("@opencode/ai/providers/google-vertex/messages")
            return Effect.succeed({
              model: (modelID, settings) => {
                expect(modelID).toBe("claude-sonnet-4-6")
                expect(settings).toMatchObject({
                  accessToken: "vertex-token",
                  location: "eu",
                  project: "vertex-project",
                  thinking: { type: "adaptive", display: "summarized" },
                  effort: "high",
                })
                return LanguageModel.make({ id: modelID, provider: "native-provider", route: native.route })
              },
            })
          },
          loadAISDK: () => Effect.die("AI SDK loader should not be called"),
        },
      )

      expect(resolved).toMatchObject({ id: "claude-sonnet-4-6", provider: "test-provider" })
    }),
  )

  it.effect("merges mapped OpenRouter headers and body with catalog overlays", () =>
    ModelResolver.fromCatalogModel(
      model(Provider.aisdk("@openrouter/ai-sdk-provider"), {
        settings: {
          appName: "OpenCode",
          appUrl: "https://opencode.ai",
          extraBody: { transforms: ["middle-out"], provider: { sort: "price" } },
        },
        headers: { "X-OpenRouter-Title": "Custom" },
        body: { provider: { only: ["anthropic"] } },
      }),
      undefined,
      {
        loadPackage: () =>
          Effect.succeed({
            model: (modelID, settings) => {
              expect(settings.headers).toEqual({
                "HTTP-Referer": "https://opencode.ai",
                "X-OpenRouter-Title": "Custom",
              })
              expect(settings.body).toEqual({
                transforms: ["middle-out"],
                provider: { sort: "price", only: ["anthropic"] },
              })
              return LanguageModel.make({ id: modelID, provider: "openrouter", route: OpenAIChat.route })
            },
          }),
      },
    ),
  )

  it.effect("merges mapped Mistral headers and body with catalog overlays", () =>
    ModelResolver.fromCatalogModel(
      model(Provider.aisdk("@ai-sdk/mistral"), {
        settings: {
          headers: { "x-factory": "factory", "x-shared": "factory" },
          extraBody: { factory: true, custom: { source: true } },
        },
        headers: { "x-shared": "catalog" },
        body: { custom: { catalog: true } },
      }),
      undefined,
      {
        loadPackage: () =>
          Effect.succeed({
            model: (modelID, settings) => {
              expect(settings.headers).toEqual({
                "x-factory": "factory",
                "x-shared": "catalog",
              })
              expect(settings.body).toEqual({
                factory: true,
                custom: { source: true, catalog: true },
              })
              return LanguageModel.make({ id: modelID, provider: "mistral", route: OpenAIChat.route })
            },
          }),
      },
    ),
  )

  it.effect("loads supported AISDK catalog packages as native routes", () =>
    Effect.gen(function* () {
      const google = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/google"), { settings: { thinkingConfig: { thinkingBudget: 1_024 } } }),
      )
      const openrouter = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@openrouter/ai-sdk-provider"), {
          settings: { reasoning: { effort: "high" } },
        }),
      )
      const cerebras = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/cerebras"), { settings: { reasoningEffort: "high" } }),
      )
      const deepinfra = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/deepinfra"), {
          settings: { baseURL: "https://deepinfra.example/provider-root", reasoningEffort: "none" },
        }),
      )
      const togetherai = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/togetherai"), { settings: { reasoningEffort: "high" } }),
      )
      const groq = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/groq"), {
          settings: { reasoningEffort: "high", parallelToolCalls: false },
        }),
      )
      const mistral = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/mistral"), {
          settings: { safePrompt: true, promptCacheKey: "session-123", reasoningEffort: "high" },
        }),
      )
      const xai = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/xai"), { settings: { reasoningEffort: "high" } }),
      )
      const bedrock = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock"), {
          settings: { region: "us-east-1", topP: 0.8, serviceTier: "priority" },
          body: {},
        }),
      )
      const mantle = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          modelID: "openai.gpt-oss-120b",
          settings: { region: "us-east-1", topP: 0.6 },
        }),
      )
      const workers = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/cloudflare-workers-ai", {
          modelID: "@cf/meta/llama-3.1-8b-instruct",
        }),
        Credential.Key.make({
          type: "key",
          key: "workers-secret",
          configuration: { accountId: "account" },
        }),
      )

      expect(google.route.id).toBe("gemini")
      expect(google.route.defaults.providerOptions).toEqual({ thinkingConfig: { thinkingBudget: 1_024 } })
      expect(openrouter.route.id).toBe("openrouter")
      expect(openrouter.route.defaults.providerOptions).toEqual({ reasoning: { effort: "high" } })
      expect(cerebras.route.id).toBe("cerebras-chat")
      expect(cerebras.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
      expect(String(cerebras.provider)).toBe("test-provider")
      expect(deepinfra.route.id).toBe("deepinfra-chat")
      expect(deepinfra.route.endpoint.baseURL).toBe("https://deepinfra.example/provider-root/openai")
      expect(deepinfra.route.defaults.providerOptions).toEqual({ reasoningEffort: "none" })
      expect(String(deepinfra.provider)).toBe("test-provider")
      expect(togetherai.route.id).toBe("togetherai-chat")
      expect(togetherai.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
      expect(String(togetherai.provider)).toBe("test-provider")
      expect(groq.route.id).toBe("groq-chat")
      expect(groq.route.protocol).toBe("groq-chat")
      expect(groq.route.defaults.providerOptions).toEqual({ reasoningEffort: "high", parallelToolCalls: false })
      expect(String(groq.provider)).toBe("test-provider")
      expect(mistral.route.id).toBe("mistral-chat")
      expect(mistral.route.defaults.providerOptions).toEqual({
        safePrompt: true,
        promptCacheKey: "session-123",
        reasoningEffort: "high",
      })
      expect(String(mistral.provider)).toBe("test-provider")
      expect(xai.route.id).toBe("xai-responses")
      expect(xai.route.defaults.providerOptions).toEqual({
        reasoningEffort: "high",
        store: false,
        include: ["reasoning.encrypted_content"],
      })
      expect(bedrock.route.id).toBe("bedrock-converse")
      expect(bedrock.route.defaults.generation).toEqual({ topP: 0.8 })
      expect(bedrock.route.defaults.http?.body).toEqual({ serviceTier: { type: "priority" } })
      expect(mantle.route.id).toBe("bedrock-mantle-chat")
      expect(mantle.route.defaults.generation).toEqual({ topP: 0.6 })
      expect(workers.route.endpoint.baseURL).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/v1")
    }),
  )

  it.effect("loads arbitrary AISDK packages through the injected AISDK loader", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/perplexity"), {
          modelID: "perplexity-api-model",
          settings: { project: "test" },
          headers: { "x-aisdk": "header" },
          body: { custom: true },
        }),
        Credential.Key.make({
          type: "key",
          key: "fallback-secret",
          configuration: { accountId: "account" },
        }),
        {
          loadAISDK: (runtime) =>
            Effect.sync(() => {
              expect(runtime).toMatchObject({
                id: "test-model",
                modelID: "perplexity-api-model",
                providerID: "test-provider",
                package: Provider.aisdk("@ai-sdk/perplexity"),
                settings: { project: "test", apiKey: "fallback-secret", accountId: "account" },
                headers: { "x-aisdk": "header" },
                body: { custom: true },
              })
              return LanguageModel.make({
                id: runtime.modelID ?? runtime.id,
                provider: runtime.providerID,
                route: native.route,
              })
            }),
        },
      )

      expect(resolved).toMatchObject({ id: "perplexity-api-model", provider: "test-provider" })
    }),
  )

  it.effect("rejects unresolved variables before loading opaque AISDK packages", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/perplexity"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/v1" },
          }),
          undefined,
          { loadAISDK: () => Effect.die("AI SDK loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["REQUIRED_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects placeholders introduced by environment expansion before loading providers", () =>
    withEnv({ PROVIDER_HOST: "${MISSING_HOST}", MISSING_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/perplexity"), {
            settings: { baseURL: "https://${PROVIDER_HOST}/v1" },
          }),
          undefined,
          { loadAISDK: () => Effect.die("AI SDK loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["MISSING_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects unresolved variables before loading native provider packages", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/google"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/v1" },
          }),
          undefined,
          { loadPackage: () => Effect.die("Native package loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["REQUIRED_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects AISDK packages without an available loader", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/perplexity"), {
          settings: { baseURL: "https://perplexity.example/v1" },
        }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedPackageError",
        providerID: "test-provider",
        modelID: "test-model",
        package: "aisdk:@ai-sdk/perplexity",
      })
      expect(failure.message).toBe("Unsupported package for test-provider/test-model: aisdk:@ai-sdk/perplexity")
    }),
  )

  it.effect("reports provider configuration errors from supported packages", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "gpt-5.4-nano",
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("oauth"),
          access: "oauth-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ModelConfigurationError",
        providerID: "azure",
        modelID: "test-model",
        package: "@opencode/ai/providers/azure/responses",
        detail: "Azure requires resourceName or baseURL",
      })
      expect(failure.message).toBe("Cannot initialize azure/test-model: Azure requires resourceName or baseURL")
    }),
  )

  it.effect("distinguishes unexpected constructor failures from configuration errors", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(model("@opencode/ai/providers/custom"), undefined, {
        loadPackage: () =>
          Effect.succeed({
            model: () => {
              throw new Error("custom provider crashed")
            },
          }),
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "construct",
        detail: "custom provider crashed",
      })
    }),
  )

  it.effect("reports package load and AISDK initialization failures with their causes", () =>
    Effect.gen(function* () {
      const load = yield* ModelResolver.fromCatalogModel(model("@opencode/ai/providers/custom"), undefined, {
        loadPackage: (specifier) =>
          Effect.fail(
            new Provider.LoadError({ package: specifier, cause: new Error(`Provider package ${specifier} is broken`) }),
          ),
      }).pipe(Effect.flip)
      expect(load).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "load",
        detail: "Provider package @opencode/ai/providers/custom is broken",
      })

      const init = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/perplexity")), undefined, {
        loadAISDK: (runtime) =>
          Effect.fail(
            new AISDK.InitError({ providerID: runtime.providerID, cause: new Error("Perplexity plugin failed") }),
          ),
      }).pipe(Effect.flip)
      expect(init).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "init",
        detail: "Perplexity plugin failed",
      })
      expect(init.message).toBe("Cannot initialize test-provider/test-model: Perplexity plugin failed")
    }),
  )

  it.effect("drops an empty API key before loading an AISDK package", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/perplexity"), {
          settings: { apiKey: "", baseURL: "https://perplexity.example/v1" },
        }),
        undefined,
        {
          loadAISDK: (runtime) =>
            Effect.sync(() => {
              expect(runtime.settings).not.toHaveProperty("apiKey")
              return native
            }),
        },
      )
    }),
  )

  it.effect("reports whether a catalog model declares a provider package", () =>
    Effect.sync(() => {
      expect(ModelResolver.hasPackage(model(Provider.aisdk("@ai-sdk/openai")))).toBe(true)
      expect(ModelResolver.hasPackage(model("@opencode/ai/providers/custom"))).toBe(true)
      expect(ModelResolver.hasPackage(model(undefined))).toBe(false)
    }),
  )
})

describe("ModelResolver routes", () => {
  const leaf = (providerID: string) =>
    model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make(providerID),
      modelID: "luna",
      settings: { apiKey: "key" },
    })

  const routed = (leaves: ReadonlyArray<ReturnType<typeof leaf>>, definition: Record<string, unknown>) => {
    const targets = leaves.map((item) => ModelRoute.ref({ providerID: item.providerID, model: item.id }))
    return Info.make({
      ...model(undefined),
      providerID: ModelRoute.PROVIDER_ID,
      id: ID.make("pool"),
      settings: {
        [ModelRoute.SETTING]: {
          id: "pool",
          targets,
          targetVariants: targets.map(() => ({})),
          health: ModelRoute.policy(),
          attempts: 1,
          ...definition,
        },
      },
    })
  }

  const withResolver = <A, E>(
    leaves: ReadonlyArray<ReturnType<typeof leaf>>,
    run: (resolver: ModelResolver.Interface) => Effect.Effect<A, E>,
    integration?: unknown,
    dataDir?: string,
  ) => {
    const provider = Provider.Info.make({
      ...Provider.Info.empty(leaves[0].providerID),
      activation: "enabled",
      package: Provider.aisdk("@ai-sdk/openai"),
      settings: { apiKey: "key" },
    })
    const layer = ModelResolver.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Provider.Service, { get: () => Effect.succeed(provider) }),
          Layer.mock(Model.Service, {
            get: (providerID, id) =>
              Effect.succeed(leaves.find((item) => item.providerID === providerID && item.id === id)),
          }),
          Layer.mock(
            Integration.Service,
            (integration ?? {
              revision: () => 0,
              connection: { active: () => Effect.undefined },
            }) as never,
          ),
          Layer.mock(Npm.Service, {}),
          Layer.mock(AISDK.Service, {} as never),
          Layer.succeed(Global.Service, Global.make(dataDir === undefined ? {} : { data: dataDir })),
        ),
      ),
    )
    return withConfigEnv({}, () =>
      Effect.gen(function* () {
        return yield* run(yield* ModelResolver.Service)
      }).pipe(Effect.provide(layer)),
    )
  }

  const ordered = {
    nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
  }
  const single = { nodes: [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }] }
  const targetOf = (resolved: ModelResolver.Resolved) => String(resolved.routing?.target.providerID)

  it.effect("carries each target's declared cache format into the resolved model's compatibility", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], {
      ...ordered,
      targetCacheFormats: [{ cacheFormat: "anthropic" }, { cacheFormat: "alibaba" }],
    })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(route)
        expect(first.model.compatibility?.cacheFormat).toBe("anthropic")
        const next = yield* first.routing!.fallback()
        expect(next?.model.compatibility?.cacheFormat).toBe("alibaba")
      }),
    )
  })

  it.effect("carries the route's declared system prompt into the resolution (#1413)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered, system: "You are a persona." })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(route)
        expect(first.routing?.system).toBe("You are a persona.")
        const next = yield* first.routing!.fallback()
        expect(next?.routing?.system).toBe("You are a persona.")
      }),
    )
  })

  // #1720: a configured provider route registers direct-addressing models under its own
  // provider id; the resolver routes any definition-carrying model, whatever its provider.
  it.effect("resolves a direct provider-route model through its members and falls over (#1720)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const direct = Info.make({
      ...routed([a, b], { ...ordered, id: "mistral-plan/luna" }),
      providerID: Provider.ID.make("mistral-plan"),
      id: ID.make("luna"),
    })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(direct)
        expect(targetOf(first)).toBe("pa")
        expect(first.routing?.routeID).toBe(ID.make("mistral-plan/luna"))
        const next = yield* first.routing!.fallback()
        expect(next ? targetOf(next) : undefined).toBe("pb")
      }),
    )
  })

  it.effect("names the provider-route id when a direct provider-route model has no targets (#1720)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const direct = Info.make({
      ...routed([a], { ...single, targets: [], targetVariants: [], nodes: [], id: "mistral-plan/luna" }),
      providerID: Provider.ID.make("mistral-plan"),
      id: ID.make("luna"),
    })
    return withResolver([a], (resolver) =>
      Effect.gen(function* () {
        const error = yield* resolver.resolveModel(direct).pipe(Effect.flip)
        expect(error.message).toBe("No model is available for route mistral-plan/luna")
      }),
    )
  })

  it.effect("a target's declared cache format overrides the model's own compatibility", () => {
    ModelRoute.resetHealth()
    const a = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pa"),
      modelID: "luna",
      settings: { apiKey: "key" },
      compatibility: { cacheFormat: "alibaba" },
    })
    const route = routed([a], { ...single, targetCacheFormats: [{ cacheFormat: "anthropic" }] })
    return withResolver([a], (resolver) =>
      Effect.gen(function* () {
        const resolved = yield* resolver.resolveModel(route)
        expect(resolved.model.compatibility?.cacheFormat).toBe("anthropic")
      }),
    )
  })

  // #1014 PR2: a session seated on a sub-route re-enters through a parent route
  // that nests it when the sub-route exhausts, instead of dying on the sub-route.
  const routeAs = (id: string, leaves: ReadonlyArray<ReturnType<typeof leaf>>, extra: Record<string, unknown>) => {
    const targets = leaves.map((item) => ModelRoute.ref({ providerID: item.providerID, model: item.id }))
    return Info.make({
      ...model(undefined),
      providerID: ModelRoute.PROVIDER_ID,
      id: ID.make(id),
      settings: {
        [ModelRoute.SETTING]: {
          id,
          targets,
          targetVariants: targets.map(() => ({})),
          health: ModelRoute.policy(),
          attempts: 1,
          ...extra,
        },
      },
    })
  }

  const withCascadeResolver = <A, E>(
    leaves: ReadonlyArray<ReturnType<typeof leaf>>,
    routes: ReadonlyArray<ReturnType<typeof routeAs>>,
    run: (resolver: ModelResolver.Interface) => Effect.Effect<A, E>,
    integration?: unknown,
  ) => {
    const provider = Provider.Info.make({
      ...Provider.Info.empty(leaves[0].providerID),
      activation: "enabled",
      package: Provider.aisdk("@ai-sdk/openai"),
      settings: { apiKey: "key" },
    })
    const catalog = [...routes, ...leaves]
    const layer = ModelResolver.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Provider.Service, { get: () => Effect.succeed(provider) }),
          Layer.mock(Model.Service, {
            get: (providerID, id) =>
              Effect.succeed(catalog.find((item) => item.providerID === providerID && item.id === id)),
            available: () => Effect.succeed(catalog),
            all: () => Effect.succeed(catalog),
          }),
          Layer.mock(
            Integration.Service,
            (integration ?? {
              revision: () => 0,
              connection: { active: () => Effect.undefined },
            }) as never,
          ),
          Layer.mock(Npm.Service, {}),
          Layer.mock(AISDK.Service, {} as never),
        ),
      ),
    )
    return withConfigEnv({}, () =>
      Effect.gen(function* () {
        return yield* run(yield* ModelResolver.Service)
      }).pipe(Effect.provide(layer)),
    )
  }

  const subAndParent = () => {
    const a = leaf("pa")
    const b = leaf("pb")
    const c = leaf("pc")
    const sub = routeAs("sub", [a, b], {
      nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    })
    const parent = routeAs("parent", [a, b, c], {
      nodes: [
        { selection: "ordered", weights: [1, 1], children: [{ node: 1 }, { leaf: 2 }] },
        { routeID: "sub", selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
      ],
    })
    return { a, b, c, sub, parent }
  }

  it.effect("cascades to the nesting parent route when a sub-route's fallback exhausts (#1014)", () => {
    ModelRoute.resetHealth()
    const { a, b, c, sub, parent } = subAndParent()
    return withCascadeResolver([a, b, c], [sub, parent], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(sub)
        expect(String(first.routing?.routeID)).toBe("sub")
        expect(targetOf(first)).toBe("pa")
        const second = yield* first.routing!.fallback()
        expect(String(second?.routing?.routeID)).toBe("sub")
        expect(targetOf(second!)).toBe("pb")
        // The sub-route is exhausted: the cascade re-enters through the parent,
        // whose only untried leaf is the one outside the nested subtree.
        const third = yield* second!.routing!.fallback()
        expect(String(third?.routing?.routeID)).toBe("parent")
        expect(targetOf(third!)).toBe("pc")
        // Every candidate in the chain has been tried: the cascade stops cleanly.
        const fourth = yield* third!.routing!.fallback()
        expect(fourth).toBeUndefined()
      }),
    )
  })

  // Ported from model-route-mock-provider.test.ts (#1806): the incident's fatal
  // resolution happened one altitude up — a wall inside the nested route, then the
  // chain re-resolving the parent. The route-level driver deliberately does not
  // reproduce the resolver cascade; this harness does.
  it.effect("route chains: a wall inside a nested route does not strand the parent route's untried members (#1806)", () => {
    ModelRoute.resetHealth()
    const { a, b, c, sub, parent } = subAndParent()
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    const targetB = ModelRoute.ref({ providerID: "pb", model: b.id })
    return withCascadeResolver([a, b, c], [sub, parent], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(sub)
        expect(String(first.routing?.routeID)).toBe("sub")
        expect(targetOf(first)).toBe("pa")
        // The wall lands inside the nested route mid-session: both of the sub-route's
        // members are quota-benched, so the sub-route has no servable target.
        ModelRoute.failed(targetA, ModelRoute.policy(), Date.now(), { quota: true })
        ModelRoute.failed(targetB, ModelRoute.policy(), Date.now(), { quota: true })
        // The fallback cascades to the parent instead of dying on the sub-route, and
        // the parent's untried healthy member serves — no no-candidates resolution.
        const rescued = yield* first.routing!.fallback()
        expect(String(rescued?.routing?.routeID)).toBe("parent")
        expect(targetOf(rescued!)).toBe("pc")
        // Everything in the chain is now tried or walled: the cascade stops cleanly.
        const done = yield* rescued!.routing!.fallback()
        expect(done).toBeUndefined()
      }),
    )
  })

  it.effect("route chains: a nested member whose active credential is walled serves on its sibling credential (#1806)", () => {
    ModelRoute.resetHealth()
    const { a, b, c, sub, parent } = subAndParent()
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    const targetB = ModelRoute.ref({ providerID: "pb", model: b.id })
    const activated: string[] = []
    let activeB = "cred-a"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "key" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) =>
        Effect.succeed({ id, connections: String(id) === "pb" ? [conn("cred-a"), conn("cred-b")] : [] }),
      connection: {
        active: (id: Integration.ID) => Effect.succeed(String(id) === "pb" ? conn(activeB) : undefined),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activated.push(String(id))
            activeB = String(id)
          }),
      },
    }
    return withCascadeResolver(
      [a, b, c],
      [sub, parent],
      (resolver) =>
        Effect.gen(function* () {
          const first = yield* resolver.resolveModel(sub)
          expect(targetOf(first)).toBe("pa")
          // pa walls mid-session; pb's *active* credential is known-full, but its
          // stored sibling is healthy — pb must not be judged by cred-a alone.
          ModelRoute.failed(targetA, ModelRoute.policy(), Date.now(), { quota: true })
          ModelRoute.observeCredentialQuota(targetB, "cred-a", {
            planID: "pb-plan",
            window: "monthly",
            providerID: "pb",
            percent: 100,
            remaining: 0,
            resetAt: Date.now() + 3_600_000,
            observedAt: Date.now(),
            stale: false,
          })
          const rescued = yield* first.routing!.fallback()
          expect(String(rescued?.routing?.routeID)).toBe("sub")
          expect(targetOf(rescued!)).toBe("pb")
          expect(String(rescued?.routing?.credentialID)).toBe("cred-b")
          expect(activated).toEqual(["cred-b"])
        }),
      integration,
    )
  })

  it.effect("cascades on initial resolution when a sub-route has no servable target (#1014)", () => {
    ModelRoute.resetHealth()
    const { a, b, c, sub, parent } = subAndParent()
    // The sub-route's leaves are not in the catalog the resolver can load, so the
    // within-route pass selects and discards both, then the parent serves its
    // remaining leaf with the tried leaves excluded by ref.
    return withCascadeResolver([c], [sub, parent], (resolver) =>
      Effect.gen(function* () {
        const resolved = yield* resolver.resolveModel(sub)
        expect(String(resolved.routing?.routeID)).toBe("parent")
        expect(targetOf(resolved)).toBe("pc")
        expect(String(a.providerID)).toBe("pa")
        expect(String(b.providerID)).toBe("pb")
      }),
    )
  })

  it.effect("cascades to the nearest ancestor when a grandparent also nests the sub-route (#1014)", () => {
    ModelRoute.resetHealth()
    const { a, b, c, sub, parent } = subAndParent()
    const d = leaf("pd")
    const grandparent = routeAs("grandparent", [a, b, c, d], {
      nodes: [
        { selection: "ordered", weights: [1, 1, 1], children: [{ node: 1 }, { node: 2 }, { leaf: 3 }] },
        {
          routeID: "parent",
          selection: "ordered",
          weights: [1, 1, 1],
          children: [{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }],
        },
        { routeID: "sub", selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
      ],
    })
    // The grandparent comes first in the catalog: catalog order must not win
    // over nesting proximity.
    return withCascadeResolver([a, b, c, d], [grandparent, sub, parent], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(sub)
        const second = yield* first.routing!.fallback()
        const third = yield* second!.routing!.fallback()
        expect(String(third?.routing?.routeID)).toBe("parent")
        expect(targetOf(third!)).toBe("pc")
        // Only once the parent is exhausted does the cascade climb to the grandparent.
        const fourth = yield* third!.routing!.fallback()
        expect(String(fourth?.routing?.routeID)).toBe("grandparent")
        expect(targetOf(fourth!)).toBe("pd")
      }),
    )
  })

  it.effect("does not cascade into a parent that cannot serve the requested variant (#1014)", () => {
    ModelRoute.resetHealth()
    const a = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pa"),
      modelID: "luna",
      settings: { apiKey: "key" },
      variants: [{ id: VariantID.make("high") }],
    })
    const b = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pb"),
      modelID: "luna",
      settings: { apiKey: "key" },
      variants: [{ id: VariantID.make("high") }],
    })
    const c = leaf("pc")
    const sub = Info.make({
      ...routeAs("sub", [a, b], {
        nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
      }),
      variants: [{ id: VariantID.make("high") }],
    })
    // The parent route does not offer `high` (no variants advertised): entering
    // it would serve pc at its default settings, silently dropping the variant.
    const parent = routeAs("parent", [a, b, c], {
      nodes: [
        { selection: "ordered", weights: [1, 1], children: [{ node: 1 }, { leaf: 2 }] },
        { routeID: "sub", selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
      ],
    })
    return withCascadeResolver([a, b, c], [sub, parent], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(sub, VariantID.make("high"))
        expect(targetOf(first)).toBe("pa")
        const second = yield* first.routing!.fallback()
        expect(targetOf(second!)).toBe("pb")
        const third = yield* second!.routing!.fallback()
        expect(third).toBeUndefined()
      }),
    )
  })

  it.effect("a speculative fallback does not consume the parent route for the primary's own fallback (#1014)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const c = leaf("pc")
    const sub = routeAs("sub", [a], {
      nodes: [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }],
    })
    const parent = routeAs("parent", [a, b, c], {
      nodes: [
        { selection: "ordered", weights: [1, 1, 1], children: [{ node: 1 }, { leaf: 1 }, { leaf: 2 }] },
        { routeID: "sub", selection: "ordered", weights: [1], children: [{ leaf: 0 }] },
      ],
    })
    return withCascadeResolver([a, b, c], [sub, parent], (resolver) =>
      Effect.gen(function* () {
        const first = yield* resolver.resolveModel(sub)
        expect(targetOf(first)).toBe("pa")
        // Hedge exploration: the primary's fallback is called speculatively and
        // lands in the parent.
        const hedge = yield* first.routing!.fallback()
        expect(String(hedge?.routing?.routeID)).toBe("parent")
        expect(targetOf(hedge!)).toBe("pb")
        // The race settles back on the primary: its own fallback must still be
        // able to enter the parent, and from there reach the parent's last leaf.
        const next = yield* first.routing!.fallback()
        expect(String(next?.routing?.routeID)).toBe("parent")
        const last = yield* next!.routing!.fallback()
        expect(targetOf(last!)).toBe("pc")
      }),
    )
  })

  it.effect("surfaces the typed load error when a parentless route's targets all fail to load (#1014)", () => {
    ModelRoute.resetHealth()
    const broken = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
      providerID: Provider.ID.make("pa"),
      modelID: "luna",
      settings: { baseURL: "https://${OPENCODE_5256_UNSET_HOST}/v1" },
    })
    const solo = routeAs("solo", [broken], {
      nodes: [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }],
    })
    return withCascadeResolver([broken], [solo], (resolver) =>
      Effect.gen(function* () {
        const failure = yield* resolver.resolveModel(solo).pipe(Effect.flip)
        // Not RouteUnavailableError: the actionable initialization failure is
        // preserved through the cascade boundary.
        expect(failure._tag).toBe("SessionRunnerModel.UnresolvedProviderVariablesError")
      }),
    )
  })

  it.effect("leaves compatibility unchanged when the route declares no cache format", () => {
    ModelRoute.resetHealth()
    const a = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pa"),
      modelID: "luna",
      settings: { apiKey: "key" },
      compatibility: { cacheFormat: "alibaba" },
    })
    const route = routed([a], { ...single })
    return withResolver([a], (resolver) =>
      Effect.gen(function* () {
        const resolved = yield* resolver.resolveModel(route)
        expect(resolved.model.compatibility?.cacheFormat).toBe("alibaba")
      }),
    )
  })

  it.effect("skips a target that is over budget, cooling or skipped, and uses it as a last resort", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered, budgets: [{ requestsPerMinute: 2, softLimit: 1 }, {}] })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        ModelRoute.recordUsage(ModelRoute.ref({ providerID: "pa", model: a.id }), 0)
        ModelRoute.recordUsage(ModelRoute.ref({ providerID: "pa", model: a.id }), 0)
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
        // The fallback walks on from whichever target answered.
        ModelRoute.resetHealth()
        const first = yield* resolver.resolveModel(route)
        const next = yield* first.routing!.fallback()
        expect(targetOf(next!)).toBe("pb")
        // With every target unavailable the least-bad one still answers.
        ModelRoute.setAdjustments([{ id: "x", match: "p", action: "skip", until: Date.now() + 60_000 }])
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        ModelRoute.resetHealth()
        ModelRoute.failed(ModelRoute.ref({ providerID: "pa", model: a.id }), ModelRoute.policy(), Date.now())
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
      }),
    )
  })

  it.effect("last resort prefers a merely cooling target over a quota-benched one (code#8086)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        // pa answers quota exhaustion: the bench is the only signal it has, and it
        // is quota-dead. pb fails ordinarily and is merely cooling. Both fall out
        // of the ready set, but the last resort serves pb despite the order -
        // seating pa would spend the turn on a leg that has already answered 100%.
        ModelRoute.failed(ModelRoute.ref({ providerID: "pa", model: a.id }), ModelRoute.policy(), Date.now(), { quota: true })
        ModelRoute.failed(ModelRoute.ref({ providerID: "pb", model: b.id }), ModelRoute.policy(), Date.now())
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
      }),
    )
  })

  it.effect("last resort still serves a quota-benched target when nothing undead remains (code#8086)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        // Every target quota-dead: the preference has nothing to prefer, and the
        // pool still cannot run out - the usable set itself answers, in order.
        ModelRoute.failed(ModelRoute.ref({ providerID: "pa", model: a.id }), ModelRoute.policy(), Date.now(), { quota: true })
        ModelRoute.failed(ModelRoute.ref({ providerID: "pb", model: b.id }), ModelRoute.policy(), Date.now(), { quota: true })
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
      }),
    )
  })

  it.live("admits exactly one half-open probe when a quota window reset learned after the bench passes (#1123)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], ordered)
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        // A quota bench planted with no known reset runs on the generic ladder.
        ModelRoute.failed(targetA, ModelRoute.policy(), Date.now(), { quota: true })
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
        // The provider's window reset (5h wall in the incident) is learned after the bench,
        // from the quota feed, and it passes while the bench still has most of a day to run.
        const resetAt = Date.now() + 250
        ModelRoute.observeProviderQuota(
          targetA,
          {
            planID: "plan",
            window: "five-hours",
            providerID: "pa",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: Date.now(),
            stale: false,
          },
          Date.now(),
        )
        yield* Effect.sleep("400 millis")
        // Rollover admits pa again — as the single probe.
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        // While that probe is outstanding no second attempt is admitted to pa.
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
        // The probe succeeds: pa is fully unbenched, long before the ladder would have expired.
        ModelRoute.completed(targetA, ModelRoute.policy(), {
          firstTokenMs: 100,
          responseMs: 500,
          tokensPerSecond: 30,
        })
        expect(ModelRoute.cooldownUntil(targetA)).toBe(0)
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
      }),
    )
  })

  it.live("stamps the probe claim it spends on the resolution, and a release hands it back (#1478)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], ordered)
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        ModelRoute.failed(targetA, ModelRoute.policy(), Date.now(), { quota: true })
        const resetAt = Date.now() + 250
        ModelRoute.observeProviderQuota(
          targetA,
          {
            planID: "plan",
            window: "five-hours",
            providerID: "pa",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: Date.now(),
            stale: false,
          },
          Date.now(),
        )
        yield* Effect.sleep("400 millis")
        const probe = yield* resolver.resolveModel(route)
        expect(targetOf(probe)).toBe("pa")
        expect(probe.routing?.probeClaim).toBeDefined()
        // An ordinary resolution spends no claim and carries none.
        const ordinary = yield* resolver.resolveModel(route)
        expect(targetOf(ordinary)).toBe("pb")
        expect(ordinary.routing?.probeClaim).toBeUndefined()
        // The owner hands the unattempted claim back: the probe is due again while the
        // bench itself is still in force, and the next resolution claims it afresh.
        const claim = probe.routing!.probeClaim!
        expect(ModelRoute.releaseBenchProbe(targetA, claim.credentialID, claim.claimedAt, claim.token)).toBe(true)
        expect(ModelRoute.probeDue(targetA, undefined)).toBe(true)
        expect(ModelRoute.cooldownUntil(targetA)).toBeGreaterThan(Date.now())
        const again = yield* resolver.resolveModel(route)
        expect(targetOf(again)).toBe("pa")
        expect(again.routing?.probeClaim?.claimedAt).toBeGreaterThanOrEqual(claim.claimedAt)
      }),
    )
  })

  it.live("a load failure settles both probe scopes of the pick (#1486)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    const cred = "cred-load"
    const conn = {
      type: "credential" as const,
      id: Credential.ID.make(cred),
      label: cred,
      method: "key" as const,
    }
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) => Effect.succeed({ id, connections: [conn] }),
      connection: {
        active: () => Effect.succeed(conn),
        resolve: () => Effect.fail(new Error("credential boom")),
        activate: () => Effect.void,
      },
    }
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const policy = ModelRoute.policy()
          const now = Date.now()
          for (let index = 0; index < 8; index++) {
            ModelRoute.failed(targetA, policy, now + index, { quota: true })
            ModelRoute.failed(targetA, policy, now + index, { quota: true }, cred)
          }
          const resetAt = now + 250
          const snapshot = {
            planID: "plan",
            window: "five-hours",
            providerID: "pa",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now,
            stale: false,
          }
          ModelRoute.observeProviderQuota(targetA, snapshot, now)
          ModelRoute.observeCredentialQuota(targetA, cred, snapshot, now)
          yield* Effect.sleep("400 millis")
          expect(ModelRoute.probeDue(targetA, undefined)).toBe(true)
          expect(ModelRoute.probeDue(targetA, cred)).toBe(true)
          // The pick claims both scopes, then load fails on the credential.
          const error = yield* resolver.resolveModel(route).pipe(Effect.flip)
          expect(error).toBeDefined()
          // Both scopes settled: benched with no outstanding claim left behind.
          expect(ModelRoute.cooldownUntil(targetA)).toBeGreaterThan(Date.now())
          expect(ModelRoute.credentialCooldownUntil(targetA, cred)).toBeGreaterThan(Date.now())
          expect(ModelRoute.probeDue(targetA, undefined)).toBe(false)
          expect(ModelRoute.probeDue(targetA, cred)).toBe(false)
          expect(ModelRoute.activeBenches(Date.now()).some((bench) => bench.probeClaimed)).toBe(false)
        }),
      integration,
    )
  })

  it.live("lets a due half-open probe recover a quota-exhausted pool, then restores the pool exclusion (#1390)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const outside = leaf("pc")
    const route = routed([a, b, outside], {
      nodes: [
        { selection: "ordered", weights: [1, 1], children: [{ node: 1 }, { leaf: 2 }] },
        { routeID: "sub", selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
      ],
    })
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    const targetB = ModelRoute.ref({ providerID: "pb", model: b.id })
    return withResolver([a, b, outside], (resolver) =>
      Effect.gen(function* () {
        const now = Date.now()
        const resetAt = now + 250
        ModelRoute.failed(targetA, ModelRoute.policy(), now, { quota: true })
        ModelRoute.failed(targetB, ModelRoute.policy(), now, { quota: true })
        for (const [target, providerID] of [[targetA, "pa"], [targetB, "pb"]] as const)
          ModelRoute.observeProviderQuota(
            target,
            {
              planID: "plan",
              window: "five-hours",
              providerID,
              percent: 100,
              remaining: 0,
              resetAt: providerID === "pa" ? resetAt : resetAt + 30_000,
              observedAt: now + 1,
              stale: false,
            },
            now + 1,
          )

        // Before pa's reset, neither bench is probe-eligible and the pool stays pulled.
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pc")
        yield* Effect.sleep("400 millis")

        // pa's reset has passed: the pool no longer counts that due probe as exhaustion,
        // so it is selected even though the other pool member remains quota-benched.
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        // Once pa's probe is claimed, its bench counts again alongside pb's not-yet-due
        // bench, restoring the hard pool exclusion while the probe is outstanding.
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pc")
      }),
    )
  })

  it.effect("passes over a target whose provider reports a spent rate-limit window", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], ordered)
    const spent = (providerID: string, model: string) =>
      ModelRoute.observeRateLimit(ModelRoute.ref({ providerID, model }), {
        at: Date.now(),
        limit: { requests: "60" },
        remaining: { requests: "0" },
        reset: { requests: "1h" },
      })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        spent("pa", a.id)
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
        // Neither is cooling, so the provider's forecast is the only reason pa was passed over.
        expect(ModelRoute.coolingDown(ModelRoute.ref({ providerID: "pa", model: a.id }))).toBe(false)
        // With every target spent, the first still answers rather than the turn failing.
        spent("pb", b.id)
        expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
      }),
    )
  })

  it.effect("a fixed route only fails over: skips, budgets and provider holds apply from rules up", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const spend = () => {
      ModelRoute.setAdjustments([{ id: "x", match: "pa", action: "skip", until: Date.now() + 60_000 }])
      ModelRoute.observeRateLimit(ModelRoute.ref({ providerID: "pa", model: a.id }), {
        at: Date.now(),
        limit: { requests: "60" },
        remaining: { requests: "0" },
        reset: { requests: "1h" },
      })
    }
    const fixed = routed([a, b], { ...ordered, autonomy: "fixed" })
    const rules = routed([a, b], { ...ordered, autonomy: "rules" })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        spend()
        expect(targetOf(yield* resolver.resolveModel(rules))).toBe("pb")
        expect(targetOf(yield* resolver.resolveModel(fixed))).toBe("pa")
        // A real failure still moves a fixed route along.
        ModelRoute.failed(ModelRoute.ref({ providerID: "pa", model: a.id }), ModelRoute.policy(), Date.now())
        expect(targetOf(yield* resolver.resolveModel(fixed))).toBe("pb")
      }),
    )
  })

  it.effect("a requested route variant runs each target at the variant it is remapped to", () => {
    ModelRoute.resetHealth()
    const a = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pa"),
      modelID: "luna",
      settings: { apiKey: "key" },
      variants: [{ id: VariantID.make("high") }],
    })
    const b = leaf("pb")
    // The route advertises `low` as the config plugin would: every target can produce it through a remap.
    const route = Info.make({
      ...routed([a, b], { ...ordered, targetVariants: [{ map: { low: VariantID.make("high") } }, {}] }),
      variants: [{ id: VariantID.make("low") }],
    })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        const resolved = yield* resolver.resolveModel(route, VariantID.make("low"))
        expect(targetOf(resolved)).toBe("pa")
        expect(resolved.routing?.target.variant).toBe(VariantID.make("high"))
        // Without a requested variant, each target runs at its own default, which for this one is none.
        const plain = yield* resolver.resolveModel(route)
        expect(targetOf(plain)).toBe("pa")
        expect(plain.routing?.target.variant).toBeUndefined()
      }),
    )
  })

  it.effect("a requested route variant runs a target without a remap at the same native variant", () => {
    ModelRoute.resetHealth()
    const a = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pa"),
      modelID: "sonnet",
      settings: { apiKey: "key" },
      variants: [{ id: VariantID.make("low") }, { id: VariantID.make("high") }],
    })
    const b = leaf("pb")
    // A family route (one model, its previous generation as failover) with no remaps and a default:
    // `#low` must reach the target as low, not fall back to the default.
    const route = Info.make({
      ...routed([a, b], { ...ordered, targetVariants: [{ default: VariantID.make("high") }, {}] }),
      variants: [{ id: VariantID.make("low") }, { id: VariantID.make("high") }],
    })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        const low = yield* resolver.resolveModel(route, VariantID.make("low"))
        expect(targetOf(low)).toBe("pa")
        expect(low.routing?.target.variant).toBe(VariantID.make("low"))
        // Without a requested variant the target's default still applies.
        const plain = yield* resolver.resolveModel(route)
        expect(plain.routing?.target.variant).toBe(VariantID.make("high"))
      }),
    )
  })

  it.effect("learned adjustments take effect only on the routes whose level they were made for", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const c = leaf("pc")
    // The review skips pa from adaptive up; the prediction skips pb from predictive up.
    ModelRoute.setAdjustments([
      { id: "auto:pa", match: "pa", action: "skip", until: Date.now() + 60_000, requires: "adaptive" },
      { id: "auto-hourly:pb", match: "pb", action: "skip", until: Date.now() + 60_000, requires: "predictive" },
    ])
    const trio = {
      nodes: [{ selection: "ordered", weights: [1, 1, 1], children: [{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }] }],
    }
    const levelled = (autonomy: ModelRouteAutonomy.Level | undefined) =>
      routed([a, b, c], { ...trio, ...(autonomy ? { autonomy } : {}) })
    return withResolver([a, b, c], (resolver) =>
      Effect.gen(function* () {
        // A rules route keeps its own order: neither learned skip is for it.
        expect(targetOf(yield* resolver.resolveModel(levelled("rules")))).toBe("pa")
        // An adaptive route takes the review's skip of pa, but not the prediction's skip of pb.
        expect(targetOf(yield* resolver.resolveModel(levelled("adaptive")))).toBe("pb")
        // A predictive route takes both, and a route with no level keeps every rule on.
        expect(targetOf(yield* resolver.resolveModel(levelled("predictive")))).toBe("pc")
        expect(targetOf(yield* resolver.resolveModel(levelled(undefined)))).toBe("pc")
      }),
    )
  })

  it.effect("skips a route target whose ceiling the request does not fit", () => {
    ModelRoute.resetHealth()
    ModelRoute.resetSelection()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], {
      ...ordered,
      limit: { context: 120_000 },
      targetLimits: [{ context: 100_000 }, { context: 200_000 }],
    })
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => {
      events.push(event)
    })
    return Effect.ensuring(
      withResolver([a, b], (resolver) =>
        Effect.gen(function* () {
          // Effective ceilings are min(route cap, leaf ceiling): 100k for pa, 120k for pb.
          expect(targetOf(yield* resolver.resolveModel(route, undefined, "s-limit-small", 50_000))).toBe("pa")
          expect(targetOf(yield* resolver.resolveModel(route, undefined, "s-limit-big", 110_000))).toBe("pb")
          // The skip is attributed to the limit specifically in the resolved-route dump.
          const decision = events.find((event) => event.kind === "decision" && event.row.chosen === "pb/test-model")
          expect(decision?.row).toMatchObject({
            candidates: ["pb/test-model"],
            detail: { excluded: [{ candidate: "pa/test-model", reason: "over-limit" }] },
          })
          // Without a request size every target stays eligible, as before.
          expect(targetOf(yield* resolver.resolveModel(route, undefined, "s-limit-plain"))).toBe("pa")
        }),
      ),
      Effect.sync(() => ModelRouteLog.setSink(undefined)),
    )
  })

  it.effect("does not restore an over-limit target as a last resort", () => {
    ModelRoute.resetHealth()
    ModelRoute.resetSelection()
    const a = leaf("pa")
    const route = routed([a], { ...single, targetLimits: [{ context: 100_000 }] })
    return withResolver([a], (resolver) =>
      Effect.gen(function* () {
        // The only target's ceiling is below the request: resolution fails rather than
        // falling back to the over-limit target.
        const exit = yield* Effect.exit(resolver.resolveModel(route, undefined, "s-too-big", 110_000))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(exit.cause).toBeDefined()
        // A request that fits still resolves to the target.
        expect(targetOf(yield* resolver.resolveModel(route, undefined, "s-fits", 90_000))).toBe("pa")
      }),
    )
  })

  it.effect("gives each new session its own target in round-robin mode and keeps it", () => {
    ModelRoute.resetHealth()
    ModelRoute.resetSelection()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], {
      nodes: [{ selection: "round-robin", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    })
    return withResolver([a, b], (resolver) =>
      Effect.gen(function* () {
        const one = targetOf(yield* resolver.resolveModel(route, undefined, "s1"))
        const two = targetOf(yield* resolver.resolveModel(route, undefined, "s2"))
        expect(new Set([one, two]).size).toBe(2)
        expect(targetOf(yield* resolver.resolveModel(route, undefined, "s1"))).toBe(one)
        expect(targetOf(yield* resolver.resolveModel(route, undefined, "s2"))).toBe(two)
      }),
    )
  })

  it.effect("credentialFallback activates the next eligible credential and re-resolves the same target (#6)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    const activated: string[] = []
    let activeID = "cred-a"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "key" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) => Effect.succeed({ id, connections: [conn("cred-a"), conn("cred-b")] }),
      connection: {
        active: () => Effect.succeed(conn(activeID)),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activated.push(String(id))
            activeID = String(id)
          }),
      },
    }
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const resolved = yield* resolver.resolveModel(route)
          expect(String(resolved.routing?.credentialID)).toBe("cred-a")
          const switched = yield* resolved.routing!.credentialFallback!()
          expect(activated).toEqual(["cred-b"])
          expect(targetOf(switched!)).toBe("pa")
          expect(String(switched?.routing?.credentialID)).toBe("cred-b")
          // The chain remembers every credential it has served: cred-a stays excluded
          // even though nothing health-based blocks it, so the walk cannot cycle back
          // and forth between two credentials — it ends and route fallback runs (#1379).
          const rotated = yield* switched!.routing!.credentialFallback!()
          expect(activated).toEqual(["cred-b"])
          expect(rotated).toBeUndefined()
        }),
      integration,
    )
  })

  it.effect("credentialFallback re-derives account-scoped headers from the activated credential (#870)", () => {
    ModelRoute.resetHealth()
    const a = model(Provider.aisdk("@ai-sdk/openai"), {
      providerID: Provider.ID.make("pa"),
      modelID: "luna",
      settings: { apiKey: "key" },
      headers: { "chatgpt-account-id": "acct-a" },
    })
    const route = routed([a], { ...single })
    let activeID = "cred-a"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "oauth" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) => Effect.succeed({ id, connections: [conn("cred-a"), conn("cred-b")] }),
      connection: {
        active: () => Effect.succeed(conn(activeID)),
        resolve: (connection: { id: Credential.ID }) =>
          Effect.succeed(
            Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("chatgpt-browser"),
              access: `token-${String(connection.id)}`,
              refresh: "refresh",
              expires: Date.now() + 60_000,
              metadata: { accountID: String(connection.id) === "cred-a" ? "acct-a" : "acct-b" },
            }),
          ),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activeID = String(id)
          }),
      },
    }
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const resolved = yield* resolver.resolveModel(route)
          expect(String(resolved.routing?.credentialID)).toBe("cred-a")
          expect(resolved.model.route.defaults.headers).toMatchObject({ "chatgpt-account-id": "acct-a" })
          const switched = yield* resolved.routing!.credentialFallback!()
          expect(String(switched?.routing?.credentialID)).toBe("cred-b")
          // The retry is built on cred-b's token AND cred-b's account header: the catalog
          // source's stale acct-a header must not survive the switch (#870).
          expect(switched!.model.route.defaults.headers).toMatchObject({ "chatgpt-account-id": "acct-b" })
        }),
      integration,
    )
  })

  it.effect("credentialFallback does not add an account header to a catalog that never carried one (#870)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    let activeID = "cred-a"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "oauth" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) => Effect.succeed({ id, connections: [conn("cred-a"), conn("cred-b")] }),
      connection: {
        active: () => Effect.succeed(conn(activeID)),
        resolve: (connection: { id: Credential.ID }) =>
          Effect.succeed(
            Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("chatgpt-browser"),
              access: `token-${String(connection.id)}`,
              refresh: "refresh",
              expires: Date.now() + 60_000,
              metadata: { accountID: String(connection.id) === "cred-a" ? "acct-a" : "acct-b" },
            }),
          ),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activeID = String(id)
          }),
      },
    }
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const resolved = yield* resolver.resolveModel(route)
          const switched = yield* resolved.routing!.credentialFallback!()
          expect(String(switched?.routing?.credentialID)).toBe("cred-b")
          // The leaf's catalog has no chatgpt-account-id (its credentials are key fixtures in
          // other tests, but the header rule is provider-agnostic): the switch must not invent
          // one from cred-b's accountID metadata.
          expect(switched!.model.route.defaults.headers).not.toHaveProperty("chatgpt-account-id")
        }),
      integration,
    )
  })

  it.effect("credentialFallback excludes the serving credential, not one another session activated (#6)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    const activated: string[] = []
    let activeID = "cred-a"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "key" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) => Effect.succeed({ id, connections: [conn("cred-a"), conn("cred-b")] }),
      connection: {
        active: () => Effect.succeed(conn(activeID)),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activated.push(String(id))
            activeID = String(id)
          }),
      },
    }
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const resolved = yield* resolver.resolveModel(route)
          expect(String(resolved.routing?.credentialID)).toBe("cred-a")
          // The serving credential fails on quota and is benched; meanwhile another
          // session activates cred-b, so cred-b is the *active* credential by the time
          // this session's fallback runs.
          ModelRoute.failed(
            ModelRoute.ref({ providerID: "pa", model: a.id }),
            ModelRoute.policy(),
            Date.now(),
            { quota: true },
            "cred-a",
          )
          activeID = "cred-b"
          // The fallback must still offer cred-b: it excludes the credential that
          // served this resolution (cred-a, also credential-cooling), not the
          // currently active one.
          const switched = yield* resolved.routing!.credentialFallback!()
          expect(String(switched?.routing?.credentialID)).toBe("cred-b")
          expect(targetOf(switched!)).toBe("pa")
        }),
      integration,
    )
  })

  it.effect("serving attribution comes from the load itself, not the earlier active snapshot (#6)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    const activated: string[] = []
    let activeReads = 0
    let current = "cred-b"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "key" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) => Effect.succeed({ id, connections: [conn("cred-a"), conn("cred-b")] }),
      connection: {
        // The ready filter's snapshot reads the active credential first (cred-a); a
        // concurrent session then activates cred-b, so the load itself serves on cred-b.
        active: () =>
          Effect.sync(() => {
            activeReads += 1
            return conn(activeReads === 1 ? "cred-a" : current)
          }),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activated.push(String(id))
            current = String(id)
          }),
      },
    }
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const resolved = yield* resolver.resolveModel(route)
          // Attribution names the credential the request was actually built with.
          expect(String(resolved.routing?.credentialID)).toBe("cred-b")
          // And the fallback excludes that serving credential, so it offers cred-a —
          // with snapshot attribution it would have excluded cred-a and retried the
          // exhausted cred-b.
          const switched = yield* resolved.routing!.credentialFallback!()
          expect(activated).toEqual(["cred-a"])
          expect(String(switched?.routing?.credentialID)).toBe("cred-a")
        }),
      integration,
    )
  })

  itWithRouteLog.effect("quota snapshots from disjoint routes are both fed within one TTL (#1339)", () =>
    withTempDir(({ path }) =>
      Effect.gen(function* () {
        ModelRoute.resetHealth()
        ModelRoute.resetQuotaFeed()
        const now = Date.now()
        const providers = ["quota-a1", "quota-a2", "quota-b1", "quota-b2"]
        const store = providers.reduce(
          (current, providerID) =>
            ModelPlan.upsertPlan(
              current,
              {
                providerID,
                label: providerID,
                coverage: "subscription",
                quotas: [{ name: "hour", unit: "requests", limit: 1, windowHours: 1 }],
                status: "active",
              },
              new Date(now).toISOString(),
            ).store,
          ModelPlan.emptyStore(),
        )
        ModelPlan.writeStore(store, path)

        const db = (yield* Database.Service).db
        yield* db
          .insert(RouteAttemptTable)
          .values(
            providers.map((providerID) => ({
              time_started: now - 1,
              time_ended: now,
              session_id: `session-${providerID}`,
              route_id: `route-${providerID}`,
              provider_id: providerID,
              model_id: "luna",
              outcome: "success",
              output_started: true,
            })),
          )
          .run()

        const route = (providers: [string, string, string], poolID: string) => {
          const leaves = providers.map(leaf)
          return routed(leaves, {
            nodes: [
              { selection: "ordered", weights: [1, 1], children: [{ node: 1 }, { leaf: 2 }] },
              {
                routeID: poolID,
                providerRoute: poolID,
                selection: "ordered",
                weights: [1, 1],
                children: [{ leaf: 0 }, { leaf: 1 }],
              },
            ],
          })
        }
        const routeA = route(["quota-a1", "quota-a2", "quota-a-fallback"], "quota-pool-a")
        const routeB = route(["quota-b1", "quota-b2", "quota-b-fallback"], "quota-pool-b")
        const definitionA = ModelRoute.definition(routeA)!
        const definitionB = ModelRoute.definition(routeB)!
        const allProviders = [...providers, "quota-a-fallback", "quota-b-fallback"]

        yield* withResolver(
          allProviders.map(leaf),
          (resolver) =>
            Effect.gen(function* () {
              // No pool verdict exists to consult (Drew, 2026-11-07): the feed's
              // effect is per provider \u2014 route A's providers are gated by their
              // own snapshots, route B's are not fed yet, and resolution lands on
              // A's individually-clear fallback leaf.
              const resolvedA = yield* resolver.resolveModel(routeA)
              expect(targetOf(resolvedA)).toBe("quota-a-fallback")
              expect(ModelRoute.providerQuotaBlocked(definitionA.targets[0])).toBeDefined()
              expect(ModelRoute.providerQuotaBlocked(definitionA.targets[1])).toBeDefined()
              expect(ModelRoute.providerQuotaBlocked(definitionB.targets[0])).toBeUndefined()
              expect(ModelRoute.providerQuotaBlocked(definitionB.targets[1])).toBeUndefined()

              const resolvedB = yield* resolver.resolveModel(routeB)
              expect(targetOf(resolvedB)).toBe("quota-b-fallback")
              expect(ModelRoute.providerQuotaBlocked(definitionB.targets[0])).toBeDefined()
              expect(ModelRoute.providerQuotaBlocked(definitionB.targets[1])).toBeDefined()
            }),
          undefined,
          path,
        )
      }).pipe(Effect.ensuring(Effect.sync(() => ModelRoute.resetHealth()))),
    ),
  )

  it.effect("a known-full active credential takes its target out of the route until a good read (#6)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered })
    const conn = { type: "credential" as const, id: Credential.ID.make("cred-a"), label: "lab", method: "key" as const }
    const integration = {
      revision: () => 0,
      connection: {
        active: (id: Integration.ID) => Effect.succeed(String(id) === "pa" ? conn : undefined),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
      },
    }
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    const snapshot = (percent: number): QuotaSnapshot.Snapshot => ({
      planID: "pa-plan",
      window: "monthly",
      providerID: "pa",
      percent,
      remaining: percent >= 100 ? 0 : 50,
      resetAt: Date.now() + 3_600_000,
      observedAt: Date.now(),
      stale: false,
    })
    return withResolver(
      [a, b],
      (resolver) =>
        Effect.gen(function* () {
          expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
          ModelRoute.observeCredentialQuota(targetA, "cred-a", snapshot(100))
          expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
          ModelRoute.observeCredentialQuota(targetA, "cred-a", snapshot(40))
          expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        }),
      integration,
    )
  })

  it.effect("a known-full credential is the last resort when nothing else remains (#6)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    const conn = { type: "credential" as const, id: Credential.ID.make("cred-a"), label: "lab", method: "key" as const }
    const integration = {
      revision: () => 0,
      connection: {
        active: () => Effect.succeed(conn),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
      },
    }
    ModelRoute.observeCredentialQuota(ModelRoute.ref({ providerID: "pa", model: a.id }), "cred-a", {
      planID: "pa-plan",
      window: "monthly",
      providerID: "pa",
      percent: 100,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
      observedAt: Date.now(),
      stale: false,
    })
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          // Only target in the route: the gate yields rather than refusing the turn.
          expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
        }),
      integration,
    )
  })

  it.effect("an over-limit non-full target does not mask a known-full last resort that fits (#6)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], {
      ...ordered,
      targetLimits: [{ context: 200_000 }, { context: 100_000 }],
    })
    const conn = { type: "credential" as const, id: Credential.ID.make("cred-a"), label: "lab", method: "key" as const }
    const integration = {
      revision: () => 0,
      connection: {
        active: (id: Integration.ID) => Effect.succeed(String(id) === "pa" ? conn : undefined),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
      },
    }
    ModelRoute.observeCredentialQuota(ModelRoute.ref({ providerID: "pa", model: a.id }), "cred-a", {
      planID: "pa-plan",
      window: "monthly",
      providerID: "pa",
      percent: 100,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
      observedAt: Date.now(),
      stale: false,
    })
    return withResolver(
      [a, b],
      (resolver) =>
        Effect.gen(function* () {
          // pa's credential is known-full but pa fits the request; pb is not quota-blocked
          // but its ceiling is below the request. The last resort is pa: an over-limit
          // target is unusable, so it cannot count as the non-full alternative that
          // excludes the known-full credential.
          expect(targetOf(yield* resolver.resolveModel(route, undefined, "s-mask", 110_000))).toBe("pa")
        }),
      integration,
    )
  })

  // #1806 mechanism 3: the ready filter judged a multi-credential leaf by its single
  // active credential, so a leaf whose active credential was quota-blocked or
  // credential-cooling was excluded even when a stored sibling could serve it.
  const multiCredIntegration = (blocked: "quota" | "none") => {
    const activated: string[] = []
    let activeID = "cred-a"
    const conn = (id: string) => ({
      type: "credential" as const,
      id: Credential.ID.make(id),
      label: id,
      method: "key" as const,
    })
    const integration = {
      revision: () => 0,
      get: (id: Integration.ID) =>
        Effect.succeed({ id, connections: String(id) === "pa" ? [conn("cred-a"), conn("cred-b")] : [] }),
      connection: {
        active: (id: Integration.ID) => Effect.succeed(String(id) === "pa" ? conn(activeID) : undefined),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
        activate: (id: Credential.ID) =>
          Effect.sync(() => {
            activated.push(String(id))
            activeID = String(id)
          }),
      },
    }
    void blocked
    return { integration, activated }
  }
  const fullSnapshot = (providerID: string): QuotaSnapshot.Snapshot => ({
    planID: `${providerID}-plan`,
    window: "monthly",
    providerID,
    percent: 100,
    remaining: 0,
    resetAt: Date.now() + 3_600_000,
    observedAt: Date.now(),
    stale: false,
  })

  it.effect("a leaf whose active credential is quota-blocked serves on a stored sibling credential (#1806)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered })
    const { integration, activated } = multiCredIntegration("quota")
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    return withResolver(
      [a, b],
      (resolver) =>
        Effect.gen(function* () {
          // Served on the active credential while it is healthy.
          const first = yield* resolver.resolveModel(route)
          expect(String(first.routing?.credentialID)).toBe("cred-a")
          // The active credential becomes known-full: the leaf must not be judged
          // by it alone — the stored sibling serves, activated before the load.
          ModelRoute.observeCredentialQuota(targetA, "cred-a", fullSnapshot("pa"))
          const resolved = yield* resolver.resolveModel(route)
          expect(targetOf(resolved)).toBe("pa")
          expect(String(resolved.routing?.credentialID)).toBe("cred-b")
          expect(activated).toEqual(["cred-b"])
        }),
      integration,
    )
  })

  it.effect("a leaf whose active credential is credential-cooling serves on a stored sibling credential (#1806)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const route = routed([a], { ...single })
    const { integration, activated } = multiCredIntegration("none")
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    const now = Date.now()
    for (let index = 0; index < 8; index++)
      ModelRoute.failed(targetA, ModelRoute.policy(), now + index, { quota: true }, "cred-a")
    expect(ModelRoute.credentialCooldownUntil(targetA, "cred-a")).toBeGreaterThan(Date.now())
    return withResolver(
      [a],
      (resolver) =>
        Effect.gen(function* () {
          const resolved = yield* resolver.resolveModel(route)
          expect(targetOf(resolved)).toBe("pa")
          expect(String(resolved.routing?.credentialID)).toBe("cred-b")
          expect(activated).toEqual(["cred-b"])
        }),
      integration,
    )
  })

  it.effect("a leaf is out when every stored credential that could serve it is blocked (#1806)", () => {
    ModelRoute.resetHealth()
    const a = leaf("pa")
    const b = leaf("pb")
    const route = routed([a, b], { ...ordered })
    const { integration, activated } = multiCredIntegration("quota")
    const targetA = ModelRoute.ref({ providerID: "pa", model: a.id })
    return withResolver(
      [a, b],
      (resolver) =>
        Effect.gen(function* () {
          expect(targetOf(yield* resolver.resolveModel(route))).toBe("pa")
          ModelRoute.observeCredentialQuota(targetA, "cred-a", fullSnapshot("pa"))
          ModelRoute.observeCredentialQuota(targetA, "cred-b", fullSnapshot("pa"))
          expect(targetOf(yield* resolver.resolveModel(route))).toBe("pb")
          expect(activated).toEqual([])
        }),
      integration,
    )
  })
})
