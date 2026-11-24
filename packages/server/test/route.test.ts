import path from "node:path"
import { expect } from "bun:test"
import { Context, Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { RouteAttemptTable, RouteDecisionTable } from "@opencode/core/model-route-log/sql"
import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { serveRoutes } from "./fixture/routes"
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

it.live("rejects a route override that names excludeWindows and stores nothing", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-endpoint-")))
    const file = path.join(tmp.path, "route-overrides.json")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => ModelRouteOverrides.setFilePath(file)),
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(tmp.path)

          // Routing has no window map at evaluation time, so an unresolved excludeWindows
          // name would leave the override inert; the server must refuse it.
          const posted = yield* Effect.promise(() =>
            fetch(new URL("/api/route/overrides", server.base), {
              method: "POST",
              headers: { ...server.headers, "content-type": "application/json" },
              body: JSON.stringify({
                ...draft,
                id: "test-override-exclude-windows",
                schedule: { daysOfWeek: [1], excludeWindows: ["maintenance"] },
              }),
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

it.live("serves the route-attempt read API over HTTP: empty ledger, aggregate shape, read-only", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-attempts-")))
    const server = yield* startServer(tmp.path)

    const attempts = yield* Effect.promise(() =>
      fetch(new URL("/api/route/attempts?provider=openai&session=ses_1&since=0", server.base), {
        headers: server.headers,
      }),
    )
    expect(attempts.status).toBe(200)
    expect(yield* Effect.promise(() => attempts.json())).toEqual({ data: [] })

    const stats = yield* Effect.promise(() =>
      fetch(new URL("/api/route/attempts/stats?since=0", server.base), { headers: server.headers }),
    )
    expect(stats.status).toBe(200)
    expect(yield* Effect.promise(() => stats.json())).toEqual({
      data: {
        targets: [],
        hedges: [],
        errors: [],
        coverage: { attempts: 0, providers: 0, models: 0, sessions: 0, routes: 0, first: null, last: null },
      },
    })

    const decisions = yield* Effect.promise(() =>
      fetch(new URL("/api/route/decisions?since=0", server.base), { headers: server.headers }),
    )
    expect(decisions.status).toBe(200)
    expect(yield* Effect.promise(() => decisions.json())).toEqual({ data: [] })

    // Read-only surface (#2497): there is no mutation endpoint for attempts.
    const posted = yield* Effect.promise(() =>
      fetch(new URL("/api/route/attempts", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(posted.status).not.toBe(200)
    const after = yield* list(server.base, server.headers)
    expect(after.status).toBe(200)
  }),
)

it.live("serves populated route attempts, stats and decisions over HTTP in parity with the core queries (#2497)", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-route-attempts-parity-")))
    const server = yield* serveRoutes(
      {
        app: { version: "test-version" },
        database: { path: path.join(tmp.path, "opencode.db") },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      [Global.node.replace(tempGlobalLayer)],
    )
    const db = Context.get(server.context, Database.Service).db

    // A populated ledger: two providers, two sessions, one failure carrying an error tag,
    // and one row seeded with a credential id and a provider error body — the two values
    // the read API must never serve (#2497 acceptance: attempts and aggregates only).
    const attempts: ModelRouteLog.Attempt[] = [
      {
        time_started: 1_000,
        time_ended: 2_000,
        session_id: "ses_1",
        route_id: "luna",
        provider_id: "openai",
        model_id: "gpt-6-luna",
        outcome: "success",
        output_started: true,
        tokens_input: 100,
        tokens_output: 10,
        credential_id: "cred_secret",
        error_body: "provider body that must never be served",
      },
      {
        time_started: 3_000,
        time_ended: 4_000,
        session_id: "ses_2",
        route_id: "luna",
        provider_id: "openai",
        model_id: "gpt-6-luna",
        outcome: "failure",
        output_started: false,
        tokens_input: 50,
        error_tag: "QuotaExceeded",
        error_code: "rate_limit",
        error_status: 429,
        error_message: "upstream quota exceeded",
        error_body: "raw provider body that must never be served",
        hedged: true,
        assistant_message_id: "msg_hedge",
      },
      {
        time_started: 4_000,
        time_ended: 5_000,
        session_id: "ses_1",
        route_id: "luna",
        provider_id: "anthropic",
        model_id: "claude-x",
        outcome: "success",
        output_started: true,
        tokens_input: 200,
        hedged: true,
        assistant_message_id: "msg_hedge",
        first_token_ms: 800,
        tokens_per_second: 20,
      },
      {
        time_started: 9_000,
        time_ended: 10_000,
        session_id: "ses_1",
        route_id: "luna",
        provider_id: "openai",
        model_id: "gpt-6-luna",
        outcome: "success",
        output_started: true,
      },
    ]
    for (const row of attempts) yield* db.insert(RouteAttemptTable).values(row).run()
    yield* db
      .insert(RouteDecisionTable)
      .values({
        time: 2_000,
        session_id: "ses_1",
        route_id: "luna",
        selection: "weighted",
        candidates: ["openai/gpt-6-luna"],
        chosen: "openai/gpt-6-luna",
        reason: "drawn",
      })
      .run()
    yield* db
      .insert(RouteDecisionTable)
      .values({
        time: 6_000,
        session_id: "ses_2",
        route_id: "other",
        selection: "weighted",
        candidates: ["anthropic/claude-x"],
        chosen: "anthropic/claude-x",
        reason: "drawn",
      })
      .run()

    // The oracle is core's own query layer over the same ledger: the HTTP surface is in
    // parity when it serves exactly what these functions return for the same window.
    const expectedAttempts = yield* ModelRouteLog.filteredAttempts(db, { since: 0 })
    const expectedFiltered = yield* ModelRouteLog.filteredAttempts(db, { since: 0, providerID: "anthropic" })
    const expectedDecisions = yield* ModelRouteLog.filteredDecisions(db, { since: 0, routeID: "luna" })
    expect(expectedAttempts).toHaveLength(4)
    expect(expectedDecisions).toHaveLength(1)

    const get = (route: string) =>
      Effect.promise(() => server.fetch(`http://opencode.local${route}`)).pipe(
        Effect.flatMap((response) =>
          Effect.promise(async () => ({ status: response.status, text: await response.text() })),
        ),
      )
    // The wire shape of a core row: ledger nulls are absent fields (the handler maps them
    // to undefined and JSON drops them); every other value is served as stored.
    const wire = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined))
    const byTarget = (a: { providerID: string; modelID: string }, b: { providerID: string; modelID: string }) =>
      a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID)

    const listAll = yield* get("/api/route/attempts?since=0")
    expect(listAll.status).toBe(200)
    expect(listAll.text).not.toContain("cred_secret")
    expect(listAll.text).not.toContain("provider body that must never be served")
    const listAllBody = JSON.parse(listAll.text) as { data: Record<string, unknown>[] }
    expect(listAllBody.data).toEqual(expectedAttempts.map((row) => wire({ ...row })))
    for (const row of listAllBody.data) {
      expect(Object.keys(row)).not.toContain("credentialID")
      expect(Object.keys(row)).not.toContain("errorBody")
      expect(Object.keys(row)).not.toContain("quota")
    }

    const listFiltered = yield* get("/api/route/attempts?since=0&provider=anthropic")
    expect(listFiltered.status).toBe(200)
    expect(JSON.parse(listFiltered.text)).toEqual({ data: expectedFiltered.map((row) => wire({ ...row })) })

    for (const index of Array.from({ length: 51 }, (_, index) => index)) {
      yield* db
        .insert(RouteAttemptTable)
        .values({
          time_started: 1_100 + index,
          time_ended: 1_200 + index,
          route_id: "luna",
          provider_id: `error-provider-${index}`,
          model_id: `error-model-${index}`,
          outcome: "failure",
          output_started: false,
          error_tag: `ProviderError${index}`,
          error_code: `ERR_${index}`,
          error_status: 500,
        })
        .run()
    }
    yield* db
      .insert(RouteAttemptTable)
      .values({
        time_started: 4_500,
        time_ended: 4_600,
        route_id: "luna",
        provider_id: "openai",
        model_id: "gpt-6-luna",
        outcome: "failure",
        output_started: false,
        error_tag: "QuotaExceeded",
        error_code: "rate_limit",
        error_status: 429,
        error_message: `second upstream message ${"x".repeat(320)}`,
      })
      .run()
    const expectedTargets = yield* ModelRouteLog.targetTotals(db, 0, 5_000)
    const expectedCoverage = yield* ModelRouteLog.ledgerCoverage(db, 0, 5_000)
    const stats = yield* get("/api/route/attempts/stats?since=0&until=5000")
    expect(stats.status).toBe(200)
    const statsBody = JSON.parse(stats.text) as {
      data: {
        targets: {
          providerID: string
          modelID: string
          avgFirstTokenMs: number | null
          avgTokensPerSecond: number | null
        }[]
        hedges: { providerID: string; modelID: string; hedges: number; wins: number }[]
        errors: {
          providerID: string
          modelID: string
          tag: string | null
          code: string | null
          status: number | null
          count: number
          lastTime: number
          lastMessage: string | null
        }[]
        coverage: unknown
      }
    }
    expect([...statsBody.data.targets].sort(byTarget)).toEqual([...expectedTargets].sort(byTarget))
    expect(statsBody.data.targets.find((target) => target.providerID === "anthropic")).toMatchObject({
      avgFirstTokenMs: 800,
      avgTokensPerSecond: 20,
    })
    expect([...statsBody.data.hedges].sort(byTarget)).toEqual(
      [
        { providerID: "anthropic", modelID: "claude-x", hedges: 1, wins: 1 },
        { providerID: "openai", modelID: "gpt-6-luna", hedges: 1, wins: 0 },
      ].sort(byTarget),
    )
    expect(statsBody.data.errors).toHaveLength(50)
    expect(statsBody.data.errors[0]).toEqual({
      providerID: "openai",
      modelID: "gpt-6-luna",
      tag: "QuotaExceeded",
      code: "rate_limit",
      status: 429,
      count: 2,
      lastTime: 4_500,
      lastMessage: `second upstream message ${"x".repeat(320)}`.slice(0, 300),
    })
    expect(stats.text).not.toContain("raw provider body that must never be served")
    expect(statsBody.data.coverage).toEqual(
      expectedCoverage ?? { attempts: 0, providers: 0, models: 0, sessions: 0, routes: 0, first: null, last: null },
    )

    const decisions = yield* get("/api/route/decisions?since=0&route=luna")
    expect(decisions.status).toBe(200)
    expect(JSON.parse(decisions.text)).toEqual({ data: expectedDecisions.map((row) => wire({ ...row })) })
  }),
)
