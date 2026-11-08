import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { findClosestTool, levenshteinDistance, analyzeArgumentMismatch, attemptParameterRepair } from "../src/tool/plugin/mcpx-diagnose.js"
import {
  generateSubagentSessionID,
  registerLease,
  getLease,
  removeLease,
  clearLeases,
  initializeSubagentSession,
} from "../src/tool/plugin/mcpx-subagent.js"
import {
  projectTools,
  retractTools,
  clearProjectedTools,
  getProjectedTools,
  extractToolsFromScript,
} from "../src/tool/plugin/mcpx-projection.js"
import { McpxSecrets } from "../src/tool/plugin/mcpx-secrets.js"

describe("Feature 2: Dynamic Tool Projection", () => {
  it("projects and retracts tools via mock daemon", async () => {
    clearProjectedTools()
    const addedTools: any[] = []
    const removedTools: string[] = []

    const mockEditor: any = {
      add: (tool: any) => addedTools.push(tool),
      remove: (id: string) => removedTools.push(id),
    }

    const mockDaemon = async (path: string) => {
      if (path === "/v1/tools") {
        return [
          {
            namespace: "neon",
            tool: "run_sql",
            description: "Run SQL on Neon Postgres",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "SQL query" },
              },
              required: ["query"],
            },
          },
          {
            namespace: "chrome_devtools",
            tool: "navigate_page",
            description: "Navigate to URL",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
            },
          },
        ]
      }
      return []
    }

    // 1. Project neon tools
    const res1 = await projectTools({
      namespaces: ["neon"],
      callDaemon: mockDaemon,
      editor: mockEditor,
    })
    expect(res1.added).toContain("neon_run_sql")
    expect(res1.added).not.toContain("chrome_devtools_navigate_page")
    expect(getProjectedTools().has("neon_run_sql")).toBe(true)

    // 2. Retract neon tools
    const retracted = retractTools(["neon"], mockEditor)
    expect(retracted).toContain("neon_run_sql")
    expect(getProjectedTools().has("neon_run_sql")).toBe(false)
    expect(removedTools).toContain("neon_run_sql")
  })
})

describe("Feature 3: Ephemeral Subagent Session Leasing", () => {
  it("generates deterministic child session IDs and tracks leases", () => {
    clearLeases()
    const parentSessionID = "ses_parent_123"
    const childID = "subagent_abc"

    const expectedChildSessionID = `mcpx-sub-${parentSessionID}-${childID}`
    const generated = generateSubagentSessionID(parentSessionID, childID)
    expect(generated).toBe(expectedChildSessionID)

    registerLease({
      leaseID: generated,
      childSessionID: generated,
      childID,
      parentSessionID,
    })

    const leaseByChild = getLease(childID)
    expect(leaseByChild).toBeDefined()
    expect(leaseByChild?.childSessionID).toBe(generated)

    const leaseBySession = getLease(generated)
    expect(leaseBySession).toBeDefined()
    expect(leaseBySession?.parentSessionID).toBe(parentSessionID)

    removeLease(childID)
    expect(getLease(childID)).toBeUndefined()
  })

  it("links a nested subagent to its parent's lease", async () => {
    clearLeases()
    const child = await Effect.runPromise(initializeSubagentSession({ parentSessionID: "ses_root", childID: "ses_child" }))
    const grandchild = await Effect.runPromise(
      initializeSubagentSession({ parentSessionID: "ses_child", childID: "ses_grandchild" }),
    )

    expect(child.parentSessionID).toBe("ses_root")
    expect(grandchild.childSessionID).toBe("mcpx-sub-ses_child-ses_grandchild")
    expect(grandchild.parentSessionID).toBe(child.childSessionID)
    clearLeases()
  })
})

describe("Feature 4: Self-Healing & Diagnostics", () => {
  it("calculates Levenshtein distance and finds typo matches", () => {
    expect(levenshteinDistance("click", "clik")).toBe(1)
    expect(levenshteinDistance("navigate_page", "navgate_page")).toBe(1)

    const candidates = ["click", "close_page", "navigate_page", "take_screenshot"]
    const match = findClosestTool("navgate_page", candidates)
    expect(match?.tool).toBe("navigate_page")
    expect(match?.distance).toBe(1)
  })

  it("detects shape mismatches and auto-repairs parameter types", () => {
    const schema = {
      type: "object",
      properties: {
        timeout: { type: "number" },
        active: { type: "boolean" },
        tags: { type: "array" },
      },
      required: ["timeout"],
    }

    // timeout is passed as string "5000", active passed as "true"
    const input = { timeout: "5000", active: "true", tags: "foo,bar" }
    const analysis = analyzeArgumentMismatch(schema, input)
    expect(analysis.mismatches.length).toBeGreaterThan(0)

    const repair = attemptParameterRepair(schema, input)
    expect(repair.repaired).toBe(true)
    expect(repair.repairedParams?.timeout).toBe(5000)
    expect(repair.repairedParams?.active).toBe(true)
  })

  it("does not floor non-integer strings for integer parameters", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    }

    for (const value of ["3.9", "-1.9", "-1.1"]) {
      const repair = attemptParameterRepair(schema, { count: value })
      expect(repair.repaired).toBe(false)
      expect(repair.repairedParams).toBeUndefined()
    }

    // Already-integer strings keep coercing. "3.0" no longer does: it is not
    // an integer spelling under the plain-decimal grammar (#769).
    for (const [value, expected] of [["42", 42], ["-2", -2]] as const) {
      const repair = attemptParameterRepair(schema, { count: value })
      expect(repair.repaired).toBe(true)
      expect(repair.repairedParams?.count).toBe(expected)
    }
  })

  it("does not repair non-finite strings for number or integer parameters", () => {
    const numberSchema = {
      type: "object",
      properties: { ratio: { type: "number" } },
      required: ["ratio"],
    }
    const integerSchema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    }

    for (const value of ["Infinity", "-Infinity", "NaN"]) {
      expect(attemptParameterRepair(numberSchema, { ratio: value }).repaired).toBe(false)
      expect(attemptParameterRepair(integerSchema, { count: value }).repaired).toBe(false)
    }

    // A finite fractional string still coerces for a number parameter.
    const repair = attemptParameterRepair(numberSchema, { ratio: "1.5" })
    expect(repair.repaired).toBe(true)
    expect(repair.repairedParams?.ratio).toBe(1.5)
    expect(JSON.parse(JSON.stringify(repair.repairedParams))).toEqual({ ratio: 1.5 })
  })

  it("pins the plain-decimal grammar: non-decimal spellings are left unrepaired (#769)", () => {
    const numberSchema = {
      type: "object",
      properties: { ratio: { type: "number" } },
      required: ["ratio"],
    }
    const integerSchema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    }

    // Spellings Number() would reinterpret are not plain decimals, so neither
    // parameter kind coerces them (previously "0x10" -> 16 and "1e3" -> 1000).
    for (const value of ["0x10", "0b101", "0o17", "1e3", "1e-1", "+42", "5."]) {
      expect(attemptParameterRepair(integerSchema, { count: value }).repaired).toBe(false)
      expect(attemptParameterRepair(numberSchema, { ratio: value }).repaired).toBe(false)
    }
    // Integer "3.0" is not an integer spelling and stays unrepaired, aligned
    // with ToolInputRepair; a number parameter still coerces it to 3.
    expect(attemptParameterRepair(integerSchema, { count: "3.0" }).repaired).toBe(false)
    expect(attemptParameterRepair(numberSchema, { ratio: "3.0" }).repairedParams?.ratio).toBe(3)
    // Plain decimals keep coercing for both kinds.
    expect(attemptParameterRepair(integerSchema, { count: "42" }).repairedParams?.count).toBe(42)
    expect(attemptParameterRepair(numberSchema, { ratio: "42" }).repairedParams?.ratio).toBe(42)
  })
})

describe("Feature 5: Just-in-Time Secret Prompting", () => {
  it("detects a missing secret only from a daemon 409, never from free text", () => {
    const refused = new McpxSecrets.DaemonHTTPError(
      409,
      JSON.stringify({ code: "secret_required", server: "neon", secrets: ["NEON_API_KEY"], requestId: "req_1" }),
    )
    expect(McpxSecrets.secretRequired(refused)).toEqual({
      server: "neon",
      secrets: ["NEON_API_KEY"],
      requestId: "req_1",
    })
    expect(McpxSecrets.secretRequired(new McpxSecrets.DaemonHTTPError(500, "boom"))).toBeUndefined()
    expect(McpxSecrets.secretRequired(new Error("ANTHROPIC_API_KEY is required to proceed"))).toBeUndefined()
  })

  it("fails a refused call with the request id and sends no secret header", async () => {
    const headers: Record<string, string>[] = []
    const mockDaemon = async (_path: string, _method?: string, _body?: any, requestHeaders?: Record<string, string>) => {
      headers.push(requestHeaders ?? {})
      throw new McpxSecrets.DaemonHTTPError(
        409,
        JSON.stringify({ code: "secret_required", server: "openai", secrets: ["OPENAI_API_KEY"], requestId: "req_7" }),
      )
    }

    const failure = await mockDaemon("/v1/call", "POST", {}, { "x-mcpx-session-id": "ses_1" }).catch((error) =>
      McpxSecrets.failureOf(error, "openai_run"),
    )
    expect(failure.message).toContain('OPENAI_API_KEY (server "openai")')
    expect(failure.message).toContain("(request req_7)")
    expect(headers).toHaveLength(1)
    expect(Object.keys(headers[0] ?? {}).filter((name) => name.startsWith("x-mcpx-secret"))).toEqual([])
    expect(headers[0]).not.toHaveProperty("x-mcpx-injected-secrets")
  })

  it("never resolves a missing secret from the environment", async () => {
    process.env.MCPX_TEST_ENV_SECRET = "from-env"
    try {
      const headers: Record<string, string>[] = []
      const mockDaemon = async (_path: string, _method?: string, _body?: any, requestHeaders?: Record<string, string>) => {
        headers.push(requestHeaders ?? {})
        throw new McpxSecrets.DaemonHTTPError(
          409,
          JSON.stringify({ code: "secret_required", server: "test", secrets: ["MCPX_TEST_ENV_SECRET"] }),
        )
      }

      const failure = await mockDaemon("/v1/call", "POST", {}).catch((error) => McpxSecrets.failureOf(error, "test_run"))
      expect(failure.message).toContain("MCPX_TEST_ENV_SECRET")
      expect(headers[0] ?? {}).not.toHaveProperty("x-mcpx-secret-mcpx_test_env_secret")
    } finally {
      delete process.env.MCPX_TEST_ENV_SECRET
    }
  })

  it("names the missing secret and its request id when neither the host nor the environment has it", () => {
    const refused = new McpxSecrets.DaemonHTTPError(
      409,
      JSON.stringify({ code: "secret_required", server: "test", secrets: ["MCPX_TEST_ABSENT_SECRET"], requestId: "req_9" }),
    )
    const failure = McpxSecrets.failureOf(refused, "test_run")
    expect(failure.message).toContain("MCPX_TEST_ABSENT_SECRET")
    expect(failure.message).toContain("(request req_9)")
  })

  it("names every missing secret and server when a script needs more than one", () => {
    const failure = McpxSecrets.secretFailure({
      subject: "the script",
      reason: "unset",
      missing: [
        { server: "neon", secrets: ["NEON_API_KEY"] },
        { server: "github", secrets: ["GITHUB_TOKEN"] },
      ],
      requestIDs: ["req_1", "req_2"],
    })
    expect(failure.message).toContain('NEON_API_KEY (server "neon")')
    expect(failure.message).toContain('GITHUB_TOKEN (server "github")')
    expect(failure.message).toContain("(request req_1, req_2)")
    expect(failure.message).toContain("`mcpx secrets set NEON_API_KEY` and `mcpx secrets set GITHUB_TOKEN`")
  })
})

describe("Feature 2: Script references", () => {
  it("returns each referenced namespace and tool once, in both reference forms", () => {
    expect(
      extractToolsFromScript(
        `await tools.neon.run_sql({}); await tools["neon"]["run_sql"]({}); tools['github']['create_issue']({})`,
      ),
    ).toEqual([
      { namespace: "neon", tool: "run_sql" },
      { namespace: "github", tool: "create_issue" },
    ])
  })

  it("ignores partial references and look-alikes", () => {
    expect(extractToolsFromScript("tools.neon; mytools.neon.run_sql({}); tools.neon['run_sql']({})")).toEqual([])
  })
})

describe("Feature 2: TTL and Script Auto-Projection", () => {
  it("decrements turn TTL and auto-retracts expired tools", () => {
    clearProjectedTools()
    const removed: string[] = []
    const mockEditor: any = {
      add: () => {},
      remove: (id: string) => removed.push(id),
    }

    const { stepTurnTtl } = require("../src/tool/plugin/mcpx-projection.js")
    const { getProjectedTools } = require("../src/tool/plugin/mcpx-projection.js")

    // Manually register a projected tool with ttl = 2
    getProjectedTools().set("test_tool", {
      id: "test_tool",
      namespace: "test",
      toolName: "tool",
      originalTool: {},
      ttlRemaining: 2,
    })

    // Turn 1 step: ttl becomes 1
    const expired1 = stepTurnTtl(mockEditor)
    expect(expired1.length).toBe(0)
    expect(getProjectedTools().has("test_tool")).toBe(true)

    // Turn 2 step: ttl becomes 0 -> retracted!
    const expired2 = stepTurnTtl(mockEditor)
    expect(expired2).toContain("test_tool")
    expect(getProjectedTools().has("test_tool")).toBe(false)
    expect(removed).toContain("test_tool")
  })
})
