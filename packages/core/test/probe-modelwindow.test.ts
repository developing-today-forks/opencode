import { describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"

// Probe: a model with TWO windows at the SAME measuredAt (the real gatherer shape:
// QuotaCurrent.modelWindowsOf stamps every per-model window with the provider's
// measuredAt). One window full (5h:100), one with headroom (weekly:4).
// #1974's stated rule: "a reading that still shows the window full lifts nothing".
// If release depends on the ARRAY ORDER of the two windows, the judgement is
// order-dependent, not window-based.
const reading = (windows: { name: string; usedPercent: number }[], at: number) => [
  {
    providerID: "opendesign",
    measuredAt: at,
    windows: [],
    models: {
      "claude-haiku-5.5": windows.map((w) => ({ name: w.name, usedPercent: w.usedPercent, resetAt: null, measuredAt: at })),
    },
  },
]

const setup = () => {
  const now = 720_000_000
  const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" })
  ModelRoute.resetHealth()
  ModelRoute.observeQuotaFailure(leaf, undefined, now + 3 * 86_400_000, now)
  expect(ModelRoute.skipped(leaf, now + 1)).toBe(true)
  return { now, leaf, judgedAt: now + 15 * 60_000 }
}

describe("probe: multi-window model reading", () => {
  test("full window LAST (weekly:4 then 5h:100) -> release?", () => {
    const { leaf, judgedAt } = setup()
    const released = ModelRoute.releaseQuotaSkipsForCurrent(
      leaf,
      reading([{ name: "weekly", usedPercent: 4 }, { name: "5h", usedPercent: 100 }], judgedAt),
      judgedAt,
    )
    console.log("ORDER weekly,5h released=", JSON.stringify(released), "skipped=", ModelRoute.skipped(leaf, judgedAt + 1))
  })
  test("full window FIRST (5h:100 then weekly:4) -> release?", () => {
    const { leaf, judgedAt } = setup()
    const released = ModelRoute.releaseQuotaSkipsForCurrent(
      leaf,
      reading([{ name: "5h", usedPercent: 100 }, { name: "weekly", usedPercent: 4 }], judgedAt),
      judgedAt,
    )
    console.log("ORDER 5h,weekly released=", JSON.stringify(released), "skipped=", ModelRoute.skipped(leaf, judgedAt + 1))
  })
  test("control: both windows headroom (weekly:4, 5h:1) -> release expected", () => {
    const { leaf, judgedAt } = setup()
    const released = ModelRoute.releaseQuotaSkipsForCurrent(
      leaf,
      reading([{ name: "weekly", usedPercent: 4 }, { name: "5h", usedPercent: 1 }], judgedAt),
      judgedAt,
    )
    console.log("CONTROL both-low released=", JSON.stringify(released))
    expect(released).toEqual(["quota-model:opendesign:claude-haiku-5.5"])
  })
  test("control: single full window -> no release expected", () => {
    const { leaf, judgedAt } = setup()
    const released = ModelRoute.releaseQuotaSkipsForCurrent(
      leaf,
      reading([{ name: "weekly", usedPercent: 100 }], judgedAt),
      judgedAt,
    )
    console.log("CONTROL single-full released=", JSON.stringify(released))
    expect(released).toEqual([])
  })
})
