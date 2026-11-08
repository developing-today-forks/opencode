import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_context_vars_test")
const detachedSessionID = SessionSchema.ID.make("ses_context_detached_test")
const empty = { load: () => Effect.succeed(Instructions.empty) }
const disabledTools: (ReadonlySet<string> | undefined)[] = []

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionDiscovery.node,
      SessionContext.node,
      PluginHooks.node,
    ]),
    [
      InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, empty)),
      SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, empty)),
      ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, empty)),
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, empty)),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: (_permissions, disabled) =>
            Effect.sync(() => {
              disabledTools.push(disabled)
              return { definitions: [], execute: () => Effect.die(new Error("unused")) }
            }),
        }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

it.effect("renders session variables in instruction files that opt in through frontmatter", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projects = yield* Project.Service
    const agents = yield* Agent.Service
    const discovery = yield* InstructionDiscovery.Service
    const context = yield* SessionContext.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      }),
    )
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: "context-vars",
        directory: "/project",
        title: "Context vars",
        version: "test",
        agent: Agent.ID.make("build"),
      })
      .run()
      .pipe(Effect.orDie)
    yield* discovery.transform((editor) => {
      editor.add(
        new InstructionDiscovery.File({
          path: "/project/AGENTS.md",
          content: "---\nvars: true\n---\nYou are {session_title} ({session_id}); keep {unknown}.",
        }),
      )
      editor.add(new InstructionDiscovery.File({ path: "/project/PLAIN.md", content: "Literal {session_id}." }))
    })

    const selection = yield* context.select(sessionID)
    const observed = yield* Instructions.read(selection.instructions)
    expect(disabledTools.at(-1)).toBeUndefined()
    const values = Object.fromEntries(
      observed.flatMap((entry) => (typeof entry.value === "object" ? [[entry.key, entry.value]] : [])),
    )
    expect(Instructions.renderInitial(selection.instructions, values)).toBe(
      [
        `Instructions from: /project/AGENTS.md\nYou are Context vars (${sessionID}); keep {unknown}.`,
        "Instructions from: /project/PLAIN.md\nLiteral {session_id}.",
      ].join("\n\n"),
    )
  }),
)

it.effect("passes detached tool exclusions from the stored session into its tool snapshot", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projects = yield* Project.Service
    const agents = yield* Agent.Service
    const context = yield* SessionContext.Service
    disabledTools.length = 0
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      }),
    )
    yield* db
      .insert(SessionTable)
      .values({
        id: detachedSessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: "context-detached",
        directory: "/project",
        version: "test",
        agent: Agent.ID.make("build"),
        detached: true,
      })
      .run()
      .pipe(Effect.orDie)

    yield* context.select(detachedSessionID)

    expect(disabledTools.at(-1)?.has("question")).toBe(true)
  }),
)
