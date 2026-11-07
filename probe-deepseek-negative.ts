import { provider } from "./packages/ai/src/quota/providers/deepseek.ts"
const fetchWith = (payload: unknown) =>
  provider.fetchQuota({
    credentials: [{ id: "row-1", integrationID: "deepseek", active: true, value: { type: "key", key: "fixture-key" } }],
    disabledProviders: new Set<string>(),
    instances: new Map(),
    providerConfig: {},
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    env: {},
  } as never)
for (const [label, payload] of [
  ["negative USD only", { balance_infos: [{ currency: "USD", total_balance: "-5.00" }] }],
  ["negative USD numeric", { balance_infos: [{ currency: "USD", total_balance: -5 }] }],
  ["zero USD only (control?)", { balance_infos: [{ currency: "USD", total_balance: "0.00" }] }],
  ["positive USD control", { balance_infos: [{ currency: "USD", total_balance: "42.00" }] }],
  ["positive EUR + negative USD (#1800 control)", { balance_infos: [{ currency: "USD", total_balance: "-5" }, { currency: "EUR", total_balance: "10" }] }],
  ["negative CNY only", { balance_infos: [{ currency: "CNY", total_balance: "-7" }] }],
] as const) {
  const r = await fetchWith(payload)
  console.log(label, "=> ok:", r.ok, "error:", r.error ?? null, "windows:", JSON.stringify(r.usage?.windows))
}
