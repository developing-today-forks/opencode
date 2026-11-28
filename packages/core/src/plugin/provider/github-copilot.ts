import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import type { SessionRequestKind, SessionTitle } from "@opencode/plugin/effect/session"
import { isRecord } from "@opencode/util/record"
import { Clock, Effect, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { IntegrationConnection } from "../../integration/connection.js"
import { Credential } from "../../credential.js"
import { CopilotModels } from "../../github-copilot/models.js"
import { App } from "../../app.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { Agent } from "../../agent.js"
import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "../../provider.js"
import { SessionAffinity } from "../../session/affinity.js"
import { collectBoundedResponseBody, readBoundedResponseText } from "../../tool/http-body.js"
import type { Session } from "@opencode/schema/session"
import { SharedCache } from "../../shared-cache.js"
import { activeCredential, credentialSettings } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"
import type { PluginInternal } from "../internal.js"

const clientID = "Ov23li8tweQw6odWQebz"
const apiVersion = "2026-08-01"
const userApiVersion = "2025-04-01"
const pollingSafetyMargin = 3000
/** Poll interval for the device flow, in milliseconds. The server-supplied
 * `interval` was only floored (#915): a large or unit-confused value (600
 * for a 600-second wait in milliseconds, say) made the first sleep outlast
 * the integration layer's 10-minute attempt lifetime, silently guaranteeing
 * a login timeout. Non-positive and non-finite values take the 5-second
 * fallback and the result is clamped to [1s, 60s] — the sibling flows'
 * deviceIntervalMs shape (opencode.ts, #880) plus a ceiling low enough to
 * poll many times within the attempt lifetime; the poll loop adds
 * pollingSafetyMargin on top of every wait. */
export const deviceIntervalMs = (interval: number): number => {
  const seconds = Number.isFinite(interval) && interval > 0 ? interval : 5
  return Math.min(Math.max(seconds, 1), 60) * 1000
}
/** The wait after a `slow_down` response. RFC 8628 says the client must
 * slow down, so the next wait never drops below the current wait + 5s —
 * the sibling flows' behaviour — even when the response repeats a smaller
 * positive `interval`; a larger server interval is honoured through
 * deviceIntervalMs, ceiling and all. */
export const slowDownWaitMs = (wait: number, interval?: number): number =>
  Math.max(wait + 5000, interval === undefined ? 0 : deviceIntervalMs(interval))
const methodID = Integration.MethodID.make("device")

const Device = Schema.Struct({
  verification_uri: Schema.String,
  user_code: Schema.String,
  device_code: Schema.String,
  interval: Schema.Number,
})
const Token = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
})
const User = Schema.Struct({
  chat_enabled: Schema.optional(Schema.Boolean),
  can_signup_for_limited: Schema.optional(Schema.Boolean),
  endpoints: Schema.optional(
    Schema.Struct({
      api: Schema.optional(Schema.String),
    }),
  ),
})
const decodeUser = Schema.decodeUnknownOption(User)
/** Decode an OAuth device/token response body on the failure channel. A 200
 * with valid JSON of the wrong shape must fail typed, not die: the previous
 * `Effect.map(Schema.decodeUnknownSync(...))` turned the schema throw into a
 * fiber defect that killed the login/poll fiber before any of the readable
 * error branches could run (#2884). The sibling flows' decodeUnknownEffect
 * shape (xai.ts, gitlab.ts), mapped to a plain Error like the non-OK branch. */
export function decodeOAuthDevice(body: unknown) {
  return Schema.decodeUnknownEffect(Device)(body).pipe(
    Effect.mapError(() => new Error("GitHub Copilot device authorization returned an unreadable response body")),
    Effect.catchDefect(() =>
      Effect.fail(new Error("GitHub Copilot device authorization returned an unreadable response body")),
    ),
  )
}
export function decodeOAuthToken(body: unknown) {
  return Schema.decodeUnknownEffect(Token)(body).pipe(
    Effect.mapError(() => new Error("GitHub Copilot token poll returned an unreadable response body")),
    Effect.catchDefect(() => Effect.fail(new Error("GitHub Copilot token poll returned an unreadable response body"))),
  )
}
const AutoRoute = Schema.Struct({
  session_token: Schema.String,
  expires_at: Schema.Number,
  selected_model: Schema.Struct({ id: Schema.String }),
})
const JsonBody = Schema.fromJsonString(Schema.Unknown)
const decodeBody = Schema.decodeUnknownOption(JsonBody)

const oauth = (app: App.Info) =>
  ({
    integrationID: Integration.ID.make("github-copilot"),
    method: {
      id: methodID,
      type: "oauth",
      label: "Login with GitHub Copilot",
      form: [
        {
          type: "string",
          key: "deploymentType",
          title: "Select GitHub deployment type",
          required: true,
          options: [
            { label: "GitHub.com", value: "github.com", description: "Public" },
            { label: "GitHub Enterprise", value: "enterprise", description: "Data residency or self-hosted" },
          ],
        },
        {
          type: "string",
          key: "enterpriseUrl",
          title: "Enter your GitHub Enterprise URL or domain",
          placeholder: "company.ghe.com or https://company.ghe.com",
          required: true,
          when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
        },
      ],
    },
    authorize: (answer) =>
      Effect.gen(function* () {
        const enterprise = answer.deploymentType === "enterprise"
        const enterpriseUrl = typeof answer.enterpriseUrl === "string" ? answer.enterpriseUrl : undefined
        if (enterprise && !enterpriseUrl) return yield* Effect.fail(new Error("Enterprise URL is required"))
        const domain = enterprise ? normalizeDomain(enterpriseUrl ?? "") : "github.com"
        const urls = oauthURLs(domain)
        const device = yield* request(urls.device, {
          method: "POST",
          headers: headers(app),
          body: JSON.stringify({ client_id: clientID, scope: "read:user" }),
        }).pipe(Effect.flatMap(decodeOAuthDevice))
        const interval = deviceIntervalMs(device.interval)

        const poll = (wait: number): Effect.Effect<Credential.OAuth, unknown> =>
          request(urls.token, {
            method: "POST",
            headers: headers(app),
            body: JSON.stringify({
              client_id: clientID,
              device_code: device.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          }).pipe(
            Effect.flatMap(decodeOAuthToken),
            Effect.flatMap((token) => {
              if (token.access_token) {
                const access = token.access_token
                return request(userURL(enterprise ? domain : undefined), {
                  headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${access}`,
                    "User-Agent": App.useragent(app),
                    "X-GitHub-Api-Version": userApiVersion,
                  },
                }).pipe(
                  Effect.map((user) => Option.getOrUndefined(decodeUser(user))),
                  // Only an explicit entitlement answer blocks login; a failed
                  // or malformed lookup must not turn a GitHub hiccup into a denial.
                  Effect.orElseSucceed(() => undefined),
                  Effect.flatMap((user) => {
                    const denied = user && copilotEntitlementError(user)
                    if (denied) return Effect.fail(new Error(denied))
                    const apiEndpoint = user?.endpoints?.api?.replace(/\/+$/, "")
                    return Effect.succeed(
                      Credential.OAuth.make({
                        type: "oauth",
                        methodID,
                        refresh: access,
                        access,
                        expires: 0,
                        ...((enterprise || apiEndpoint) && {
                          metadata: {
                            ...(enterprise ? { enterpriseUrl: domain } : {}),
                            ...(apiEndpoint ? { apiEndpoint } : {}),
                          },
                        }),
                      }),
                    )
                  }),
                )
              }
              if (token.error === "authorization_pending")
                return Effect.sleep(wait + pollingSafetyMargin).pipe(Effect.andThen(poll(wait)))
              if (token.error === "slow_down") {
                const next = slowDownWaitMs(wait, token.interval)
                return Effect.sleep(next + pollingSafetyMargin).pipe(Effect.andThen(poll(next)))
              }
              return Effect.fail(new Error(`Device authorization failed${token.error ? `: ${token.error}` : ""}`))
            }),
          )

        return {
          mode: "auto" as const,
          url: device.verification_uri,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(interval),
        }
      }),
  }) satisfies IntegrationOAuthMethodRegistration

export const GithubCopilotPlugin = define({
  id: "opencode.provider.github.copilot",
  effect: Effect.fn(function* (ctx) {
    const providers = yield* Provider.Service
    const cache = yield* SharedCache.Service
    const roots = SessionAffinity.rootCache()
    const http = yield* HttpClient.HttpClient
    const outbound = yield* FetchHttpClient.Fetch
    // Each Session keeps the model Copilot's Auto router picked until its token nears expiry, the Session is compacted,
    // or the account changes. The token unlocks the pick and its Auto discount; Copilot rejects it for any other model.
    const routes = new Map<Session.ID, { model: string; account: string; token?: string; until: number }>()
    // The endpoint saved at login serves requests until the first refresh reads the account's current one, so an
    // Enterprise login doesn't send its token to the public host while that refresh is still running.
    const login = yield* credentialSettings(ctx, "github-copilot", (value) =>
      value.type === "oauth" ? { baseURL: copilotBaseURL(value.metadata) } : {},
    )
    const discovered = yield* ProviderRefresh.start({
      integrationID: "github-copilot",
      initial: {} as {
        readonly baseURL?: string
        readonly token?: string
        readonly models?: CopilotModels.Snapshot
        readonly connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
      },
      active: ctx.integration.connection.active("github-copilot"),
      reload: ctx.provider.reload(),
      load: Effect.fn("GithubCopilotPlugin.load")(function* (_, options) {
        const { connection, credential } = yield* activeCredential(ctx, "github-copilot")
        if (!connection || credential?.type !== "oauth") return { connection, value: {} }
        // The account's API endpoint changes with its plan, so read it again on every refresh; the one stored at
        // login is the fallback.
        const endpoint = yield* cache
          .get({
            key: `github-copilot-endpoint:${IntegrationConnection.key(connection)}`,
            ...options,
            load: ctx.integration.connection.resolve(connection).pipe(
              Effect.flatMap((current) =>
                current?.type === "oauth"
                  ? HttpClient.filterStatusOk(http)
                      .execute(
                        HttpClientRequest.get(
                          userURL(
                            typeof current.metadata?.enterpriseUrl === "string"
                              ? current.metadata.enterpriseUrl
                              : undefined,
                          ),
                        ).pipe(
                          HttpClientRequest.setHeaders({
                            Accept: "application/json",
                            Authorization: `Bearer ${current.refresh}`,
                            "User-Agent": App.useragent(ctx.app),
                            "X-GitHub-Api-Version": userApiVersion,
                          }),
                        ),
                      )
                      .pipe(
                        Effect.flatMap((response) =>
                          collectBoundedResponseBody(
                            response,
                            oauthMaxResponseBytes,
                            () => new Error(`OAuth response exceeded ${oauthMaxResponseBytes} bytes`),
                          ),
                        ),
                        Effect.flatMap((body) =>
                          Schema.decodeUnknownEffect(Schema.fromJsonString(User))(new TextDecoder().decode(body)),
                        ),
                        Effect.map((user) => user.endpoints?.api?.replace(/\/+$/, "")),
                        Effect.timeout("5 seconds"),
                      )
                  : Effect.fail(new Error("GitHub Copilot connection has no OAuth credential")),
              ),
            ),
          })
          .pipe(Effect.orElseSucceed(() => undefined))
        const url = endpoint || copilotBaseURL(credential.metadata)
        const headers = (yield* providers.get(Provider.ID.githubCopilot))?.headers ?? {}
        const models = yield* cache
          .get({
            key: modelsKey(connection, url, headers),
            ...options,
            load: ctx.integration.connection.resolve(connection).pipe(
              Effect.flatMap((current) =>
                current?.type === "oauth"
                  ? CopilotModels.load(http, url, {
                      ...headers,
                      Authorization: `Bearer ${current.refresh}`,
                      "User-Agent": App.useragent(ctx.app),
                      "X-GitHub-Api-Version": apiVersion,
                    })
                  : Effect.fail(new Error("GitHub Copilot connection has no OAuth credential")),
              ),
            ),
          })
          .pipe(Effect.orElseSucceed(() => undefined))
        return { connection, value: { baseURL: url, token: credential.refresh, models, connection } }
      }),
    })

    yield* ctx.integration.transform((editor) => {
      editor.method.remove("github-copilot", { type: "key" })
      // models.dev lists GITHUB_TOKEN, which git and Actions usually set without Copilot access. GitHub's Copilot CLI
      // reads a dedicated token from COPILOT_GITHUB_TOKEN first.
      editor.method.update({
        integrationID: Provider.ID.githubCopilot,
        method: { type: "env", names: ["COPILOT_GITHUB_TOKEN"] },
      })
      editor.method.update(oauth(ctx.app))
    })
    yield* ctx.provider.transform((evt) => {
      const item = evt.get(Provider.ID.githubCopilot)
      if (!item) return
      const loaded = discovered.current
      const url = loaded.baseURL ?? (typeof login.settings.baseURL === "string" ? login.settings.baseURL : baseURL())
      if (loaded.models) {
        const router = CopilotModels.autoModel(url, loaded.models)
        evt.add({
          info: item.provider,
          models: [
            ...CopilotModels.derive(url, loaded.models, Array.from(item.models.values())).values(),
            ...(router ? [router] : []),
          ],
          sourceConnection: loaded.connection,
        })
        return
      }
      // Without the live model list, the models.dev package says which Copilot API serves
      // each model: Anthropic means Messages, OpenAI means Responses, and anything else
      // falls back to the model ID.
      for (const id of item.models.keys()) {
        evt.models.update(item.provider.id, id, (model) => {
          const route = CopilotModels.routeFor(
            model.modelID ?? model.id,
            model.package === "@opencode/ai/providers/anthropic"
              ? "messages"
              : model.package === "@opencode/ai/providers/openai"
                ? "responses"
                : undefined,
            url,
          )
          model.package = route.package
          model.settings = Provider.mergeOverlay(model.settings, { baseURL: route.baseURL })
        })
      }
    })
    yield* ctx.model.transform((models) => {
      if (models.get(Provider.ID.githubCopilot, Model.ID.make("gpt-5-chat-latest"))) {
        models.update(Provider.ID.githubCopilot, Model.ID.make("gpt-5-chat-latest"), (model) => {
          // This chat-only alias conflicts with the Copilot GPT-5 Responses route,
          // so hide it only for Copilot rather than for every provider catalog.
          model.enabled = false
        })
      }
    })
    yield* ctx.session.hook(
      "model.request",
      (evt) =>
        Effect.gen(function* () {
          const session = yield* ctx.session
            .get({ sessionID: evt.sessionID })
            .pipe(Effect.orElseSucceed(() => undefined))
          const interaction = interactionType(evt.kind, session?.parentID !== undefined)
          evt.headers["X-Interaction-Type"] = interaction
          evt.headers["X-Interaction-Id"] = session
            ? yield* SessionAffinity.resolveRoot(roots, session, (sessionID) =>
                ctx.session.get({ sessionID }).pipe(Effect.orElseSucceed(() => undefined)),
              )
            : evt.sessionID
          if (interaction !== "conversation-agent") evt.headers["x-initiator"] = "agent"
          const route = routes.get(evt.sessionID)
          if (route?.token && route.model === evt.model.id) evt.headers["Copilot-Session-Token"] = route.token
        }),
      { providerID: Provider.ID.githubCopilot },
    )
    const route = Effect.fn("GithubCopilotPlugin.route")(function* (sessionID: Session.ID) {
      const loaded = discovered.current
      if (!loaded.baseURL || !loaded.token || !loaded.models) return
      const user = yield* ctx.session.context({ sessionID }).pipe(
        Effect.map((messages) => messages.findLast((message) => message.type === "user")),
        Effect.orElseSucceed(() => undefined),
      )
      const headers = (yield* providers.get(Provider.ID.githubCopilot))?.headers ?? {}
      const picked = yield* HttpClient.filterStatusOk(http)
        .execute(
          HttpClientRequest.post(`${loaded.baseURL}/auto`).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              Authorization: `Bearer ${loaded.token}`,
              "User-Agent": App.useragent(ctx.app),
              "X-GitHub-Api-Version": apiVersion,
            }),
            HttpClientRequest.bodyJsonUnsafe({
              prompt: user?.text ?? "",
              ...(user?.files?.some((file) => file.mime.startsWith("image/")) ? { has_image: true } : {}),
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AutoRoute)),
          Effect.timeout("5 seconds"),
          Effect.tapError((cause) => Effect.logWarning("Copilot Auto routing failed", { cause })),
          Effect.option,
        )
      const now = yield* Clock.currentTimeMillis
      if (Option.isSome(picked) && loaded.models.has(picked.value.selected_model.id))
        return {
          model: picked.value.selected_model.id,
          account: loaded.token,
          token: picked.value.session_token,
          // Route again before the token can expire mid-request.
          until: picked.value.expires_at * 1000 - 5 * 60_000,
        }
      const models = Array.from(loaded.models.values())
      const fallback =
        models.find((model) => model.is_chat_fallback) ?? models.find((model) => model.billing?.auto_discount)
      // Retry routing soon when the router fails or picks a model this client cannot serve.
      return fallback && { model: fallback.id, account: loaded.token, until: now + 5 * 60_000 }
    })
    yield* ctx.session.hook(
      "experimental.model.resolve",
      (evt) =>
        Effect.gen(function* () {
          // Titles use Copilot's utility model, so they never route.
          if (evt.model.id !== CopilotModels.auto || evt.kind === "title") return
          const now = yield* Clock.currentTimeMillis
          const cached = routes.get(evt.sessionID)
          const current =
            cached && cached.until > now && cached.account === discovered.current.token
              ? cached
              : yield* route(evt.sessionID)
          if (!current) return
          for (const [id, route] of routes) if (route.until <= now) routes.delete(id)
          routes.set(evt.sessionID, current)
          evt.model = Model.Ref.make({ providerID: Provider.ID.githubCopilot, id: Model.ID.make(current.model) })
        }),
      { providerID: Provider.ID.githubCopilot },
    )
    // Compaction rewrites the prompt, so the request after it routes again, like Copilot's own clients. The compaction
    // request itself still carries the current pick's token.
    yield* ctx.session.hook(
      "compaction",
      (evt) =>
        Effect.sync(() => {
          const route = routes.get(evt.sessionID)
          if (route) route.until = 0
        }),
      { providerID: Provider.ID.githubCopilot },
    )
    // GitHub's integration guide designates session naming as a utility scenario served by
    // free, rate-limited utility models. Any failure leaves the result unset so the normal
    // billable title path still runs.
    yield* ctx.session.hook(
      "title",
      (evt) =>
        Effect.gen(function* () {
          const loaded = discovered.current
          if (!loaded.baseURL || !loaded.token || !loaded.models) return
          const agent = yield* ctx.agent
            .get({ agentID: Agent.ID.make("title") })
            .pipe(Effect.orElseSucceed(() => undefined))
          if (agent?.data.model) return
          const model = utilityTitleModels.find((id) => loaded.models?.has(id))
          if (!model) return
          evt.result = yield* utilityTitle(
            { baseURL: loaded.baseURL, token: loaded.token, model, app: ctx.app, fetch: outbound },
            evt,
          ).pipe(
            Effect.tapError((cause) => Effect.logDebug("Copilot utility title failed", { model, cause })),
            Effect.orElseSucceed(() => undefined),
          )
        }),
      { providerID: Provider.ID.githubCopilot },
    )
    yield* ctx.session.hook(
      "http.request",
      (evt) =>
        Effect.gen(function* () {
          // The Messages route sends the token as `x-api-key`, the OpenAI routes as a bearer token.
          const token =
            evt.request.headers.get("x-api-key") ?? evt.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
          if (!token) return
          const text = yield* Effect.promise(() => evt.request.clone().text())
          const body = Option.getOrUndefined(decodeBody(text))
          applyHeaders(evt.request.headers, token, ctx.app, requestMetadata(evt.request.url, body))
        }),
      { providerID: Provider.ID.githubCopilot },
    )
  }),
} satisfies PluginInternal.InternalPlugin)

function modelsKey(
  connection: Parameters<typeof IntegrationConnection.key>[0],
  url: string,
  headers: Record<string, string>,
) {
  const fingerprint = SharedCache.fingerprint(JSON.stringify(Object.entries(headers).toSorted()))
  return `github-copilot:${IntegrationConnection.key(connection)}:${url}:${fingerprint}`
}

function normalizeDomain(input: string) {
  return input.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function oauthURLs(domain: string) {
  return {
    device: `https://${domain}/login/device/code`,
    token: `https://${domain}/login/oauth/access_token`,
  }
}

function userURL(enterprise?: string) {
  return `${enterprise ? `https://api.${normalizeDomain(enterprise)}` : "https://api.github.com"}/copilot_internal/user`
}

function baseURL(enterprise?: string) {
  return enterprise ? `https://copilot-api.${normalizeDomain(enterprise)}` : "https://api.githubcopilot.com"
}

// GitHub reports Copilot access on /copilot_internal/user; OAuth itself succeeds
// for any GitHub account, so this is the only signal that the account can chat.
export function copilotEntitlementError(user: { chat_enabled?: boolean; can_signup_for_limited?: boolean }) {
  if (user.chat_enabled !== false) return
  if (user.can_signup_for_limited)
    return "This GitHub account is not signed up for GitHub Copilot. Sign up for Copilot Free at https://github.com/features/copilot/plans and connect again."
  return "This GitHub account does not have GitHub Copilot access. It needs an active Copilot subscription or a seat assigned by an organization."
}

export function copilotBaseURL(metadata?: Readonly<Record<string, unknown>>) {
  const endpoint = metadata?.apiEndpoint
  if (typeof endpoint === "string" && endpoint) return endpoint
  const enterprise = metadata?.enterpriseUrl
  return baseURL(typeof enterprise === "string" ? enterprise : undefined)
}

/**
 * Size cap for OAuth token/device/discovery response bodies. These are
 * small JSON structs (a few KB in practice); 64 KiB is generous headroom
 * while keeping a misbehaving or malicious issuer/enterprise host from
 * buffering an unbounded body into memory during auth/startup (#1026).
 */
export const oauthMaxResponseBytes = 64 * 1024

function headers(app: App.Info) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": App.useragent(app),
  }
}

function request(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return JSON.parse(
        await readBoundedResponseText(response, oauthMaxResponseBytes, () => new Error(`OAuth response exceeded ${oauthMaxResponseBytes} bytes`)),
      )
    },
    catch: (cause) => cause,
  })
}

type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

// Matches the Copilot client: gpt-4o-mini is the "small utility" model; when an account
// lacks it the request falls through to the regular title path instead of another guess.
export const utilityTitleModels = ["gpt-4o-mini"]

const UtilityCompletion = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) })),
})
const decodeUtilityCompletion = Schema.decodeUnknownEffect(Schema.fromJsonString(UtilityCompletion))
/** Size cap for the utility-title response body. A title completion is a
 * small JSON struct (a few hundred bytes in practice); 64 KiB is generous
 * headroom for its wrapping while staying far below webfetch's 5 MB cap.
 * Without a cap, `response.text()` buffers the whole body — bounded only
 * by the 20 s timeout — so a misbehaving configured endpoint could OOM the
 * process on this automatic background call (#960). */
export const utilityTitleMaxResponseBytes = 64 * 1024

// This issues its own /chat/completions call instead of steering core's title request.
// The `session.title` hook exposes `model` read-only, so pointing core at another model
// would mean widening that contract and re-resolving inside SessionModelRequest; rewriting
// the body in `http.request` is worse still, since the endpoint (/responses for GPT-5,
// /v1/messages for Claude) is fixed before that hook runs and gpt-4o-mini only serves
// /chat/completions. Utility titles are Copilot-specific, stateless, non-streaming, and
// free, so a small request here costs less than a core seam. Trade-offs: no session
// usage record for the title step (the call bills nothing) and no `http.*` hook visibility.
export function utilityTitle(
  input: { baseURL: string; token: string; model: string; app: App.Info; fetch?: Fetch },
  request: Pick<SessionTitle, "sessionID" | "system" | "messages" | "options">,
) {
  const send = input.fetch ?? fetch
  const text = (parts: ReadonlyArray<{ type: string; text?: string | null }>) =>
    parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
  const messages = [
    ...(request.system.length ? [{ role: "system", content: text(request.system) }] : []),
    ...request.messages.map((message) => ({ role: message.role, content: text(message.content) })),
  ]
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await send(`${input.baseURL}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          "User-Agent": App.useragent(input.app),
          "X-GitHub-Api-Version": apiVersion,
          "Openai-Intent": "conversation-edits",
          "X-Interaction-Type": "agent-session-name-generation",
          "X-Interaction-Id": request.sessionID,
          "x-initiator": "agent",
        },
        body: JSON.stringify({
          model: input.model,
          messages,
          stream: false,
          ...(typeof request.options.maxTokens === "number" ? { max_tokens: request.options.maxTokens } : {}),
        }),
      })
      if (!response.ok) throw new Error(`Utility title request failed: ${response.status}`)
      return readBoundedResponseText(
        response,
        utilityTitleMaxResponseBytes,
        () => new Error("Utility title response exceeded " + utilityTitleMaxResponseBytes + " bytes"),
      )
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap(decodeUtilityCompletion),
    Effect.flatMap((completion) => {
      const title = completion.choices[0]?.message.content?.trim()
      return title ? Effect.succeed(title) : Effect.fail(new Error("Utility title response was empty"))
    }),
  )
}

function applyHeaders(headers: Headers, token: string | undefined, app: App.Info, metadata: RequestMetadata) {
  if (token) {
    headers.delete("authorization")
    headers.delete("x-api-key")
    headers.set("Authorization", `Bearer ${token}`)
  }
  headers.set("User-Agent", App.useragent(app))
  headers.set("Openai-Intent", "conversation-edits")
  headers.set("X-GitHub-Api-Version", apiVersion)
  // The step may already have declared itself agent-initiated (subagent, title, compaction);
  // the body can only ever escalate to "agent", never back to "user".
  if (metadata.agent) headers.set("x-initiator", "agent")
  else if (!headers.has("x-initiator")) headers.set("x-initiator", "user")
  if (metadata.vision) headers.set("Copilot-Vision-Request", "true")
}

// Mirrors the Copilot client's X-Interaction-Type vocabulary: the agent loop is the default,
// nested sessions are subagents, and title/compaction are the two utility overrides.
export function interactionType(kind: SessionRequestKind, child: boolean) {
  if (kind === "title") return "conversation-background"
  if (kind === "compaction") return "conversation-compaction"
  if (child) return "conversation-subagent"
  return "conversation-agent"
}

type RequestMetadata = ReturnType<typeof requestMetadata>

function requestMetadata(url: string, body: unknown) {
  if (!isRecord(body)) return { agent: false, vision: false }
  if (Array.isArray(body.input)) {
    const last = body.input.at(-1)
    return {
      agent: !isRecord(last) || last.role !== "user",
      // Tool results carry their images in `output`, user messages in `content`.
      vision: body.input.some(
        (item) =>
          isRecord(item) &&
          [item.content, item.output].some(
            (parts) => Array.isArray(parts) && parts.some((part) => isRecord(part) && part.type === "input_image"),
          ),
      ),
    }
  }
  if (!Array.isArray(body.messages)) return { agent: false, vision: false }
  const last = body.messages.at(-1)
  if (url.includes("completions")) {
    const previous = body.messages.at(-2)
    return {
      // Chat Completions moves tool-result images into a user message after the tool messages.
      agent: !isRecord(last) || last.role !== "user" || (isRecord(previous) && previous.role === "tool"),
      vision: body.messages.some(
        (message) =>
          isRecord(message) &&
          Array.isArray(message.content) &&
          message.content.some((part) => isRecord(part) && part.type === "image_url"),
      ),
    }
  }
  const content = isRecord(last) && Array.isArray(last.content) ? last.content : []
  return {
    agent:
      !isRecord(last) || last.role !== "user" || !content.some((part) => isRecord(part) && part.type !== "tool_result"),
    vision: body.messages.some(
      (message) =>
        isRecord(message) &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            isRecord(part) &&
            (part.type === "image" ||
              (part.type === "tool_result" &&
                Array.isArray(part.content) &&
                part.content.some((nested) => isRecord(nested) && nested.type === "image"))),
        ),
    ),
  }
}
