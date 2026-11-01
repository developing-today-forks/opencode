import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { Info } from "@opencode/schema/config"

// #1140: routing config's canonical shape is `experimental.routes.*`. The flat
// `experimental.model_routes` / `provider_routes` / `model_route_*` keys are the
// deprecated spellings of the same keys: the schema still accepts them (external
// file readers — the route proxy in developing-today/code, OpenChamber's
// validateModelRoutes — parse the file directly), and normalization folds them
// into the nested shape so every internal consumer reads exactly one shape.
// Mapping: model_routes -> routes.models, provider_routes -> routes.providers,
// model_route_windows -> routes.windows, model_route_schedules -> routes.schedules,
// model_route_tuning -> routes.tuning, model_route_log -> routes.log,
// model_route_settings -> routes.settings. Precedence: nested wins per key; a
// differing flat value under a nested one is a diagnosed conflict.

function normalized(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  expect(result.type).toBe("normalized")
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return result
}

function decoded(input: unknown) {
  return Schema.decodeUnknownSync(Info)(normalized(input).encoded)
}

const routesOf = (input: unknown) => decoded(input).experimental?.routes

// The deployed laptop config's shape (the 2026-11-01 production shape from
// #1277's regression test, extended with the remaining flat routing keys):
// flat model_routes + flat provider_routes with an ordered openai-plan group,
// flat windows, schedules, tuning, log and settings. It must keep working
// UNCHANGED — the shim exists precisely so this file never has to migrate.
const productionFlat = {
  provider: {
    openai: {
      models: {
        "gpt-6-luna": { limit: { context: 1050000, output: 128000 } },
        "gpt-6.1-terra": { limit: { context: 1050000, output: 128000 } },
      },
    },
    "openai.alternate": { instanceOf: "openai", name: "OpenAI Alternate (Student - popesdrew)" },
  },
  experimental: {
    provider_routes: {
      "openai-plan": { providers: ["openai.alternate", "openai"], selection: "ordered" },
    },
    model_routes: {
      "luna-plan": {
        targets: ["openai-plan/gpt-6-luna"],
        selection: "round-robin",
        autonomy: "rules",
        weights: { "openai-plan/gpt-6-luna": 2.5 },
      },
      "terra-plan": {
        targets: [{ model: "openai-plan/gpt-6.1-terra", window: "off-peak" }],
        selection: "ordered",
      },
    },
    model_route_windows: {
      "off-peak": { daysOfWeek: ["sat", "sun"], timezone: "UTC" },
    },
    model_route_schedules: [
      { providers: ["openai"], when: "off-peak", factor: 1.5, note: "weekend lift" },
    ],
    model_route_tuning: { enabled: true, notes: ["openai/gpt-6-luna: out of quota, back in 3 hours"] },
    model_route_log: { captureErrorBodies: true },
    model_route_settings: { bench: { multiplier: 3 } },
  },
} as const

const productionNested = {
  provider: productionFlat.provider,
  experimental: {
    routes: {
      providers: {
        "openai-plan": { providers: ["openai.alternate", "openai"], selection: "ordered" },
      },
      models: {
        "luna-plan": {
          targets: ["openai-plan/gpt-6-luna"],
          selection: "round-robin",
          autonomy: "rules",
          weights: { "openai-plan/gpt-6-luna": 2.5 },
        },
        "terra-plan": {
          targets: [{ model: "openai-plan/gpt-6.1-terra", window: "off-peak" }],
          selection: "ordered",
        },
      },
      windows: {
        "off-peak": { daysOfWeek: ["sat", "sun"], timezone: "UTC" },
      },
      schedules: [{ providers: ["openai"], when: "off-peak", factor: 1.5, note: "weekend lift" }],
      tuning: { enabled: true, notes: ["openai/gpt-6-luna: out of quota, back in 3 hours"] },
      log: { captureErrorBodies: true },
      settings: { bench: { multiplier: 3 } },
    },
  },
} as const

describe("nested routes conversion (#1140)", () => {
  test("the production flat shape normalizes to the nested shape with no diagnostics", () => {
    const result = normalized(productionFlat)
    expect(result.diagnostics).toEqual([])
    const routes = routesOf(productionFlat)
    expect(routes?.providers?.["openai-plan"]?.providers).toEqual(["openai.alternate", "openai"])
    expect(routes?.providers?.["openai-plan"]?.selection).toBe("ordered")
    expect(routes?.models?.["luna-plan"]?.targets).toHaveLength(1)
    expect(routes?.windows?.["off-peak"]?.timezone).toBe("UTC")
    expect(routes?.schedules).toHaveLength(1)
    expect(routes?.tuning?.enabled).toBe(true)
    expect(routes?.log?.captureErrorBodies).toBe(true)
    expect(routes?.settings?.bench?.multiplier).toBe(3)
    // The normalized config carries no flat routing keys at all.
    const experimental = decoded(productionFlat).experimental
    expect(experimental?.model_routes).toBeUndefined()
    expect(experimental?.provider_routes).toBeUndefined()
    expect(experimental?.model_route_windows).toBeUndefined()
    expect(experimental?.model_route_schedules).toBeUndefined()
    expect(experimental?.model_route_tuning).toBeUndefined()
    expect(experimental?.model_route_log).toBeUndefined()
    expect(experimental?.model_route_settings).toBeUndefined()
  })

  test("flat-only and nested-only spellings resolve to the identical config", () => {
    expect(decoded(productionFlat).experimental).toEqual(decoded(productionNested).experimental)
    expect(normalized(productionNested).diagnostics).toEqual([])
  })

  test("nested-only input passes through unchanged in shape", () => {
    const routes = routesOf({ experimental: { routes: { models: { pool: { targets: ["openai/gpt-6-luna"] } } } } })
    expect(routes?.models?.pool?.targets).toHaveLength(1)
    expect(routes?.providers).toBeUndefined()
  })

  test("when both spellings name a key, nested wins and the conflict is diagnosed per key", () => {
    const result = normalized({
      experimental: {
        model_routes: { flat: { targets: ["openai/gpt-6-luna"] } },
        model_route_settings: { bench: { multiplier: 2 } },
        routes: {
          models: { nested: { targets: ["anthropic/claude-sonnet-5"] } },
          settings: { bench: { multiplier: 3 } },
        },
      },
    })
    const routes = routesOf({
      experimental: {
        model_routes: { flat: { targets: ["openai/gpt-6-luna"] } },
        routes: { models: { nested: { targets: ["anthropic/claude-sonnet-5"] } } },
      },
    })
    expect(routes?.models?.nested).toBeDefined()
    expect(routes?.models?.flat).toBeUndefined()
    expect(result.diagnostics).toContainEqual({
      kind: "conflict",
      path: ["experimental", "routes", "models"],
      message: "retained native value over legacy value",
    })
    expect(result.diagnostics).toContainEqual({
      kind: "conflict",
      path: ["experimental", "routes", "settings"],
      message: "retained native value over legacy value",
    })
  })

  test("identical flat and nested values are not a conflict", () => {
    const result = normalized({
      experimental: {
        model_route_log: { captureErrorBodies: true },
        routes: { log: { captureErrorBodies: true } },
      },
    })
    expect(result.diagnostics).toEqual([])
    expect(routesOf({ experimental: { routes: { log: { captureErrorBodies: true } } } })?.log?.captureErrorBodies).toBe(
      true,
    )
  })

  test("keys not in conflict still fold: a flat-only key beside nested keys lands in routes", () => {
    const routes = routesOf({
      experimental: {
        model_route_windows: { peak: { start: "01:00", end: "04:00", timezone: "UTC" } },
        routes: { models: { pool: { targets: ["openai/gpt-6-luna"] } } },
      },
    })
    expect(routes?.windows?.peak?.start).toBe("01:00")
    expect(routes?.models?.pool).toBeDefined()
  })

  test("an unknown key inside a nested block is diagnosed at its nested path, like the flat path before it", () => {
    const nested = normalized({
      experimental: { routes: { tuning: { enabled: true, intervalMinutes: 30, intervall: 5 } } },
    })
    expect(nested.diagnostics).toContainEqual({
      kind: "invalid",
      path: ["experimental", "routes", "tuning", "intervall"],
      message: "omitted unknown setting",
    })
    expect(routesOf({ experimental: { routes: { tuning: { enabled: true, intervalMinutes: 30 } } } })?.tuning).toEqual(
      { enabled: true, intervalMinutes: 30 },
    )
    const flat = normalized({
      experimental: { model_route_tuning: { enabled: true, intervalMinutes: 30, intervall: 5 } },
    })
    expect(flat.diagnostics).toContainEqual({
      kind: "invalid",
      path: ["experimental", "model_route_tuning", "intervall"],
      message: "omitted unknown setting",
    })
  })

  test("a malformed nested entry is dropped with a nested-path diagnostic, exactly as its flat equivalent", () => {
    const nested = normalized({
      experimental: { routes: { windows: { peak: { start: 25, end: "04:00" } } } },
    })
    expect(nested.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      ["experimental", "routes", "windows", "peak"],
    ])
    expect(routesOf({ experimental: { routes: { windows: { peak: { start: 25 } } } } })?.windows).toBeUndefined()
    const flat = normalized({
      experimental: { model_route_windows: { peak: { start: 25, end: "04:00" } } },
    })
    expect(flat.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      ["experimental", "model_route_windows", "peak"],
    ])
  })

  test("an unknown key at the routes level is ignored, like an unknown flat experimental key", () => {
    const nested = normalized({ experimental: { routes: { bogus: 1 } } })
    const flat = normalized({ experimental: { bogus: 1 } })
    expect(nested.diagnostics).toEqual(flat.diagnostics)
  })

  test("empty containers keep their presence in both spellings", () => {
    expect(routesOf({ experimental: { model_routes: {} } })?.models).toEqual({})
    expect(routesOf({ experimental: { routes: { providers: {} } } })?.providers).toEqual({})
    expect(routesOf({ experimental: { model_route_schedules: [] } })?.schedules).toEqual([])
  })

  test("the schema still accepts the flat keys at file level (external readers keep validating)", () => {
    const raw = Schema.decodeUnknownSync(Info)({
      experimental: {
        model_routes: { pool: { targets: ["openai/gpt-6-luna"] } },
        provider_routes: { "openai-plan": { providers: ["openai"] } },
        model_route_windows: { peak: { start: "01:00" } },
      },
    })
    expect(raw.experimental?.model_routes?.pool).toBeDefined()
    expect(raw.experimental?.provider_routes?.["openai-plan"]).toBeDefined()
    expect(raw.experimental?.routes).toBeUndefined()
  })

  test("aliases still resolve inside flat model_routes targets after the fold", () => {
    const result = normalized({
      aliases: { providers: { ds: "deepseek" } },
      experimental: { model_routes: { pool: { targets: ["ds/deepseek-chat"] } } },
    })
    expect(result.diagnostics).toEqual([])
    const routes = (
      result.encoded.experimental as { routes?: { models?: Record<string, { targets: unknown[] }> } } | undefined
    )?.routes?.models
    expect(routes?.pool?.targets).toEqual([{ providerID: "deepseek", model: "deepseek-chat" }])
  })
})
