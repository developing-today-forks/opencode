import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020.js"
import { Effect, Schema, SchemaGetter } from "effect"
import { z } from "zod"
import { convertSchema } from "@opencode/ai/protocols/antigravity"
import { emptyInputJsonSchema } from "@opencode/ai/tool"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { GlobTool } from "@opencode/core/tool/plugin/glob"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { McpResourceTools } from "@opencode/core/tool/plugin/mcp-resource"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"
import { MessagingTools } from "@opencode/core/tool/plugin/messaging"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { PlanInfoTool } from "@opencode/core/tool/plugin/plan-info"
import { PtyTool } from "@opencode/core/tool/plugin/pty"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { RouteAdjustTool } from "@opencode/core/tool/plugin/route-adjust"
import { RouteStatsTool } from "@opencode/core/tool/plugin/route-stats"
import { RouteUsageTool } from "@opencode/core/tool/plugin/route-usage"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { WebFetchTool } from "@opencode/core/tool/plugin/webfetch"
import { WebSearchTool } from "@opencode/core/tool/plugin/websearch"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Info } from "@opencode/schema/tool"
import { Tool } from "../src/tool"
import { definition, execute } from "../src/tool/runtime"

const builtinInputs: ReadonlyArray<{ name: string; input: Info["input"] }> = [
  { name: "edit", input: EditTool.Input },
  { name: "glob", input: GlobTool.Input },
  { name: "grep", input: GrepTool.Input },
  { name: "opencode_list_mcp_resources", input: McpResourceTools.ListInput },
  { name: "opencode_read_mcp_resource", input: McpResourceTools.ReadInput },
  { name: "mcpx_exec", input: McpxTool.ExecInput },
  { name: "mcpx_discover", input: McpxTool.DiscoverInput },
  { name: "opencode_mcpx_observe", input: McpxTool.ObserveInput },
  { name: "mcpx_project", input: McpxTool.ProjectInput },
  { name: "mcpx_retract", input: McpxTool.RetractInput },
  { name: "comms_msg", input: MessagingTools.MsgInput },
  { name: "comms_topics", input: MessagingTools.TopicsInput },
  { name: "comms_sessions", input: MessagingTools.SessionsInput },
  { name: "opencode_session_rename", input: OpenCodeTools.RenameInput },
  { name: "opencode_session_move", input: OpenCodeTools.MoveInput },
  { name: "opencode_worktree_create", input: OpenCodeTools.WorktreeCreateInput },
  { name: "opencode_worktree_list", input: OpenCodeTools.WorktreeListInput },
  { name: "opencode_worktree_remove", input: OpenCodeTools.WorktreeRemoveInput },
  { name: "opencode_models", input: OpenCodeTools.ModelsInput },
  { name: "patch", input: PatchTool.Input },
  { name: PlanInfoTool.name, input: PlanInfoTool.Input },
  { name: RouteAdjustTool.name, input: RouteAdjustTool.Input },
  { name: RouteStatsTool.name, input: RouteStatsTool.Input },
  { name: RouteUsageTool.name, input: RouteUsageTool.Input },
  { name: "pty", input: PtyTool.Input },
  { name: "question", input: QuestionTool.Input },
  { name: "read", input: ReadTool.Input },
  { name: "shell", input: ShellTool.Input },
  { name: "skill", input: SkillTool.Input },
  { name: "subagent", input: SubagentTool.Input },
  { name: "webfetch", input: WebFetchTool.Input },
  { name: "websearch", input: WebSearchTool.Input },
  { name: "write", input: WriteTool.Input },
]

const context = {
  sessionID: Session.ID.make("ses_tool_schema"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_tool_schema"),
  id: Tool.CallID.make("call_tool_schema"),
  progress: () => Effect.void,
} satisfies Tool.Context

test("tools are structural values", async () => {
  const config = {
    name: "foreign",
    description: "Foreign tool",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ output: { ok: true } }),
  }
  const tool: Info = config

  expect(definition(tool)).toEqual({
    type: "tool",
    name: "foreign",
    description: "Foreign tool",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  })
})

test("Effect tool schemas use exact optional keys and flatten compatible constraints", () => {
  const tool: Info = {
    name: "constraints",
    description: "Constraints",
    input: Schema.Struct({
      offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      code: Schema.String.check(Schema.isPattern(/^a/u), Schema.isPattern(/z$/u)),
    }),
    execute: () => Effect.succeed({ content: "unused" }),
  }

  expect(definition(tool).inputSchema).toEqual({
    type: "object",
    properties: {
      offset: { type: "integer", minimum: 0 },
      code: { type: "string", pattern: "^a", allOf: [{ pattern: "z$" }] },
    },
    required: ["code"],
    additionalProperties: false,
  })
})

test.each([
  { name: "plain", input: Schema.Struct({}), metadata: {} },
  {
    name: "annotated",
    input: Schema.Struct({}).annotate({ identifier: "Empty Input", description: "No parameters" }),
    metadata: { description: "No parameters" },
  },
])("empty $name Effect input structs describe callable object parameters", async ({ input, metadata }) => {
  const tool: Info = {
    name: "empty",
    description: "Empty tool",
    input,
    output: input,
    execute: (value) => Effect.succeed({ output: value }),
  }
  expect(definition(tool).inputSchema).toEqual({
    ...metadata,
    type: "object",
    properties: {},
    additionalProperties: false,
  })
  expect(definition(tool).outputSchema).toEqual({ ...metadata, not: { type: "null" } })
  expect(await Effect.runPromise(execute(tool, {}, context))).toMatchObject({ output: {} })
})

test("empty input normalization preserves explicit Effect overrides and raw JSON schemas", () => {
  for (const override of [{ type: "object", additionalProperties: true }, { not: { type: "null" } }]) {
    const tool: Info = {
      name: "explicit",
      description: "Explicit schema tool",
      input: override,
      execute: () => Effect.succeed({ content: "unused" }),
    }
    expect(definition(tool).inputSchema).toEqual(override)
    const checked = Schema.Struct({}).check(Schema.makeFilter(() => true, { toJsonSchema: () => override }))
    expect(definition({ ...tool, output: checked }).outputSchema).toEqual(
      definition({ ...tool, input: checked }).inputSchema,
    )
  }
})

// Projection rules are covered by @opencode/ai; core must delegate to them and execute the decoded input.
test("Effect inputs delegate empty-input projection to the shared helper", async () => {
  // Callers send `{}`; the handler receives a token.
  const defaulted = Schema.Struct({}).pipe(
    Schema.decodeTo(Schema.Struct({ token: Schema.String }), {
      decode: SchemaGetter.transform(() => ({ token: "default" })),
      encode: SchemaGetter.transform(() => ({})),
    }),
  )
  const checked = Schema.Struct({}).check(Schema.isMinProperties(1))
  const tool = (input: Schema.Codec<unknown, unknown>): Info => ({
    name: "delegated",
    description: "Delegated input",
    input,
    execute: (value) => Effect.succeed({ content: JSON.stringify(value) }),
  })

  expect(emptyInputJsonSchema(defaulted)).toEqual(definition(tool(defaulted)).inputSchema)
  expect(definition(tool(defaulted)).inputSchema).toEqual({
    type: "object",
    properties: {},
    additionalProperties: false,
  })
  expect(emptyInputJsonSchema(checked)).toBeUndefined()
  expect(definition(tool(checked)).inputSchema).toEqual({ not: { type: "null" }, minProperties: 1 })
  expect(await Effect.runPromise(execute(tool(defaulted), {}, context))).toMatchObject({
    content: [{ type: "text", text: JSON.stringify({ token: "default" }) }],
  })
})

test("empty input normalization leaves nested empty structs unchanged", () => {
  const tool: Info = {
    name: "nested",
    description: "Nested empty struct",
    input: Schema.Struct({ value: Schema.Struct({}) }),
    execute: () => Effect.succeed({ content: "unused" }),
  }
  expect(definition(tool).inputSchema).toEqual({
    type: "object",
    properties: { value: { not: { type: "null" } } },
    required: ["value"],
    additionalProperties: false,
  })
})

test("Effect tool schemas inline named child schemas", () => {
  const Child = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Child" })
  const tool: Info = {
    name: "references",
    description: "References",
    input: Schema.Struct({ child: Child.annotate({ description: "Child value" }) }),
    execute: () => Effect.succeed({ content: "unused" }),
  }

  expect(definition(tool).inputSchema).toEqual({
    type: "object",
    properties: {
      child: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
        description: "Child value",
      },
    },
    required: ["child"],
    additionalProperties: false,
  })
})

test("Effect tool schemas resolve escaped definition names", () => {
  const Slash = Schema.Struct({ slash: Schema.String }).annotate({ identifier: "A/B" })
  const Tilde = Schema.Struct({ tilde: Schema.String }).annotate({ identifier: "A~B" })
  const tool: Info = {
    name: "escaped-references",
    description: "Escaped references",
    input: Schema.Struct({ slash: Slash, tilde: Tilde }),
    execute: () => Effect.succeed({ content: "unused" }),
  }

  expect(JSON.stringify(definition(tool).inputSchema)).not.toContain("$ref")
  expect(JSON.stringify(definition(tool).inputSchema)).not.toContain("$defs")
})

test.each(["Lookup Input", "café", "A/B~C% D#E"])(
  "Effect tool schemas inline URI-encoded definition %s",
  (identifier) => {
    const child = Schema.Struct({ city: Schema.String }).annotate({ identifier })
    const tool: Info = {
      name: "encoded-reference",
      description: "Encoded reference",
      input: child,
      output: Schema.Struct({ result: child }),
      execute: () => Effect.succeed({ content: "unused" }),
    }
    const expected = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    }
    expect(definition(tool).inputSchema).toEqual(expected)
    expect(definition(tool).outputSchema).toEqual({
      type: "object",
      properties: { result: expected },
      required: ["result"],
      additionalProperties: false,
    })
  },
)

test("portable schemas validate and describe typed tools", async () => {
  const input = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => {
        if (typeof value !== "object" || value === null || !("count" in value) || typeof value.count !== "string")
          return { issues: [{ message: "count must be numeric" }] }
        const count = Number(value.count)
        return Number.isFinite(count) ? { value: { count } } : { issues: [{ message: "count must be numeric" }] }
      },
      jsonSchema: {
        input: () => ({ type: "object", properties: { count: { type: "string" } } }),
        output: () => ({ type: "object", properties: { count: { type: "number" } } }),
      },
    },
  }
  const output = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value: String(value) }),
      jsonSchema: {
        input: () => ({ type: "number" }),
        output: () => ({ type: "string" }),
      },
    },
  }
  const tool: Info = {
    name: "portable",
    description: "Portable tool",
    input,
    output,
    execute: ({ count }) => Effect.succeed({ output: count + 1 }),
  }

  expect(definition(tool)).toEqual({
    type: "tool",
    name: "portable",
    description: "Portable tool",
    inputSchema: { type: "object", properties: { count: { type: "string" } } },
    outputSchema: { type: "string" },
  })
  const result = await Effect.runPromise(execute(tool, { count: "41" }, context))
  expect(result.output).toBe("42")
})

test("Zod schemas validate, transform, and describe typed tools", async () => {
  const tool: Info = {
    name: "zod",
    description: "Zod tool",
    input: z.object({ count: z.string().transform(Number) }),
    output: z.object({ count: z.number() }),
    execute: ({ count }) => Effect.succeed({ output: { count: count + 1 } }),
  }

  expect(definition(tool)).toEqual({
    type: "tool",
    name: "zod",
    description: "Zod tool",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { count: { type: "string" } },
      required: ["count"],
    },
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
      additionalProperties: false,
    },
  })
  expect(await Effect.runPromise(execute(tool, { count: "41" }, context))).toMatchObject({
    output: { count: 42 },
  })
  expect(await Effect.runPromise(Effect.flip(execute(tool, { count: 41 }, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "zod":\n- count: Invalid input: expected string, received number\n\nArguments provided:\n{\n  "count": 41\n}\n\nUpdate the arguments and call the tool again.',
    }),
  )
})

test("portable schema failures become tool failures", async () => {
  const input = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (_value: unknown) => ({
        issues: [
          { path: ["value"], message: "expected a string" },
          { path: [{ key: "nested" }, { key: "count" }], message: "expected a positive integer" },
        ],
      }),
      jsonSchema: {
        input: () => ({ type: "string" }),
        output: () => ({ type: "string" }),
      },
    },
  }

  const error = await Effect.runPromise(
    Effect.flip(
      execute(
        {
          name: "invalid",
          description: "Invalid",
          input,
          execute: () => Effect.succeed({ content: "unused" }),
        },
        1,
        context,
      ),
    ),
  )
  expect(error).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "invalid":\n- value: expected a string\n- nested.count: expected a positive integer\n\nArguments provided:\n1\n\nUpdate the arguments and call the tool again.',
    }),
  )
})

test("Effect schema failures use normalized input issues", async () => {
  const tool: Info = {
    name: "effect",
    description: "Effect tool",
    input: Schema.Struct({
      value: Schema.String,
      nested: Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    }),
    execute: () => Effect.succeed({ content: "unused" }),
  }

  expect(await Effect.runPromise(Effect.flip(execute(tool, { value: 1, nested: { count: 0 } }, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "effect":\n- value: Expected string\n- nested.count: Expected a value greater than or equal to 1\n\nArguments provided:\n{\n  "value": 1,\n  "nested": {\n    "count": 0\n  }\n}\n\nUpdate the arguments and call the tool again.',
    }),
  )
})

test("input error prompts limit normalized issues", async () => {
  const input = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (_value: unknown) => ({
        issues: Array.from({ length: 6 }, (_, index) => ({ message: `issue ${index + 1}` })),
      }),
      jsonSchema: {
        input: () => ({}),
        output: () => ({}),
      },
    },
  }
  const tool: Info = {
    name: "limited",
    description: "Limited issues",
    input,
    execute: () => Effect.succeed({ content: "unused" }),
  }

  expect(await Effect.runPromise(Effect.flip(execute(tool, {}, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "limited":\n- root: issue 1\n- root: issue 2\n- root: issue 3\n- root: issue 4\n- root: issue 5\n- ...and 1 more issue\n\nArguments provided:\n{}\n\nUpdate the arguments and call the tool again.',
    }),
  )
})

test("canonical results carry metadata with typed output", async () => {
  const input = Schema.Struct({ value: Schema.String })
  const output = Schema.Struct({ value: Schema.String, internal: Schema.Boolean })
  const tool: Info = {
    name: "annotated",
    description: "Annotated tool",
    input,
    output,
    execute: ({ value }) => Effect.succeed({ output: { value, internal: true }, metadata: { value }, content: value }),
  }

  expect(await Effect.runPromise(tool.execute({ value: "out" }, context))).toEqual({
    output: { value: "out", internal: true },
    metadata: { value: "out" },
    content: "out",
  })
})

test("raw JSON schemas validate and decode tool input", async () => {
  const input = {
    type: "object",
    properties: {
      value: { type: "string" },
      nested: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 } },
        required: ["count"],
        additionalProperties: false,
      },
    },
    required: ["value"],
    additionalProperties: false,
  }
  const tool: Info = {
    name: "raw",
    description: "Raw tool",
    input,
    execute: (input) => Effect.succeed({ content: JSON.stringify(input) }),
  }

  expect(definition(tool)).toEqual({
    type: "tool",
    name: "raw",
    description: "Raw tool",
    inputSchema: input,
  })
  expect(await Effect.runPromise(execute(tool, { value: "ok", extra: true }, context))).toEqual({
    output: undefined,
    content: [{ type: "text", text: '{"value":"ok"}' }],
  })
  expect(await Effect.runPromise(Effect.flip(execute(tool, { value: 1 }, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "raw":\n- value: Expected string\n\nArguments provided:\n{\n  "value": 1\n}\n\nUpdate the arguments and call the tool again.',
    }),
  )
  expect(await Effect.runPromise(Effect.flip(execute(tool, {}, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "raw":\n- value: Missing key\n\nArguments provided:\n{}\n\nUpdate the arguments and call the tool again.',
    }),
  )
  expect(await Effect.runPromise(Effect.flip(execute(tool, { value: "ok", nested: { count: 0 } }, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "raw":\n- nested.count: Expected a value greater than or equal to 1\n\nArguments provided:\n{\n  "value": "ok",\n  "nested": {\n    "count": 0\n  }\n}\n\nUpdate the arguments and call the tool again.',
    }),
  )
  expect(await Effect.runPromise(Effect.flip(execute(tool, { value: 1, nested: { count: 0 } }, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "raw":\n- value: Expected string\n- nested.count: Expected a value greater than or equal to 1\n\nArguments provided:\n{\n  "value": 1,\n  "nested": {\n    "count": 0\n  }\n}\n\nUpdate the arguments and call the tool again.',
    }),
  )
})

test("raw JSON schemas resolve draft-07 definitions", async () => {
  const tool: Info = {
    name: "draft-07",
    description: "Draft-07 tool",
    input: {
      type: "object",
      properties: { value: { $ref: "#/definitions/value" } },
      required: ["value"],
      definitions: { value: { type: "string" } },
    },
    execute: (input) => Effect.succeed({ content: JSON.stringify(input) }),
  }

  expect(await Effect.runPromise(execute(tool, { value: "ok" }, context))).toMatchObject({
    content: [{ type: "text", text: '{"value":"ok"}' }],
  })
  expect(await Effect.runPromise(Effect.flip(execute(tool, { value: 1 }, context)))).toEqual(
    new Tool.Error({
      message:
        'Invalid arguments for tool "draft-07":\n- value: Expected value\n\nArguments provided:\n{\n  "value": 1\n}\n\nUpdate the arguments and call the tool again.',
    }),
  )
})

test("raw JSON schemas pass input through when they cannot be imported", async () => {
  const tool: Info = {
    name: "invalid-schema",
    description: "Invalid schema tool",
    input: {
      type: "object",
      properties: { value: { $ref: "#/$defs/missing" } },
    },
    execute: (input) => Effect.succeed({ content: JSON.stringify(input) }),
  }

  expect(await Effect.runPromise(execute(tool, { value: 1, extra: true }, context))).toMatchObject({
    content: [{ type: "text", text: '{"value":1,"extra":true}' }],
  })
})

test("missing external input schemas fall back to an empty schema", () => {
  const tool = {
    name: "external",
    description: "External tool",
    input: undefined,
    execute: () => Effect.succeed({ content: "unused" }),
  } as unknown as Info

  expect(definition(tool)).toEqual({
    type: "tool",
    name: "external",
    description: "External tool",
    inputSchema: {},
  })
})

test("built-in tool input schemas satisfy the official draft 2020-12 meta-schema", () => {
  const validator = new Ajv2020({ allErrors: true, strict: false })

  for (const { name, input } of builtinInputs) {
    const schema = definition({
      name,
      description: name,
      input,
      execute: () => Effect.succeed({ content: "" }),
    }).inputSchema

    // Anthropic Messages sends this schema verbatim as input_schema. Antigravity
    // turns it into the provider's protobuf Schema, so that result is not itself
    // JSON Schema; still exercise the Anthropic-target conversion on each input.
    convertSchema(schema, true)
    expect(validator.validateSchema(schema), `${name}: ${validator.errorsText()}`).toBe(true)
  }
})
