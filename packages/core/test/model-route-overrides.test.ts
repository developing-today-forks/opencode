import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteOverrides } from "@opencode/core/model-route-overrides"

const DAY = 86_400_000
const now = Date.now()
const anthropic = ModelRoute.ref({ providerID: "anthropic", model: "claude-opus-4-1" })
const openai = ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" })
const draft = (over: Partial<ModelRouteOverrides.Override>): ModelRouteOverrides.Override => ({
  id: "t",
  action: "avoid",
  providers: [],
  models: [],
  routes: [],
  fixed: true,
  until: now + DAY,
  text: "",
  source: "user",
  createdAt: now,
  ...over,
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-overrides-"))
  ModelRouteOverrides.setFilePath(path.join(dir, "route-overrides.json"))
  ModelRoute.resetHealth()
})
afterEach(() => {
  ModelRouteOverrides.setFilePath(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("ModelRouteOverrides matching", () => {
  test("provider names match regardless of case, and models match wildcards", () => {
    const item = draft({ providers: ["Anthropic"], models: ["*opus*"] })
    expect(ModelRouteOverrides.applies(item, anthropic, now)).toBe(true)
    expect(ModelRouteOverrides.applies(item, openai, now)).toBe(false)
    const sonnet = ModelRoute.ref({ providerID: "anthropic", model: "claude-sonnet-4" })
    expect(ModelRouteOverrides.applies(item, sonnet, now)).toBe(false)
  })

  test("a provider with no model pattern covers all its models, and expiry ends it", () => {
    const item = draft({ providers: ["openai"], until: now + 1_000 })
    expect(ModelRouteOverrides.applies(item, openai, now)).toBe(true)
    expect(ModelRouteOverrides.applies(item, openai, now + 1_000)).toBe(false)
  })

  test("an entry that names nothing is dropped, so it can never apply to everything", () => {
    expect(
      ModelRouteOverrides.parse({ overrides: [{ id: "x", action: "avoid", providers: [], models: [], until: now }] }),
    ).toEqual([])
    expect(
      ModelRouteOverrides.parse({ overrides: [{ id: "x", action: "nuke", providers: ["a"], until: now }] }),
    ).toEqual([])
  })

  test("an entry with a non-string in a scope list is dropped, never widened (#536)", () => {
    const base = { id: "x", action: "avoid", until: now + DAY }
    expect(
      ModelRouteOverrides.parse({ overrides: [{ ...base, providers: ["openai", 42], models: ["gpt-*"] }] }),
    ).toEqual([])
    expect(
      ModelRouteOverrides.parse({ overrides: [{ ...base, providers: ["openai"], models: ["gpt-*", null] }] }),
    ).toEqual([])
    expect(
      ModelRouteOverrides.parse({ overrides: [{ ...base, providers: ["openai"], routes: ["route-1", null] }] }),
    ).toEqual([])
    expect(
      ModelRouteOverrides.parse({ overrides: [{ ...base, providers: ["openai"], models: ["gpt-*"] }] }).map(
        (item) => item.id,
      ),
    ).toEqual(["x"])
  })
})

describe("ModelRouteOverrides storage", () => {
  test("a saved override is read back, and expired ones are dropped on save", () => {
    ModelRouteOverrides.save(
      [draft({ id: "live", providers: ["openai"] }), draft({ id: "old", providers: ["openai"], until: now - 1 })],
      now,
    )
    expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["live"])
  })

  test("a save leaves no temporary file behind and round-trips through current() (#924)", () => {
    ModelRouteOverrides.save([draft({ id: "a", providers: ["openai"] })], now)
    expect(fs.readdirSync(dir)).toEqual(["route-overrides.json"])
    if (process.platform !== "win32") expect(fs.statSync(ModelRouteOverrides.filePath()).mode & 0o777).toBe(0o600)
    expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["a"])
    ModelRouteOverrides.save([draft({ id: "b", providers: ["openai"] })], now)
    expect(fs.readdirSync(dir)).toEqual(["route-overrides.json"])
    expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["b"])
  })

  test("save replaces through a symlink and preserves the target mode", () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-overrides-target-"))
    const target = path.join(targetDir, "route-overrides.json")
    fs.writeFileSync(target, JSON.stringify({ version: 1, overrides: [] }, null, 2))
    fs.chmodSync(target, 0o640)
    fs.symlinkSync(target, ModelRouteOverrides.filePath())

    try {
      ModelRouteOverrides.save([draft({ id: "linked", providers: ["openai"] })], now)
      expect(fs.lstatSync(ModelRouteOverrides.filePath()).isSymbolicLink()).toBe(true)
      expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["linked"])
      if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o640)
      expect(fs.readdirSync(targetDir)).toEqual(["route-overrides.json"])
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true })
    }
  })

  test("save refuses a colliding exclusive temp without changing either file", () => {
    const file = ModelRouteOverrides.filePath()
    const temporary = path.join(dir, `.tmp-${process.pid}-616263646566`)
    fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: [] }, null, 2))
    fs.writeFileSync(temporary, "sentinel")
    const randomBytes = spyOn(crypto, "randomBytes").mockImplementation(() => Buffer.from("abcdef") as never)

    try {
      expect(() => ModelRouteOverrides.save([draft({ id: "a", providers: ["openai"] })], now)).toThrow()
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify({ version: 1, overrides: [] }, null, 2))
      expect(fs.readFileSync(temporary, "utf8")).toBe("sentinel")
    } finally {
      randomBytes.mockRestore()
    }
  })

  test("a save retries a transient rename failure and lands (#924)", () => {
    const rename = fs.renameSync
    let calls = 0
    const spy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      rename(source, destination)
    })
    try {
      ModelRouteOverrides.save([draft({ id: "a", providers: ["openai"] })], now)
      expect(calls).toBe(2)
      expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["a"])
      expect(fs.readdirSync(dir)).toEqual(["route-overrides.json"])
    } finally {
      spy.mockRestore()
    }
  })

  test("a save whose rename keeps failing throws, leaves no temporary file, and keeps the old store (#924)", () => {
    ModelRouteOverrides.save([draft({ id: "a", providers: ["openai"] })], now)
    let calls = 0
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    })
    try {
      expect(() => ModelRouteOverrides.save([draft({ id: "b", providers: ["openai"] })], now)).toThrow(
        "operation not permitted",
      )
      expect(calls).toBe(5)
      expect(fs.readdirSync(dir)).toEqual(["route-overrides.json"])
      expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["a"])
    } finally {
      spy.mockRestore()
    }
  })

  test("a missing or corrupt file means no overrides, never an error", () => {
    expect(ModelRouteOverrides.current()).toEqual([])
    fs.writeFileSync(ModelRouteOverrides.filePath(), "{ not json")
    expect(ModelRouteOverrides.current()).toEqual([])
  })

  test("the file is separate from the config and holds only overrides", () => {
    ModelRouteOverrides.add(draft({ id: "a", providers: ["openai"] }), now)
    const stored = JSON.parse(fs.readFileSync(ModelRouteOverrides.filePath(), "utf8"))
    expect(stored.version).toBe(1)
    expect(stored.overrides.map((item: { id: string }) => item.id)).toEqual(["a"])
    ModelRouteOverrides.remove("a", now)
    expect(ModelRouteOverrides.current()).toEqual([])
  })
})

describe("user overrides in routing", () => {
  test("avoid takes a target out of rotation until it expires", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"] }), now)
    expect(ModelRoute.userSkipped(openai, now)).toBe(true)
    expect(ModelRoute.userSkipped(anthropic, now)).toBe(false)
    expect(ModelRoute.userSkipped(openai, now + DAY + 1)).toBe(false)
  })

  test("prefer raises a target's weight", () => {
    expect(ModelRoute.weightFactor(anthropic, now)).toBe(1)
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"] }), now)
    expect(ModelRoute.weightFactor(anthropic, now)).toBe(3)
  })

  test("allow-over-budget lets a target run past its soft budget", () => {
    const budget = { requestsPerDay: 1 }
    ModelRoute.recordUsage(anthropic, 0, now)
    ModelRoute.recordUsage(anthropic, 0, now)
    expect(ModelRoute.overBudget(anthropic, budget, now)).toBe(true)
    ModelRouteOverrides.add(draft({ action: "allow-over-budget", providers: ["anthropic"] }), now)
    expect(ModelRoute.overBudget(anthropic, budget, now)).toBe(false)
  })
})

describe("priority, lighter, and the fixed-route facet", () => {
  const sonnet = ModelRoute.ref({ providerID: "anthropic", model: "claude-sonnet-4" })
  const fixedScope = { routeID: "r", fixed: true }
  const rulesScope = { routeID: "r", fixed: false }

  test("an avoid reaches fixed routes by default", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"] }), now)
    expect(ModelRoute.userSkipped(openai, now, fixedScope)).toBe(true)
    expect(ModelRoute.userSkipped(openai, now, rulesScope)).toBe(true)
  })

  test("an override marked not-fixed stops short of fixed routes", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"], fixed: false }), now)
    expect(ModelRoute.userSkipped(openai, now, fixedScope)).toBe(false)
    expect(ModelRoute.userSkipped(openai, now, rulesScope)).toBe(true)
  })

  test("an override limited to one route does not touch another", () => {
    ModelRouteOverrides.add(draft({ providers: ["openai"], routes: ["other"] }), now)
    expect(ModelRoute.userSkipped(openai, now, { routeID: "r", fixed: true })).toBe(false)
    expect(ModelRoute.userSkipped(openai, now, { routeID: "other", fixed: true })).toBe(true)
  })

  test("prefer reorders a fixed route's order and raises a target's weight", () => {
    ModelRoute.resetHealth()
    const targets = [openai, sonnet]
    const definition = {
      id: "r",
      targets,
      targetVariants: [],
      health: ModelRoute.policy(),
      autonomy: "fixed",
      nodes: [{ selection: "ordered" as const, weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    } as unknown as ModelRoute.Definition
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), undefined, false)).toEqual([0, 1])
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"] }), now)
    expect(ModelRoute.orderTargets(definition, new Set([0, 1]), undefined, false)).toEqual([1, 0])
  })

  test("a lighter preference moves a target down and carries its own factor", () => {
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"], factor: 1 / 3 }), now)
    expect(ModelRoute.weightFactor(sonnet, now, rulesScope)).toBeCloseTo(1 / 3)
  })

  test("learned weights do not reorder a fixed route, but do on a route that lets the tuner decide", () => {
    ModelRoute.resetHealth()
    ModelRoute.setAdjustments([
      { id: "auto:w", match: "anthropic/claude-sonnet-4", action: "weight", factor: 5, until: now + DAY },
    ])
    expect(ModelRoute.weightFactor(sonnet, now, fixedScope)).toBe(1)
    expect(ModelRoute.weightFactor(sonnet, now, rulesScope)).toBe(5)
    ModelRoute.setAdjustments([])
  })
})

describe("scheduled and absolute priorities", () => {
  const sonnet = ModelRoute.ref({ providerID: "anthropic", model: "claude-sonnet-4" })
  const day = 86_400_000
  const today = { daysOfWeek: [new Date(now).getUTCDay()], timezone: "UTC" }

  test("an override with a recurring window needs no end date and is kept on save", () => {
    ModelRouteOverrides.save(
      [
        draft({
          id: "recurring",
          action: "prefer",
          providers: ["anthropic"],
          factor: 0.8,
          schedule: today,
          until: undefined,
        }),
        draft({ id: "expired", providers: ["openai"], until: now - 1 }),
      ],
      now,
    )
    const stored = ModelRouteOverrides.current()
    expect(stored.map((item) => item.id)).toEqual(["recurring"])
    expect(stored[0].schedule).toEqual(today)
    expect(stored[0].until).toBeUndefined()
  })

  test("an expired override is dropped on save even when it has a schedule (#535)", () => {
    ModelRouteOverrides.save(
      [
        draft({ id: "exp-sched", providers: ["openai"], schedule: today, until: now - 1 }),
        draft({ id: "live-sched", providers: ["openai"], schedule: today, until: now + DAY }),
        draft({ id: "recurring", providers: ["openai"], schedule: today, until: undefined }),
      ],
      now,
    )
    expect(ModelRouteOverrides.current().map((item) => item.id)).toEqual(["live-sched", "recurring"])
  })

  test("a recurring override applies only inside its window", () => {
    ModelRouteOverrides.add(
      draft({ id: "peak", action: "prefer", providers: ["anthropic"], factor: 0.5, schedule: today, until: undefined }),
      now,
    )
    expect(ModelRoute.weightFactor(sonnet, now)).toBeCloseTo(0.5)
    expect(ModelRouteOverrides.applies(ModelRouteOverrides.current()[0], sonnet, now + day)).toBe(false)
  })

  test("a static weight replaces the configured one, a factor scales it", () => {
    ModelRouteOverrides.add(
      draft({
        id: "factor",
        action: "prefer",
        providers: ["anthropic"],
        factor: 0.8,
        schedule: today,
        until: undefined,
      }),
      now,
    )
    expect(ModelRoute.weightOf(sonnet, 2, now)).toBeCloseTo(1.6)
    ModelRouteOverrides.remove("factor", now)
    ModelRouteOverrides.add(
      draft({
        id: "static",
        action: "prefer",
        providers: ["anthropic"],
        weight: 0.25,
        schedule: today,
        until: undefined,
      }),
      now,
    )
    expect(ModelRoute.weightOf(sonnet, 2, now)).toBeCloseTo(0.25)
  })

  test("an unwindowed override still applies until it expires", () => {
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"], factor: 0.2 }), now)
    expect(ModelRoute.weightFactor(sonnet, now)).toBeCloseTo(0.2)
    expect(ModelRoute.weightFactor(sonnet, now + DAY + 1)).toBe(1)
  })

  test("malformed schedules are dropped rather than applied at the wrong time", () => {
    expect(
      ModelRouteOverrides.parse({
        overrides: [
          { id: "bad-zone", action: "prefer", providers: ["anthropic"], schedule: { timezone: "Mars/Olympus" } },
          { id: "bad-time", action: "prefer", providers: ["anthropic"], schedule: { start: "25:00" } },
          { id: "no-end", action: "prefer", providers: ["anthropic"] },
        ],
      }),
    ).toEqual([])
  })

  test("a malformed schedule drops the entry even when it has a valid until (#570)", () => {
    const parsed = ModelRouteOverrides.parse({
      overrides: [
        {
          id: "bad-window",
          action: "avoid",
          providers: ["openai"],
          until: now + DAY,
          schedule: { start: "25:00", end: "17:00" },
        },
        {
          id: "bad-zone-until",
          action: "avoid",
          providers: ["openai"],
          until: now + DAY,
          schedule: { timezone: "Not/AZone" },
        },
        { id: "unwindowed", action: "avoid", providers: ["openai"], until: now + DAY },
        {
          id: "windowed",
          action: "avoid",
          providers: ["openai"],
          until: now + DAY,
          schedule: { from: now + DAY, until: now + 2 * DAY },
        },
      ],
    })
    expect(parsed.map((item) => item.id)).toEqual(["unwindowed", "windowed"])
    const windowed = parsed.find((item) => item.id === "windowed")!
    expect(windowed.schedule).toEqual({ from: now + DAY, until: now + 2 * DAY })
    // The kept windowed entry does not apply outside its window.
    expect(ModelRouteOverrides.applies(windowed, ModelRoute.ref({ providerID: "openai", model: "gpt-5" }), now)).toBe(
      false,
    )
  })

  test("a malformed until drops the entry even when it has a schedule (#669)", () => {
    const parsed = ModelRouteOverrides.parse({
      overrides: [
        { id: "string-until", action: "avoid", providers: ["openai"], until: "tomorrow", schedule: today },
        { id: "null-until", action: "avoid", providers: ["openai"], until: null, schedule: today },
        { id: "nan-until", action: "avoid", providers: ["openai"], until: Number.NaN, schedule: today },
        {
          id: "infinite-until",
          action: "avoid",
          providers: ["openai"],
          until: Number.POSITIVE_INFINITY,
          schedule: today,
        },
        { id: "string-until-nosched", action: "avoid", providers: ["openai"], until: "tomorrow" },
        { id: "valid-until", action: "avoid", providers: ["openai"], until: now + DAY, schedule: today },
        { id: "recurring", action: "avoid", providers: ["openai"], schedule: today },
      ],
    })
    expect(parsed.map((item) => item.id)).toEqual(["valid-until", "recurring"])
    expect(parsed.find((item) => item.id === "valid-until")?.until).toBe(now + DAY)
    expect(parsed.find((item) => item.id === "recurring")?.until).toBeUndefined()
  })

  test("a present-but-invalid factor or weight drops the entry, never the default lift (#662)", () => {
    const base = { action: "prefer", providers: ["anthropic"], until: now + DAY }
    const parsed = ModelRouteOverrides.parse({
      overrides: [
        { ...base, id: "factor-zero", factor: 0 },
        { ...base, id: "factor-negative", factor: -1 },
        { ...base, id: "factor-infinite", factor: Infinity },
        { ...base, id: "weight-zero", weight: 0 },
        { ...base, id: "weight-negative", weight: -0.5 },
        { ...base, id: "factor-valid", factor: 0.5 },
        { ...base, id: "weight-valid", weight: 0.25 },
        { ...base, id: "absent" },
      ],
    })
    expect(parsed.map((item) => item.id)).toEqual(["factor-valid", "weight-valid", "absent"])
    expect(parsed.find((item) => item.id === "factor-valid")?.factor).toBe(0.5)
    expect(parsed.find((item) => item.id === "weight-valid")?.weight).toBe(0.25)
  })

  test("an invalid factor or weight does not drop a non-prefer entry (#662)", () => {
    const parsed = ModelRouteOverrides.parse({
      overrides: [
        { action: "avoid", id: "avoid-zero", providers: ["anthropic"], until: now + DAY, factor: 0 },
        {
          action: "allow-over-budget",
          id: "budget-zero",
          providers: ["anthropic"],
          until: now + DAY,
          weight: 0,
        },
      ],
    })
    expect(parsed.map((item) => item.id)).toEqual(["avoid-zero", "budget-zero"])
    expect(parsed.find((item) => item.id === "avoid-zero")?.factor).toBeUndefined()
  })

  test("a prefer override with factor: 0 or weight: 0 does not lift the target (#662)", () => {
    ModelRouteOverrides.add(draft({ id: "zero-factor", action: "prefer", providers: ["anthropic"], factor: 0 }), now)
    expect(ModelRoute.weightFactor(anthropic, now)).toBe(1)
    ModelRouteOverrides.remove("zero-factor", now)
    ModelRouteOverrides.add(draft({ id: "zero-weight", action: "prefer", providers: ["anthropic"], weight: 0 }), now)
    expect(ModelRoute.weightFactor(anthropic, now)).toBe(1)
  })
})

describe("traced weights (#589)", () => {
  const sonnet = ModelRoute.ref({ providerID: "anthropic", model: "claude-sonnet-4" })
  const rulesScope = { routeID: "r", fixed: false }

  test("a scheduled rule in force shows up in the scheduled layer only", () => {
    const scope = {
      ...rulesScope,
      schedules: [{ match: { targets: ["anthropic/claude-sonnet-4"] }, factor: 2 }],
    } as ModelRoute.WeightScope
    const trace = ModelRoute.tracedWeightOf(sonnet, 3, now, scope)
    expect(trace).toEqual({ base: 3, scheduled: 6, prefer: 6, adjustment: 6, demotion: 6, gate: null })
    expect(trace.demotion).toBe(ModelRoute.weightOf(sonnet, 3, now, scope))
  })

  test("a prefer override shows up in the prefer layer only", () => {
    ModelRouteOverrides.add(draft({ action: "prefer", providers: ["anthropic"], factor: 0.5 }), now)
    const trace = ModelRoute.tracedWeightOf(sonnet, 3, now, rulesScope)
    expect(trace).toEqual({ base: 3, scheduled: 3, prefer: 1.5, adjustment: 1.5, demotion: 1.5, gate: null })
    expect(trace.demotion).toBe(ModelRoute.weightOf(sonnet, 3, now, rulesScope))
  })

  test("an adjustment shows up in the adjustment layer, and not on a fixed route", () => {
    ModelRoute.setAdjustments([
      { id: "tuned", match: "anthropic/claude-sonnet-4", action: "weight", factor: 5, until: now + DAY },
    ])
    const trace = ModelRoute.tracedWeightOf(sonnet, 2, now, rulesScope)
    expect(trace).toEqual({ base: 2, scheduled: 2, prefer: 2, adjustment: 10, demotion: 10, gate: null })
    expect(trace.demotion).toBe(ModelRoute.weightOf(sonnet, 2, now, rulesScope))
    const fixed = ModelRoute.tracedWeightOf(sonnet, 2, now, { routeID: "r", fixed: true })
    expect(fixed.adjustment).toBe(2)
    expect(fixed.demotion).toBe(ModelRoute.weightOf(sonnet, 2, now, { routeID: "r", fixed: true }))
    ModelRoute.setAdjustments([])
  })

  test("a demoted target shows the demotion factor in the final layer only", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60_000, quotaCooldownMs: 900_000 })
    ModelRoute.failed(sonnet, policy, now, { quota: true })
    ModelRoute.failed(sonnet, policy, now + 1, { quota: true })
    ModelRoute.failed(sonnet, policy, now + 2, { quota: true })
    const trace = ModelRoute.tracedWeightOf(sonnet, 4, now + 3, rulesScope)
    expect(trace).toEqual({ base: 4, scheduled: 4, prefer: 4, adjustment: 4, demotion: 0.04, gate: null })
    expect(trace.demotion).toBe(ModelRoute.weightOf(sonnet, 4, now + 3, rulesScope))
  })
})
