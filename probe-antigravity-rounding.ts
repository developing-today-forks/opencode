import { parseBucket, transformModels } from "./packages/ai/src/quota/providers/antigravity.ts"

const show = (label: string, fraction: number) => {
  const b = parseBucket({ window: "FIVE_HOUR", remainingFraction: fraction, resetTime: "2026-12-01T00:00:00Z" } as never)
  console.log(`${label} fraction=${fraction} trueUsed=${(1 - fraction) * 100} -> usedPercent=${b?.window.usedPercent} remainingPercent=${b?.window.remainingPercent}`)
}
show("nearly-full-remaining", 0.999)
show("nearly-exhausted", 0.001)
show("half-ish", 0.504)
show("control-half", 0.5)
show("control-quarter", 0.25)

// fallback path (transformModels with no groups)
const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const models = transformModels({ models: { "gemini-x": { quotaInfo: { remainingFraction: 0.001, resetTime } } } } as never, [])
console.log("fallback 0.001 ->", JSON.stringify(models["gemini-x"]?.windows))
const models2 = transformModels({ models: { "gemini-x": { quotaInfo: { remainingFraction: 0.999, resetTime } } } } as never, [])
console.log("fallback 0.999 ->", JSON.stringify(models2["gemini-x"]?.windows))
