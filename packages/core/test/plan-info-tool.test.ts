import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PlanInfoTool } from "@opencode/core/tool/plugin/plan-info"

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "plan-info-tool-"))
const now = () => new Date("2026-10-14T09:00:00.000Z")

describe("plan_info", () => {
  test("upsert records a plan; get returns it with guidance; list shows how old the check is", () => {
    const dataDir = dir()
    const saved = PlanInfoTool.apply(
      {
        action: "upsert",
        providerID: "anthropic",
        plan: "Max 20x",
        coverage: "subscription",
        fee: { amount: 200, currency: "USD", period: "monthly" },
        quotas: [{ name: "5-hour", unit: "messages", windowHours: 5, resetRule: "rolling" }],
        verifiedAt: "2026-10-01",
        verifiedFrom: "user",
        details: "bought in March",
      },
      { dataDir, now },
    )
    expect(saved.content).toContain("Saved plan anthropic-max")
    const got = PlanInfoTool.apply({ action: "get", providerID: "anthropic" }, { dataDir, now })
    expect(got.content).toContain("13 days ago")
    expect(got.content).toContain("Open the provider's billing or usage page")
    const listed = PlanInfoTool.apply({ action: "list" }, { dataDir, now })
    expect(listed.content).toContain("5-hour: limit unknown messages per 5h, resets rolling")
  })

  test("a note keeps the user's words and is recorded as coming from the model", () => {
    const dataDir = dir()
    const noted = PlanInfoTool.apply(
      { action: "note", text: "ran out of claude too fast", kind: "experience", providerID: "anthropic" },
      { dataDir, now },
    )
    expect(noted.content).toContain("(experience): ran out of claude too fast")
    expect((noted.output.result as { source: string }).source).toBe("model")
    const found = PlanInfoTool.apply({ action: "notes", providerID: "anthropic" }, { dataDir, now })
    expect(found.content).toContain("ran out of claude too fast")
  })

  test("a tier is recorded for a model, and a pool records its purpose", () => {
    const dataDir = dir()
    const tiered = PlanInfoTool.apply(
      { action: "tier", model: "openai/gpt-6-astra", tier: "frontier", coveredBy: ["openai-plus"] },
      { dataDir, now },
    )
    expect(tiered.content).toContain("Set openai/gpt-6-astra to the frontier tier")
    const pooled = PlanInfoTool.apply(
      { action: "pool", id: "hard", tier: "frontier", purpose: "debugging with an unknown cause" },
      { dataDir, now },
    )
    expect(pooled.content).toContain("Pool hard: frontier, debugging with an unknown cause")
    expect(PlanInfoTool.apply({ action: "list" }, { dataDir, now }).content).toContain("openai/gpt-6-astra: frontier")
  })

  test("non-positive quota window durations are rejected and never persisted; omitted and positive durations stay valid", () => {
    const dataDir = dir()
    for (const windowHours of [0, -1]) {
      expect(() =>
        PlanInfoTool.apply(
          {
            action: "upsert",
            providerID: "anthropic",
            plan: "Max 20x",
            coverage: "subscription",
            quotas: [{ name: "bad-window", unit: "messages", windowHours, resetRule: "rolling" }],
          },
          { dataDir, now },
        ),
      ).toThrow(/windowHours/)
    }
    expect(PlanInfoTool.apply({ action: "list" }, { dataDir, now }).content).toContain("No plans recorded yet.")
    const noWindow = PlanInfoTool.apply(
      {
        action: "upsert",
        providerID: "anthropic",
        plan: "Max 20x",
        coverage: "subscription",
        quotas: [{ name: "monthly", unit: "messages", resetRule: "monthly" }],
      },
      { dataDir, now },
    )
    expect(noWindow.content).toContain("Saved plan anthropic-max")
    const positive = PlanInfoTool.apply(
      {
        action: "upsert",
        providerID: "openai",
        plan: "Plus",
        coverage: "subscription",
        quotas: [{ name: "5-hour", unit: "messages", windowHours: 5, resetRule: "rolling" }],
      },
      { dataDir, now },
    )
    expect(positive.content).toContain("Saved plan openai-plus")
    expect(PlanInfoTool.apply({ action: "list" }, { dataDir, now }).content).toContain("per 5h")
  })

  test("one malformed entry degrades list per-entry, and writes refuse rather than dropping it (#2922)", () => {
    const dataDir = dir()
    const file = path.join(dataDir, "plans.json")
    const good = {
      id: "anthropic-max-20x",
      providerID: "anthropic",
      label: "Personal",
      coverage: "subscription",
      quotas: [],
      status: "active",
      createdAt: "2026-10-14T09:00:00.000Z",
      updatedAt: "2026-10-14T09:00:00.000Z",
    }
    const before = JSON.stringify(
      { version: 1, plans: [good, { ...good, id: "openai-plus", providerID: "openai", status: "bogus" }], models: {}, pools: {} },
      null,
      2,
    )
    fs.writeFileSync(file, before)
    const listed = PlanInfoTool.apply({ action: "list" }, { dataDir, now })
    expect(listed.content).toContain("anthropic-max-20x")
    expect(listed.content).toContain('1 unreadable store entries skipped: plan "openai-plus"')
    expect(() =>
      PlanInfoTool.apply({ action: "upsert", providerID: "openai", plan: "Plus" }, { dataDir, now }),
    ).toThrow('plan "openai-plus"')
    // The refused write left the file — including the bad entry — untouched.
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  test("a damaged plan file stops writes, with a message that says what to fix", () => {
    const dataDir = dir()
    fs.writeFileSync(path.join(dataDir, "plans.json"), "{")
    expect(() => PlanInfoTool.apply({ action: "list" }, { dataDir, now })).toThrow("not valid JSON")
  })

  test("a request missing what it needs is refused with the reason", () => {
    const dataDir = dir()
    expect(PlanInfoTool.apply({ action: "tier", tier: "frontier" }, { dataDir, now }).content).toContain("needs model")
    expect(PlanInfoTool.apply({ action: "note" }, { dataDir, now }).content).toContain("needs text")
  })
})
