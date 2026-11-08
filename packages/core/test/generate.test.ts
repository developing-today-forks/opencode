import { expect } from "bun:test"
import {
  AIError,
  AuthenticationError,
  LanguageModel,
  LLMClient,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
} from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { AISDK } from "@opencode/core/aisdk"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ID, Info, Model, Ref } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const selected = Info.make({
  ...Info.default(Provider.ID.make("test-provider"), ID.make("gemini")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
})
const runtime = LanguageModel.make({ id: "gemini", provider: "test-provider", route: OpenAIChat.route })

const providers = Layer.mock(Provider.Service, {
  get: () => Effect.undefined,
})
const models = Layer.mock(Model.Service, {
  get: () => Effect.succeed(selected),
})
const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: {
    active: () => Effect.undefined,
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
  model: () => Effect.succeed(runtime),
})
const client = TestLLM.testLayer({ fallback: TestLLM.text("OK", "generate") })

const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
const it = testEffect(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, client))))
const resolverIt = testEffect(resolver)

it.effect("loads dynamic AI SDK models", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const result = yield* generate.text({
      prompt: "Return exactly OK",
      model: Ref.make({ providerID: selected.providerID, id: selected.id }),
    })

    expect(result).toBe("OK")
  }),
)

// ---------------------------------------------------------- quota classification (#1441)

const quotaHint = "Subscription quota exhausted; resets at 2026-11-03T04:00:00Z"

testEffect(Layer.empty).effect("isQuotaFailure follows the routing classification: quota and rate-limit tags only", () =>
  Effect.sync(() => {
    expect(Generate.isQuotaFailure(new AIError({ reason: new QuotaExceededError({ message: quotaHint }) }))).toBe(true)
    expect(Generate.isQuotaFailure(new AIError({ reason: new RateLimitError({ message: "slow down" }) }))).toBe(true)
    expect(Generate.isQuotaFailure(new AIError({ reason: new ProviderInternalError({ message: "boom" }) }))).toBe(false)
    expect(Generate.isQuotaFailure(new AIError({ reason: new AuthenticationError({ message: "bad key" }) }))).toBe(false)
  }),
)

const failingIt = (error: AIError) =>
  testEffect(
    Generate.layer.pipe(
      Layer.provide(Layer.merge(resolver, TestLLM.testLayer({ fallback: TestLLM.failAfter(error) }))),
    ),
  )

failingIt(new AIError({ reason: new QuotaExceededError({ message: quotaHint }) })).effect(
  "a quota-exceeded provider failure surfaces as Generate.QuotaError with the reset hint preserved",
  () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const error = yield* generate
        .complete({
          model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          messages: [{ role: "user", content: "hi" }],
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Generate.QuotaError")
      expect(error.message).toBe(quotaHint)
      expect(error.message).toContain("resets at 2026-11-03T04:00:00Z")
    }),
)

failingIt(new AIError({ reason: new RateLimitError({ message: "rate limited; resets at 2026-11-03T04:00:00Z" }) })).effect(
  "a rate-limit provider failure surfaces as Generate.QuotaError",
  () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const error = yield* generate
        .complete({
          model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          messages: [{ role: "user", content: "hi" }],
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Generate.QuotaError")
      expect(error.message).toContain("rate limited")
    }),
)

failingIt(new AIError({ reason: new ProviderInternalError({ message: "upstream exploded" }) })).effect(
  "a non-quota provider failure still surfaces as Generate.UnavailableError",
  () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const error = yield* generate
        .complete({
          model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          messages: [{ role: "user", content: "hi" }],
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Generate.UnavailableError")
      expect(error.message).toBe("upstream exploded")
    }),
)

failingIt(new AIError({ reason: new AuthenticationError({ message: "bad key" }) })).effect(
  "an auth provider failure keeps the existing UnavailableError mapping, not the quota class",
  () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const error = yield* generate
        .complete({
          model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          messages: [{ role: "user", content: "hi" }],
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Generate.UnavailableError")
    }),
)

failingIt(new AIError({ reason: new QuotaExceededError({ message: quotaHint }) })).effect(
  "a quota failure on the stream path surfaces as Generate.QuotaError",
  () =>
    Effect.gen(function* () {
      const generate = yield* Generate.Service
      const error = yield* generate
        .stream({
          model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          messages: [{ role: "user", content: "hi" }],
        })
        .pipe(Stream.runCollect, Effect.flip)
      expect(error._tag).toBe("Generate.QuotaError")
      expect(error.message).toBe(quotaHint)
    }),
)

resolverIt.effect("resolves dynamic models with their catalog metadata", () =>
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const result = yield* resolver.resolve(Ref.make({ providerID: selected.providerID, id: selected.id }))

    expect(result).toEqual({
      model: runtime,
      ref: Ref.make({ providerID: selected.providerID, id: selected.id }),
      capabilities: selected.capabilities,
      cost: selected.cost,
      limit: selected.limit,
    })
  }),
)

testEffect(Layer.empty).effect("attributes each stateless completion without creating a stored session", () =>
  Effect.gen(function* () {
    const sessions: string[] = []
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const session = request.headers["x-opencode-session"]
          if (!session)
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  error: { type: "MissingSessionID", message: "Session ID is required" },
                },
                { status: 400 },
              ),
            )
          sessions.push(session)
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              `data: ${JSON.stringify({
                id: "completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "gemini",
                choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      ),
    )
    const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
    yield* Effect.gen(function* () {
      const generate = yield* Generate.Service
      for (let index = 0; index < 2; index++) {
        expect(
          yield* generate.text({
            prompt: "Return exactly OK",
            model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          }),
        ).toBe("OK")
      }
    }).pipe(Effect.provide(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, native)))))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toStartWith("ses_")
    expect(sessions[1]).not.toBe(sessions[0])
  }),
)
