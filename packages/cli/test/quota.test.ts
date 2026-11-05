import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readConfigFacts, quotaRunSucceeded, renderQuotaResults } from "../src/commands/handlers/quota"
import type { QuotaResult } from "@opencode/ai/quota"

const window = (usedPercent: number | null, valueLabel?: string) => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  ...(valueLabel ? { valueLabel } : {}),
})

const okResult: QuotaResult = {
  providerId: "mistral",
  providerName: "Mistral AI",
  ok: true,
  configured: true,
  fetchedAt: 0,
  usage: {
    windows: {
      api: window(4.66, "$0.70 / $15"),
      vibe: window(0.04, "$0.06 / $150"),
    },
  },
}

const errorResult: QuotaResult = {
  providerId: "meta",
  providerName: "Meta Model API",
  ok: false,
  configured: true,
  fetchedAt: 0,
  usage: null,
  error: "Subscription quota exhausted",
}

describe("quota exit-code behavior", () => {
  test("succeeds when every requested provider produced a successful result", () => {
    expect(quotaRunSucceeded([{ results: [okResult] }])).toBe(true)
    expect(quotaRunSucceeded([{ results: [errorResult, okResult] }])).toBe(true)
  })

  test("fails when a requested provider produced no successful result", () => {
    expect(quotaRunSucceeded([{ results: [okResult] }, { results: [errorResult] }])).toBe(false)
    expect(quotaRunSucceeded([{ results: [] }])).toBe(false)
  })
})

describe("quota human rendering", () => {
  test("renders one block per credential with windows and dollar labels", () => {
    const rendered = renderQuotaResults([okResult])
    expect(rendered).toContain("Mistral AI (mistral)")
    expect(rendered).toContain("api: 4.66% used ($0.70 / $15)")
    expect(rendered).toContain("vibe: 0.04% used ($0.06 / $150)")
  })

  test("renders an error block without inventing windows", () => {
    const rendered = renderQuotaResults([errorResult])
    expect(rendered).toContain("Meta Model API (meta): Subscription quota exhausted")
    expect(rendered).not.toContain("% used")
  })
})

describe("quota config facts discovery (#1733)", () => {
  const makeTree = () => {
    const root = mkdtempSync(join(tmpdir(), "quota-config-facts-"))
    const globalDir = join(root, "global")
    const systemDir = join(root, "system")
    const project = join(root, "project")
    const child = join(project, "packages", "app")
    for (const dir of [globalDir, systemDir, project, child]) mkdirSync(dir, { recursive: true })
    return { root, globalDir, systemDir, project, child }
  }

  test("a child directory sees disabled_providers and instances defined only in a parent directory", () => {
    const tree = makeTree()
    try {
      writeFileSync(
        join(tree.project, "opencode.json"),
        JSON.stringify({
          disabled_providers: ["parent-disabled"],
          provider: { myinstance: { instanceOf: "openai", name: "My Instance" } },
        }),
      )
      const facts = readConfigFacts(
        { config: tree.globalDir, data: tree.root, state: tree.root },
        { cwd: tree.child, systemDirectory: tree.systemDir, env: {} },
      )
      expect(facts.disabledProviders.has("parent-disabled")).toBe(true)
      expect(facts.instances.get("myinstance")).toEqual({ base: "openai", name: "My Instance" })
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  test("a disable that exists only in the system directory is reported", () => {
    const tree = makeTree()
    try {
      writeFileSync(
        join(tree.systemDir, "opencode.jsonc"),
        JSON.stringify({ disabled_providers: ["system-disabled"] }),
      )
      const facts = readConfigFacts(
        { config: tree.globalDir, data: tree.root, state: tree.root },
        { cwd: tree.child, systemDirectory: tree.systemDir, env: {} },
      )
      expect(facts.disabledProviders.has("system-disabled")).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  test("the invocation directory's own config is still read (root behavior unchanged)", () => {
    const tree = makeTree()
    try {
      writeFileSync(join(tree.child, "opencode.json"), JSON.stringify({ disabled_providers: ["local"] }))
      const facts = readConfigFacts(
        { config: tree.globalDir, data: tree.root, state: tree.root },
        { cwd: tree.child, systemDirectory: tree.systemDir, env: {} },
      )
      expect(facts.disabledProviders.has("local")).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })
})
