import { Duration, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { ServerInfo } from "../server-info"
import { ServerPairing } from "../pairing"

const EXPIRED = "This pairing link expired or was already used. Run `opencode pair` to get a new one."

const LANDING =
  "<!doctype html><html><head><meta charset='utf-8'><title>Pair with opencode</title></head>" +
  "<body><h1>Pair this browser with opencode?</h1>" +
  "<p>Confirming signs this browser in with the pairing link you opened. " +
  "If you did not run opencode pair, close this page instead.</p>" +
  "<form method='post'><button type='submit'>Pair this browser</button></form></body></html>"

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    const pairing = yield* ServerPairing.Service
    const auth = yield* ServerAuth.Config

    const redeem = Effect.fn(function* (code: string, browser: boolean) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = (yield* pairing.consume(code)) ? ServerAuth.issueSession(auth) : undefined
      if (token === undefined) {
        if (!browser) return yield* new UnauthorizedError({ message: "Pairing link expired or already used" })
        return HttpServerResponse.text(EXPIRED, { status: 401 })
      }
      if (!browser) return { token }
      return HttpServerResponse.redirect("/").pipe(
        HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(request.headers.host), token, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          maxAge: Duration.seconds(ServerAuth.SESSION_TTL_SECONDS),
        }),
      )
    })

    return handlers
      .handle("server.info", () =>
        Effect.gen(function* () {
          const info = yield* ServerInfo.Service
          return {
            version: info.app.version ?? "unknown",
            pid: process.pid ?? 0,
            urls: info.urls(),
            paths: info.paths,
            capabilities: { persistentPty: PersistentPty.available },
          }
        }),
      )
      .handle("server.pair", () => pairing.issue())
      .handle(
        "server.connect",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browser navigations ask for HTML; everything else is an API client that wants the token.
          const browser = request.headers.accept?.includes("text/html") === true
          // A browser GET must never redeem the one-time code (#2307):
          // link previews and security scanners fetch pairing URLs
          // with a plain GET, and consuming on fetch strands the
          // intended user. Browsers get a confirmation landing page
          // and redeem with the explicit POST (server.redeem);
          // the API-client flow keeps redeeming on GET, as before.
          if (!browser) return yield* redeem(ctx.params.code, false)
          if (!(yield* pairing.peek(ctx.params.code))) return HttpServerResponse.text(EXPIRED, { status: 401 })
          return HttpServerResponse.html(LANDING)
        }),
      )
      .handle(
        "server.redeem",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          const browser = request.headers.accept?.includes("text/html") === true
          return yield* redeem(ctx.params.code, browser)
        }),
      )
  }),
)
