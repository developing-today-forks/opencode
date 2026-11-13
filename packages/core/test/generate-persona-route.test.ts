/**
 * Persona routes (#1413, Wave C): a model route that carries a system
 * prompt (`system` in model_routes config) serves the design-code door's
 * persona behaviour through the façade's Generate path —
 *   - the carried prompt leads the caller's own system text on EVERY
 *     candidate the route tries (the door composed
 *     `DESIGN_SYSTEM_PROMPT + "\n\n" + callerSystem` per dispatch), and
 *   - a failed primary candidate fails over to the route's next
 *     candidate in configured order (the door's primary→fallback recipe
 *     walk), each candidate its own ledgered attempt.
 * The stack is the real one (ModelResolver + LLMClient over a fake HTTP
 * endpoint, as in generate-passthrough.test.ts); the fake endpoint
 * fails the first leaf it is asked for and answers the second.
 */
import { expect } from "bun:test"
import { LanguageModel, LLMClient } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import { AISDK } from "@opencode/core/aisdk"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ModelRoute } from "@opencode/core/model-route"
import { ID, Info, Model, Ref } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const DESIGN = "You are an elite Code & Systems Design Architect."

const leaf = (providerID: string, modelID: string) =>
  Info.make({
    ...Info.default(Provider.ID.make(providerID), ID.make(modelID)),
    package: Provider.aisdk("@ai-sdk/openai"),
    settings: { apiKey: "key" },
  })

const leafA = leaf("door-a", "gemini-flash")
const leafB = leaf("door-b", "gpt-luna")

const route = Info.make({
  ...Info.default(ModelRoute.PROVIDER_ID, ID.make("design-persona")),
  name: "design-persona",
  settings: {
    [ModelRoute.SETTING]: {
      id: "design-persona",
      system: DESIGN,
      targets: [leafA, leafB].map((item) => ({ providerID: item.providerID, id: item.id })),
      targetVariants: [{}, {}],
      health: ModelRoute.policy(),
      attempts: 1,
      nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    },
  },
})

const catalog = new Map(
  [route, leafA, leafB].map((info) => [`${info.providerID}/${info.id}`, info] as const),
)

const providers = Layer.mock(Provider.Service, {
  get: (providerID) =>
    Effect.succeed(
      Provider.Info.make({
        ...Provider.Info.empty(providerID),
        activation: "enabled",
        package: Provider.aisdk("@ai-sdk/openai"),
        settings: { apiKey: "key" },
      }),
    ),
})
const models = Layer.mock(Model.Service, {
  get: (providerID, id) => Effect.succeed(catalog.get(`${providerID}/${id}`)),
})
const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: { active: () => Effect.undefined },
} as never)
const npm = Layer.mock(Npm.Service, {} as never)
const aisdk = Layer.mock(AISDK.Service, {
  hook: { sdk: () => Effect.die("unused"), language: () => Effect.die("unused") },
  model: (info: Info) =>
    Effect.succeed(
      LanguageModel.make({ id: String(info.modelID ?? info.id), provider: String(info.providerID), route: OpenAIChat.route }),
    ),
} as never)

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body as { text?: string; body?: Uint8Array }
  if (body.text !== undefined) return body.text
  if (body.body) return new TextDecoder().decode(body.body)
  return ""
}

const chatSSE = (text: string) =>
  new Response(
    `data: ${JSON.stringify({
      id: "completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "leaf",
      choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )

const setup = () => {
  const bodies: string[] = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const text = bodyTextOf(request)
        bodies.push(text)
        // The primary candidate's backend fails (the door's 5xx case);
        // the fallback candidate answers.
        if (bodies.length === 1)
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ error: { message: "primary backend down" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          )
        return HttpClientResponse.fromWeb(request, chatSSE("FALLBACK-ANSWER"))
      }),
    ),
  )
  const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
  const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
  const it = testEffect(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, native))))
  return { it, bodies }
}

const personaRef = Ref.make({ providerID: ModelRoute.PROVIDER_ID, id: ID.make("design-persona") })

{
  const { it, bodies } = setup()
  it.effect("complete: primary failure fails over, carried prompt leads on both candidates", () =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const generate = yield* Generate.Service
      const response = yield* generate.complete({
        model: personaRef,
        system: "Caller system text.",
        messages: [{ role: "user", content: "hi" }],
      })
      expect(response.text).toBe("FALLBACK-ANSWER")
      // Exactly two provider calls: primary (failed) then fallback.
      expect(bodies.length).toBe(2)
      for (const body of bodies) {
        const designAt = body.indexOf("elite Code & Systems Design Architect")
        const callerAt = body.indexOf("Caller system text.")
        expect(designAt).toBeGreaterThanOrEqual(0)
        expect(callerAt).toBeGreaterThan(designAt)
      }
    }),
  )
}

{
  const { it, bodies } = setup()
  it.effect("stream: primary failure before any event fails over to the fallback candidate", () =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const generate = yield* Generate.Service
      const events = yield* Stream.runCollect(
        generate.stream({
          model: personaRef,
          messages: [{ role: "user", content: "hi" }],
        }),
      )
      const text = events
        .filter((event) => event.type === "text-delta")
        .map((event) => (event as { text: string }).text)
        .join("")
      expect(text).toBe("FALLBACK-ANSWER")
      expect(bodies.length).toBe(2)
      expect(bodies[0]).toContain("elite Code & Systems Design Architect")
    }),
  )
}
