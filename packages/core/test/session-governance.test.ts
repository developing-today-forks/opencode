import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Directory, type Entry } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { ConfigAgentDocuments } from "@opencode/core/config/agent-documents"
import { NotFoundError } from "@opencode/core/session"
import { SessionSchema } from "@opencode/core/session/schema"
import { SubagentDepth } from "@opencode/core/session/subagent-depth"
import { FSUtil } from "@opencode/util/fs-util"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionStore } from "@opencode/core/session/store"
import { ModelGovernance } from "@opencode/core/session/model-governance"
import { EventTable } from "@opencode/core/event/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = (id: string) => Model.Ref.make({ id: Model.ID.make(id), providerID: Provider.ID.make("test") })

describe("Session model governance", () => {
  it.effect("stores the policy given at create and denies a forbidden child, creating nothing", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        subagentPolicy: { models: ["test/allowed"] },
      })
      expect(parent.subagentPolicy).toEqual({ models: ["test/allowed"] })

      const error = yield* session
        .create({ parentID: parent.id, agent: Agent.ID.make("worker"), model: model("denied") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((error as ModelGovernance.DeniedError).message).toContain("test/allowed")
      expect((yield* session.list()).data).toEqual([parent])

      const child = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("worker"),
        model: model("allowed"),
      })
      expect(child.parentID).toBe(parent.id)
      expect((yield* session.list()).data).toHaveLength(2)
    }),
  )

  it.effect("setSubagentPolicy applies live to later launches without a restart", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, model: model("kept") })

      const before = yield* session.create({ parentID: parent.id, model: model("kept") })
      expect(before.model?.id).toBe(Model.ID.make("kept"))

      yield* session.setSubagentPolicy({ sessionID: parent.id, subagentPolicy: { models: ["test/other"] } })
      expect((yield* session.get(parent.id)).subagentPolicy).toEqual({ models: ["test/other"] })
      expect(
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, parent.id))
          .all()
          .pipe(Effect.orDie),
      ).toContainEqual({ type: Bus.versionedType(SessionEvent.SubagentPolicyUpdated.type, 1) })

      const error = yield* session.create({ parentID: parent.id, model: model("kept") }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      const allowed = yield* session.create({ parentID: parent.id, model: model("other") })
      expect(allowed.model?.id).toBe(Model.ID.make("other"))

      expect(
        yield* session
          .setSubagentPolicy({ sessionID: Session.ID.create(), subagentPolicy: {} })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Session.NotFoundError)
    }),
  )

  it.effect("a tightened policy binds a running child's later switchModel, but not a top-level session's", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        model: model("a"),
        subagentPolicy: { models: ["test/a", "test/b"] },
      })
      const child = yield* session.create({ parentID: parent.id, model: model("a") })

      yield* session.switchModel({ sessionID: child.id, model: model("b") })
      expect((yield* session.get(child.id)).model?.id).toBe(Model.ID.make("b"))

      yield* session.setSubagentPolicy({ sessionID: parent.id, subagentPolicy: { models: ["test/a"] } })
      yield* session.switchModel({ sessionID: child.id, model: model("a") })
      const error = yield* session.switchModel({ sessionID: child.id, model: model("b") }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((yield* session.get(child.id)).model?.id).toBe(Model.ID.make("a"))

      // Top-level sessions are unchecked.
      yield* session.switchModel({ sessionID: parent.id, model: model("b") })
      expect((yield* session.get(parent.id)).model?.id).toBe(Model.ID.make("b"))
    }),
  )

  it.effect("a tightened policy binds a child's switchAgent, but not a top-level session's", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        model: model("a"),
        subagentPolicy: { models: ["test/a", "test/b"] },
      })
      const child = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("worker"),
        model: model("b"),
      })

      // Permitted while the child's model is inside the policy.
      yield* session.switchAgent({ sessionID: child.id, agent: Agent.ID.make("reviewer") })
      expect((yield* session.get(child.id)).agent).toBe(Agent.ID.make("reviewer"))

      yield* session.setSubagentPolicy({ sessionID: parent.id, subagentPolicy: { models: ["test/a"] } })
      const error = yield* session
        .switchAgent({ sessionID: child.id, agent: Agent.ID.make("specialist") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((error as ModelGovernance.DeniedError).message).toContain("test/a")
      // A denied switch publishes nothing: the child keeps its agent and model.
      const after = yield* session.get(child.id)
      expect(after.agent).toBe(Agent.ID.make("reviewer"))
      expect(after.model?.id).toBe(Model.ID.make("b"))

      // Top-level sessions are unchecked.
      yield* session.switchAgent({ sessionID: parent.id, agent: Agent.ID.make("specialist") })
      expect((yield* session.get(parent.id)).agent).toBe(Agent.ID.make("specialist"))
    }),
  )

  it.effect("forking a session whose model is outside its own subsession policy fails", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({
        location,
        model: model("opus"),
        subagentPolicy: { models: ["test/haiku"] },
      })
      yield* session.prompt({ sessionID: parent.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")

      const error = yield* session.fork({ sessionID: parent.id }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((error as ModelGovernance.DeniedError).message).toContain("test/haiku")
    }),
  )

  it.effect("a permitted fork copies the source session's subagent policy", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({
        location,
        model: model("haiku"),
        subagentPolicy: { models: ["test/haiku"], excludedModels: ["test/opus"] },
      })
      yield* session.prompt({ sessionID: parent.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")

      const forked = yield* session.fork({ sessionID: parent.id })
      expect(forked.subagentPolicy).toEqual({ models: ["test/haiku"], excludedModels: ["test/opus"] })
      expect(forked.model?.id).toBe(Model.ID.make("haiku"))
    }),
  )

  it.effect("forking a child does not escape the policy above its source", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const grandparent = yield* session.create({
        location,
        model: model("haiku"),
        subagentPolicy: { models: ["test/haiku"] },
      })
      const child = yield* session.create({
        parentID: grandparent.id,
        agent: Agent.ID.make("worker"),
        model: model("haiku"),
      })
      yield* session.prompt({ sessionID: child.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, child.id, "steer")

      const forked = yield* session.fork({ sessionID: child.id })
      // The fork is projected top-level, but governance still binds it to
      // the chain above its source.
      expect(forked.parentID).toBeUndefined()

      const switchError = yield* session
        .switchModel({ sessionID: forked.id, model: model("opus") })
        .pipe(Effect.flip)
      expect(switchError).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((yield* session.get(forked.id)).model?.id).toBe(Model.ID.make("haiku"))

      const childError = yield* session
        .create({ parentID: forked.id, agent: Agent.ID.make("worker"), model: model("opus") })
        .pipe(Effect.flip)
      expect(childError).toBeInstanceOf(ModelGovernance.DeniedError)

      const grandchild = yield* session.create({
        parentID: forked.id,
        agent: Agent.ID.make("worker"),
        model: model("haiku"),
      })
      expect(grandchild.model?.id).toBe(Model.ID.make("haiku"))
    }),
  )

  it.effect("a policy agent override narrows the models a named agent may launch with", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        subagentPolicy: {
          models: ["test/*"],
          agentOverrides: { worker: { models: ["test/a"] } },
        },
      })
      const error = yield* session
        .create({ parentID: parent.id, agent: Agent.ID.make("worker"), model: model("b") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      const child = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("worker"),
        model: model("a"),
      })
      expect(child.model?.id).toBe(Model.ID.make("a"))
      // Other agents are bound only by the policy's own list.
      const other = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("other"),
        model: model("b"),
      })
      expect(other.model?.id).toBe(Model.ID.make("b"))
    }),
  )
})

describe("Markdown-defined agents in governance (#1107)", () => {
  test("a Markdown-defined agent is governed through directory expansion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-governance-"))
    try {
      await mkdir(path.join(root, "agents"), { recursive: true })
      await writeFile(
        path.join(root, "agents", "pinned.md"),
        ["---", "model: test/pinned", "excluded_models:", "  - test/denied", "max_depth: 1", "---", "Pinned agent."].join(
          "\n",
        ),
      )
      const entries: Entry[] = [new Directory({ type: "directory", path: AbsolutePath.make(root) })]
      // The governance definition layer sees nothing in a raw directory entry:
      // directory expansion is the seam that makes Markdown agents visible.
      expect(ModelGovernance.agentDefinitions(entries).size).toBe(0)

      const info = (
        id: string,
        options: { parentID?: string; agent?: string } = {},
      ): SessionSchema.Info =>
        SessionSchema.Info.make({
          id: SessionSchema.ID.make(id),
          parentID: options.parentID ? SessionSchema.ID.make(options.parentID) : undefined,
          projectID: Project.ID.global,
          agent: options.agent ? Agent.ID.make(options.agent) : undefined,
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location,
        })
      const parent = info("ses_parent")
      const pinnedSession = info("ses_pinned", { agent: "pinned" })
      const child = info("ses_child", { parentID: "ses_pinned" })
      const byID = new Map([parent, pinnedSession, child].map((session) => [session.id, session]))
      const sessions = {
        get: (sessionID: SessionSchema.ID) => {
          const session = byID.get(sessionID)
          return session ? Effect.succeed(session) : Effect.fail(new NotFoundError({ sessionID }))
        },
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const expanded = yield* ConfigAgentDocuments.expandEntries(fs, entries)
          const definitions = ModelGovernance.agentDefinitions(expanded)
          const checked = ModelGovernance.checkedModel(expanded, { parent, agent: Agent.ID.make("pinned") })
          const denied = yield* ModelGovernance.assertAllowed(
            sessions,
            { entries: () => Effect.succeed(expanded) },
            { parent, agent: Agent.ID.make("pinned"), model: model("denied") },
          ).pipe(Effect.flip)
          const depthError = yield* SubagentDepth.assertWithinLimit(
            sessions,
            { entries: () => Effect.succeed(entries) },
            child,
            fs,
          ).pipe(Effect.flip)
          return { definitions, checked, denied, depthError }
        }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
      )

      const pinned = result.definitions.get("pinned")
      expect(pinned?.model?.providerID).toBe("test")
      expect(pinned?.model?.id).toBe("pinned")
      expect(pinned?.excludedModels).toEqual(["test/denied"])
      expect(pinned?.maxDepth).toBe(1)
      // A model-less child of the Markdown agent runs its pinned default.
      expect(result.checked?.providerID).toBe("test")
      expect(result.checked?.id).toBe("pinned")
      // The Markdown agent's own excluded_models bind its model choice.
      expect(result.denied).toBeInstanceOf(ModelGovernance.DeniedError)
      // And its max_depth binds launches below a session it runs.
      expect(result.depthError).toBeInstanceOf(SubagentDepth.LimitError)
      expect((result.depthError as SubagentDepth.LimitError).message).toContain("max_depth")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
