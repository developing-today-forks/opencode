import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Document, Info } from "@opencode/schema/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigModelRoutesPlugin } from "@opencode/core/config/plugin/model-routes"
import { ModelRoute } from "@opencode/core/model-route"

const decode = Schema.decodeUnknownSync(Info)
const document = (scope?: string) => new Document({
  type: "document",
  info: decode({ providers: { scoped: scope === undefined ? {} : { wallScope: scope } } }),
})

describe("declared wall scope (code#13790)", () => {
  // Oracle: the three declared literals survive both supported config spellings.
  test.each(["per-model", "provider", "account"])("preserves %s through native and legacy decode", (scope) => {
    for (const key of ["providers", "provider"]) {
      const result = ConfigNormalize.normalize({ [key]: { scoped: { wallScope: scope } } })
      expect(result.type).toBe("normalized")
      if (result.type !== "normalized") return
      const info = decode(result.encoded)
      expect(info.providers?.scoped?.wallScope).toBe(scope)
      expect(ConfigModelRoutesPlugin.configuredWallScope([new Document({ type: "document", info })], "scoped")).toBe(scope)
    }
  })

  test.each(["providers", "provider"])("rejects invalid %s declarations", (key) => {
    const result = ConfigNormalize.normalize({ [key]: { scoped: { wallScope: "typo" } } })
    expect(result.diagnostics.some((item) => item.kind === "invalid" && item.path[0] === key)).toBe(true)
  })

  test("later declarations win; absence leaves inference enabled", () => {
    expect(ConfigModelRoutesPlugin.configuredWallScope([document("provider"), document("per-model"), document()], "scoped")).toBe("per-model")
    expect(ConfigModelRoutesPlugin.configuredWallScope([document()], "scoped")).toBeUndefined()
  })

  // Oracle: explicit scope overrides shape; undeclared shape remains the existing rule.
  test.each([undefined, "per-model", "provider", "account"] as const)("judges gathered gates at declared %s scope", (scope) => {
    ModelRoute.resetHealth()
    const entries = [document(scope)]
    const off = ModelRoute.onWallScope((id) => ConfigModelRoutesPlugin.configuredWallScope(entries, id), "/scope")
    const leaf = ModelRoute.ref({ providerID: "scoped", model: "full" })
    const sibling = ModelRoute.ref({ providerID: "scoped", model: "other" })
    const now = 900_000_000
    const resetAt = now + 86_400_000
    const window = { name: "weekly", usedPercent: 100, resetAt, measuredAt: now }
    const readings = [{ providerID: "scoped", measuredAt: now, windows: [window], models: {} }]
    try {
      expect(ModelRoute.plantGatheredQuotaWall(leaf, readings, now, "/scope")).toBeDefined()
      expect(ModelRoute.skipped(leaf, now + 1)).toBe(true)
      expect(ModelRoute.skipped(sibling, now + 1)).toBe(false)
      expect(ModelRoute.observeGatheredProviderWall(leaf, readings, now, "/scope")).toBe(scope !== "per-model")
      const expected = scope === "per-model" ? undefined : { until: resetAt }
      expect(ModelRoute.providerQuotaBlocked(sibling, now + 1, "/scope")).toEqual(expected)
      expect(ModelRoute.providerRootStartBlocked(sibling, now + 1, "/scope")).toEqual(expected)
      // Changing scope is lazy, and suppresses an already retained gathered gate.
      entries.push(document("per-model"))
      expect(ModelRoute.providerQuotaBlocked(sibling, now + 1, "/scope")).toBeUndefined()
      expect(ModelRoute.providerRootStartBlocked(sibling, now + 1, "/scope")).toBeUndefined()
    } finally {
      off()
      ModelRoute.resetHealth()
    }
  })

  test.each([undefined, "provider", "account"] as const)("%s scope judges model-shaped evidence", (scope) => {
    ModelRoute.resetHealth()
    const off = ModelRoute.onWallScope((id) => ConfigModelRoutesPlugin.configuredWallScope([document(scope)], id), "/scope")
    const leaf = ModelRoute.ref({ providerID: "scoped", model: "full" })
    const sibling = ModelRoute.ref({ providerID: "scoped", model: "other" })
    const now = 910_000_000
    const resetAt = now + 86_400_000
    const readings = [{ providerID: "scoped", measuredAt: now, windows: [], models: {
      full: [{ name: "weekly", usedPercent: 100, resetAt, measuredAt: now }],
      other: [{ name: "weekly", usedPercent: 10, resetAt, measuredAt: now }],
    } }]
    try {
      // Oracle: a declared shared wall cannot depend on target feed order.
      for (const targets of [[leaf, sibling], [sibling, leaf]]) {
        ModelRoute.resetHealth()
        for (const target of targets)
          expect(ModelRoute.observeGatheredProviderWall(target, readings, now, "/scope")).toBe(scope !== undefined)
        expect(ModelRoute.providerQuotaBlocked(sibling, now + 1, "/scope")).toEqual(scope === undefined ? undefined : { until: resetAt })
        expect(ModelRoute.providerRootStartBlocked(sibling, now + 1, "/scope")).toEqual(scope === undefined ? undefined : { until: resetAt })
      }
      ModelRoute.completed(sibling, ModelRoute.policy({}), { firstTokenMs: 10, responseMs: 10, tokensPerSecond: 30 }, now + 10)
      expect(ModelRoute.providerQuotaBlocked(sibling, now + 11, "/scope")).toEqual(scope === undefined ? undefined : { until: resetAt })
    } finally {
      off()
      ModelRoute.resetHealth()
    }
  })
})
