import { provider as codex } from "./packages/ai/src/quota/providers/codex.ts"
const mkCtx = (access: string, calls: any[]) => ({
  credentials: [{ id: "row-1", integrationID: "openai", active: true, value: { type: "oauth", access, refresh: "r", expires: Date.now() + 3600_000 } }],
  disabledProviders: new Set<string>(),
  instances: new Map(),
  providerConfig: {},
  env: {},
  fetchImpl: async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null })
    return new Response(JSON.stringify({}), { status: 401, headers: { "content-type": "application/json" } })
  },
})
for (const [label, access] of [["whitespace '   '", "   "], ["empty ''", ""], ["real 'tok-real'", "tok-real"]] as const) {
  const calls: any[] = []
  const ctx = mkCtx(access, calls)
  const configured = await codex.isConfigured(ctx as never)
  const result = await codex.fetchQuota(ctx as never)
  console.log(`codex access=${label}: isConfigured=${configured} fetchCalls=${calls.length} auth=${JSON.stringify(calls[0]?.auth)} result.configured=${result.configured} ok=${result.ok} error=${JSON.stringify(result.error)}`)
}
