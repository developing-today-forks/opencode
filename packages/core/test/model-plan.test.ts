import { describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelPlan } from "@opencode/core/model-plan"

const NOW = "2026-10-14T09:00:00.000Z"
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "model-plan-"))

describe("ModelPlan store", () => {
  test("a missing store reads as empty, and a write leaves no temporary file behind", () => {
    const root = dir()
    expect(ModelPlan.readStore(root)).toEqual(ModelPlan.emptyStore())
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      {
        providerID: "anthropic",
        plan: "Max 20x",
        label: "Personal",
        quotas: [{ name: "5-hour", unit: "messages", windowHours: 5, resetRule: "rolling" }],
      },
      NOW,
    )
    ModelPlan.writeStore(store, root)
    expect(fs.readdirSync(root)).toEqual(["plans.json"])
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, "plans.json")).mode & 0o777).toBe(0o600)
    expect(ModelPlan.readStore(root).plans).toHaveLength(1)
  })

  test("writeStore replaces through a symlink and preserves the target mode", () => {
    const root = dir()
    const linked = dir()
    const target = path.join(root, "plans.json")
    fs.writeFileSync(target, JSON.stringify(ModelPlan.emptyStore()))
    fs.chmodSync(target, 0o640)
    fs.symlinkSync(target, path.join(linked, "plans.json"))

    ModelPlan.writeStore(ModelPlan.emptyStore(), linked)

    expect(fs.lstatSync(path.join(linked, "plans.json")).isSymbolicLink()).toBe(true)
    expect(ModelPlan.readStore(root)).toEqual(ModelPlan.emptyStore())
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(root)).toEqual(["plans.json"])
  })

  test("writeStore refuses a colliding exclusive temp without changing either file", () => {
    const root = dir()
    const target = path.join(root, "plans.json")
    const temporary = path.join(root, `.tmp-${process.pid}-616263646566`)
    fs.writeFileSync(target, JSON.stringify(ModelPlan.emptyStore()))
    fs.writeFileSync(temporary, "sentinel")
    const randomBytes = spyOn(crypto, "randomBytes").mockReturnValue(Buffer.from("abcdef"))

    try {
      expect(() => ModelPlan.writeStore(ModelPlan.emptyStore(), root)).toThrow()
      expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(ModelPlan.emptyStore()))
      expect(fs.readFileSync(temporary, "utf8")).toBe("sentinel")
    } finally {
      randomBytes.mockRestore()
    }
  })

  test("a write retries a transient rename failure and lands", () => {
    const root = dir()
    const rename = fs.renameSync
    let calls = 0
    const spy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      rename(source, destination)
    })
    try {
      ModelPlan.writeStore(ModelPlan.emptyStore(), root)
      expect(calls).toBe(2)
      expect(ModelPlan.readStore(root)).toEqual(ModelPlan.emptyStore())
      expect(fs.readdirSync(root)).toEqual(["plans.json"])
    } finally {
      spy.mockRestore()
    }
  })

  test("a write whose rename keeps failing transiently throws and leaves no temporary file", () => {
    const root = dir()
    const file = path.join(root, "plans.json")
    const before = JSON.stringify(ModelPlan.emptyStore())
    fs.writeFileSync(file, before)
    let calls = 0
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    })
    try {
      expect(() => ModelPlan.writeStore(ModelPlan.emptyStore(), root)).toThrow("operation not permitted")
      expect(calls).toBe(5)
      expect(fs.readFileSync(file, "utf8")).toBe(before)
      expect(fs.readdirSync(root)).toEqual(["plans.json"])
    } finally {
      spy.mockRestore()
    }
  })

  test("upsert creates a plan with an id from its provider and name, then updates that same record", () => {
    const first = ModelPlan.upsertPlan(ModelPlan.emptyStore(), { providerID: "anthropic", plan: "Max 20x" }, NOW)
    expect(first.plan.id).toBe("anthropic-max-20x")
    expect(first.plan).toMatchObject({ status: "active", coverage: "subscription", quotas: [], createdAt: NOW })
    const second = ModelPlan.upsertPlan(
      first.store,
      {
        id: "anthropic-max-20x",
        fee: { amount: 200, currency: "USD", period: "monthly" },
        verifiedAt: "2026-10-14",
      },
      "2026-10-15T00:00:00.000Z",
    )
    expect(second.store.plans).toHaveLength(1)
    expect(second.plan).toMatchObject({
      plan: "Max 20x",
      fee: { amount: 200, currency: "USD", period: "monthly" },
      verifiedAt: "2026-10-14",
      createdAt: NOW,
      updatedAt: "2026-10-15T00:00:00.000Z",
    })
  })

  test("a null clears a field and an omitted field is kept", () => {
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      { providerID: "openai", plan: "Plus", expiresOn: "2026-12-01" },
      NOW,
    )
    const next = ModelPlan.upsertPlan(store, { id: "openai-plus", expiresOn: null }, NOW)
    expect(next.plan.plan).toBe("Plus")
    expect(next.plan.expiresOn).toBeUndefined()
  })

  test("a plan needs a provider, and a malformed store is an error rather than an empty one", () => {
    expect(() => ModelPlan.upsertPlan(ModelPlan.emptyStore(), { label: "no provider" }, NOW)).toThrow("providerID")
    const root = dir()
    fs.writeFileSync(path.join(root, "plans.json"), "{ not json")
    expect(() => ModelPlan.readStore(root)).toThrow("not valid JSON")
    fs.writeFileSync(path.join(root, "plans.json"), JSON.stringify({ version: 2, plans: [] }))
    expect(() => ModelPlan.readStore(root)).toThrow()
  })

  test("a model needs a tier when it is first set; a pool takes a purpose and a tier", () => {
    expect(() => ModelPlan.setModel(ModelPlan.emptyStore(), "openai/gpt-6-astra", {}, NOW)).toThrow("needs a tier")
    const store = ModelPlan.setModel(
      ModelPlan.emptyStore(),
      "openai/gpt-6-astra",
      { tier: "frontier", coveredBy: ["openai-plus"] },
      NOW,
    )
    expect(store.models["openai/gpt-6-astra"]).toMatchObject({ tier: "frontier", coveredBy: ["openai-plus"] })
    const moved = ModelPlan.setModel(store, "openai/gpt-6-astra", { tier: "cheap" }, NOW)
    expect(moved.models["openai/gpt-6-astra"]).toMatchObject({ tier: "cheap", coveredBy: ["openai-plus"] })
    const pooled = ModelPlan.setPool(
      moved,
      "hard",
      { tier: "frontier", purpose: "debugging with an unknown cause" },
      NOW,
    )
    expect(pooled.pools.hard).toMatchObject({ tier: "frontier", purpose: "debugging with an unknown cause" })
  })

  test("a pool or model named for an inherited key starts from an empty entry, not the prototype", () => {
    const pooled = ModelPlan.setPool(ModelPlan.emptyStore(), "constructor", { purpose: "shadowed pool id" }, NOW)
    expect(Object.hasOwn(pooled.pools, "constructor")).toBe(true)
    expect(pooled.pools["constructor"]).toMatchObject({ purpose: "shadowed pool id", updatedAt: NOW })
    expect(typeof pooled.pools["constructor"]).toBe("object")

    const again = ModelPlan.setPool(pooled, "constructor", { tier: "cheap" }, NOW)
    expect(again.pools["constructor"]).toMatchObject({ purpose: "shadowed pool id", tier: "cheap" })

    expect(() => ModelPlan.setModel(ModelPlan.emptyStore(), "toString", {}, NOW)).toThrow("needs a tier")
    const modeled = ModelPlan.setModel(ModelPlan.emptyStore(), "toString", { tier: "cheap" }, NOW)
    expect(Object.hasOwn(modeled.models, "toString")).toBe(true)
    expect(modeled.models["toString"]).toMatchObject({ tier: "cheap" })
  })

  test("an inherited value is never merged into a pool or model being set", () => {
    const empty = ModelPlan.emptyStore()
    const pools = Object.assign(Object.create({ constructor: { purpose: "inherited", updatedAt: NOW } }), empty.pools)
    const models = Object.assign(Object.create({ toString: { tier: "frontier", updatedAt: NOW } }), empty.models)

    const pooled = ModelPlan.setPool({ ...empty, pools }, "constructor", { tier: "cheap" }, NOW)
    expect(pooled.pools["constructor"]).toMatchObject({ tier: "cheap", updatedAt: NOW })
    expect(pooled.pools["constructor"].purpose).toBeUndefined()

    expect(() => ModelPlan.setModel({ ...empty, models }, "toString", {}, NOW)).toThrow("needs a tier")
    const modeled = ModelPlan.setModel({ ...empty, models }, "toString", { tier: "cheap" }, NOW)
    expect(modeled.models["toString"]).toMatchObject({ tier: "cheap", updatedAt: NOW })
  })

  test("slug never ends in a dash, including when the 64-char slice cuts after a separator", () => {
    expect(ModelPlan.slug("a".repeat(63) + " b c")).toBe("a".repeat(63))
    expect(ModelPlan.slug("a".repeat(64))).toBe("a".repeat(64))
    expect(ModelPlan.slug("Claude Max 20x")).toBe("claude-max-20x")
    expect(ModelPlan.slug("--weird--name--")).toBe("weird-name")
  })

  test("notes are appended, filtered and kept in order, and a damaged line is skipped and counted", () => {
    const root = dir()
    ModelPlan.addNote(
      { text: "ran out of claude too fast", kind: "experience", providerID: "anthropic" },
      "2026-10-10T10:00:00.000Z",
      root,
    )
    ModelPlan.addNote(
      { text: "I always have GPT left at month end", kind: "expectation", providerID: "openai" },
      "2026-10-11T10:00:00.000Z",
      root,
    )
    fs.appendFileSync(path.join(root, "plan-notes.jsonl"), "not a note\n")
    const all = ModelPlan.readNotes({}, root)
    expect(all.notes.map((note) => note.text)).toEqual([
      "ran out of claude too fast",
      "I always have GPT left at month end",
    ])
    expect(all.skipped).toBe(1)
    expect(ModelPlan.readNotes({ providerID: "anthropic" }, root).notes).toHaveLength(1)
    expect(ModelPlan.readNotes({ since: "2026-10-11T00:00:00.000Z" }, root).notes.map((note) => note.kind)).toEqual([
      "expectation",
    ])
    expect(ModelPlan.readNotes({ limit: 1 }, root).notes[0]?.kind).toBe("expectation")
    expect(ModelPlan.readNotes({ limit: 0 }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: -1 }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: Number.NaN }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: Number.POSITIVE_INFINITY }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: 0.5 }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: 2.5 }, root).notes).toHaveLength(2)
    expect(ModelPlan.readNotes({ limit: 1.5 }, root).notes).toHaveLength(1)
    expect(ModelPlan.readNotes({ limit: 0 }, root).skipped).toBe(1)
  })

  test("staleness counts whole days without going negative, and a blank note is refused", () => {
    const now = Date.parse(NOW)
    expect(ModelPlan.daysSince("2026-10-04", now)).toBe(10)
    expect(ModelPlan.daysSince(new Date(now - 60 * 60 * 1000).toISOString(), now)).toBe(0)
    expect(ModelPlan.daysSince(new Date(now - 25 * 60 * 60 * 1000).toISOString(), now)).toBe(1)
    expect(ModelPlan.daysSince(new Date(now + 60 * 60 * 1000).toISOString(), now)).toBe(0)
    expect(ModelPlan.daysSince(new Date(now + 10 * 86_400_000).toISOString(), now)).toBe(0)
    expect(ModelPlan.daysSince(undefined, now)).toBeNull()
    expect(ModelPlan.daysSince("not a date", now)).toBeNull()
    expect(() => ModelPlan.addNote({ text: "   " }, NOW, dir())).toThrow("some text")
  })

  test("notes sort chronologically across timestamp formats and limits keep the newest", () => {
    const root = dir()
    ModelPlan.addNote({ text: "half second later" }, "2026-10-27T09:00:00.500Z", root)
    ModelPlan.addNote({ text: "same time without milliseconds" }, "2026-10-27T09:00:00Z", root)
    ModelPlan.addNote({ text: "offset, but earliest" }, "2026-10-27T10:30:00+02:00", root)

    expect(ModelPlan.readNotes({}, root).notes.map((note) => note.text)).toEqual([
      "offset, but earliest",
      "same time without milliseconds",
      "half second later",
    ])
    expect(ModelPlan.readNotes({ limit: 1 }, root).notes.map((note) => note.text)).toEqual(["half second later"])
    expect(ModelPlan.readNotes({ limit: 2 }, root).notes.map((note) => note.text)).toEqual([
      "same time without milliseconds",
      "half second later",
    ])
  })

  test("unparseable timestamps sort before parsed dates and equal instants stay stable", () => {
    const root = dir()
    ModelPlan.addNote({ text: "unparseable" }, "not-a-date", root)
    ModelPlan.addNote({ text: "equal instant first" }, "2026-10-27T09:00:00Z", root)
    ModelPlan.addNote({ text: "equal instant second" }, "2026-10-27T11:00:00+02:00", root)
    ModelPlan.addNote({ text: "later" }, "2026-10-27T09:00:01Z", root)

    expect(ModelPlan.readNotes({}, root).notes.map((note) => note.text)).toEqual([
      "unparseable",
      "equal instant first",
      "equal instant second",
      "later",
    ])
    expect(ModelPlan.readNotes({ limit: 1 }, root).notes.map((note) => note.text)).toEqual(["later"])
  })

  test("an unparseable since throws instead of silently returning no notes", () => {
    const root = dir()
    ModelPlan.addNote({ text: "a note" }, "2026-10-27T09:00:00Z", root)
    expect(() => ModelPlan.readNotes({ since: "not-a-date" }, root)).toThrow("not-a-date")
    expect(ModelPlan.readNotes({ since: "2026-12-01T00:00:00.000Z" }, root)).toEqual({ notes: [], skipped: 0 })
  })

  test("a note whose timestamp does not parse is counted skipped under a since filter", () => {
    const root = dir()
    ModelPlan.addNote({ text: "bad timestamp" }, "not-a-date", root)
    ModelPlan.addNote({ text: "good timestamp" }, "2026-10-27T09:00:00Z", root)
    const filtered = ModelPlan.readNotes({ since: "2026-01-01T00:00:00.000Z" }, root)
    expect(filtered.notes.map((note) => note.text)).toEqual(["good timestamp"])
    expect(filtered.skipped).toBe(1)
    const unfiltered = ModelPlan.readNotes({}, root)
    expect(unfiltered.notes.map((note) => note.text)).toEqual(["bad timestamp", "good timestamp"])
    expect(unfiltered.skipped).toBe(0)
  })


  test("calendar-invalid dates are not silently rolled into the next month (#717)", () => {
    const root = dir()
    const now = Date.parse(NOW)
    // A bare Date.parse rolls 2026-02-30 to Mar 2; every ModelPlan date site must
    // treat it like an unparseable date instead of trusting the rolled instant.
    expect(() => ModelPlan.readNotes({ since: "2026-02-30" }, root)).toThrow("2026-02-30")
    expect(ModelPlan.daysSince("2026-02-30", now)).toBeNull()
    expect(ModelPlan.daysSince("2026-02-30T00:00:00.000Z", now)).toBeNull()
    // A note timestamped with a calendar-invalid date behaves like an unparseable
    // one: counted skipped under a since filter, sorted first without one.
    ModelPlan.addNote({ text: "rolled timestamp" }, "2026-02-30T00:00:00.000Z", root)
    ModelPlan.addNote({ text: "good timestamp" }, "2026-10-27T09:00:00Z", root)
    const filtered = ModelPlan.readNotes({ since: "2026-01-01T00:00:00.000Z" }, root)
    expect(filtered.notes.map((note) => note.text)).toEqual(["good timestamp"])
    expect(filtered.skipped).toBe(1)
    expect(ModelPlan.readNotes({}, root).notes.map((note) => note.text)).toEqual([
      "rolled timestamp",
      "good timestamp",
    ])
    // addNote must not embed the rolled instant (Mar 2) in the note id.
    const rolled = ModelPlan.addNote({ text: "bad date note" }, "2026-02-30T00:00:00.000Z", root)
    expect(rolled.id).not.toContain(Date.parse("2026-02-30T00:00:00.000Z").toString(36))
    // Valid dates keep working through the same paths.
    expect(ModelPlan.daysSince("2026-02-28", now)).not.toBeNull()
    expect(ModelPlan.readNotes({ since: "2026-02-28T00:00:00.000Z" }, root).notes.map((note) => note.text)).toEqual([
      "good timestamp",
    ])
  })

  test("guidance points OpenCode's own plans at the console and leaves other providers without it", () => {
    expect(ModelPlan.guidance("opencode-go").join(" ")).toContain("opencode.ai/console")
    expect(ModelPlan.guidance("anthropic").join(" ")).not.toContain("opencode.ai/console")
  })
})
