import { describe, expect, test } from "bun:test"
import { ModelRouteLimits } from "@opencode/core/model-route-limits"
import { ModelRouteTuning } from "@opencode/core/model-route-tuning"

const now = Date.parse("2026-11-08T00:00:00Z")
const DAY = 86_400_000

describe("probe: week forms in the shared quota-reset relative grammar", () => {
  test("controls that must keep working", () => {
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 7 days", now)).toBe(now + 7 * DAY)
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 30m", now)).toBe(now + 30 * 60_000)
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 1 hour 30 minutes", now)).toBe(now + 90 * 60_000)
    expect(ModelRouteLimits.resetAtFromMessage("quota resets in 5 deals", now)).toBeUndefined()
  })
  test("week forms via ModelRouteLimits.resetAtFromMessage", () => {
    console.log("in 1 week =>", ModelRouteLimits.resetAtFromMessage("weekly quota resets in 1 week", now))
    console.log("in 2 weeks =>", ModelRouteLimits.resetAtFromMessage("weekly quota resets in 2 weeks", now))
    console.log("in 1 wk =>", ModelRouteLimits.resetAtFromMessage("weekly quota resets in 1 wk", now))
    console.log("relativeMs in 1 week =>", ModelRouteLimits.relativeMs("resets in 1 week"))
    expect(ModelRouteLimits.resetAtFromMessage("weekly quota resets in 1 week", now)).toBe(now + 7 * DAY)
  })
  test("week forms via ModelRouteTuning.parseQuotaReset (second door, #996 parity)", () => {
    console.log("tuning in 1 week =>", ModelRouteTuning.parseQuotaReset("quota limit reached, resets in 1 week", now))
    expect(ModelRouteTuning.parseQuotaReset("quota limit reached, resets in 1 week", now)).toBe(now + 7 * DAY)
  })
})
