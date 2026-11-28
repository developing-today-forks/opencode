import { ModelRouteLimits } from "@opencode/core/model-route-limits"
const now = Date.parse("2026-11-08T00:00:00Z")
console.log("in 2 days and 1 week =>", ModelRouteLimits.resetAtFromMessage("quota resets in 2 days and 1 week", now), "expected full:", now + 9 * 86_400_000)
console.log("in 1 week 2 days =>", ModelRouteLimits.resetAtFromMessage("quota resets in 1 week 2 days", now))
