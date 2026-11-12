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

function acceptsMediaType(accept: string | undefined, expected: string) {
  return (
    accept?.split(",").some((range) => {
      const [mediaType, ...parameters] = range.split(";")
      if (mediaType.trim().toLowerCase() !== expected) return false
      const quality = parameters.find((parameter) => /^q\s*=/i.test(parameter.trim()))
      if (quality === undefined) return true
      const value = quality.slice(quality.indexOf("=") + 1).trim()
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return false
      return Number(value) > 0
    }) ?? false
  )
}

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
          const accept = request.headers.accept ?? ""
          // A GET must not redeem the one-time code unless the caller
          // explicitly asks for the API representation (#2307): link
          // previews and security scanners fetch pairing URLs with a
          // plain GET (Accept: text/html, */*, or none), and consuming
          // on fetch strands the intended user. Unclassified GETs get
          // the confirmation landing page and redeem with the
          // explicit POST (server.redeem); API clients signal intent
          // with Accept: application/json (what the generated client
          // sends) and keep redeeming on GET, as before.
          const api = acceptsMediaType(accept, "application/json") && !acceptsMediaType(accept, "text/html")
          if (api) return yield* redeem(ctx.params.code, false)
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
