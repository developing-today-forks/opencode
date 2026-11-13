import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Effect, Option, Schedule, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Server } from "node:http"
import { App } from "../../app.js"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import { MAX_EXPIRES_IN_SECONDS } from "./expires.js"
import { serverSeconds } from "../../util/number.js"

const providerID = Provider.ID.make("digitalocean")
const integrationID = Integration.ID.make("digitalocean")
const methodID = Integration.MethodID.make("browser")

const clientID = "b1a6c5158156caac821fd1b30253ca8acb52454a48fa744420e41889cb589f82"
const authorizeEndpoint = "https://cloud.digitalocean.com/v1/oauth/authorize"
const routersEndpoint = "https://api.digitalocean.com/v2/gen-ai/models/routers"
const callbackPort = 1456
/** Byte cap on the token POST body the callback page sends to the loopback
 * server (#1954): the legitimate body is a few hundred bytes of JSON; this
 * matches the callback page error-excerpt cap (oauth/page.ts). */
export const MAX_CALLBACK_BODY_BYTES = 64 * 1024
const callbackPath = "/auth/callback"
const tokenPath = "/auth/token"
const RoutersResponse = Schema.Struct({
  model_routers: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString })),
})
const decodeCallback = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.optional(Schema.String),
      expires_in: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      error_description: Schema.optional(Schema.String),
    }),
  ),
)

/** Server-supplied `expires_in` seconds, restricted to a plain unsigned
 * decimal integer spelling (the #715/#724 grammar family): spellings like
 * "1e3", "0x10", "3600junk", or "3600.9" are not reinterpreted — they yield
 * NaN and the caller applies its 30-day fallback (#771). A well-spelled but
 * implausibly large value — the classic millisecond-scale lifetime — is
 * clamped to the shared sane bound (#899, expires.ts): stored verbatim it
 * would fabricate an expiry the consumer trusts for weeks. */
export const expiresInSeconds = (raw: string | undefined): number => {
  const text = (raw ?? "0").trim()
  // The spelling grammar stays here (#771): an invalid spelling yields NaN
  // outright, because serverSeconds has a single fallback and this site's
  // pinned returns differ per input class - NaN for an invalid spelling,
  // 0 for a spelled "0" / absent value. A well-spelled value is normalised
  // by serverSeconds (#994) with fallback 0, so "0" and absent still return
  // 0, and an oversized (millisecond-scale) value clamps to the bound.
  if (!/^\d+$/.test(text)) return Number.NaN
  return serverSeconds(Number.parseInt(text, 10), {
    fallback: 0,
    max: MAX_EXPIRES_IN_SECONDS,
    oversized: "clamp",
  })
}

const oauth = {
  integrationID,
  method: {
    id: methodID,
    type: "oauth",
    label: "Login with DigitalOcean",
  },
  authorize: () =>
    Effect.gen(function* () {
      const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      const token = yield* Deferred.make<{ access: string; expiresIn: number }, Error>()
      // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
      const { createServer } = yield* Effect.promise(() => import("node:http"))
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost")
        if (request.method === "GET" && url.pathname === callbackPath) {
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.bootstrap({ tokenPath, provider: "DigitalOcean" }))
          return
        }
        if (request.method === "POST" && url.pathname === tokenPath) {
          // Bounded read (#1954): the bootstrap page POSTs a few hundred bytes of
          // JSON built from the URL hash, so cap the accumulated body as chunks
          // arrive (the callback page excerpt cap, page.ts) instead of
          // buffering an unbounded body into Buffer.concat.
          const chunks: Buffer[] = []
          let size = 0
          let oversized = false
          request.on("data", (chunk: Buffer) => {
            if (oversized) return
            size += chunk.byteLength
            if (size > MAX_CALLBACK_BODY_BYTES) {
              oversized = true
              const message = "OAuth callback body too large"
              Effect.runFork(Deferred.fail(token, new Error(message)))
              response.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }))
              request.destroy()
              return
            }
            chunks.push(chunk)
          })
          request.on("end", () => {
            if (oversized) return
            const body = Option.getOrUndefined(decodeCallback(Buffer.concat(chunks).toString("utf8")))
            const error = body?.error_description || body?.error
            const access = body?.access_token
            if (error || !access || body?.state !== state) {
              const message = error || (access ? "Invalid OAuth state" : "Missing access token")
              Effect.runFork(Deferred.fail(token, new Error(message)))
              response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }))
              return
            }
            const expires = expiresInSeconds(body.expires_in)
            Effect.runFork(
              Deferred.succeed(token, {
                access,
                expiresIn: Number.isFinite(expires) && expires > 0 ? expires : 60 * 60 * 24 * 30,
              }),
            )
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
          })
          return
        }
        response.writeHead(404).end("Not found")
      })
      const port = yield* listen(server)
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      const redirect = `http://localhost:${port}${callbackPath}`
      return {
        mode: "auto" as const,
        url: `${authorizeEndpoint}?${new URLSearchParams({
          response_type: "token",
          client_id: clientID,
          redirect_uri: redirect,
          scope: "genai:read inference:query",
          state,
        })}`,
        instructions: "Complete authorization in your browser. This window will close automatically.",
        callback: Effect.gen(function* () {
          const payload = yield* Deferred.await(token)
          return Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: payload.access,
            refresh: "",
            expires: (yield* Clock.currentTimeMillis) + payload.expiresIn * 1000,
          })
        }),
      }
    }),
} satisfies IntegrationOAuthMethodRegistration

export const DigitalOceanPlugin = define({
  id: "opencode.provider.digitalocean",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const loading = Semaphore.makeUnsafe(1)
    const loaded: { access?: string; routers: (typeof RoutersResponse.Type)["model_routers"] } = { routers: [] }

    const load = Effect.fn("DigitalOceanPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      if (credential?.type !== "oauth" || credential.methodID !== methodID) {
        loaded.access = undefined
        loaded.routers = []
        return
      }
      if (loaded.access !== credential.access) {
        loaded.access = credential.access
        loaded.routers = []
      }
      if (credential.expires !== 0 && credential.expires <= (yield* Clock.currentTimeMillis)) return
      const result = yield* http
        .execute(
          HttpClientRequest.get(routersEndpoint).pipe(
            HttpClientRequest.bearerToken(credential.access),
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RoutersResponse)),
          Effect.timeout("10 seconds"),
          Effect.catch((cause) =>
            Effect.logWarning("failed to sync DigitalOcean routers", { cause }).pipe(Effect.as(undefined)),
          ),
        )
      if (result) loaded.routers = result.model_routers
    })

    yield* ctx.integration.transform((draft) => {
      draft.method.update(oauth)
    })
    yield* ctx.provider.transform((evt) => {
      if (!evt.get(providerID)) return
      for (const router of loaded.routers) {
        const id = `router:${router.name}`
        if (evt.get(providerID)?.models.has(Model.ID.make(id))) continue
        evt.models.update(providerID, id, (draft) => {
          draft.name = router.name
          draft.family = Model.Family.make("digitalocean-inference-routers")
          draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
          draft.limit = { context: 128_000, output: 8_192 }
        })
      }
    })
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.provider.reload())))
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Retain the last successful inventory for this credential through transient failures.
    yield* refresh().pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)
  }),
} satisfies PluginInternal.InternalPlugin)

function listen(server: Server) {
  return Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(callbackPort, "localhost", () => {
      server.off("error", onError)
      resume(Effect.succeed(callbackPort))
    })
  }).pipe(
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `DigitalOcean login needs local port ${callbackPort}, but it is already in use. Stop the process using that port and try again.`,
          )
        : cause,
    ),
  )
}
