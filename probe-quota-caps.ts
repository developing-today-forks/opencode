import { readQuotaJson, QUOTA_RESPONSE_MAX_BYTES } from "./packages/ai/src/quota/utils.ts"
import { parseCodingPlanWindows } from "./packages/ai/src/quota/providers/opendesign.ts"

// --- A: readQuotaJson cap is denominated in bytes but measured in UTF-16 code units ---
const euroPayload = JSON.stringify("€".repeat(400_000))
console.log("A euro: jsonChars=", euroPayload.length, " utf8Bytes=", new TextEncoder().encode(euroPayload).length, " cap=", QUOTA_RESPONSE_MAX_BYTES)
try {
  const v = await readQuotaJson(new Response(euroPayload))
  console.log("A euro: ACCEPTED, returned string length", typeof v === "string" ? v.length : typeof v)
} catch (e) { console.log("A euro: REJECTED:", (e as Error).message) }
const asciiPayload = JSON.stringify("a".repeat(1_100_000))
console.log("A ascii: jsonChars=", asciiPayload.length, " utf8Bytes=", new TextEncoder().encode(asciiPayload).length)
try {
  const v = await readQuotaJson(new Response(asciiPayload))
  console.log("A ascii: ACCEPTED, returned string length", typeof v === "string" ? v.length : typeof v)
} catch (e) { console.log("A ascii: REJECTED:", (e as Error).message) }

// --- B: opendesign parseCodingPlanWindows out-of-range remaining ---
const neg = parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: -50, resetsAt: 1893456000 }] })
console.log("B negative-remaining:", JSON.stringify(neg))
const over = parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: 150, resetsAt: 1893456000 }] })
console.log("B over-limit-remaining:", JSON.stringify(over))
const sane = parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 100, remainingCredits: 25, resetsAt: 1893456000 }] })
console.log("B sane:", JSON.stringify(sane))
