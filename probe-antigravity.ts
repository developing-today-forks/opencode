import { transformModels, transformSummary } from "./packages/ai/src/quota/providers/antigravity.ts"
import { provider as openrouterProvider } from "./packages/ai/src/quota/providers/openrouter.ts"

// CASE A: model with NO quotaInfo at all, no summary groups
console.log("A empty-model:", JSON.stringify(transformModels({ models: { "gemini-x": {} } } as never, [])))
// CASE B: model with quotaInfo carrying ONLY resetTime (no remainingFraction)
console.log("B reset-only:", JSON.stringify(transformModels({ models: { "gemini-x": { quotaInfo: { resetTime: "2027-01-01T00:00:00Z" } } } } as never, [])))
// CASE C: control - real remainingFraction
console.log("C real:", JSON.stringify(transformModels({ models: { "gemini-x": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-07T00:00:00Z" } } } } as never, [])))
// CASE D: model with empty quotaInfo object
console.log("D empty-quotaInfo:", JSON.stringify(transformModels({ models: { "gemini-x": { quotaInfo: {} } } } as never, [])))

const fetchWith = (payload: unknown) => openrouterProvider.fetchQuota({ credentials: [{ id: "r1", integrationID: "openrouter", active: true, value: { type: "key", key: "fixture-key" } }], disabledProviders: new Set(), instances: new Map(), providerConfig: {}, fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }), env: {} } as never)
console.log("E openrouter negative monthly spend:", JSON.stringify(await fetchWith({ data: { limit: null, limit_remaining: null, usage_monthly: -5 } })))
console.log("F openrouter control positive spend:", JSON.stringify((await fetchWith({ data: { limit: null, limit_remaining: null, usage_monthly: 12.5 } })).usage))
