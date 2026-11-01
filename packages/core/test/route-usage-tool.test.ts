import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "@opencode/core/database/database"
import { ModelPlan } from "@opencode/core/model-plan"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { RouteUsageTool } from "@opencode/core/tool/plugin/route-usage"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { withTempDir } from "./fixture/tmpdir"

const it = testEffect(LayerNode.compile(LayerNode.group([ModelRouteLog.node, Database.node])))

const burnAttempt = (sessionID: string, routeID: string, time_started: number) => ({
  time_started,
  time_ended: time_started + 500,
  route_id: routeID,
  provider_id: "openai",
  model_id: "gpt-6-luna",
  outcome: "success" as const,
  output_started: true,
  session_id: sessionID,
})

const NOW = Date.parse("2026-10-14T09:00:00.000Z")

const pool = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
  selection: "weighted",
  targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
  weights: { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
})

describe("route_usage without a history database", () => {
  test("lists configured members as unused, and plan windows with no usage shown as unknown", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-usage-"))
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      {
        providerID: "openai",
        plan: "Plus",
        quotas: [{ name: "5-hour", unit: "requests", limit: 100, windowHours: 5 }],
      },
      "2026-10-14T09:00:00.000Z",
    )
    ModelPlan.writeStore(store, dataDir)
    const report = await Effect.runPromise(
      RouteUsageTool.collect({ hours: 24 }, { routes: new Map([["cheap-fast", pool]]) }, { dataDir, now: () => NOW }),
    )
    expect(report.noDatabase).toBe(true)
    expect(report.targets.map((target) => target.target)).toEqual(["openai/gpt-6-luna", "github-copilot/gpt-6-luna"])
    expect(report.targets[0]?.pools).toEqual([
      { routeID: "cheap-fast", state: "configured-not-reached", offered: 0, chosen: 0 },
    ])
    expect(report.plans).toMatchObject([
      { plan: "openai-plus", window: "5-hour", used: null, percent: null, limit: 100 },
    ])
  })

  test("a quota window without windowHours is listed with its limit and reset rule, usage unknown", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-usage-"))
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      {
        providerID: "openai",
        plan: "Plus",
        quotas: [
          { name: "5-hour", unit: "requests", limit: 100, windowHours: 5 },
          { name: "monthly", unit: "requests", limit: 1000, resetRule: "resets on the 1st" },
        ],
      },
      "2026-10-14T09:00:00.000Z",
    )
    ModelPlan.writeStore(store, dataDir)
    const report = await Effect.runPromise(
      RouteUsageTool.collect({ hours: 24 }, undefined, { dataDir, now: () => NOW }),
    )
    expect(report.plans).toMatchObject([
      { plan: "openai-plus", window: "5-hour", windowHours: 5, used: null, limit: 100 },
      {
        plan: "openai-plus",
        window: "monthly",
        windowHours: null,
        used: null,
        percent: null,
        remaining: null,
        limit: 1000,
        resetRule: "resets on the 1st",
      },
    ])
  })

  test("a damaged plan file is reported, and usage still comes back", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-usage-"))
    fs.writeFileSync(path.join(dataDir, "plans.json"), "{")
    const report = await Effect.runPromise(RouteUsageTool.collect({}, undefined, { dataDir, now: () => NOW }))
    expect(report.planError).toContain("not valid JSON")
    expect(report.plans).toEqual([])
    expect(report.noDatabase).toBe(true)
  })
})

describe("route_usage burn rates", () => {
  it.live("a multi-pool same-model session contributes its window share once (#1033)", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const now = Date.now()
        const { store } = ModelPlan.upsertPlan(
          ModelPlan.emptyStore(),
          {
            providerID: "openai",
            plan: "Plus",
            quotas: [{ name: "5-hour", unit: "requests", limit: 100, windowHours: 5 }],
          },
          new Date(now).toISOString(),
        )
        ModelPlan.writeStore(store, tmp.path)
        Array.from({ length: 5 }, (_, index) => [
          burnAttempt("ses_burnrate_dedupe", "pool-a", now - 3_600_000 + index * 1_000),
          burnAttempt("ses_burnrate_dedupe", "pool-b", now - 3_600_000 + index * 1_000 + 500),
        ])
          .flat()
          .forEach((row) => ModelRouteLog.record({ kind: "attempt", row }))
        yield* Effect.sleep("100 millis")

        const report = yield* RouteUsageTool.collect({ hours: 24, session: "ses_burnrate_dedupe" }, undefined, {
          dataDir: tmp.path,
          now: () => now,
        })
        // Ten requests against a limit of 100: one 10% sample, not one per pool.
        expect(report.burnRates).toEqual([
          {
            providerID: "openai",
            modelID: "gpt-6-luna",
            effort: null,
            plan: "openai-plus",
            window: "5-hour",
            percentPerSession: 10,
            sessions: 1,
            source: "bucket",
          },
        ])
      }),
    ),
  )

  it.live("two windows of one provider with different limits get separate burn buckets (#1033)", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const now = Date.now()
        const { store } = ModelPlan.upsertPlan(
          ModelPlan.emptyStore(),
          {
            providerID: "openai",
            plan: "Plus",
            quotas: [
              { name: "5-hour", unit: "requests", limit: 100, windowHours: 5 },
              { name: "daily", unit: "requests", limit: 1000, windowHours: 24 },
            ],
          },
          new Date(now).toISOString(),
        )
        ModelPlan.writeStore(store, tmp.path)
        Array.from({ length: 10 }, (_, index) =>
          burnAttempt("ses_burnrate_windows", "pool-a", now - 3_600_000 + index * 1_000),
        ).forEach((row) => ModelRouteLog.record({ kind: "attempt", row }))
        yield* Effect.sleep("100 millis")

        const report = yield* RouteUsageTool.collect({ hours: 24, session: "ses_burnrate_windows" }, undefined, {
          dataDir: tmp.path,
          now: () => now,
        })
        // Ten requests are 10% of the 5-hour window but 1% of the daily one: averaging them would
        // describe neither window.
        expect(report.burnRates).toEqual([
          {
            providerID: "openai",
            modelID: "gpt-6-luna",
            effort: null,
            plan: "openai-plus",
            window: "5-hour",
            percentPerSession: 10,
            sessions: 1,
            source: "bucket",
          },
          {
            providerID: "openai",
            modelID: "gpt-6-luna",
            effort: null,
            plan: "openai-plus",
            window: "daily",
            percentPerSession: 1,
            sessions: 1,
            source: "bucket",
          },
        ])
      }),
    ),
  )
})
