import { provider as deepseek } from "./packages/ai/src/quota/providers/deepseek.ts"
import { provider as groq } from "./packages/ai/src/quota/providers/groq.ts"
import { provider as mistral } from "./packages/ai/src/quota/providers/mistral.ts"
import { provider as openrouter } from "./packages/ai/src/quota/providers/openrouter.ts"

const mkCtx = (integrationID: string, key: string, calls: any[]) => ({
  credentials: [{ id: "row-1", integrationID, active: true, value: { type: "key", key } }],
  disabledProviders: new Set<string>(),
  instances: new Map(),
  providerConfig: {},
  env: {},
  fetchImpl: async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? init?.headers?.authorization ?? null })
    return new Response(JSON.stringify({}), { status: 401, headers: { "content-type": "application/json" } })
  },
})

const cases: Array<[string, any, string]> = [
  ["deepseek", deepseek, "deepseek"],
  ["groq", groq, "groq"],
  ["mistral", mistral, "mistral"],
  ["openrouter", openrouter, "openrouter"],
]

for (const [name, provider, integrationID] of cases) {
  for (const [label, key] of [["whitespace '   '", "   "], ["empty ''", ""], ["real 'sk-real'", "sk-real"]] as const) {
    const calls: any[] = []
    const ctx = mkCtx(integrationID, key, calls)
    const configured = await provider.isConfigured(ctx as never)
    const result = await provider.fetchQuota(ctx as never)
    console.log(`${name} key=${label}: isConfigured=${configured} fetchCalls=${calls.length} auth=${JSON.stringify(calls[0]?.auth)} result.configured=${result.configured} ok=${result.ok} error=${JSON.stringify(result.error)}`)
  }
}
