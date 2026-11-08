import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { QuotaCurrent } from "@opencode/core/quota-current"

const file = (providers: unknown) =>
  JSON.stringify({
    version: 1,
    generatedAt: "2026-11-08T05:15:16.875Z",
    source: "opencode-quota",
    providers,
  })

const entry = (over: Record<string, unknown> = {}) => ({
  providerId: "antigravity",
  providerName: "Antigravity",
  serviceId: "antigravity",
  state: "ok",
  measuredAt: "2026-11-08T05:15:18.632Z",
  source: "opencode-quota",
  windows: [
    {
      name: "weekly",
      value: 100,
      pctOfLimit: 100,
      valueLabel: null,
      windowSeconds: 604800,
      resetsAt: "2026-11-09T09:00:23.000Z",
      measuredAt: "2026-11-08T05:15:18.632Z",
      source: "opencode-quota",
      state: "ok",
    },
  ],
  usage: {
    windows: {},
    models: {
      "gemini-3.8-flash": {
        windows: {
          weekly: { usedPercent: 4, remainingPercent: 96, resetAt: 1794613422000 },
          "5h": { usedPercent: 1, remainingPercent: 99, resetAt: 1794132018000 },
        },
      },
    },
  },
  ...over,
})

describe("QuotaCurrent.parse", () => {
  test("reads provider windows and per-model windows in the gatherer's shape", () => {
    const readings = QuotaCurrent.parse(file([entry()]))
    expect(readings).toHaveLength(1)
    expect(readings[0]?.providerID).toBe("antigravity")
    expect(readings[0]?.windows).toEqual([
      { name: "weekly", usedPercent: 100, resetAt: Date.parse("2026-11-09T09:00:23.000Z"), measuredAt: Date.parse("2026-11-08T05:15:18.632Z") },
    ])
    expect(readings[0]?.models["gemini-3.8-flash"]).toEqual([
      { name: "weekly", usedPercent: 4, resetAt: 1794613422000, measuredAt: Date.parse("2026-11-08T05:15:18.632Z") },
      { name: "5h", usedPercent: 1, resetAt: 1794132018000, measuredAt: Date.parse("2026-11-08T05:15:18.632Z") },
    ])
  })

  test("an errored or unmeasured entry carries no reading", () => {
    expect(QuotaCurrent.parse(file([entry({ state: "error" })]))).toEqual([])
    expect(QuotaCurrent.parse(file([entry({ measuredAt: undefined })]))).toEqual([])
    expect(QuotaCurrent.parse(file([entry({ providerId: 42 })]))).toEqual([])
  })

  test("a missing or malformed file is no readings, never an error", () => {
    expect(QuotaCurrent.parse("not json")).toEqual([])
    expect(QuotaCurrent.parse("{}")).toEqual([])
    expect(QuotaCurrent.parse('{"providers": {}}')).toEqual([])
  })
})

describe("QuotaCurrent.readSnapshot", () => {
  test("reads the aggregator state directory beside the state root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-current-"))
    const state = path.join(root, "opencode")
    const aggregator = path.join(root, "pm-aggregator")
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(aggregator, { recursive: true })
    fs.writeFileSync(path.join(aggregator, "quota-current.json"), file([entry()]))
    const readings = QuotaCurrent.readSnapshot(state)
    expect(readings).toHaveLength(1)
    expect(readings[0]?.providerID).toBe("antigravity")
  })

  test("no snapshot anywhere is no readings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-current-"))
    const state = path.join(root, "opencode")
    fs.mkdirSync(state, { recursive: true })
    expect(QuotaCurrent.readSnapshot(state)).toEqual([])
  })
})
