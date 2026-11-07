import { provider } from "./packages/ai/src/quota/providers/groq.ts"
const fetchWith = (headers: Record<string,string>) => provider.fetchQuota({
  credentials: [{ id: "row-1", integrationID: "groq", active: true, value: { type: "key", key: "gsk-fixture" } }],
  disabledProviders: new Set<string>(), instances: new Map(), providerConfig: {},
  fetchImpl: async () => new Response("{}", { status: 200, headers }), env: {},
} as never)
const overReq = await fetchWith({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "150", "x-ratelimit-reset-requests": "2m" })
console.log("OVER-REQ", JSON.stringify(overReq.usage?.windows.requests_daily))
const overTok = await fetchWith({ "x-ratelimit-limit-tokens": "10000", "x-ratelimit-remaining-tokens": "12000", "x-ratelimit-reset-tokens": "30s" })
console.log("OVER-TOK", JSON.stringify(overTok.usage?.windows.tokens_minute))
const control = await fetchWith({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "40", "x-ratelimit-reset-requests": "2m" })
console.log("CONTROL", JSON.stringify(control.usage?.windows.requests_daily))
