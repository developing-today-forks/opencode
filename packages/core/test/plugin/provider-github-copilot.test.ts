import { AISDK } from "@opencode/core/aisdk"
import { App } from "@opencode/core/app"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/core/session"
import { Location } from "@opencode/core/location"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import {
  copilotBaseURL,
  copilotEndpointDiscoveryNeeded,
  copilotEntitlementError,
  copilotFetch,
  deviceIntervalMs,
  discoverCopilotApiEndpoint,
  GithubCopilotPlugin,
  oauthMaxResponseBytes,
  slowDownWaitMs,
  utilityTitle,
  utilityTitleMaxResponseBytes,
} from "@opencode/core/plugin/provider/github-copilot"
import { Message, SystemPart } from "@opencode/ai"
import { Provider } from "@opencode/core/provider"
import { Integration } from "@opencode/core/integration"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { fakeSelectorSdk } from "../fixture/selector"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* GithubCopilotPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const sessions = Effect.fn(function* () {
  const service = yield* Session.Service
  const location = yield* Location.Service
  const parent = yield* service.create({ location: { directory: location.directory } })
  const child = yield* service.create({ parentID: parent.id })
  return { parent: parent.id, child: child.id }
})

const modelRequest = Effect.fn(function* (sessionID: Session.ID, kind: SessionRequestKind, agent = "build") {
  const hooks = yield* PluginHooks.Service
  return yield* hooks.trigger("session", "model.request", {
    sessionID,
    agent: Agent.ID.make(agent),
    model: Model.Ref.make({ providerID: Provider.ID.githubCopilot, id: Model.ID.make("gpt-5.4") }),
    kind,
    headers: {},
  })
})

describe("GithubCopilotPlugin", () => {
  test("prefers the account-specific Copilot API endpoint", () => {
    expect(
      copilotBaseURL({
        enterpriseUrl: "company.ghe.com",
        apiEndpoint: "https://api.business.githubcopilot.com",
      }),
    ).toBe("https://api.business.githubcopilot.com")
  })

  test("only discovers a plan endpoint when the credential stored neither endpoint nor enterprise URL", () => {
    expect(copilotEndpointDiscoveryNeeded(undefined)).toBe(true)
    expect(copilotEndpointDiscoveryNeeded({})).toBe(true)
    // A v1-migrated credential carries only account identity metadata.
    expect(copilotEndpointDiscoveryNeeded({ accountID: "123" })).toBe(true)
    expect(copilotEndpointDiscoveryNeeded({ apiEndpoint: "https://api.business.githubcopilot.com" })).toBe(false)
    expect(copilotEndpointDiscoveryNeeded({ enterpriseUrl: "company.ghe.com" })).toBe(false)
    expect(copilotEndpointDiscoveryNeeded({ apiEndpoint: "" })).toBe(true)
  })

  it.live("discovers the plan endpoint a migrated credential never stored", () =>
    Effect.gen(function* () {
      const seen: Array<{ url?: string; init?: RequestInit }> = []
      const endpoint = yield* discoverCopilotApiEndpoint({
        token: "token",
        app: App.make({ name: "test", version: "1.2.3", channel: "beta" }),
        fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          seen.push({ url: String(input), init })
          return Response.json({
            copilot_plan: "business",
            endpoints: { api: "https://api.business.githubcopilot.com/" },
          })
        },
      })
      expect(endpoint).toBe("https://api.business.githubcopilot.com")
      expect(seen[0]?.url).toBe("https://api.github.com/copilot_internal/user")
      const headers = new Headers(seen[0]?.init?.headers)
      expect(headers.get("authorization")).toBe("Bearer token")
      expect(headers.get("x-github-api-version")).toBe("2025-04-01")
      expect(headers.get("user-agent")).toBe("opencode/beta/1.2.3/test")
    }),
  )

  it.live("returns no plan endpoint when the lookup reports none", () =>
    Effect.gen(function* () {
      const app = App.make({ name: "test", version: "1.2.3", channel: "beta" })
      const missing = yield* discoverCopilotApiEndpoint({
        token: "token",
        app,
        fetch: async () => Response.json({ copilot_plan: "individual" }),
      })
      expect(missing).toBeUndefined()
      const malformed = yield* discoverCopilotApiEndpoint({
        token: "token",
        app,
        fetch: async () => Response.json({ endpoints: { api: 42 } }),
      })
      expect(malformed).toBeUndefined()
    }),
  )

  it.live("fails plan endpoint discovery on a non-200 lookup so load can fall back", () =>
    Effect.gen(function* () {
      const error = yield* discoverCopilotApiEndpoint({
        token: "token",
        app: App.make({ name: "test", version: "1.2.3", channel: "beta" }),
        fetch: async () => new Response("nope", { status: 500 }),
      }).pipe(Effect.flip)
      expect(String(error)).toContain("500")
    }),
  )

  it.live("fails plan endpoint discovery on a declared oversized response before reading it (#1026)", () =>
    Effect.gen(function* () {
      let bodyRead = false
      const error = yield* discoverCopilotApiEndpoint({
        token: "token",
        app: App.make({ name: "test", version: "1.2.3", channel: "beta" }),
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("small body"))
              },
              pull(controller) {
                bodyRead = true
                controller.close()
              },
            }),
            { headers: { "content-length": String(oauthMaxResponseBytes + 1) } },
          ),
      }).pipe(Effect.flip)
      expect(String(error)).toContain("exceeded")
      expect(bodyRead).toBe(false)
    }),
  )

  it.live("fails plan endpoint discovery on a streamed oversized response with no declared length (#1026)", () =>
    Effect.gen(function* () {
      const chunkBytes = oauthMaxResponseBytes / 2
      const totalChunks = 8
      let pulled = 0
      const error = yield* discoverCopilotApiEndpoint({
        token: "token",
        app: App.make({ name: "test", version: "1.2.3", channel: "beta" }),
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (pulled === totalChunks) return controller.close()
                pulled++
                controller.enqueue(new Uint8Array(chunkBytes))
              },
            }),
          ),
      }).pipe(Effect.flip)
      expect(String(error)).toContain("exceeded")
      expect(pulled).toBeLessThan(totalChunks)
    }),
  )

  test("rejects accounts without Copilot chat access", () => {
    expect(copilotEntitlementError({ chat_enabled: false, can_signup_for_limited: true })).toContain("Copilot Free")
    expect(copilotEntitlementError({ chat_enabled: false, can_signup_for_limited: false })).toContain(
      "subscription or a seat",
    )
    expect(copilotEntitlementError({ chat_enabled: false })).toContain("subscription or a seat")
  })

  test("only blocks on an explicit entitlement denial", () => {
    expect(copilotEntitlementError({ chat_enabled: true })).toBeUndefined()
    expect(copilotEntitlementError({ chat_enabled: true, can_signup_for_limited: true })).toBeUndefined()
    expect(copilotEntitlementError({})).toBeUndefined()
  })

  it.effect("registers GitHub Copilot device OAuth", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      expect((yield* integrations.get(Integration.ID.make("github-copilot")))?.methods).toContainEqual({
        id: Integration.MethodID.make("device"),
        type: "oauth",
        label: "Login with GitHub Copilot",
        form: expect.any(Array),
      })
    }),
  )

  it.effect("removes the generic key method", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      yield* integrations.transform((editor) => {
        editor.method.update({
          integrationID: Integration.ID.make("github-copilot"),
          method: { type: "key" },
        })
        editor.method.update({
          integrationID: Integration.ID.make("github-copilot"),
          method: { type: "env", names: ["GITHUB_TOKEN"] },
        })
      })
      yield* addPlugin()
      expect((yield* integrations.get(Integration.ID.make("github-copilot")))?.methods).toEqual([
        { type: "env", names: ["GITHUB_TOKEN"] },
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "Login with GitHub Copilot",
          form: expect.any(Array),
        },
      ])
    }),
  )

  it.live("adds Copilot authentication and request metadata headers", () =>
    Effect.gen(function* () {
      const requests: Headers[] = []
      const send = copilotFetch(
        "token",
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requests.push(new Headers(init?.headers))
          return Response.json({ ok: true })
        },
        App.make({ name: "test", version: "1.2.3", channel: "beta" }),
      )
      yield* Effect.promise(() =>
        send("https://api.githubcopilot.com/chat/completions", {
          method: "POST",
          headers: { "x-api-key": "old" },
          body: JSON.stringify({
            messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png" } }] }],
          }),
        }),
      )
      expect(requests[0]?.get("authorization")).toBe("Bearer token")
      expect(requests[0]?.has("x-api-key")).toBe(false)
      expect(requests[0]?.get("x-initiator")).toBe("user")
      expect(requests[0]?.get("copilot-vision-request")).toBe("true")
      expect(requests[0]?.get("x-github-api-version")).toBe("2026-08-01")
      expect(requests[0]?.get("user-agent")).toBe("opencode/beta/1.2.3/test")
    }),
  )

  it.effect("adds Copilot authentication to native Anthropic requests", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const hooks = yield* PluginHooks.Service
      const event = yield* hooks.trigger("session", "http.request", {
        sessionID: Session.ID.make("ses_test"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.githubCopilot, id: Model.ID.make("claude-sonnet-4.5") }),
        kind: "primary",
        request: new Request("https://api.githubcopilot.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": "token" },
          body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
        }),
      })
      expect(event.request.headers.get("authorization")).toBe("Bearer token")
      expect(event.request.headers.has("x-api-key")).toBe(false)
      expect(event.request.headers.get("x-initiator")).toBe("user")
      expect(event.request.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
      expect(event.request.headers.get("x-github-api-version")).toBe("2026-08-01")
    }),
  )

  it.effect("classifies main-loop steps as agent interactions", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const event = yield* modelRequest((yield* sessions()).parent, "primary")
      expect(event.headers).toEqual({ "X-Interaction-Type": "conversation-agent", "X-Interaction-Id": event.sessionID })
    }),
  )

  it.effect("classifies child-session steps as subagent interactions", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const ids = yield* sessions()
      const event = yield* modelRequest(ids.child, "primary")
      expect(event.headers).toEqual({
        "X-Interaction-Type": "conversation-subagent",
        "X-Interaction-Id": ids.parent,
        "x-initiator": "agent",
      })
    }),
  )

  it.effect("classifies title generation as a background interaction", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const event = yield* modelRequest((yield* sessions()).parent, "title")
      expect(event.headers).toEqual({
        "X-Interaction-Type": "conversation-background",
        "X-Interaction-Id": event.sessionID,
        "x-initiator": "agent",
      })
    }),
  )

  it.effect("classifies compaction requests by kind rather than agent", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const ids = yield* sessions()
      const event = yield* modelRequest(ids.child, "compaction", "build")
      expect(event.headers).toEqual({
        "X-Interaction-Type": "conversation-compaction",
        "X-Interaction-Id": ids.parent,
        "x-initiator": "agent",
      })
    }),
  )

  it.effect("does not classify by agent name", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const event = yield* modelRequest((yield* sessions()).parent, "primary", "compaction")
      expect(event.headers).toEqual({ "X-Interaction-Type": "conversation-agent", "X-Interaction-Id": event.sessionID })
    }),
  )

  it.effect("ignores other providers' model requests", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const hooks = yield* PluginHooks.Service
      const event = yield* hooks.trigger("session", "model.request", {
        sessionID: (yield* sessions()).parent,
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-5.4") }),
        kind: "primary",
        headers: {},
      })
      expect(event.headers).toEqual({})
    }),
  )

  const titleRequest = {
    sessionID: Session.ID.make("ses_title"),
    system: [SystemPart.make("You are a title generator.")],
    messages: [Message.user("how do I make my python script faster")],
    options: { maxTokens: 32 },
  }
  const utilityInput = (send: (init?: RequestInit) => Response | Promise<Response>) => ({
    baseURL: "https://api.individual.githubcopilot.com",
    token: "token",
    model: "gpt-4o-mini",
    app: App.make({ name: "test", version: "1.2.3", channel: "beta" }),
    fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => send(init),
  })

  it.live("names sessions with the utility model as a free background request", () =>
    Effect.gen(function* () {
      const seen: Array<{ url?: string; init?: RequestInit }> = []
      const title = yield* utilityTitle(
        {
          ...utilityInput(() => Response.json({ choices: [{ message: { content: "  Speed Up Python Script\n" } }] })),
          fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            seen.push({ url: String(input), init })
            return Response.json({ choices: [{ message: { content: "  Speed Up Python Script\n" } }] })
          },
        },
        titleRequest,
      )
      expect(title).toBe("Speed Up Python Script")
      expect(seen[0]?.url).toBe("https://api.individual.githubcopilot.com/chat/completions")
      const headers = new Headers(seen[0]?.init?.headers)
      expect(headers.get("authorization")).toBe("Bearer token")
      expect(headers.get("x-interaction-type")).toBe("agent-session-name-generation")
      expect(headers.get("x-interaction-id")).toBe("ses_title")
      expect(headers.get("x-initiator")).toBe("agent")
      expect(headers.get("x-github-api-version")).toBe("2026-08-01")
      expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
        model: "gpt-4o-mini",
        stream: false,
        max_tokens: 32,
        messages: [
          { role: "system", content: "You are a title generator." },
          { role: "user", content: "how do I make my python script faster" },
        ],
      })
    }),
  )

  it.live("fails the utility title on rate limits so the billable path can run", () =>
    Effect.gen(function* () {
      const error = yield* utilityTitle(
        utilityInput(() => new Response("slow down", { status: 429 })),
        titleRequest,
      ).pipe(Effect.flip)
      expect(String(error)).toContain("429")
    }),
  )

  it.live("fails the utility title on a declared oversized response before reading it", () =>
    Effect.gen(function* () {
      const error = yield* utilityTitle(
        utilityInput(
          () =>
            new Response("small body, lying header", {
              headers: { "content-length": String(utilityTitleMaxResponseBytes + 1) },
            }),
        ),
        titleRequest,
      ).pipe(Effect.flip)
      expect(String(error)).toContain("exceeded")
    }),
  )

  it.live("fails the utility title on a streamed oversized response with no declared length", () =>
    Effect.gen(function* () {
      const error = yield* utilityTitle(
        utilityInput(
          () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("x".repeat(utilityTitleMaxResponseBytes + 1)))
                  controller.close()
                },
              }),
            ),
        ),
        titleRequest,
      ).pipe(Effect.flip)
      expect(String(error)).toContain("exceeded")
    }),
  )

  it.live("fails the utility title on an empty completion", () =>
    Effect.gen(function* () {
      const error = yield* utilityTitle(
        utilityInput(() => Response.json({ choices: [{ message: { content: null } }] })),
        titleRequest,
      ).pipe(Effect.flip)
      expect(String(error)).toContain("empty")
    }),
  )

  it.live("keeps a declared agent initiator when the body looks user-initiated", () =>
    Effect.gen(function* () {
      const requests: Headers[] = []
      const send = copilotFetch(
        "token",
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requests.push(new Headers(init?.headers))
          return Response.json({ ok: true })
        },
        App.make({ name: "test", version: "1.2.3", channel: "beta" }),
      )
      yield* Effect.promise(() =>
        send("https://api.githubcopilot.com/chat/completions", {
          method: "POST",
          headers: { "x-initiator": "agent" },
          body: JSON.stringify({ messages: [{ role: "user", content: "summarize" }] }),
        }),
      )
      expect(requests[0]?.get("x-initiator")).toBe("agent")
    }),
  )

  it.effect("classifies session generation requests as agent interactions", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const event = yield* modelRequest((yield* sessions()).parent, "generate")
      expect(event.headers).toEqual({ "X-Interaction-Type": "conversation-agent", "X-Interaction-Id": event.sessionID })
    }),
  )

  it.effect("creates the bundled Copilot SDK for the GitHub Copilot package", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const ignored = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5")),
          modelID: Model.ID.make("gpt-5"),
          package: "aisdk:test-provider",
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "github-copilot" },
      })
      const result = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5")),
          modelID: Model.ID.make("gpt-5"),
          package: "aisdk:test-provider",
        }),
        package: "@ai-sdk/github-copilot",
        options: { name: "github-copilot" },
      })
      expect(ignored.sdk).toBeUndefined()
      expect(result.sdk).toBeDefined()
    }),
  )

  it.effect("rewrites models.dev fallback models to the GitHub Copilot package", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      const aisdk = yield* AISDK.Service
      yield* providers.transform((editor) => {
        editor.update(Provider.ID.githubCopilot, (provider) => {
          provider.activation = "enabled"
        })
        editor.models.update(Provider.ID.githubCopilot, Model.ID.make("gpt-5.6-sol"), (model) => {
          model.package = Provider.aisdk("@ai-sdk/openai-compatible")
        })
      })
      yield* addPlugin()
      const fallback = required(yield* models.get(Provider.ID.githubCopilot, Model.ID.make("gpt-5.6-sol")))
      expect(fallback.package).toBe(Provider.aisdk("@ai-sdk/github-copilot"))

      const resolved = yield* ModelResolver.fromCatalogModel(fallback, undefined, {
        loadPackage: () => Effect.die("Copilot must not load a native provider package"),
        loadAISDK: (model) => aisdk.model(model),
      })
      expect(resolved.route.id).toBe("ai-sdk:@ai-sdk/github-copilot")
      expect(resolved.route.providerMetadataKey).toBe("copilot")
    }),
  )

  it.effect("selects languageModel when responses and chat are absent", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("claude-sonnet-4")),
          modelID: Model.ID.make("claude-sonnet-4"),
          package: "aisdk:test-provider",
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: {},
      })
      expect(calls).toEqual(["languageModel:claude-sonnet-4"])
    }),
  )

  it.effect("selects languageModel with the API model ID when responses and chat are absent", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("alias")),
          modelID: Model.ID.make("claude-sonnet-4"),
          package: "aisdk:test-provider",
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: {},
      })
      expect(calls).toEqual(["languageModel:claude-sonnet-4"])
    }),
  )

  it.effect("uses responses for gpt-5 models except gpt-5-mini", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5")),
          modelID: Model.ID.make("gpt-5"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5.1-codex")),
          modelID: Model.ID.make("gpt-5.1-codex"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-4o")),
          modelID: Model.ID.make("gpt-4o"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5-mini")),
          modelID: Model.ID.make("gpt-5-mini"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5-mini-2025-08-07")),
          modelID: Model.ID.make("gpt-5-mini-2025-08-07"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([
        "responses:gpt-5",
        "responses:gpt-5.1-codex",
        "chat:gpt-4o",
        "chat:gpt-5-mini",
        "chat:gpt-5-mini-2025-08-07",
      ])
    }),
  )

  it.effect("uses responses for Grok and MAI Code models and chat for Gemini", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("grok-4.5")),
          modelID: Model.ID.make("grok-4.5"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("grok-4.6")),
          modelID: Model.ID.make("grok-4.6"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gemini-3.8-flash")),
          modelID: Model.ID.make("gemini-3.8-flash"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("mai-code-1.1-flash")),
          modelID: Model.ID.make("mai-code-1.1-flash"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-4o")),
          modelID: Model.ID.make("gpt-4o"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([
        "responses:grok-4.5",
        "responses:grok-4.6",
        "chat:gemini-3.8-flash",
        "responses:mai-code-1.1-flash",
        "chat:gpt-4o",
      ])
    }),
  )

  it.effect("uses advertised Copilot endpoint metadata before model ID fallbacks", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("mai-code-1-flash-picker")),
          modelID: Model.ID.make("mai-code-1-flash-picker"),
          package: "aisdk:test-provider",
          settings: { endpoint: "responses" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: { endpoint: "responses" },
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("gpt-5")),
          modelID: Model.ID.make("gpt-5"),
          package: "aisdk:test-provider",
          settings: { endpoint: "chat" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: { endpoint: "chat" },
      })
      expect(calls).toEqual(["responses:mai-code-1-flash-picker", "chat:gpt-5"])
    }),
  )

  it.effect("uses the API model ID when selecting responses or chat", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("default")),
          modelID: Model.ID.make("gpt-5"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("small")),
          modelID: Model.ID.make("gpt-5-mini"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("github-copilot"), Model.ID.make("sonnet")),
          modelID: Model.ID.make("claude-sonnet-4"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual(["responses:gpt-5", "chat:gpt-5-mini", "chat:claude-sonnet-4"])
    }),
  )

  it.effect("disables gpt-5-chat-latest before Copilot language selection", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      yield* providers.transform((editor) => {
        editor.update(Provider.ID.githubCopilot, (provider) => {
          provider.activation = "enabled"
        })
        editor.models.update(Provider.ID.githubCopilot, Model.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        required(yield* models.get(Provider.ID.githubCopilot, Model.ID.make("gpt-5-chat-latest")))
          .enabled,
      ).toBe(false)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-Copilot providers", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      yield* providers.transform((editor) => {
        editor.update(Provider.ID.make("custom-copilot"), () => {})
        editor.models.update(Provider.ID.make("custom-copilot"), Model.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        required(yield* models.get(Provider.ID.make("custom-copilot"), Model.ID.make("gpt-5-chat-latest")))
          .enabled,
      ).toBe(true)
    }),
  )

  it.effect("ignores non-Copilot providers", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make("gpt-5")),
          modelID: Model.ID.make("gpt-5"),
          package: "aisdk:test-provider",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )
})

describe("GithubCopilotPlugin device polling", () => {
  test("bounds the device poll interval and falls back on unusable values (#915)", () => {
    // Ordinary GitHub interval: 5s, polled with the safety margin on top.
    expect(deviceIntervalMs(5)).toBe(5000)
    expect(deviceIntervalMs(10)).toBe(10_000)
    expect(deviceIntervalMs(1)).toBe(1000)
    // Sub-second values are floored to 1 second instead of flooding the
    // token endpoint.
    expect(deviceIntervalMs(0.5)).toBe(1000)
    // An oversized or unit-confused interval is clamped to the 60-second
    // ceiling instead of outlasting the 10-minute attempt lifetime.
    expect(deviceIntervalMs(600)).toBe(60_000)
    expect(deviceIntervalMs(999_999)).toBe(60_000)
    // Zero, negative, and non-finite values take the 5-second fallback
    // instead of busy-polling or never polling.
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(deviceIntervalMs(value)).toBe(5000)
  })

  test("slow_down never shortens the wait (#915)", () => {
    // No usable interval in the response: the sibling flows' +5s.
    expect(slowDownWaitMs(5000, undefined)).toBe(10_000)
    expect(slowDownWaitMs(5000, Number.NaN)).toBe(10_000)
    // A smaller positive interval must not speed polling up against an
    // endpoint asking the client to back off.
    expect(slowDownWaitMs(5000, 1)).toBe(10_000)
    expect(slowDownWaitMs(5000, 8)).toBe(10_000)
    // A larger server interval is honoured, through the same ceiling.
    expect(slowDownWaitMs(5000, 30)).toBe(30_000)
    expect(slowDownWaitMs(5000, 600)).toBe(60_000)
  })
})
