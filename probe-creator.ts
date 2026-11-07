import { provider as claudeProvider } from "./packages/ai/src/quota/providers/claude.ts"
import { parseBucket, transformSummary, transformModels } from "./packages/ai/src/quota/providers/antigravity.ts"

const claudeFetchWith = (payload: unknown) =>
  claudeProvider.fetchQuota({
    credentials: [],
    disabledProviders: new Set(),
    instances: new Map(),
    providerConfig: {},
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" },
    homeDir: "/nonexistent-probe-home-2235",
  } as never)

console.log("CLAUDE A empty-object:", JSON.stringify(await claudeFetchWith({})))
console.log("CLAUDE B empty-limits:", JSON.stringify(await claudeFetchWith({ limits: [] })))
console.log("CLAUDE C figureless-session-limit:", JSON.stringify(await claudeFetchWith({ limits: [{ kind: "session", resets_at: "2026-12-01T00:00:00Z" }] })))
console.log("CLAUDE D control-real:", JSON.stringify((await claudeFetchWith({ five_hour: { utilization: 10, resets_at: "2026-12-01T00:00:00Z" } })).usage))

console.log("AG BUCKET A reset-only-no-fraction:", JSON.stringify(parseBucket({ window: "5h", resetTime: "2026-12-01T00:00:00Z" } as never)))
console.log("AG BUCKET B empty:", JSON.stringify(parseBucket({} as never)))
console.log("AG BUCKET C control-real:", JSON.stringify(parseBucket({ window: "5h", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" } as never)))
console.log("AG SUMMARY A figureless-bucket:", JSON.stringify(transformSummary({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h", resetTime: "2026-12-01T00:00:00Z" }] }] } as never)))
console.log("AG SUMMARY B control-real:", JSON.stringify(transformSummary({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" }] }] } as never)))
const groupsFigureless = transformSummary({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h", resetTime: "2026-12-01T00:00:00Z" }] }] } as never)
console.log("AG MODELS matched-figureless-group:", JSON.stringify(transformModels({ models: { "gemini-x": {} } } as never, groupsFigureless as never)))
