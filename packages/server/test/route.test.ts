import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const draft = {
  id: "test-override-2494",
  action: "avoid",
  providers: ["route-test-provider"],
  models: [],
  routes: [],
  fixed: true,
  until: Date.now() + 3_600_000,
  text: "avoid during the test",
  source: "user",
  createdAt: Date.now(),
}

const list = (base: string, headers: Record<string, string>) =>
  Effect.promise(() => fetch(new URL("/api/route/overrides", base), { headers })).pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => ({ status: response.status, body: (await response.json()) as unknown })),
    ),
  )

const ids = (body: unknown) =>
  isRecord(body) && Array.isArray(body["data"])
    ? body["data"].flatMap((item) => (isRecord(item) && typeof item["id"] === "string" ? [item["id"]] : []))
    : []

it.live("stores, lists, and removes route overrides over HTTP", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-endpoint-")))
    const file = path.join(tmp.path, "route-overrides.json")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => ModelRouteOverrides.setFilePath(file)),
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(tmp.path)

          const posted = yield* Effect.promise(() =>
            fetch(new URL("/api/route/overrides", server.base), {
              method: "POST",
              headers: { ...server.headers, "content-type": "application/json" },
              body: JSON.stringify(draft),
            }),
          )
          expect(posted.status).toBe(200)
          expect(ids(yield* Effect.promise(() => posted.json()))).toContain(draft.id)

          const listed = yield* list(server.base, server.headers)
          expect(listed.status).toBe(200)
          expect(ids(listed.body)).toContain(draft.id)

          const removed = yield* Effect.promise(() =>
            fetch(new URL(`/api/route/overrides/${draft.id}`, server.base), {
              method: "DELETE",
              headers: server.headers,
            }),
          )
          expect(removed.status).toBe(204)

          const after = yield* list(server.base, server.headers)
          expect(ids(after.body)).not.toContain(draft.id)
        }),
      () => Effect.sync(() => ModelRouteOverrides.setFilePath(undefined)),
    )
  }),
)

it.live("rejects a malformed route override and stores nothing", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-endpoint-")))
    const file = path.join(tmp.path, "route-overrides.json")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => ModelRouteOverrides.setFilePath(file)),
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(tmp.path)

          // No provider and no model named: core's parse drops the entry, so the
          // server must refuse it rather than store an override routing ignores.
          const posted = yield* Effect.promise(() =>
            fetch(new URL("/api/route/overrides", server.base), {
              method: "POST",
              headers: { ...server.headers, "content-type": "application/json" },
              body: JSON.stringify({ ...draft, id: "test-override-malformed", providers: [], models: [] }),
            }),
          )
          expect(posted.status).toBe(400)

          const listed = yield* list(server.base, server.headers)
          expect(listed.status).toBe(200)
          expect(ids(listed.body)).toEqual([])
        }),
      () => Effect.sync(() => ModelRouteOverrides.setFilePath(undefined)),
    )
  }),
)

it.live("rejects an already-expired route override and stores nothing", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-endpoint-")))
    const file = path.join(tmp.path, "route-overrides.json")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => ModelRouteOverrides.setFilePath(file)),
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(tmp.path)

          // save() drops expired entries, so a 200 here would answer with the override
          // silently missing from the list; the server must refuse it instead.
          const posted = yield* Effect.promise(() =>
            fetch(new URL("/api/route/overrides", server.base), {
              method: "POST",
              headers: { ...server.headers, "content-type": "application/json" },
              body: JSON.stringify({ ...draft, id: "test-override-expired", until: Date.now() - 1_000 }),
            }),
          )
          expect(posted.status).toBe(400)

          const listed = yield* list(server.base, server.headers)
          expect(listed.status).toBe(200)
          expect(ids(listed.body)).toEqual([])
        }),
      () => Effect.sync(() => ModelRouteOverrides.setFilePath(undefined)),
    )
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
