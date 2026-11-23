import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"
import { pluginsLoaded } from "./fixture/routes"

// Regression coverage for opencode#2543: cancelling an integration attempt
// that does not exist must answer 404 like status/complete do for the same
// ID, instead of a 204 that looks like a successful abort.
it.live("integration cancel answers 404 for unknown attempts and integrations", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-integration-cancel-")
    const context = yield* Layer.build(
      createRoutes({
        app: { version: "test" },
        database: { path: ":memory:" },
        models: { fetch: false },
        fs: { filewatcher: false },
        config: { directory: tmp.path, project: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const request = (method: "DELETE", route: string) =>
      Effect.promise(async (signal) => {
        const url = new URL(route, "http://opencode.local")
        url.searchParams.set("location[directory]", tmp.path)
        const response = await handler(new Request(url, { method, signal }))
        return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
      })

    yield* pluginsLoaded(context, tmp.path)

    const oauth = yield* request("DELETE", "/api/integration/opencode/connect/oauth/unknown-attempt")
    expect(oauth.status).toBe(404)
    expect(oauth.body).toMatchObject({ _tag: "IntegrationAttemptNotFoundError", attemptID: "unknown-attempt" })

    const command = yield* request("DELETE", "/api/integration/opencode/connect/command/unknown-attempt")
    expect(command.status).toBe(404)
    expect(command.body).toMatchObject({ _tag: "IntegrationAttemptNotFoundError", attemptID: "unknown-attempt" })

    const missing = yield* request("DELETE", "/api/integration/nope/connect/oauth/unknown-attempt")
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ _tag: "IntegrationNotFoundError", integrationID: "nope" })
  }),
)
