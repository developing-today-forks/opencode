import { describe, expect, test } from "bun:test"
import { RouteStatsTool } from "@opencode/core/tool/plugin/route-stats"
import { ModelRoute } from "@opencode/core/model-route"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Schema } from "effect"

/** A pool written the way a config file writes it, decoded the way the config loader decodes it. */
const pool = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
  selection: "weighted",
  autonomy: "agent",
  targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
  weights: { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
})

describe("route_stats configuration view", () => {
  test("reports configured pools and tuner notes without a history database", async () => {
    const notes = ["openai/gpt-6-luna: out of quota, back in 3 hours"]
    const report = await Effect.runPromise(
      RouteStatsTool.collect({ hours: 24 }, { routes: new Map([["cheap-fast", pool]]), notes }),
    )
    expect(report.noDatabase).toBe(true)
    expect(report.notes).toEqual(notes)
    expect(report.routes).toHaveLength(1)
    expect(report.routes[0]).toMatchObject({
      id: "cheap-fast",
      attempts: 0,
      configured: {
        selection: "weighted",
        autonomy: "agent",
        targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
      },
    })
    expect(report.routes[0]?.members).toMatchObject([
      { target: "openai/gpt-6-luna", configuredWeight: 3, attempts: 0 },
      { target: "github-copilot/gpt-6-luna", configuredWeight: 1, attempts: 0 },
    ])
  })

  test("narrows the per-pool view to the route asked for", async () => {
    const report = await Effect.runPromise(
      RouteStatsTool.collect({ route: "other" }, { routes: new Map([["cheap-fast", pool]]), notes: [] }),
    )
    expect(report.routes).toEqual([])
  })

  test("surfaces declared per-target ceilings in the per-pool view", async () => {
    const mixed = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
      selection: "ordered",
      targets: [{ model: "anthropic/opus", limit: { context: 100_000 } }, "openai/gpt-6-luna"],
    })
    const report = await Effect.runPromise(
      RouteStatsTool.collect({ hours: 24 }, { routes: new Map([["small", mixed]]), notes: [] }),
    )
    expect(report.routes).toHaveLength(1)
    expect(report.routes[0]?.configured).toMatchObject({
      targets: ["anthropic/opus", "openai/gpt-6-luna"],
      limits: { "anthropic/opus": 100_000 },
    })
    expect(report.routes[0]?.members).toMatchObject([
      { target: "anthropic/opus", configuredLimit: 100_000 },
      { target: "openai/gpt-6-luna", configuredLimit: null },
    ])
  })
  test("surfaces active benches with reason and expiry, even for targets with no attempts", async () => {
    ModelRoute.resetHealth()
    const target = ModelRoute.ref({ providerID: "benched-provider", model: "quiet-model" })
    const now = Date.now()
    ModelRoute.failed(target, ModelRoute.policy(), now, { quota: true }, "cred-stats")
    const report = await Effect.runPromise(RouteStatsTool.collect({ hours: 24 }, { routes: new Map(), notes: [] }))
    expect(report.benches).toEqual([
      expect.objectContaining({
        providerID: "benched-provider",
        modelID: "quiet-model",
        credentialID: "cred-stats",
        reason: "quota",
        consecutiveFailures: 1,
        probeDue: false,
        probeClaimed: false,
      }),
    ])
    expect(report.benches[0]?.until).toBeGreaterThan(now)
    ModelRoute.resetHealth()
  })
})
