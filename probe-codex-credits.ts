import { provider } from "./packages/ai/src/quota/providers/codex.ts"

const fetchWith = (payload: unknown) =>
  provider.fetchQuota({
    credentials: [
      { id: "row-1", integrationID: "openai", active: true, value: { type: "oauth", access: "tok-fixture", refresh: "fixture", expires: 4_102_444_800_000 } },
    ],
    disabledProviders: new Set<string>(),
    instances: new Map(),
    providerConfig: {},
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    env: {},
  } as never)

for (const [label, payload] of [
  ["negative balance only", { credits: { balance: -5 } }],
  ["negative balance + real window", { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1893456000 } }, credits: { balance: -5 } }],
  ["zero balance (control)", { credits: { balance: 0 } }],
  ["positive balance (control)", { credits: { balance: 42 } }],
] as const) {
  const r = await fetchWith(payload)
  console.log(label, "=> ok:", r.ok, "windows:", JSON.stringify(r.usage?.windows))
}
