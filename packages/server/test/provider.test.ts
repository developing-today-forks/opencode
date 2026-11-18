import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Plugin } from "@opencode/plugin/effect"
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"
import { startServer } from "./fixture/server"

it.live(
  "policy-controlled endpoints wait for plugins while other catalog reads answer",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("opencode-provider-endpoints-")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const context = yield* Layer.build(
        createRoutes({
          password: "secret",
          database: { path: ":memory:" },
          models: { fetch: false },
          fs: { filewatcher: false },
          config: {
            directory: tmp.path,
            project: false,
            content: JSON.stringify({
              providers: {
                custom: {
                  name: "Configured Custom Provider",
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { apiKey: "secret" },
                  models: { chat: {} },
                },
              },
              agents: { reviewer: { description: "Reviews changes" } },
            }),
          },
        }).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const sdk = Context.get(context, SdkPlugins.Service)
      yield* sdk.register(
        Plugin.define({
          id: "slow-plugin",
          effect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
            }),
        }),
      )
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const request = (method: "GET" | "POST", route: string, body?: unknown) =>
        Effect.promise((signal) => {
          const url = new URL(route, "http://opencode.local")
          url.searchParams.set("location[directory]", tmp.path)
          return handler(
            new Request(url, {
              method,
              headers: {
                authorization: `Basic ${btoa("opencode:secret")}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal,
            }),
          )
        })
      yield* request("GET", "/api/agent").pipe(Effect.timeout("2 seconds"))
      yield* Deferred.await(started)
      // Managed policy is applied by the last internal plugin, so endpoints whose entries it can deny wait until
      // activation finishes rather than serve a provider it would remove.
      const providers = yield* request("GET", "/api/provider").pipe(Effect.forkScoped)
      const models = yield* request("GET", "/api/model").pipe(Effect.forkScoped)
      const search = yield* request("POST", "/api/websearch", { query: "opencode" }).pipe(
        Effect.forkScoped,
      )
      // Everything else answers with the current snapshot, and clients refresh on the matching *.updated events.
      for (const route of ["/api/agent", "/api/skill", "/api/integration"]) {
        const response = yield* request("GET", route).pipe(Effect.timeout("2 seconds"))
        expect(response.status).toBe(200)
      }
      const get = yield* request("GET", "/api/provider/custom").pipe(Effect.timeout("2 seconds"))
      expect(get.status).toBe(404)
      expect(yield* Effect.promise(() => get.json())).toMatchObject({
        _tag: "ProviderNotFoundError",
        providerID: "custom",
      })
      const pending = yield* Effect.all(
        [providers, models, search].map((fiber) => Fiber.await(fiber).pipe(Effect.timeoutOption("500 millis"))),
        { concurrency: "unbounded" },
      )
      expect(pending.every(Option.isNone)).toBeTrue()

      yield* Deferred.succeed(release, undefined)
      const list = yield* Fiber.join(providers)
      expect(list.status).toBe(200)
      expect(yield* Effect.promise(() => list.json())).toMatchObject({
        location: { directory: tmp.path },
        data: expect.arrayContaining([expect.objectContaining({ id: "custom" })]),
      })
      expect((yield* Fiber.join(models)).status).toBe(200)
      expect((yield* Fiber.join(search)).status).toBe(400)
    }),
  15_000,
)

it.live("provider list and get embed each provider's resolved models", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-provider-models-")
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          providers: {
            custom: {
              name: "Configured Custom Provider",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { apiKey: "secret" },
              models: { chat: { name: "Chat Model" }, reason: {} },
            },
          },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const get = (route: string) =>
      Effect.promise(() => {
        const url = new URL(route, server.base)
        url.searchParams.set("location[directory]", tmp.path)
        return fetch(url, { headers: server.headers })
      })

    // Provider reads return the current snapshot without waiting for plugin
    // settlement, so poll until the config provider has registered.
    const custom = yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 50; attempt++) {
        const list = yield* get("/api/provider")
        expect(list.status).toBe(200)
        const listBody: unknown = yield* Effect.promise(() => list.json())
        if (!isRecord(listBody) || !Array.isArray(listBody["data"]))
          throw new Error("Expected a provider list response")
        const found = listBody["data"].find((entry) => isRecord(entry) && entry["id"] === "custom")
        if (found) return found
        yield* Effect.sleep("100 millis")
      }
      throw new Error("Expected the custom provider to appear in the provider list")
    })
    if (!isRecord(custom) || !Array.isArray(custom["models"])) throw new Error("Expected the custom provider to embed models")
    expect(custom["models"].map((model) => (isRecord(model) ? model["id"] : undefined)).sort()).toEqual([
      "chat",
      "reason",
    ])
    expect(
      custom["models"].some((model) => isRecord(model) && model["id"] === "chat" && model["providerID"] === "custom"),
    ).toBeTrue()

    const single = yield* get("/api/provider/custom")
    expect(single.status).toBe(200)
    const singleBody: unknown = yield* Effect.promise(() => single.json())
    if (!isRecord(singleBody) || !isRecord(singleBody["data"]) || !Array.isArray(singleBody["data"]["models"]))
      throw new Error("Expected a provider response with embedded models")
    expect(singleBody["data"]["models"]).toHaveLength(2)
  }),
  30_000,
)

it.live(
  "provider get serves only the providers provider list serves",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("opencode-provider-get-available-")
      const server = yield* startServer(tmp.path)
      const get = (route: string) =>
        Effect.promise(() => {
          const url = new URL(route, server.base)
          url.searchParams.set("location[directory]", tmp.path)
          return fetch(url, { headers: server.headers })
        })

      // The catalog records providers such as openai even with no connection
      // for them; snapshot().available withholds those from list, so get must
      // withhold them too instead of embedding their recorded models (#661).
      // Poll until the available opencode provider appears, which shows the
      // catalog has registered.
      const listed = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 50; attempt++) {
          const list = yield* get("/api/provider")
          expect(list.status).toBe(200)
          const listBody: unknown = yield* Effect.promise(() => list.json())
          if (!isRecord(listBody) || !Array.isArray(listBody["data"]))
            throw new Error("Expected a provider list response")
          if (listBody["data"].some((entry) => isRecord(entry) && entry["id"] === "opencode")) return listBody["data"]
          yield* Effect.sleep("100 millis")
        }
        throw new Error("Expected the opencode provider to appear in the provider list")
      })
      expect(listed.some((entry) => isRecord(entry) && entry["id"] === "openai")).toBeFalse()

      const unavailable = yield* get("/api/provider/openai")
      expect(unavailable.status).toBe(404)
      expect(yield* Effect.promise(() => unavailable.json())).toMatchObject({
        _tag: "ProviderNotFoundError",
        providerID: "openai",
      })

      const available = yield* get("/api/provider/opencode")
      expect(available.status).toBe(200)
      const availableBody: unknown = yield* Effect.promise(() => available.json())
      if (!isRecord(availableBody) || !isRecord(availableBody["data"]))
        throw new Error("Expected a provider response for an available provider")
      expect(availableBody["data"]["id"]).toBe("opencode")
    }),
  30_000,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
