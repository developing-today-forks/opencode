import { describe, expect, test } from "bun:test"
import { ModelPlan } from "@opencode/core/model-plan"
import { ModelUsage } from "@opencode/core/model-usage"

const totals = (overrides: Partial<ModelUsage.Totals> = {}): ModelUsage.Totals => ({
  requests: 1,
  failures: 0,
  input: 100,
  output: 50,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0.01,
  cacheSavedUsd: 0,
  ...overrides,
})

const attemptRow = (overrides: Partial<ModelUsage.TurnAttemptRow>): ModelUsage.TurnAttemptRow => ({
  id: 1,
  continuationOf: null,
  continuationIndex: 0,
  assistantMessageID: "msg_root",
  sessionID: "ses_turn",
  providerID: "openai",
  modelID: "gpt-6-luna",
  timeStarted: 1_000,
  timeEnded: 2_000,
  outcome: "success",
  input: 100,
  output: 50,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0.01,
  ...overrides,
})

describe("ModelUsage", () => {
  test("metered tokens are input, output and reasoning, with cache kept apart", () => {
    const row = totals({ input: 100, output: 50, reasoning: 10, cacheRead: 999, cacheWrite: 5 })
    expect(ModelUsage.metered(row)).toBe(160)
    expect(ModelUsage.usedOf("tokens", row)).toBe(160)
    expect(ModelUsage.usedOf("requests", row)).toBe(1)
    expect(ModelUsage.usedOf("messages", row)).toBe(1)
    expect(ModelUsage.usedOf("usd", row)).toBe(0.01)
    expect(ModelUsage.usedOf("percent", row)).toBeNull()
  })

  test("cache hit ratio is cache reads over all prompt tokens, null only when there were no prompt tokens", () => {
    expect(ModelUsage.cacheHitRatio(totals({ input: 100, cacheRead: 100, cacheWrite: 0 }))).toBe(0.5)
    expect(ModelUsage.cacheHitRatio(totals({ input: 60, cacheRead: 30, cacheWrite: 10 }))).toBe(0.3)
    // Zero-cache case: traffic with no cache reads is a real 0, not unknown.
    expect(ModelUsage.cacheHitRatio(totals({ input: 100, cacheRead: 0, cacheWrite: 0 }))).toBe(0)
    expect(ModelUsage.cacheHitRatio(totals({ input: 0, cacheRead: 0, cacheWrite: 0 }))).toBeNull()
  })

  test("sum and day reports aggregate cache savings alongside cost", () => {
    const total = ModelUsage.sum([
      totals({ cacheRead: 10, cacheSavedUsd: 0.25 }),
      totals({ cacheRead: 5, cacheSavedUsd: 0.5 }),
    ])
    expect(total.cacheRead).toBe(15)
    expect(total.cacheSavedUsd).toBeCloseTo(0.75)
    const days = ModelUsage.dayReports([
      { day: "2026-10-13", providerID: "openai", modelID: "a", ...totals({ cacheRead: 40, cacheSavedUsd: 0.4 }) },
      { day: "2026-10-13", providerID: "openai", modelID: "b", ...totals({ cacheRead: 10, cacheSavedUsd: 0.1 }) },
    ])
    expect(days[0]).toMatchObject({ cacheRead: 50, cacheSavedUsd: 0.5 })
    expect(days[0]?.providers["openai"]).toMatchObject({ cacheRead: 50, cacheSavedUsd: 0.5 })
  })

  test("percent needs a positive limit", () => {
    expect(ModelUsage.percentOf(25, 100)).toBe(25)
    expect(ModelUsage.percentOf(1, 3)).toBe(33.3)
    expect(ModelUsage.percentOf(25, undefined)).toBeNull()
    expect(ModelUsage.percentOf(25, 0)).toBeNull()
  })

  test("target reports list every configured target, used or not, with the state of each pool it sits in", () => {
    const configured = new Map([
      ["cheap", ["openai/gpt-6-luna", "azure/gpt-6-luna", "zai/glm-5"]],
      ["hard", ["openai/gpt-6-luna"]],
    ])
    const offers = [
      { routeID: "cheap", target: "openai/gpt-6-luna", offered: 10, chosen: 7 },
      { routeID: "cheap", target: "azure/gpt-6-luna", offered: 10, chosen: 0 },
      { routeID: "hard", target: "openai/gpt-6-luna", offered: 0, chosen: 0 },
    ]
    const rows = [
      { providerID: "openai", modelID: "gpt-6-luna", sessions: 3, first: 1, last: 2, ...totals({ requests: 9 }) },
    ]
    const reports = ModelUsage.targetReports(
      rows,
      ["openai/gpt-6-luna", "azure/gpt-6-luna", "zai/glm-5"],
      offers,
      configured,
    )
    const openai = reports.find((report) => report.target === "openai/gpt-6-luna")
    expect(openai).toMatchObject({ requests: 9, sessions: 3, providerID: "openai", modelID: "gpt-6-luna" })
    expect(openai?.pools).toEqual([
      { routeID: "cheap", state: "used", offered: 10, chosen: 7 },
      { routeID: "hard", state: "configured-not-reached", offered: 0, chosen: 0 },
    ])
    expect(reports.find((report) => report.target === "azure/gpt-6-luna")?.pools).toEqual([
      { routeID: "cheap", state: "offered-not-chosen", offered: 10, chosen: 0 },
    ])
    expect(reports.find((report) => report.target === "zai/glm-5")).toMatchObject({
      requests: 0,
      providerID: "zai",
      modelID: "glm-5",
      pools: [{ routeID: "cheap", state: "configured-not-reached", offered: 0, chosen: 0 }],
    })
  })

  test("slash-less targets split as model with an empty provider, never a mangled provider", () => {
    expect(ModelUsage.splitTarget("openai/gpt-6-luna")).toEqual({ providerID: "openai", modelID: "gpt-6-luna" })
    // First slash wins: model ids may contain further slashes.
    expect(ModelUsage.splitTarget("openai/org/gpt-6")).toEqual({ providerID: "openai", modelID: "org/gpt-6" })
    expect(ModelUsage.splitTarget("gpt-5")).toEqual({ providerID: "", modelID: "gpt-5" })
    const reports = ModelUsage.targetReports([], ["gpt-5"], [], new Map())
    expect(reports).toMatchObject([{ target: "gpt-5", providerID: "", modelID: "gpt-5", requests: 0 }])
  })

  test("a session lists the pools and models it used, with their requests", () => {
    const sessions = [{ sessionID: "s1", first: 1, last: 9, ...totals({ requests: 3 }) }]
    const rows = [
      { sessionID: "s1", routeID: "cheap", providerID: "openai", modelID: "gpt-6-luna", ...totals({ requests: 2 }) },
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 1 }),
      },
      { sessionID: "s2", routeID: "cheap", providerID: "openai", modelID: "gpt-6-luna", ...totals() },
    ]
    const [report] = ModelUsage.sessionReports(sessions, rows)
    expect(report?.pools).toEqual(["cheap", "hard"])
    expect(report?.targets.map((item) => [item.target, item.requests])).toEqual([
      ["openai/gpt-6-luna", 2],
      ["anthropic/claude-opus-5", 1],
    ])
  })

  test("a session reports its share of each plan window it drew on, in the window's unit", () => {
    const plan = {
      id: "anthropic-max",
      providerID: "anthropic",
      label: "Personal",
      coverage: "subscription",
      quotas: [],
      status: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as ModelPlan.Plan
    const window = { name: "5-hour", unit: "messages", limit: 200, windowHours: 5 } as ModelPlan.QuotaWindow
    const rows = [
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 50 }),
      },
      { sessionID: "s1", routeID: "cheap", providerID: "openai", modelID: "gpt-6-luna", ...totals({ requests: 10 }) },
    ]
    const [report] = ModelUsage.sessionReports(
      [{ sessionID: "s1", first: 1, last: 2, ...totals({ requests: 60 }) }],
      rows,
      [{ plan, window }],
    )
    expect(report?.windows).toEqual([
      { plan: "anthropic-max", window: "5-hour", unit: "messages", used: 50, percent: 25 },
    ])
  })

  test("a session's plan-window share counts only the rows inside the window's own lookback when given them", () => {
    const plan = {
      id: "anthropic-max",
      providerID: "anthropic",
      label: "Personal",
      coverage: "subscription",
      quotas: [],
      status: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as ModelPlan.Plan
    const window = { name: "5-hour", unit: "messages", limit: 200, windowHours: 5 } as ModelPlan.QuotaWindow
    const reportRows = [
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 50 }),
      },
    ]
    const windowRows = [
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 20 }),
      },
      {
        sessionID: "s2",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 99 }),
      },
    ]
    const [report] = ModelUsage.sessionReports(
      [{ sessionID: "s1", first: 1, last: 2, ...totals({ requests: 60 }) }],
      reportRows,
      [{ plan, window, rows: windowRows }],
    )
    // 20 of the session's 50 anthropic requests fall inside the 5-hour lookback; s2's rows never count.
    expect(report?.windows).toEqual([
      { plan: "anthropic-max", window: "5-hour", unit: "messages", used: 20, percent: 10 },
    ])
    // The report-window targets still come from the report rows.
    expect(report?.targets.map((item) => [item.target, item.requests])).toEqual([["anthropic/claude-opus-5", 50]])
  })

  test("days group by date and keep each provider's share", () => {
    const days = ModelUsage.dayReports([
      { day: "2026-10-13", providerID: "openai", modelID: "a", ...totals({ requests: 2, costUsd: 0.5 }) },
      { day: "2026-10-13", providerID: "anthropic", modelID: "b", ...totals({ requests: 1, costUsd: 1 }) },
      { day: "2026-10-14", providerID: "openai", modelID: "a", ...totals() },
    ])
    expect(days.map((day) => day.day)).toEqual(["2026-10-13", "2026-10-14"])
    expect(days[0]).toMatchObject({
      requests: 3,
      costUsd: 1.5,
      providers: { openai: { requests: 2, costUsd: 0.5 }, anthropic: { requests: 1, costUsd: 1 } },
    })
  })

  test("days keep providers whose id collides with Object.prototype members", () => {
    const days = ModelUsage.dayReports([
      { day: "2026-10-13", providerID: "__proto__", modelID: "a", ...totals({ requests: 7, costUsd: 1 }) },
      { day: "2026-10-13", providerID: "__proto__", modelID: "a", ...totals({ requests: 1, costUsd: 0.5 }) },
      { day: "2026-10-13", providerID: "constructor", modelID: "b", ...totals({ requests: 5, costUsd: 2 }) },
      { day: "2026-10-13", providerID: "toString", modelID: "c", ...totals({ requests: 3, costUsd: 3 }) },
      { day: "2026-10-13", providerID: "anthropic", modelID: "d", ...totals({ requests: 2, costUsd: 4 }) },
    ])
    const [day] = days
    expect(day?.requests).toBe(18)
    expect(Object.keys(day?.providers ?? {})).toEqual(["__proto__", "constructor", "toString", "anthropic"])
    // Each default totals() row meters 150 (100 input + 50 output).
    expect(day?.providers["__proto__"]).toEqual({ requests: 8, metered: 300, costUsd: 1.5, cacheRead: 0, cacheSavedUsd: 0 })
    expect(day?.providers["constructor"]).toEqual({ requests: 5, metered: 150, costUsd: 2, cacheRead: 0, cacheSavedUsd: 0 })
    expect(day?.providers["toString"]).toEqual({ requests: 3, metered: 150, costUsd: 3, cacheRead: 0, cacheSavedUsd: 0 })
    expect(day?.providers["anthropic"]).toEqual({ requests: 2, metered: 150, costUsd: 4, cacheRead: 0, cacheSavedUsd: 0 })
    const serialised = JSON.parse(JSON.stringify(day?.providers))
    expect(Object.keys(serialised)).toEqual(["__proto__", "constructor", "toString", "anthropic"])
    expect(serialised["__proto__"]).toEqual({ requests: 8, metered: 300, costUsd: 1.5, cacheRead: 0, cacheSavedUsd: 0 })
    expect(serialised["constructor"]).toEqual({ requests: 5, metered: 150, costUsd: 2, cacheRead: 0, cacheSavedUsd: 0 })
  })

  test("turns stitch a response split by output token limit continuations into one cost", () => {
    const turns = ModelUsage.turns([
      attemptRow({ id: 1, timeStarted: 1_000, timeEnded: 2_000, input: 1_000, output: 100, costUsd: 0.1 }),
      attemptRow({
        id: 2,
        continuationOf: 1,
        continuationIndex: 1,
        assistantMessageID: "msg_chunk_1",
        timeStarted: 3_000,
        timeEnded: 4_000,
        input: 1_100,
        output: 80,
        costUsd: 0.08,
      }),
      // A failed chunk is still part of the turn: its own failure stays on its row, and its cost counts.
      attemptRow({
        id: 3,
        continuationOf: 1,
        continuationIndex: 2,
        assistantMessageID: "msg_chunk_2",
        outcome: "failure",
        timeStarted: 5_000,
        timeEnded: 6_000,
        input: 1_200,
        output: 0,
        costUsd: 0.02,
      }),
      attemptRow({
        id: 4,
        assistantMessageID: "msg_other",
        sessionID: "ses_other",
        timeStarted: 7_000,
        timeEnded: 8_000,
      }),
    ])

    expect(turns).toHaveLength(2)
    const continued = turns.find((turn) => turn.rootID === 1)
    expect(continued).toMatchObject({
      rootID: 1,
      sessionID: "ses_turn",
      chunks: 3,
      requests: 3,
      failures: 1,
      input: 3_300,
      output: 180,
      first: 1_000,
      last: 6_000,
      durationMs: 5_000,
    })
    expect(continued?.costUsd).toBeCloseTo(0.2)
    expect(turns.find((turn) => turn.rootID === 4)).toMatchObject({ chunks: 1, requests: 1, failures: 0 })
  })

  test("a continuation whose root fell outside the window is still grouped by the id it names", () => {
    const [turn] = ModelUsage.turns([
      {
        id: 5,
        continuationOf: 9,
        continuationIndex: 1,
        assistantMessageID: "msg_partial",
        sessionID: "ses_turn",
        providerID: "openai",
        modelID: "gpt-6-luna",
        timeStarted: 1_000,
        timeEnded: 2_000,
        outcome: "success",
        input: 100,
        output: 50,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0.01,
      },
    ])
    expect(turn).toMatchObject({ rootID: 9, chunks: 2, requests: 1, costUsd: 0.01 })
  })

  test("retries and hedge legs of the first chunk join its turn instead of splitting it", () => {
    const turns = ModelUsage.turns([
      attemptRow({
        id: 1,
        assistantMessageID: "msg_retried",
        outcome: "failure",
        timeStarted: 1_000,
        timeEnded: 1_500,
        input: 400,
        output: 0,
        costUsd: 0,
      }),
      attemptRow({
        id: 2,
        assistantMessageID: "msg_retried",
        timeStarted: 2_000,
        timeEnded: 3_000,
        input: 500,
        output: 40,
        costUsd: 0.05,
      }),
      attemptRow({
        id: 3,
        assistantMessageID: "msg_retried_chunk",
        continuationOf: 2,
        continuationIndex: 1,
        timeStarted: 4_000,
        timeEnded: 5_000,
        input: 600,
        output: 30,
        costUsd: 0.03,
      }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      rootID: 2,
      chunks: 2,
      requests: 3,
      failures: 1,
      input: 1_500,
      output: 70,
      durationMs: 4_000,
    })
  })

  test("a plan window reports what it has used, its percent and what remains", () => {
    const plan = {
      id: "anthropic-max",
      providerID: "anthropic",
      label: "Personal",
      coverage: "subscription",
      quotas: [],
      status: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as ModelPlan.Plan
    const window = {
      name: "5-hour",
      unit: "messages",
      limit: 200,
      windowHours: 5,
      resetRule: "rolling",
    } as ModelPlan.QuotaWindow
    expect(ModelUsage.windowReport(plan, window, totals({ requests: 50 }))).toMatchObject({
      plan: "anthropic-max",
      window: "5-hour",
      used: 50,
      limit: 200,
      percent: 25,
      remaining: 150,
      resetRule: "rolling",
    })
    expect(
      ModelUsage.windowReport(plan, { ...window, unit: "percent" } as ModelPlan.QuotaWindow, totals()).percent,
    ).toBeNull()
  })
})

describe("ModelUsage serving readout (#1891)", () => {
  const servingRow = (overrides: Partial<ModelUsage.ServingAttemptRow>): ModelUsage.ServingAttemptRow => ({
    routeID: "workhorse",
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "xhigh",
    assistantMessageID: "msg_1",
    outcome: "success",
    failedOverTo: null,
    hedged: null,
    timeStarted: 2_000,
    timeEnded: 2_500,
    ...overrides,
  })

  test("lastServing names the leaf that served, not the leaf first attempted, after a failover", () => {
    // Newest-first, as sessionAttempts returns: the serving success is newest, the 429 failure older.
    const rows = [
      servingRow({ providerID: "vibe-direct", modelID: "mistral-small-latest", variant: "high", timeStarted: 3_000, timeEnded: 3_500 }),
      servingRow({ outcome: "failure", failedOverTo: "vibe-direct/mistral-small-latest", timeStarted: 2_000, timeEnded: 2_400 }),
    ]
    expect(ModelUsage.lastServing(rows)).toMatchObject({
      leaf: "vibe-direct/mistral-small-latest",
      attemptedLeaf: "openai/gpt-6-luna",
      failedOver: true,
      failedOverTo: "vibe-direct/mistral-small-latest",
      outcome: "success",
    })
    expect(ModelUsage.servingSteps(rows).map((step) => step.leaf)).toEqual([
      "vibe-direct/mistral-small-latest",
      "openai/gpt-6-luna",
    ])
  })

  test("lastServing reports no failover for a single-leaf turn and null for no attempts", () => {
    expect(ModelUsage.lastServing([servingRow({})])).toMatchObject({
      leaf: "openai/gpt-6-luna",
      attemptedLeaf: "openai/gpt-6-luna",
      failedOver: false,
      failedOverTo: null,
    })
    expect(ModelUsage.lastServing([])).toBeNull()
    expect(ModelUsage.servingSteps([])).toEqual([])
  })

  test("lastServing does not report a hedged race won by the hedge leg as a failover", () => {
    // Newest-first: the hedge leg (started later) won; the primary ended hedged-out, not failed.
    const rows = [
      servingRow({
        providerID: "vibe-direct",
        modelID: "mistral-small-latest",
        variant: "high",
        outcome: "success",
        hedged: true,
        timeStarted: 3_000,
        timeEnded: 3_500,
      }),
      servingRow({ outcome: "hedged-out", hedged: true, timeStarted: 2_000, timeEnded: 3_400 }),
    ]
    expect(ModelUsage.lastServing(rows)).toMatchObject({
      leaf: "vibe-direct/mistral-small-latest",
      attemptedLeaf: "openai/gpt-6-luna",
      failedOver: false,
      failedOverTo: null,
      hedged: true,
      outcome: "success",
    })
    expect(ModelUsage.servingSteps(rows).map((step) => step.hedged)).toEqual([true, true])
  })

  test("lastServing does not report a hedged race won by the primary as a failover", () => {
    // Newest-first: the primary won; the hedge leg (started later) ended hedged-out.
    const rows = [
      servingRow({
        providerID: "vibe-direct",
        modelID: "mistral-small-latest",
        variant: "high",
        outcome: "hedged-out",
        hedged: true,
        timeStarted: 3_000,
        timeEnded: 3_400,
      }),
      servingRow({ outcome: "success", hedged: true, timeStarted: 2_000, timeEnded: 3_500 }),
    ]
    expect(ModelUsage.lastServing(rows)).toMatchObject({
      leaf: "openai/gpt-6-luna",
      attemptedLeaf: "openai/gpt-6-luna",
      failedOver: false,
      hedged: true,
      outcome: "success",
    })
  })

  test("lastServing only groups the newest turn, never an older turn's failover", () => {
    const rows = [
      servingRow({ assistantMessageID: "msg_2", timeStarted: 5_000, timeEnded: 5_500 }),
      servingRow({ outcome: "failure", failedOverTo: "vibe-direct/mistral-small-latest", timeStarted: 2_000, timeEnded: 2_400 }),
      servingRow({ providerID: "vibe-direct", modelID: "mistral-small-latest", timeStarted: 3_000, timeEnded: 3_500 }),
    ]
    expect(ModelUsage.lastServing(rows)).toMatchObject({
      leaf: "openai/gpt-6-luna",
      attemptedLeaf: "openai/gpt-6-luna",
      failedOver: false,
    })
  })
})
