import { provider } from "./packages/ai/src/quota/providers/meta.ts"
const base: any = {
  credentials: [{ id: "r1", integrationID: "meta", active: true, value: { type: "key", key: "tok-fixture" } }],
  disabledProviders: new Set(),
  instances: new Map(),
  providerConfig: {},
  env: {},
  homeDir: "/nonexistent-home",
  cdpBase: "http://127.0.0.1:9",
}
const mk = (subs: unknown): any => ({ ...base, fetchImpl: async () => new Response(JSON.stringify({ is_subs_active: true, subs_tier_name: "fixture-tier", subs_usage: subs }), { status: 200, headers: { "content-type": "application/json" } }) })
console.log("CASE1 empty window + real weekly:", JSON.stringify(await provider.fetchQuota(mk({ window: {}, weekly: { used_percent: 25, resets_at: 1893456000 } })), null, 1))
console.log("CASE2 both empty:", JSON.stringify(await provider.fetchQuota(mk({ window: {}, weekly: {} })), null, 1))
console.log("CASE3 control real both:", JSON.stringify(await provider.fetchQuota(mk({ window: { used_percent: 10, resets_at: 1893456000 }, weekly: { used_percent: 25, resets_at: 1893456000 } })), null, 1))
