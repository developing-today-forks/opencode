import { describe, expect, test } from "bun:test"
import { Arbitrary, Duration, Effect, Schema } from "effect"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ModelRouteTuning } from "@opencode/core/model-route-tuning"
import { Info } from "@opencode/schema/config"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"

const options = { errors: "all", onExcessProperty: "ignore" } as const

function normalized(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  expect(result.type).toBe("normalized")
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return result
}

function decoded(input: unknown) {
  return Schema.decodeUnknownSync(Info, options)(normalized(input).encoded)
}

function withoutEmptyCompatibilityContainers(input: Record<string, unknown>) {
  const result = structuredClone(input)
  if (typeof result.mcp === "object" && result.mcp !== null && !Array.isArray(result.mcp)) {
    const mcp = result.mcp as Record<string, unknown>
    const originallyEmpty = !Object.keys(mcp).length
    for (const key of ["servers", "timeout"]) {
      if (
        typeof mcp[key] === "object" &&
        mcp[key] !== null &&
        !Array.isArray(mcp[key]) &&
        !Object.keys(mcp[key]).length
      )
        delete mcp[key]
    }
    if (!originallyEmpty && !Object.keys(mcp).length) delete result.mcp
  }
  if (typeof result.compaction === "object" && result.compaction !== null && !Array.isArray(result.compaction)) {
    const compaction = result.compaction as Record<string, unknown>
    const originallyEmpty = !Object.keys(compaction).length
    if (
      typeof compaction.keep === "object" &&
      compaction.keep !== null &&
      !Array.isArray(compaction.keep) &&
      !Object.keys(compaction.keep).length
    )
      delete compaction.keep
    if (!originallyEmpty && !Object.keys(compaction).length) delete result.compaction
  }
  // Deprecated experimental policies normalize into top-level policies.
  if (typeof result.experimental === "object" && result.experimental !== null && !Array.isArray(result.experimental)) {
    const experimental = result.experimental as Record<string, unknown>
    if (Array.isArray(experimental.policies)) {
      result.policies = [...experimental.policies, ...(Array.isArray(result.policies) ? result.policies : [])]
      delete experimental.policies
      if (!Object.keys(experimental).length) delete result.experimental
    }
  }
  // Deprecated experimental aliases normalize into top-level aliases (a top-level
  // aliases block wins when both are present, matching normalizeAliases).
  if (typeof result.experimental === "object" && result.experimental !== null && !Array.isArray(result.experimental)) {
    const experimental = result.experimental as Record<string, unknown>
    if (
      typeof experimental.aliases === "object" &&
      experimental.aliases !== null &&
      !Array.isArray(experimental.aliases)
    ) {
      if (typeof result.aliases !== "object" || result.aliases === null || Array.isArray(result.aliases))
        result.aliases = experimental.aliases
      delete experimental.aliases
      if (!Object.keys(experimental).length) delete result.experimental
    }
  }
  return result
}

/** Normalization drops each note line that does not match NOTE_LINE, so the expected config drops it too. */
function withoutMalformedNotes(input: Record<string, unknown>) {
  const result = structuredClone(input)
  const tuning = (result.experimental as { model_route_tuning?: { notes?: string[] } } | undefined)?.model_route_tuning
  if (tuning?.notes) tuning.notes = tuning.notes.filter((line) => ConfigModelRoutes.NOTE_LINE.test(line))
  return result
}

describe("ConfigNormalize", () => {
  test("accepts tool.use without losing statement order", () => {
    const policies = [
      { action: "tool.use", effect: "deny", resource: "shell:*" },
      { action: "tool.use", effect: "allow", resource: "shell:git *" },
      { action: "tool.use", effect: "deny", resource: "shell:git push *" },
    ] as const
    const result = normalized({ experimental: { policies } })
    expect(result.diagnostics).toEqual([])
    expect(Schema.decodeUnknownSync(Info)(result.encoded).policies).toEqual(policies)
  })

  test("drops unsupported policy actions without losing supported policies", () => {
    const supported = { action: "tool.use", effect: "deny", resource: "shell:*" } as const
    const result = normalized({
      experimental: {
        policies: [
          { action: "permission", effect: "allow", resource: "*" },
          supported,
          { action: "future.use", effect: "deny", resource: "*" },
        ],
      },
    })
    expect(Schema.decodeUnknownSync(Info)(result.encoded).policies).toEqual([supported])
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      ["experimental", "policies", "0"],
      ["experimental", "policies", "2"],
    ])
  })

  test("rejects every non-object root with one root diagnostic", () => {
    for (const input of [null, [], "config", true, 1]) {
      expect(ConfigNormalize.normalize(input)).toEqual({
        type: "rejected",
        diagnostics: [
          {
            kind: "invalid",
            path: ["$"],
            message: "rejected configuration because its root is not an object",
          },
        ],
      })
    }
  })

  test("keeps unrelated native fields when a legacy field is present", () => {
    const result = decoded({ snapshot: false, agents: { reviewer: { system: "Use V2" } } })
    expect(result.snapshots).toBe(false)
    expect(result.agents?.reviewer?.system).toBe("Use V2")
  })

  test("canonicalizes transformed native values through decode then encode", () => {
    const result = normalized({ warming: { interval: "4 minutes", duration: "30 minutes" } })
    expect(result.encoded.warming).toEqual({ interval: "240000 millis", duration: "1800000 millis" })
    const info = Schema.decodeUnknownSync(Info)(result.encoded)
    if (typeof info.warming === "boolean" || info.warming === undefined) throw new Error("expected warming info")
    expect(Duration.toMillis(info.warming.interval ?? Duration.zero)).toBe(240_000)
    expect(Duration.toMillis(info.warming.duration ?? Duration.zero)).toBe(1_800_000)
  })

  test("preserves arbitrary JSON-round-tripped native configuration", () => {
    const result = Effect.runSync(
      Arbitrary.checkEffect(
        Arbitrary.schema(Info),
        (info) => {
          const source = JSON.parse(JSON.stringify(Schema.encodeSync(Info)(info)))
          const result = normalized(source)
          expect(Schema.decodeUnknownSync(Info)(result.encoded)).toEqual(
            Schema.decodeUnknownSync(Info)(withoutMalformedNotes(withoutEmptyCompatibilityContainers(source))),
          )
          return true
        },
        { runs: 100 },
      ),
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  })

  test("merges named maps by entry and gives valid native entries precedence", () => {
    const result = normalized({
      reference: { legacy: { path: "../legacy" }, duplicate: { path: "../old" } },
      references: { native: { path: "../native" }, duplicate: { path: "../new" } },
      command: { legacy: { template: "legacy" }, duplicate: { template: "old" } },
      commands: { native: { template: "native" }, duplicate: { template: "new" } },
    })
    expect(result.encoded.references).toEqual({
      legacy: { path: "../legacy" },
      native: { path: "../native" },
      duplicate: { path: "../new" },
    })
    expect(result.encoded.commands).toEqual({
      legacy: { template: "legacy" },
      native: { template: "native" },
      duplicate: { template: "new" },
    })
    expect(result.diagnostics.filter((item) => item.kind === "conflict").map((item) => item.path)).toEqual([
      ["references", "duplicate"],
      ["commands", "duplicate"],
    ])
  })

  test("does not report canonical-equal duplicates as conflicts", () => {
    const result = normalized({
      snapshot: false,
      snapshots: false,
      reference: { docs: { path: "../docs" } },
      references: { docs: { path: "../docs" } },
      agent: { reviewer: { prompt: "same" } },
      agents: { reviewer: { system: "same" } },
      provider: { custom: { name: "same" } },
      providers: { custom: { name: "same" } },
      compaction: { preserve_recent_tokens: 1000, keep: { tokens: 1000 } },
    })
    expect(result.diagnostics.filter((item) => item.kind === "conflict")).toEqual([])
  })

  test("uses agent then mode then native agent precedence", () => {
    const result = normalized({
      agent: { reviewer: { prompt: "agent" }, agentOnly: { prompt: "agent-only" } },
      mode: { reviewer: { prompt: "mode" }, modeOnly: { prompt: "mode-only" } },
      agents: { reviewer: { system: "native" }, nativeOnly: { system: "native-only" } },
    })
    expect(result.encoded.agents).toEqual({
      reviewer: { system: "native" },
      agentOnly: { system: "agent-only" },
      modeOnly: { system: "mode-only", mode: "primary" },
      nativeOnly: { system: "native-only" },
    })
    expect(result.diagnostics.filter((item) => item.kind === "conflict").map((item) => item.path)).toEqual([
      ["agents", "reviewer"],
      ["agents", "reviewer"],
    ])
    expect(() => Schema.decodeUnknownSync(Info)(result.encoded)).not.toThrow()
  })

  test("renames legacy provider IDs in the top-level model", () => {
    expect(normalized({ model: "google-vertex-anthropic/claude#high" }).encoded.model).toEqual({
      providerID: "google-vertex",
      model: "claude",
      variant: "high",
    })
    expect(
      normalized({ model: { providerID: "azure-cognitive-services", model: "deployment" } }).encoded.model,
    ).toEqual({ providerID: "azure", model: "deployment" })
    expect(normalized({ model: "anthropic/claude" }).encoded.model).toEqual({
      providerID: "anthropic",
      model: "claude",
    })
  })

  test("migrates the legacy small model to the title agent", () => {
    const result = normalized({ small_model: "anthropic/claude-haiku-4-5" })
    expect(result.encoded.agents).toEqual({
      title: {
        model: { providerID: "anthropic", model: "claude-haiku-4-5" },
      },
    })
    expect(result.diagnostics).toEqual([])
  })

  test("merges the legacy small model with the title agent", () => {
    const result = normalized({
      small_model: "anthropic/claude-haiku-4-5",
      agent: { title: { prompt: "Custom title prompt" } },
    })
    expect(result.encoded.agents).toEqual({
      title: {
        model: { providerID: "anthropic", model: "claude-haiku-4-5" },
        system: "Custom title prompt",
      },
    })
    expect(result.diagnostics).toEqual([])
  })

  test("omits an invalid legacy small model without exposing its value", () => {
    const secret = "do-not-log-this-value"
    const result = normalized({ small_model: secret })
    expect(result.encoded.agents).toBeUndefined()
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([["unsupported", ["small_model"]]])
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })

  test("omits legacy small models that violate the Selection segment rules (#503)", () => {
    for (const small_model of ["open ai/gpt-4", "openai//gpt-4", "openai/gpt 4", " openai/gpt-4"]) {
      const result = normalized({ small_model })
      expect(result.encoded.agents).toBeUndefined()
      expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([["unsupported", ["small_model"]]])
    }
  })

  test("omits segment-invalid legacy agent and command models instead of throwing (#503)", () => {
    const result = normalized({
      agent: { custom: { model: "openai/gpt-4", variant: "a//b", prompt: "hi" } },
      command: { run: { template: "t", model: "openai//gpt-4" } },
    })
    expect(result.encoded.agents).toEqual({ custom: { system: "hi" } })
    expect(result.encoded.commands).toEqual({ run: { template: "t" } })
  })

  test("keeps multi-slash legacy models and slash variants (#503)", () => {
    const small = normalized({ small_model: "openrouter/anthropic/claude-sonnet-4" })
    expect(small.encoded.agents).toEqual({
      title: { model: { providerID: "openrouter", model: "anthropic/claude-sonnet-4" } },
    })
    expect(small.diagnostics).toEqual([])
    const agent = normalized({ agent: { custom: { model: "openai/gpt-4", variant: "a/b" } } })
    expect(agent.encoded.agents).toEqual({
      custom: { model: { providerID: "openai", model: "gpt-4", variant: "a/b" } },
    })
  })

  test("recovers malformed named entries and retains a valid legacy collision", () => {
    const result = normalized({
      command: { fallback: { template: "legacy" } },
      commands: {
        fallback: { template: 1 },
        valid: { template: "native" },
        invalid: { template: false },
      },
      providers: {
        valid: { name: "Valid" },
        invalid: { env: [1] },
      },
    })
    expect(result.encoded.commands).toEqual({ fallback: { template: "legacy" }, valid: { template: "native" } })
    expect(result.encoded.providers).toEqual({ valid: { name: "Valid" } })
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["commands", "fallback"],
      ["commands", "invalid"],
      ["providers", "invalid"],
    ])
  })

  test("accepts partial model capabilities without reporting a diagnostic", () => {
    const result = normalized({
      providers: {
        demo: { name: "Demo", models: { demo: { name: "Demo", capabilities: { input: ["text"], output: ["text"] } } } },
      },
    })
    expect(result.diagnostics).toEqual([])
    expect(result.encoded.providers).toEqual({
      demo: { name: "Demo", models: { demo: { name: "Demo", capabilities: { input: ["text"], output: ["text"] } } } },
    })
  })

  test("keeps a legacy provider's instanceOf", () => {
    expect(decoded({ provider: { "openai.work": { instanceOf: "openai", name: "Work" } } }).providers).toEqual({
      "openai.work": expect.objectContaining({ instanceOf: "openai", name: "Work" }),
    })
  })

  test("uses a valid retired provider alias when the canonical legacy entry is malformed", () => {
    const result = normalized({
      provider: {
        "azure-cognitive-services": { models: { deployment: {} } },
        azure: { env: [1] },
      },
    })
    expect(result.encoded.providers).toHaveProperty("azure.models.deployment")
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toContainEqual([
      "provider",
      "azure",
    ])
  })

  test("preserves permission source order and appends native rules", () => {
    expect(
      normalized({
        tools: { bash: true, write: false },
        permission: { read: "allow", custom: { first: "deny", second: "ask" }, task: "allow" },
        permissions: [{ action: "native", resource: "*", effect: "deny" }],
      }).encoded.permissions,
    ).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "custom", resource: "first", effect: "deny" },
      { action: "custom", resource: "second", effect: "ask" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "native", resource: "*", effect: "deny" },
    ])
  })

  test.each(["agent", "mode"])("preserves legacy %s permission source order", (key) => {
    const build = {
      tools: { write: false, read: true },
      permission: { "*": "allow", bash: "ask", custom: "deny", edit: "allow" },
    }
    // An agent's permission overrides its tools in place, like Object.assign.
    expect(normalized({ [key]: { build } }).encoded.agents).toMatchObject({
      build: {
        permissions: [
          { action: "edit", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "*", effect: "ask" },
          { action: "custom", resource: "*", effect: "deny" },
        ],
      },
    })
  })

  test("redacts permission resource keys from invalid diagnostics", () => {
    const result = normalized({
      permission: { bash: { "curl -H Authorization:Bearer TOPSECRET *": "bogus" } },
    })
    expect(result.diagnostics).toEqual([
      {
        kind: "invalid",
        path: ["permission", "bash", "0"],
        message: "skipped malformed recognized value",
      },
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain("TOPSECRET")
  })

  test("recovers list items for skills, instructions, and permissions", () => {
    const result = normalized({
      skills: { paths: ["./skills", 1], urls: [false, "https://example.com/skills"] },
      instructions: ["one", 2, "three"],
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "invalid" },
      ],
    })
    expect(result.encoded.skills).toEqual(["./skills", "https://example.com/skills"])
    expect(result.encoded.instructions).toEqual(["one", "three"])
    expect(result.encoded.permissions).toEqual([{ action: "read", resource: "*", effect: "allow" }])
    expect(result.diagnostics.filter((item) => item.kind === "invalid")).toHaveLength(4)
  })

  test("omits malformed collection roots instead of synthesizing empty values", () => {
    const result = normalized({
      commands: [],
      providers: "invalid",
      references: false,
      agents: 1,
      permissions: {},
      instructions: {},
    })
    expect(result.encoded).toEqual({})
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["references"],
      ["commands"],
      ["agents"],
      ["providers"],
      ["permissions"],
      ["instructions"],
    ])
  })

  test("omits all-invalid formatter and LSP maps while preserving explicit empty maps", () => {
    const invalid = normalized({
      formatter: { prettier: { command: [1] } },
      lsp: { typescript: { command: [1] } },
    })
    expect(invalid.encoded).not.toHaveProperty("formatter")
    expect(invalid.encoded).not.toHaveProperty("lsp")
    expect(invalid.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["formatter", "prettier"],
      ["lsp", "typescript"],
    ])

    expect(normalized({ formatter: {}, lsp: {} }).encoded).toMatchObject({ formatter: {}, lsp: {} })
  })

  test("combines legacy and native MCP servers and merges timeout leaves", () => {
    const result = normalized({
      experimental: { mcp_timeout: 5000 },
      mcp: {
        legacy: { type: "local", command: ["legacy"] },
        duplicate: { type: "remote", url: "https://legacy.example.com" },
        servers: {
          native: { type: "local", command: ["native"] },
          duplicate: { type: "remote", url: "https://native.example.com" },
          invalid: { type: "local", command: [1] },
        },
        timeout: { startup: 1000, catalog: 6000 },
      },
    })
    expect(result.encoded.mcp).toEqual({
      timeout: { catalog: 6000, execution: 5000, startup: 1000 },
      servers: {
        legacy: { type: "local", command: ["legacy"], disabled: undefined, timeout: undefined },
        duplicate: { type: "remote", url: "https://native.example.com" },
        native: { type: "local", command: ["native"] },
      },
    })
    expect(
      result.diagnostics.some((item) => item.kind === "conflict" && item.path.join(".") === "mcp.servers.duplicate"),
    ).toBe(true)
    expect(
      result.diagnostics.some((item) => item.kind === "conflict" && item.path.join(".") === "mcp.timeout.catalog"),
    ).toBe(true)
    expect(
      result.diagnostics.some((item) => item.kind === "invalid" && item.path.join(".") === "mcp.servers.invalid"),
    ).toBe(true)
  })

  test("expands numeric MCP timeouts to every phase", () => {
    const result = normalized({
      mcp: {
        timeout: 4000,
        servers: {
          local: { type: "local", command: ["local"], timeout: 6000 },
          remote: { type: "remote", url: "https://remote.example.com", timeout: 8000 },
          structured: { type: "local", command: ["structured"], timeout: { catalog: 9000 } },
          invalid: { type: "local", command: ["invalid"], timeout: -1 },
        },
      },
    })
    expect(result.encoded.mcp).toEqual({
      timeout: { startup: 4000, catalog: 4000, execution: 4000 },
      servers: {
        local: { type: "local", command: ["local"], timeout: { startup: 6000, catalog: 6000, execution: 6000 } },
        remote: {
          type: "remote",
          url: "https://remote.example.com",
          timeout: { startup: 8000, catalog: 8000, execution: 8000 },
        },
        structured: { type: "local", command: ["structured"], timeout: { catalog: 9000 } },
      },
    })
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["invalid", ["mcp", "servers", "invalid"]],
    ])
  })

  test("uses raw MCP discriminators for reserved server names", () => {
    const result = normalized({
      mcp: {
        servers: { type: "local", command: ["reserved-servers"] },
        timeout: { type: "remote", url: "https://reserved.example.com" },
      },
    })
    expect((result.encoded.mcp as { servers: Record<string, unknown> }).servers).toEqual({
      servers: { type: "local", command: ["reserved-servers"], disabled: undefined, timeout: undefined },
      timeout: { type: "remote", url: "https://reserved.example.com", disabled: undefined, timeout: undefined },
    })

    const enabledOnly = normalized({ mcp: { servers: { enabled: true }, timeout: { enabled: false } } })
    expect(enabledOnly.encoded.mcp).toBeUndefined()
    expect(enabledOnly.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["unsupported", ["mcp", "servers"]],
      ["unsupported", ["mcp", "timeout"]],
    ])
  })

  test("normalizes MCP timeout fields in schema order with per-leaf recovery", () => {
    const result = normalized({ mcp: { timeout: { execution: 3000, startup: "invalid", catalog: 2000 } } })

    expect(result.encoded.mcp).toEqual({ timeout: { catalog: 2000, execution: 3000 } })
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["invalid", ["mcp", "timeout", "startup"]],
    ])
    expect(normalized({ mcp: { timeout: {} } }).encoded.mcp).toBeUndefined()

    const unknown = normalized({ mcp: { timeout: { unknown: 1000 } } })
    expect(unknown.encoded.mcp).toBeUndefined()
    expect(unknown.diagnostics.map((item) => [item.kind, item.path])).toEqual([["invalid", ["mcp", "timeout"]]])
  })

  test("merges bounded compaction leaves and omits unsupported leaves", () => {
    const result = normalized({
      compaction: {
        auto: false,
        preserve_recent_tokens: 1000,
        keep: { tokens: 2000 },
        reserved: 3000,
        buffer: 4000,
        tail_turns: 2,
        prune: true,
      },
    })
    expect(result.encoded.compaction).toEqual({ auto: false, keep: { tokens: 2000 }, buffer: 4000 })
    expect(result.diagnostics.map((item) => [item.kind, item.path])).toEqual([
      ["unsupported", ["compaction", "tail_turns"]],
      ["unsupported", ["compaction", "prune"]],
      ["conflict", ["compaction", "keep", "tokens"]],
      ["conflict", ["compaction", "buffer"]],
    ])
  })

  test("distinguishes empty, mixed, and wholly malformed enabled provider lists", () => {
    expect(normalized({ enabled_providers: [] }).encoded.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
    ])
    expect(normalized({ enabled_providers: [1, "anthropic", false] }).encoded.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "anthropic", effect: "allow" },
    ])
    expect(normalized({ enabled_providers: [1, false] }).encoded.policies).toBeUndefined()
    expect(normalized({ enabled_providers: "anthropic" }).encoded.policies).toBeUndefined()
  })

  test("merges migrated, experimental, and native policies in order", () => {
    expect(
      normalized({
        enabled_providers: ["anthropic"],
        disabled_providers: ["openai"],
        policies: [{ action: "provider.use", resource: "native", effect: "deny" }],
        experimental: {
          portable_shell_scanner: true,
          subagent_depth: 0,
          policies: [{ action: "provider.use", resource: "custom", effect: "allow" }],
        },
      }).encoded,
    ).toMatchObject({
      experimental: { portable_shell_scanner: true, subagent_depth: 0 },
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "anthropic", effect: "allow" },
        { action: "provider.use", resource: "openai", effect: "deny" },
        { action: "provider.use", resource: "custom", effect: "allow" },
        { action: "provider.use", resource: "native", effect: "deny" },
      ],
    })
  })

  test("passes through the experimental shell timeout and drops invalid values", () => {
    expect(normalized({ experimental: { shell_timeout: 300000 } }).encoded).toMatchObject({
      experimental: { shell_timeout: 300000 },
    })
    expect(normalized({ experimental: { shell_timeout: 0 } }).encoded).toMatchObject({
      experimental: { shell_timeout: 0 },
    })
    expect(normalized({ experimental: { shell_timeout: -1 } }).encoded.experimental).toBeUndefined()
    expect(decoded({ experimental: { shell_timeout: 300000 } }).experimental?.shell_timeout).toBe(300000)
  })

  test("never emits experimental policies", () => {
    expect(
      normalized({ experimental: { policies: [{ action: "provider.use", resource: "*", effect: "deny" }] } }).encoded,
    ).toEqual({ policies: [{ action: "provider.use", resource: "*", effect: "deny" }] })
  })

  test("reports unsupported legacy settings without including their values", () => {
    const secret = "do-not-log-this-value"
    const result = normalized({
      logLevel: "DEBUG",
      agent: { reviewer: { name: secret, prompt: "review" } },
      provider: {
        custom: {
          id: secret,
          whitelist: ["model"],
          models: {
            model: {
              release_date: secret,
              status: "active",
              interleaved: true,
            },
          },
        },
      },
      experimental: { openTelemetry: true },
    })
    expect(result.diagnostics.filter((item) => item.kind === "unsupported").map((item) => item.path)).toEqual([
      ["logLevel"],
      ["agent", "reviewer", "name"],
      ["provider", "custom", "id"],
      ["provider", "custom", "whitelist"],
      ["provider", "custom", "models", "model", "release_date"],
      ["provider", "custom", "models", "model", "status"],
      ["provider", "custom", "models", "model", "interleaved"],
      ["experimental", "openTelemetry"],
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })

  test("diagnoses unsupported legacy model selections without dropping their entries", () => {
    const result = normalized({
      command: {
        invalidModel: { template: "one", model: "invalid" },
        invalidVariant: { template: "two", model: "anthropic/model", variant: "bad#variant" },
        missingModel: { template: "three", variant: "high" },
      },
      agent: { invalid: { prompt: "agent", model: "invalid", variant: "" } },
    })
    expect(Object.keys(result.encoded.commands as Record<string, unknown>)).toEqual([
      "invalidModel",
      "invalidVariant",
      "missingModel",
    ])
    expect(Object.keys(result.encoded.agents as Record<string, unknown>)).toEqual(["invalid"])
    expect(result.diagnostics.filter((item) => item.kind === "unsupported").map((item) => item.path)).toEqual([
      ["command", "invalidModel", "model"],
      ["command", "invalidVariant", "variant"],
      ["command", "missingModel", "variant"],
      ["agent", "invalid", "model"],
      ["agent", "invalid", "variant"],
    ])
  })

  test("migrates the legacy thinking block-binding opt-out into model compatibility", () => {
    const result = normalized({
      provider: {
        gateway: {
          models: {
            anthropic: { options: { thinking: { type: "adaptive", blockBinding: false }, effort: "high" } },
            bedrock: { options: { reasoningConfig: { blockBinding: false } } },
            both: {
              options: {
                thinking: { type: "adaptive", blockBinding: false },
                reasoningConfig: { type: "adaptive", blockBinding: false },
              },
            },
            untouched: { options: { thinking: { type: "adaptive" } } },
          },
        },
      },
    })
    expect(result.encoded.providers).toMatchObject({
      gateway: {
        models: {
          anthropic: {
            compatibility: { supportsThinkingBlockBinding: false },
            settings: { thinking: { type: "adaptive" }, effort: "high" },
          },
          bedrock: { compatibility: { supportsThinkingBlockBinding: false }, settings: {} },
          both: {
            compatibility: { supportsThinkingBlockBinding: false },
            settings: { thinking: { type: "adaptive" }, reasoningConfig: { type: "adaptive" } },
          },
          untouched: { settings: { thinking: { type: "adaptive" } } },
        },
      },
    })
    expect(result.encoded.providers).not.toHaveProperty(["gateway", "models", "bedrock", "settings", "reasoningConfig"])
    expect(result.encoded.providers).not.toHaveProperty([
      "gateway",
      "models",
      "both",
      "settings",
      "thinking",
      "blockBinding",
    ])
    expect(result.encoded.providers).not.toHaveProperty([
      "gateway",
      "models",
      "both",
      "settings",
      "reasoningConfig",
      "blockBinding",
    ])
    expect(result.encoded.providers).not.toHaveProperty(["gateway", "models", "untouched", "compatibility"])
  })

  test("migrates the legacy setCacheKey provider option into provider compatibility", () => {
    const result = normalized({
      provider: {
        proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://proxy.test/v1", setCacheKey: true } },
        openai: { options: { setCacheKey: false } },
        untouched: { options: { baseURL: "https://untouched.test/v1" } },
      },
    })
    expect(result.encoded.providers).toMatchObject({
      proxy: { compatibility: { supportsPromptCacheKey: true }, settings: { baseURL: "https://proxy.test/v1" } },
      openai: { compatibility: { supportsPromptCacheKey: false } },
    })
    expect(result.encoded.providers).not.toHaveProperty(["proxy", "settings", "setCacheKey"])
    expect(result.encoded.providers).not.toHaveProperty(["openai", "settings", "setCacheKey"])
    expect(result.encoded.providers).not.toHaveProperty(["untouched", "compatibility"])
  })

  test("invalid legacy provider overlays skip only that provider", () => {
    const result = normalized({
      provider: {
        headers: { options: { headers: { valid: "yes", invalid: 1 } } },
        body: { options: { body: "not-an-object" } },
        valid: { options: { headers: { valid: "yes" }, body: { trace: true } } },
      },
    })
    expect(result.encoded.providers).toEqual({
      valid: { settings: {}, headers: { valid: "yes" }, body: { trace: true } },
    })
    expect(result.diagnostics.filter((item) => item.kind === "invalid").map((item) => item.path)).toEqual([
      ["provider", "headers", "options", "headers"],
      ["provider", "body", "options", "body"],
    ])
  })

  test("preserves explicit false, zero, empty list, and empty map presence", () => {
    const result = normalized({
      snapshot: false,
      autoshare: false,
      references: {},
      commands: {},
      agents: {},
      providers: {},
      instructions: [],
      experimental: { subagent_depth: 0 },
    })
    expect(result.encoded).toMatchObject({
      snapshots: false,
      references: {},
      commands: {},
      agents: {},
      providers: {},
      instructions: [],
      experimental: { subagent_depth: 0 },
    })
    expect(result.encoded.share).toBeUndefined()
  })
})

describe("model route tuning and log settings", () => {
  const experimentalOf = (encoded: Readonly<Record<string, unknown>>) =>
    encoded.experimental as
      | {
          model_route_tuning?: ModelRouteTuning.Settings
          model_route_log?: { captureErrorBodies?: boolean }
        }
      | undefined

  test("notes survive normalization and reach the tuner as match and text", () => {
    const result = ConfigNormalize.normalize({
      experimental: {
        model_route_tuning: {
          enabled: true,
          notes: [
            "anthropic/claude-opus-5: promo credits, reset at 2026-01-04T00:00:00Z",
            "openai/gpt-6-luna: out of quota, back in 3 hours",
          ],
        },
      },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    const notes = ModelRouteTuning.parseNotes(experimentalOf(result.encoded)?.model_route_tuning?.notes)
    expect(notes).toEqual([
      { match: "anthropic/claude-opus-5", text: "promo credits, reset at 2026-01-04T00:00:00Z" },
      { match: "openai/gpt-6-luna", text: "out of quota, back in 3 hours" },
    ])
    const adjustments = ModelRouteTuning.noteAdjustments(notes, Date.parse("2026-01-03T00:00:00Z"), 60_000)
    expect(adjustments.find((item) => item.match === "anthropic/claude-opus-5")).toMatchObject({
      action: "skip",
      until: Date.parse("2026-01-04T00:00:00Z"),
    })
  })

  test("a malformed note is dropped on its own, and the block and its other notes are kept", () => {
    const result = ConfigNormalize.normalize({
      experimental: {
        model_route_tuning: {
          enabled: true,
          notes: [
            "openai/gpt-6-luna: out of quota, back in 3 hours",
            "no separator here",
            "anthropic/claude-opus-5: promo credits",
          ],
        },
      },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    expect(result.diagnostics).toEqual([
      {
        kind: "invalid",
        path: ["experimental", "model_route_tuning", "notes", "1"],
        message:
          "omitted malformed note: expected match: text, with a non-empty match before the first colon and non-empty text after it",
      },
    ])
    expect(experimentalOf(result.encoded)?.model_route_tuning).toEqual({
      enabled: true,
      notes: ["openai/gpt-6-luna: out of quota, back in 3 hours", "anthropic/claude-opus-5: promo credits"],
    })
  })

  test("each malformed shape is dropped with a diagnostic for its line: no match, no text, no colon, or a line break", () => {
    const result = ConfigNormalize.normalize({
      experimental: {
        model_route_tuning: { enabled: true, notes: [":x:y", "x:", "no colon", "x: y\nz", "match: text"] },
      },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    const message =
      "omitted malformed note: expected match: text, with a non-empty match before the first colon and non-empty text after it"
    expect(result.diagnostics).toEqual(
      ["0", "1", "2", "3"].map((index) => ({
        kind: "invalid",
        path: ["experimental", "model_route_tuning", "notes", index],
        message,
      })),
    )
    expect(experimentalOf(result.encoded)?.model_route_tuning).toEqual({ enabled: true, notes: ["match: text"] })
  })

  test("a second colon belongs to the text, so x::y is kept", () => {
    const result = ConfigNormalize.normalize({
      experimental: { model_route_tuning: { notes: ["x::y"] } },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    expect(result.diagnostics).toEqual([])
    expect(ModelRouteTuning.parseNotes(experimentalOf(result.encoded)?.model_route_tuning?.notes)).toEqual([
      { match: "x", text: ":y" },
    ])
  })

  test("an unknown key under the tuning block is named in a diagnostic and the rest is kept", () => {
    const result = ConfigNormalize.normalize({
      experimental: { model_route_tuning: { enabled: true, intervalMinutes: 30, intervall: 5 } },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    expect(result.diagnostics).toContainEqual({
      kind: "invalid",
      path: ["experimental", "model_route_tuning", "intervall"],
      message: "omitted unknown setting",
    })
    expect(experimentalOf(result.encoded)?.model_route_tuning).toEqual({ enabled: true, intervalMinutes: 30 })
  })

  test("captureErrorBodies is kept through normalization, and an unknown log key is reported", () => {
    const result = ConfigNormalize.normalize({
      experimental: { model_route_log: { captureErrorBodies: true, captureErrorBody: true } },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    expect(experimentalOf(result.encoded)?.model_route_log).toEqual({ captureErrorBodies: true })
    expect(result.diagnostics).toContainEqual({
      kind: "invalid",
      path: ["experimental", "model_route_log", "captureErrorBody"],
      message: "omitted unknown setting",
    })
  })
})

describe("model route cache formats", () => {
  const routesOf = (encoded: Readonly<Record<string, unknown>>) =>
    (encoded.experimental as { model_routes?: Record<string, unknown> } | undefined)?.model_routes

  test("a route and a target decode the compatibility cache format values", () => {
    const value = decoded({
      experimental: {
        model_routes: {
          pool: {
            cache_format: "anthropic",
            targets: ["openai/gpt-6-luna", { model: "anthropic/claude-sonnet-5", cache_format: "alibaba" }],
          },
        },
      },
    })
    const pool = value.experimental?.model_routes?.pool
    expect(pool?.cache_format).toBe("anthropic")
    expect(JSON.parse(JSON.stringify(pool?.targets))).toEqual([
      { providerID: "openai", model: "gpt-6-luna" },
      { model: { providerID: "anthropic", model: "claude-sonnet-5" }, cache_format: "alibaba" },
    ])
  })

  test("an unknown cache_format rejects the route at decode instead of being dropped", () => {
    const result = ConfigNormalize.normalize({
      experimental: {
        model_routes: {
          badRoute: { cache_format: "bedrock-converse", targets: ["openai/gpt-6-luna"] },
          badTarget: { targets: [{ model: "openai/gpt-6-luna", cache_format: "anthropic-breakpoints" }] },
          good: { cache_format: "alibaba", targets: ["openai/gpt-6-luna"] },
        },
      },
    })
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      ["experimental", "model_routes", "badRoute"],
      ["experimental", "model_routes", "badTarget"],
    ])
    expect(routesOf(result.encoded)).toEqual({
      good: { cache_format: "alibaba", targets: [{ providerID: "openai", model: "gpt-6-luna" }] },
    })
  })
})

describe("provider routes and route settings survive normalization", () => {
  test("experimental.provider_routes reaches the decoded config (the 2026-11-01 production collapse shape)", () => {
    const value = decoded({
      provider: {
        openai: {
          models: {
            "gpt-6-luna": { limit: { context: 1050000, output: 128000 } },
            "gpt-6.1-terra": { limit: { context: 1050000, output: 128000 } },
            "gpt-6.1-sol": { limit: { context: 1050000, output: 128000 } },
          },
        },
        "openai.alternate": { instanceOf: "openai", name: "OpenAI Alternate (Student - popesdrew)" },
      },
      experimental: {
        provider_routes: {
          "openai-plan": { providers: ["openai.alternate", "openai"], selection: "ordered" },
        },
        model_routes: {
          "luna-plan": {
            targets: ["openai-plan/gpt-6-luna"],
            selection: "round-robin",
            autonomy: "rules",
            weights: { "openai-plan/gpt-6-luna": 2.5 },
          },
        },
      },
    })
    const group = value.experimental?.provider_routes?.["openai-plan"]
    expect(group?.providers).toEqual(["openai.alternate", "openai"])
    expect(group?.selection).toBe("ordered")
    expect(value.experimental?.model_routes?.["luna-plan"]?.targets).toHaveLength(1)
  })

  test("experimental.model_route_settings reaches the decoded config", () => {
    const value = decoded({
      experimental: { model_route_settings: { bench: { multiplier: 3 } } },
    })
    expect(value.experimental?.model_route_settings?.bench?.multiplier).toBe(3)
  })
})
