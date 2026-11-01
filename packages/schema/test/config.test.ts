import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config.js"
import { ConfigAgent } from "../src/config/agent.js"
import { ConfigMCP } from "../src/config/mcp.js"
import { ConfigModel } from "../src/config/model.js"
import { ConfigModelRoutes } from "../src/config/model-routes.js"
import { ConfigProvider } from "../src/config/provider.js"
import { Mcp } from "../src/mcp.js"
import { Model } from "../src/model.js"
import { Provider } from "../src/provider.js"
import { AbsolutePath } from "../src/schema.js"
import { WebSearch } from "../src/websearch.js"

describe("Config.Entry", () => {
  test("round-trips tool.use and rejects unsupported action spellings", () => {
    const input = {
      experimental: {
        policies: [
          { action: "tool.use", resource: "shell:*", effect: "deny" },
          { action: "tool.use", resource: "shell:git *", effect: "allow" },
        ],
      },
    } as const
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    for (const action of ["permission", "tool.execute"])
      expect(() =>
        Schema.decodeUnknownSync(Config.Info)({
          experimental: { policies: [{ action, resource: "*", effect: "deny" }] },
        }),
      ).toThrow()
  })

  test("accepts directory-only worktree config and omits it when absent", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const input = { worktree: { directory: "../worktrees" } }
    expect(Schema.encodeSync(Config.Info)(decode(input))).toEqual(input)
    expect(Schema.encodeSync(Config.Info)(new Config.Info({ worktree: undefined }))).not.toHaveProperty("worktree")
    expect(() => decode({ worktree: {} })).toThrow()
    expect(() => decode({ worktree: { directory: " " } })).toThrow()
    expect(() => decode({ worktree: { directory: false } })).toThrow()
  })
  test("round-trips canonical provider IDs without changing config keys", () => {
    const input = { providers: { "console-anthropic": { canonical: "anthropic" } } }
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(decoded.providers?.["console-anthropic"]?.canonical).toBe(Provider.ID.anthropic)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    expect(() => Schema.decodeUnknownSync(Config.Info)({ providers: { custom: { canonical: 1 } } })).toThrow()
  })

  test("round-trips disabled and numeric provider HTTP timeouts", () => {
    const input = {
      providers: { custom: { settings: { timeout: 900_000, headerTimeout: 600_000, chunkTimeout: false } } },
    } as const
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    expect(Schema.decodeUnknownSync(Provider.Settings)(decoded.providers?.custom?.settings)).toMatchObject({
      timeout: 900_000,
      headerTimeout: 600_000,
      chunkTimeout: false,
    })
    expect(Schema.decodeUnknownSync(Provider.Settings)({ headerTimeout: false, chunkTimeout: 600_000 })).toMatchObject({
      headerTimeout: false,
      chunkTimeout: 600_000,
    })
  })

  test("accepts disabled, fixed, and random web search selection", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)

    expect(decode({ websearch: false }).websearch).toBe(false)
    expect(decode({ websearch: { provider: "exa" } }).websearch).toEqual({ provider: WebSearch.ID.make("exa") })
    expect(decode({ websearch: { provider: "random" } }).websearch).toEqual({ provider: "random" })
  })

  test("round-trips every configuration entry type", () => {
    const entries = [
      new Config.Document({
        type: "document",
        path: AbsolutePath.make("/project/opencode.json"),
        info: new Config.Info({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
        }),
      }),
      new Config.Document({ type: "document", info: new Config.Info({ shell: "/bin/zsh" }) }),
      new Config.Directory({ type: "directory", path: AbsolutePath.make("/project/.opencode") }),
    ]

    const encoded = Schema.encodeSync(Schema.Array(Config.Entry))(entries)
    const decoded = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(encoded)

    expect(decoded).toEqual(entries)
    expect(decoded[0]).toBeInstanceOf(Config.Document)
    expect(decoded[1]).not.toHaveProperty("path")
    expect(decoded.map((entry) => entry.type)).toEqual(["document", "document", "directory"])
    expect(decoded[0]?.type === "document" ? decoded[0].info.permissions : undefined).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
  })

  test("has a stable public identifier", () => {
    expect(Config.Entry.ast.annotations?.identifier).toBe("Config.Entry")
  })

  test("omits undefined optional properties while encoding", () => {
    const entry = new Config.Document({
      type: "document",
      path: undefined,
      info: new Config.Info({
        default_agent: undefined,
        agents: { reviewer: new ConfigAgent.Info({ description: undefined }) },
        mcp: new ConfigMCP.Info({
          timeout: undefined,
          servers: {
            docs: new Mcp.RemoteConfig({
              type: "remote",
              url: "https://example.com/mcp",
              headers: undefined,
              oauth: new Mcp.OAuthConfig({ client_id: undefined }),
            }),
          },
        }),
        providers: { custom: new ConfigProvider.Info({ canonical: undefined, headers: undefined }) },
      }),
    })
    const encoded = Schema.encodeSync(Config.Entry)(entry)
    if (encoded.type !== "document") throw new Error("Expected a config document")

    expect(encoded).not.toHaveProperty("path")
    expect(encoded.info).not.toHaveProperty("default_agent")
    expect(encoded.info.agents?.reviewer).not.toHaveProperty("description")
    expect(encoded.info.mcp).not.toHaveProperty("timeout")
    const docs = encoded.info.mcp?.servers?.docs
    if (docs?.type !== "remote" || docs.oauth === false) throw new Error("Expected a remote MCP server")
    expect(docs).not.toHaveProperty("headers")
    expect(docs.oauth).not.toHaveProperty("client_id")
    expect(encoded.info.providers?.custom).not.toHaveProperty("headers")
    expect(encoded.info.providers?.custom).not.toHaveProperty("canonical")
  })
})

describe("ConfigModelRoutes field descriptions", () => {
  // A description annotated outside the package `optional` helper lands only on the decoded side, so the
  // encoded JSON schema — what the OpenAPI document and editors are generated from — shows nothing (#240).
  const described = (schema: Schema.Top) => {
    const { definitions } = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
    const fields: Record<string, string | undefined> = {}
    const visit = (value: unknown) => {
      if (typeof value !== "object" || value === null) return
      const node = value as Record<string, unknown>
      if (node.properties && typeof node.properties === "object")
        for (const [name, property] of Object.entries(node.properties))
          fields[name] ??= (property as { description?: string }).description
      Object.values(node).forEach(visit)
    }
    visit(definitions)
    return fields
  }

  test("every documented field carries its description in the encoded JSON schema", () => {
    const cases: Array<[Schema.Top, string[]]> = [
      [ConfigModelRoutes.Budget, ["softLimit"]],
      [
        ConfigModelRoutes.Health,
        [
          "firstTokenTimeoutMs",
          "maxResponseTimeMs",
          "minOutputTokensPerSecond",
          "sampleWindow",
          "slowThreshold",
          "cooldownMs",
          "quotaCooldownMs",
        ],
      ],
      [ConfigModelRoutes.Window, ["daysOfWeek", "daysOfMonth", "start", "end", "timezone", "from", "until"]],
      [ConfigModelRoutes.Schedule, ["id", "targets", "factor", "weight", "note"]],
      [ConfigModelRoutes.GlobalSchedule, ["providers", "models", "targets", "routes", "factor", "weight"]],
      [ConfigModelRoutes.Route, ["budgets", "hedgeAfterMs", "attempts", "autonomy", "selection", "weights", "schedules"]],
      // The TargetObject arm is private; the exported union exposes its encoded object fields.
      [ConfigModelRoutes.Target, ["defaultVariant", "variants", "until"]],
      [ConfigModelRoutes.Tuning, ["enabled", "intervalMinutes", "windowHours", "notes"]],
      [ConfigModelRoutes.Log, ["captureErrorBodies"]],
    ]
    for (const [schema, names] of cases) {
      const fields = described(schema)
      for (const name of names) expect(fields[name], name).toBeString()
    }
    expect(described(ConfigModelRoutes.Budget).softLimit).toContain("Fraction of an allowance")
  })
})

describe("ConfigModelRoutes.Tuning notes", () => {
  test("accepts any string as a note, so one bad line does not refuse the block; a non-string is refused", () => {
    const decode = Schema.decodeUnknownSync(ConfigModelRoutes.Tuning)
    expect(decode({ notes: ["match: text", "x::y", ":x:y", "x:"] }).notes).toEqual([
      "match: text",
      "x::y",
      ":x:y",
      "x:",
    ])
    expect(() => decode({ notes: [5] })).toThrow()
  })
})

describe("ConfigModel.Selection segment spelling (#456)", () => {
  const decode = Schema.decodeUnknownSync(ConfigModel.Selection)

  test("accepts legitimate string and explicit selections", () => {
    expect(String(decode("openrouter/anthropic/claude-sonnet-4").model)).toBe("anthropic/claude-sonnet-4")
    expect(String(decode("anthropic/claude-sonnet#high").variant)).toBe("high")
    expect(String(decode("openai/gpt-4#a/b").variant)).toBe("a/b")
    expect(String(decode({ providerID: "openai", model: "gpt-4", variant: "a/b" }).variant)).toBe("a/b")
    const explicit = decode({ providerID: "openrouter", model: "anthropic/claude-sonnet-4", variant: "high" })
    expect(String(explicit.providerID)).toBe("openrouter")
    expect(String(explicit.model)).toBe("anthropic/claude-sonnet-4")
  })

  test("rejects padded, empty and internal-whitespace segments in string form", () => {
    for (const input of [
      "open ai/gpt-4",
      "openai/gpt 4",
      "openai/gpt\t4",
      "openai/gpt-4#hi there",
      " openai/gpt-4",
      "openai/gpt-4 ",
      "openai/gpt-4# hi",
      "openai//gpt-4",
      "openai/gpt-4#a//b",
      "openai/gpt-4#a/",
      "openai/gpt-4#/b",
      "openai/gpt-4#/",
    ])
      expect(() => decode(input)).toThrow()
  })

  test("rejects empty-sub-segment variant spellings as a SchemaError, not a raw Error, in string form (#467)", () => {
    for (const input of ["openai/gpt-4#a//b", "openai/gpt-4#a/", "openai/gpt-4#/b", "openai/gpt-4#/"])
      expect(() => decode(input)).toThrow(Schema.SchemaError)
  })

  test("rejects variant slash spellings with empty sub-segments like Model.Ref.parse (#467)", () => {
    for (const variant of ["a//b", "a/", "/b", "/"])
      expect(() => Model.Ref.parse(`openai/gpt-4#${variant}`)).toThrow()
    expect(String(Model.Ref.parse("openai/gpt-4#a/b").variant)).toBe("a/b")
  })

  test("rejects padded, empty and internal-whitespace segments in explicit form", () => {
    for (const input of [
      { providerID: "open ai", model: "gpt-4" },
      { providerID: " openai", model: "gpt-4" },
      { providerID: "openai", model: "gpt 4" },
      { providerID: "openai", model: "/gpt-4" },
      { providerID: "openai", model: "anthropic//claude-sonnet-4" },
      { providerID: "openai", model: "gpt-4", variant: "hi there" },
      { providerID: "openai", model: "gpt-4", variant: " high" },
      { providerID: "openai", model: "gpt-4", variant: "a//b" },
      { providerID: "openai", model: "gpt-4", variant: "a/" },
      { providerID: "openai", model: "gpt-4", variant: "/b" },
      { providerID: "openai", model: "gpt-4", variant: "/" },
    ])
      expect(() => decode(input)).toThrow()
  })
})
