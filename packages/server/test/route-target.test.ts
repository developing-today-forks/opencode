import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { ModelRoute } from "@opencode/core/model-route"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// POST/GET /api/session/:id/route-target (#2671): the pin a client sets is the pin routing reads.

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const sonnet = { providerID: "anthropic", id: "claude-sonnet-4-6" }
const haiku = { providerID: "anthropic", id: "claude-haiku-4-5" }

const setup = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-target-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
  yield* Effect.promise(() =>
    fs.writeFile(
      path.join(global, "opencode.json"),
      JSON.stringify({
        experimental: {
          model_routes: {
            pool: { targets: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"] },
          },
        },
      }),
    ),
  )
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    config: { directory: global },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  const request = (route: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: response.status, body: (await response.json()) as unknown }
    })
  const created = yield* request("/api/session", { location: { directory: tmp.path } })
  expect(created.status).toBe(200)
  return { request, sessionID: Schema.decodeUnknownSync(SessionResponse)(created.body).data.id }
})

it.live("sets, lists and clears a session's pinned pool member", () =>
  Effect.gen(function* () {
    ModelRoute.resetSelection()
    const { request, sessionID } = yield* setup
    const route = `/api/session/${sessionID}/route-target`

    const set = yield* request(route, { routeID: "pool", target: haiku })
    expect(set).toEqual({ status: 200, body: { data: [{ routeID: "pool", target: haiku }] } })
    expect(yield* request(route)).toEqual({ status: 200, body: { data: [{ routeID: "pool", target: haiku }] } })
    // Routing reads the same pin.
    expect(ModelRoute.pinnedTargets(sessionID)).toEqual([
      { routeID: "pool", target: ModelRoute.ref({ providerID: haiku.providerID, model: haiku.id }) },
    ])

    const replaced = yield* request(route, { routeID: "pool", target: sonnet })
    expect(replaced.body).toEqual({ data: [{ routeID: "pool", target: sonnet }] })

    const cleared = yield* request(route, { routeID: "pool", target: null })
    expect(cleared).toEqual({ status: 200, body: { data: [] } })
    expect(ModelRoute.pinnedTargets(sessionID)).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("rejects a pin on an unknown pool or on a target outside the pool", () =>
  Effect.gen(function* () {
    ModelRoute.resetSelection()
    const { request, sessionID } = yield* setup
    const route = `/api/session/${sessionID}/route-target`

    const unknownPool = yield* request(route, { routeID: "no-such-pool", target: haiku })
    expect(unknownPool.status).toBe(400)
    const outside = yield* request(route, { routeID: "pool", target: { providerID: "openai", id: "gpt-5" } })
    expect(outside.status).toBe(400)
    expect(ModelRoute.pinnedTargets(sessionID)).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("answers 404 for an unknown session", () =>
  Effect.gen(function* () {
    const { request } = yield* setup
    const missing = Session.ID.create()
    expect((yield* request(`/api/session/${missing}/route-target`)).status).toBe(404)
    expect((yield* request(`/api/session/${missing}/route-target`, { routeID: "pool", target: haiku })).status).toBe(
      404,
    )
  }).pipe(Effect.scoped),
)
