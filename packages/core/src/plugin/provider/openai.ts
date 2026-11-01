import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { expiresInSeconds } from "./expires.js"
import type { SessionRequest } from "@opencode/plugin/effect/session"
import { Deferred, Effect, Option, Schema, Semaphore, Stream } from "effect"
import type { Server } from "node:http"
import { App } from "../../app.js"
import { Credential } from "../../credential.js"
import { Bus } from "../../bus.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import { SessionAffinity } from "../../session/affinity.js"
import { readBoundedResponseText } from "../../tool/http-body.js"
import type { PluginInternal } from "../internal.js"
import { configuredSettings } from "./configured.js"
import { eachInstance } from "./instance.js"

const clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
const issuer = "https://auth.openai.com"
const callbackBindAttempts = 10
const callbackBindRetryDelay = 200
const pollingSafetyMargin = 3000
const codexBaseURL = "https://chatgpt.com/backend-api/codex"
const browserMethodID = Integration.MethodID.make("chatgpt-browser")
const headlessMethodID = Integration.MethodID.make("chatgpt-headless")
// ChatGPT accounts lost gpt-5.4 and gpt-5.4-mini in Codex on 2026-08-31 (replacements: gpt-5.6-terra, gpt-5.6-luna).
const codexAllowed = new Set(["gpt-5.5", "gpt-5.3-codex-spark"])
const codexDisallowed = new Set(["gpt-5.5-pro", "gpt-5.6"])

type Pkce = {
  verifier: string
  challenge: string
}

type TokenResponse = {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

const Claims = Schema.fromJsonString(
  Schema.Struct({
    chatgpt_account_id: Schema.optional(Schema.String),
    organizations: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
    "https://api.openai.com/auth": Schema.optional(
      Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
    ),
  }),
)
const decodeClaims = Schema.decodeUnknownOption(Claims)

const browser = (app: App.Info, integrationID: Integration.ID) =>
  ({
    integrationID,
    method: {
      id: browserMethodID,
      type: "oauth",
      label: "Codex browser (legacy)",
    },
    authorize: () =>
      Effect.gen(function* () {
        const pkce = yield* Effect.promise(generatePKCE)
        const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
        const code = yield* Deferred.make<string, Error>()
        // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://localhost")
          if (url.pathname !== "/auth/callback") {
            response.writeHead(404).end("Not found")
            return
          }
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          const value = url.searchParams.get("code")
          if (error) {
            Effect.runFork(Deferred.fail(code, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "ChatGPT" }))
            return
          }
          if (!value || url.searchParams.get("state") !== state) {
            const message = value ? "Invalid OAuth state" : "Missing authorization code"
            Effect.runFork(Deferred.fail(code, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "ChatGPT" }))
            return
          }
          Effect.runFork(Deferred.succeed(code, value))
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.success({ provider: "ChatGPT" }))
        })
        const port = yield* listen(server)
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        const redirect = `http://localhost:${port}/auth/callback`
        return {
          mode: "auto" as const,
          url: authorizeURL(redirect, pkce, state),
          instructions: "Complete authorization in your browser. This window will close automatically.",
          callback: Deferred.await(code).pipe(
            Effect.flatMap((value) => exchange(value, redirect, pkce, app)),
            Effect.map((tokens) => credential(browserMethodID, tokens)),
          ),
        }
      }),
    refresh: (value) => refresh(browserMethodID, value, app),
  }) satisfies IntegrationOAuthMethodRegistration

// OpenAI registers these two loopback ports as redirect targets. Tests set OPENCODE_TEST_OPENAI_CALLBACK_PORTS to
// "primary,fallback" so concurrent runs on one machine never contend for the real ports.
function callbackPorts() {
  const [primary, fallback] = process.env.OPENCODE_TEST_OPENAI_CALLBACK_PORTS?.split(",").map(Number) ?? []
  return { primary: primary ?? 1455, fallback: fallback ?? 1457 }
}

function listen(server: Server) {
  const { primary, fallback } = callbackPorts()
  return bind(server, primary).pipe(
    Effect.as(primary),
    Effect.catchIf(addressInUse, () =>
      cancel(primary).pipe(
        Effect.ignore,
        Effect.andThen(Effect.sleep(callbackBindRetryDelay)),
        Effect.andThen(bindWithRetry(server, primary, callbackBindAttempts - 1)),
        Effect.as(primary),
        Effect.catchIf(addressInUse, () =>
          bindWithRetry(server, fallback, callbackBindAttempts).pipe(
            Effect.as(fallback),
            Effect.catchIf(addressInUse, () =>
              Effect.fail(
                new Error(
                  `OpenAI browser login needs local port ${primary} or ${fallback}, but both are already in use. Stop the processes using those ports or choose Codex device code (legacy), then try again.`,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

function bindWithRetry(server: Server, port: number, attempts: number): Effect.Effect<void, Error> {
  return bind(server, port).pipe(
    Effect.catchIf(
      (error) => addressInUse(error) && attempts > 1,
      () => Effect.sleep(callbackBindRetryDelay).pipe(Effect.andThen(bindWithRetry(server, port, attempts - 1))),
    ),
  )
}

function bind(server: Server, port: number) {
  return Effect.callback<void, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(port, "localhost", () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  })
}

function cancel(port: number) {
  return Effect.tryPromise({
    try: (signal) =>
      fetch(`http://localhost:${port}/cancel`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      }),
    catch: (cause) => cause,
  })
}

function addressInUse(error: Error) {
  return "code" in error && error.code === "EADDRINUSE"
}

/** Poll interval for the device flow, in milliseconds. The server-supplied
 * `interval` string is restricted to a plain unsigned decimal integer
 * spelling (the #715/#724 grammar family): spellings like "0x10", "1e1",
 * "5junk", or "2.9" are not reinterpreted — they take the 5-second fallback,
 * and the result is clamped to [1s, 60s] (#771, #941): the ceiling is the
 * Copilot bound from #915 — a large or unit-confused value would otherwise
 * make a sleep outlast the login attempt, and this flow's poll loop has no
 * deadline of its own. */
export const deviceIntervalMs = (raw: string): number => {
  const text = raw.trim()
  const parsed = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN
  return Math.min(Math.max(parsed || 5, 1), 60) * 1000
}

const headless = (app: App.Info, integrationID: Integration.ID) =>
  ({
    integrationID,
    method: {
      id: headlessMethodID,
      type: "oauth",
      label: "Codex device code (legacy)",
    },
    authorize: () =>
      Effect.gen(function* () {
        const device = yield* request<{ device_auth_id: string; user_code: string; interval: string }>(
          `${issuer}/api/accounts/deviceauth/usercode`,
          {
            method: "POST",
            headers: headers("application/json", app),
            body: JSON.stringify({ client_id: clientID }),
          },
        )
        const interval = deviceIntervalMs(device.interval)
        return {
          mode: "auto" as const,
          url: `${issuer}/codex/device`,
          instructions: `Enter code: ${device.user_code}`,
          callback: Effect.gen(function* () {
            while (true) {
              const response = yield* Effect.tryPromise({
                try: (signal) =>
                  fetch(`${issuer}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: headers("application/json", app),
                    body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
                    signal,
                  }),
                catch: (cause) => cause,
              })
              if (response.ok) {
                const data = (yield* Effect.tryPromise({
                  try: async () =>
                    JSON.parse(
                      await readBoundedResponseText(response, oauthMaxResponseBytes, () => new Error(`OAuth response exceeded ${oauthMaxResponseBytes} bytes`)),
                    ),
                  catch: (cause) => cause,
                })) as {
                  authorization_code: string
                  code_verifier: string
                }
                return credential(
                  headlessMethodID,
                  yield* exchange(
                    data.authorization_code,
                    `${issuer}/deviceauth/callback`,
                    { verifier: data.code_verifier, challenge: "" },
                    app,
                  ),
                )
              }
              if (response.status !== 403 && response.status !== 404) {
                return yield* Effect.fail(new Error(`Device authorization failed: ${response.status}`))
              }
              yield* Effect.sleep(interval + pollingSafetyMargin)
            }
          }),
        }
      }),
    refresh: (value) => refresh(headlessMethodID, value, app),
  }) satisfies IntegrationOAuthMethodRegistration

export const OpenAIPlugin = define({
  id: "opencode.provider.openai",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    yield* eachInstance(
      ctx.event,
      Provider.ID.openai,
      Effect.fnUntraced(function* (ids) {
        const loading = Semaphore.makeUnsafe(1)
        const roots = SessionAffinity.rootCache()
        let chatgpt: Credential.OAuth | undefined

        const load = Effect.fn("OpenAIPlugin.load")(function* () {
          const connection = yield* ctx.integration.connection.active(ids.integrationID)
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          chatgpt =
            credential?.type === "oauth" &&
            (credential.methodID === browserMethodID || credential.methodID === headlessMethodID)
              ? credential
              : undefined
        })

        yield* ctx.integration.transform((editor) => {
          editor.method.update(browser(ctx.app, ids.integrationID))
          editor.method.update(headless(ctx.app, ids.integrationID))
        })
        yield* load()
        // Config applies after provider plugins, so read it here: a custom baseURL may not decode zstd.
        const configured = yield* configuredSettings(ids.providerID)
        yield* ctx.provider.transform((providers) => {
          const item = providers.get(ids.providerID)
          if (!item) return
          const account = chatgpt?.metadata?.accountID
          providers.update(item.provider.id, (provider) => {
            provider.settings = Provider.mergeOverlay(provider.settings, {
              transport: provider.settings?.transport ?? "websocket",
              ...(chatgpt ? { baseURL: codexBaseURL } : {}),
              // The ChatGPT backend rejects uncompressed bodies over ~1 MiB and decodes zstd.
              ...(chatgpt && configured?.baseURL === undefined
                ? { encoding: provider.settings?.encoding ?? "zstd" }
                : {}),
            })
            if (!chatgpt) return
            provider.headers = Provider.mergeHeaders(provider.headers, {
              originator: "opencode",
              "x-codex-beta-features": "remote_compaction_v2",
              ...(typeof account === "string" ? { "chatgpt-account-id": account } : {}),
            })
          })
        })
        yield* ctx.model.transform((models) => {
          for (const model of models.list(ids.providerID)) {
            // ChatGPT-plan tokens only authorize codex-eligible models, and the
            // subscription covers usage, so hide the rest and zero the cost.
            models.update(model.providerID, model.id, (draft) => {
              if (!chatgpt) return
              if (Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(draft.body?.reasoning)) {
                draft.enabled = false
                return
              }
              const apiID = draft.modelID ?? draft.id
              const match = apiID.match(/^gpt-(\d+)(?:\.(\d+))?/)
              const major = Number(match?.[1])
              const minor = Number(match?.[2] ?? 0)
              if (
                !codexAllowed.has(apiID) &&
                (codexDisallowed.has(apiID) || !match || !(major > 5 || (major === 5 && minor > 4)))
              ) {
                draft.enabled = false
                return
              }
              draft.cost = []
              // Match Codex CLI so context consumption and subscription usage stay consistent between clients.
              draft.limit =
                apiID === "gpt-6.1-sol"
                  ? { ...draft.limit, context: 628_000, input: 500_000 }
                  : { ...draft.limit, context: 400_000, input: 272_000 }
            })
          }
        })
        yield* ctx.session.hook(
          "model.request",
          (evt) =>
            Effect.gen(function* () {
              if (!chatgpt) return
              if (evt.baseURL && URL.canParse(evt.baseURL) && new URL(evt.baseURL).origin === "https://api.openai.com")
                evt.baseURL = codexBaseURL
              const session = yield* ctx.session
                .get({ sessionID: evt.sessionID })
                .pipe(Effect.orElseSucceed(() => undefined))
              evt.headers.originator = "opencode"
              // ChatGPT routes its prompt cache on this header, so a Session tree shares its root's.
              evt.headers["session-id"] = session
                ? yield* SessionAffinity.resolveRoot(roots, session, (sessionID) =>
                    ctx.session.get({ sessionID }).pipe(Effect.orElseSucceed(() => undefined)),
                  )
                : evt.sessionID
            }),
          { providerID: ids.providerID },
        )
        // The ChatGPT backend rejects a requested output limit, and OpenAI counts one against rate limits.
        const omitOutputLimit = (evt: SessionRequest) =>
          Effect.sync(() => {
            delete evt.options.maxTokens
          })
        for (const name of ["context", "compaction"] as const)
          yield* ctx.session.hook(name, omitOutputLimit, { providerID: ids.providerID })
        const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.provider.reload())))
        yield* bus.subscribe(Credential.Event.Switched).pipe(
          Stream.filter((event) => event.data.integrationID === ids.integrationID),
          Stream.runForEach(refresh),
          Effect.forkScoped({ startImmediately: true }),
        )
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

function headers(contentType: string, app: App.Info) {
  return { "Content-Type": contentType, "User-Agent": App.useragent(app) }
}

function exchange(code: string, redirect: string, pkce: Pkce, app: App.Info) {
  return request<TokenResponse>(`${issuer}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded", app),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
}

function refresh(methodID: Integration.MethodID, value: Pick<Credential.OAuth, "refresh" | "metadata">, app: App.Info) {
  return request<TokenResponse>(`${issuer}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded", app),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: value.refresh,
      client_id: clientID,
    }).toString(),
  }).pipe(
    Effect.map((tokens) => {
      const next = credential(methodID, tokens)
      return Credential.OAuth.make({ ...next, metadata: next.metadata ?? value.metadata })
    }),
  )
}

/**
 * Size cap for OAuth token/device/discovery response bodies. These are
 * small JSON structs (a few KB in practice); 64 KiB is generous headroom
 * while keeping a misbehaving or malicious issuer/enterprise host from
 * buffering an unbounded body into memory during auth/startup (#1026).
 */
export const oauthMaxResponseBytes = 64 * 1024

function request<A>(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return JSON.parse(
        await readBoundedResponseText(response, oauthMaxResponseBytes, () => new Error(`OAuth response exceeded ${oauthMaxResponseBytes} bytes`)),
      ) as A
    },
    catch: (cause) => cause,
  })
}

function credential(methodID: Integration.MethodID, tokens: TokenResponse) {
  const accountID = extractAccountID(tokens)
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + expiresInSeconds(tokens.expires_in, 3600) * 1000,
    metadata: accountID ? { accountID } : undefined,
  })
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

function authorizeURL(redirect: string, pkce: Pkce, state: string) {
  return `${issuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientID,
    redirect_uri: redirect,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })}`
}

function extractAccountID(tokens: TokenResponse) {
  return claim(tokens.id_token) ?? claim(tokens.access_token)
}

function claim(token: string) {
  const part = token.split(".")[1]
  if (!part) return
  const claims = Option.getOrUndefined(decodeClaims(Buffer.from(part, "base64url").toString()))
  if (!claims) return
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  )
}
