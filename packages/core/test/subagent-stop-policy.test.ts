import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { Location } from "@opencode/core/location"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const activeSessions = new Set<Session.ID>()

const controllableExecution = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.sync(() => activeSessions as ReadonlySet<Session.ID>),
      isActive: (sessionID) => Effect.succeed(activeSessions.has(sessionID)),
      resume: (sessionID) => Effect.sync(() => activeSessions.add(sessionID)),
      wake: () => Effect.void,
      interrupt: (sessionID) => Effect.sync(() => activeSessions.delete(sessionID)),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  SessionStore.node,
  LocationServiceMap.node,
])

const replacements = [
  SessionExecution.node.replace(controllableExecution),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements

const it = testEffect(AppNodeBuilder.build(nodes, replacements))

const startBackgroundSubagent = Effect.fn("StopPolicyTest.startBackground")(function* (
  parentID: Session.ID,
  childID: Session.ID,
  stopPolicy?: Job.StopPolicy,
) {
  const jobs = yield* Job.Service
  yield* jobs.start({
    id: childID,
    type: "subagent",
    recovery: {
      kind: "subagent",
      parentSessionID: parentID,
      childSessionID: childID,
      agent: "reviewer",
      description: "background review",
      ...(stopPolicy === undefined ? {} : { stopPolicy }),
    },
    run: Effect.never,
  })
  yield* jobs.background(childID)
  activeSessions.add(parentID)
  activeSessions.add(childID)
})

describe("Subagent stop policy", () => {
  it.live("leaves independent background subagents running on plain interrupt", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          yield* startBackgroundSubagent(parent.id, child.id, "independent")
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* sessions.interrupt(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          expect(activeSessions.has(child.id)).toBe(true)
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  it.live("treats a missing stop policy as independent", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          yield* startBackgroundSubagent(parent.id, child.id, undefined)
          yield* sessions.interrupt(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  it.live("cascade interrupt stops a background child and its foreground subagent", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          yield* startBackgroundSubagent(parent.id, child.id, "cascade")
          yield* jobs.start({ id: grandchild.id, type: "subagent", run: Effect.never })
          activeSessions.add(grandchild.id)
          yield* sessions.interrupt(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
          expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
          expect(activeSessions.has(child.id)).toBe(false)
          expect(activeSessions.has(grandchild.id)).toBe(false)
        }),
      ),
    ),
  )

  it.live("detached jobs survive plain interrupt and cascade, and yield to force-stop", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          yield* startBackgroundSubagent(parent.id, child.id, "detached")
          yield* sessions.interrupt(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          expect(activeSessions.has(child.id)).toBe(true)
          yield* sessions.interrupt(parent.id, { force: true })
          expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
          expect(activeSessions.has(child.id)).toBe(false)
        }),
      ),
    ),
  )

  it.live("a detached background subagent survives a plain interrupt aimed at the child itself", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          yield* startBackgroundSubagent(parent.id, child.id, "detached")
          expect(yield* sessions.interrupt(child.id)).toBe(false)
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          expect(activeSessions.has(child.id)).toBe(true)
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  it.live("a direct force interrupt stops a detached background subagent", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          yield* startBackgroundSubagent(parent.id, child.id, "detached")
          yield* sessions.interrupt(child.id, { force: true })
          expect(activeSessions.has(child.id)).toBe(false)
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  it.live("a direct plain interrupt still stops independent and cascade background subagents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const independent = yield* sessions.create({ parentID: parent.id })
          const cascade = yield* sessions.create({ parentID: parent.id })
          yield* startBackgroundSubagent(parent.id, independent.id, "independent")
          yield* startBackgroundSubagent(parent.id, cascade.id, "cascade")
          yield* sessions.interrupt(independent.id)
          yield* sessions.interrupt(cascade.id)
          expect(activeSessions.has(independent.id)).toBe(false)
          expect(activeSessions.has(cascade.id)).toBe(false)
          yield* jobs.cancel(independent.id)
          yield* jobs.cancel(cascade.id)
        }),
      ),
    ),
  )

  it.live("force-stop terminates independent subtrees regardless of policy", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ parentID: parent.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          yield* startBackgroundSubagent(parent.id, child.id, "independent")
          yield* jobs.start({ id: grandchild.id, type: "subagent", run: Effect.never })
          activeSessions.add(grandchild.id)
          yield* sessions.interrupt(parent.id, { force: true })
          expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
          expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
        }),
      ),
    ),
  )

  it.live("allows a non-top-level session to background a subagent job", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          activeSessions.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const root = yield* sessions.create({ location })
          const leaf = yield* sessions.create({ parentID: root.id })
          const nested = yield* sessions.create({ parentID: leaf.id })
          expect(nested.parentID).toBe(leaf.id)
          expect(leaf.parentID).toBe(root.id)
          yield* startBackgroundSubagent(leaf.id, nested.id, "independent")
          expect((yield* jobs.get(nested.id))?.status).toBe("running")
          yield* jobs.cancel(nested.id)
        }),
      ),
    ),
  )
})
