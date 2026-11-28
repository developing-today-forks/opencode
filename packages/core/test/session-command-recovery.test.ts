import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Schedule } from "effect"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Plugin } from "@opencode/core/plugin"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionMessage } from "@opencode/schema/session-message"
import { CommandPayload } from "@opencode/schema/session-inbox"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionOperation } from "@opencode/core/session/operation"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionStore } from "@opencode/core/session/store"
import { SessionProjector } from "@opencode/core/session/projector"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Crash-boundary coverage for admitted command operations. Each test crafts
// a pending inbox row directly (no admission fork runs for it) and then
// invokes SessionOperation.run exactly as the execution drain's recovery sweep
// does, so the three crash boundaries from opencode#2775 are deterministic:
// recovery before start, after start with no side effect, and after a side
// effect but before terminal settlement.
setDefaultTimeout(30_000)

class ExecutionControl extends Context.Service<
  ExecutionControl,
  {
    started: Deferred.Deferred<void>
    release: Deferred.Deferred<void>
    wakes: Session.ID[]
  }
>()("test/SessionCommandRecovery/ExecutionControl") {}

const controlLayer = Layer.effect(
  ExecutionControl,
  Effect.gen(function* () {
    return { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>(), wakes: [] }
  }),
)

const executionLayer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const control = yield* ExecutionControl
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, never>({
      drain: () => Deferred.succeed(control.started, undefined).pipe(Effect.andThen(Deferred.await(control.release))),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      resume: coordinator.run,
      interrupt: (sessionID) => coordinator.interrupt(sessionID),
      awaitIdle: coordinator.awaitIdle,
      wake: (sessionID) =>
        Effect.sync(() => control.wakes.push(sessionID)).pipe(Effect.andThen(coordinator.wake(sessionID))),
    })
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node, Session.node, SessionExecution.node, LocationServiceMap.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(executionLayer.pipe(Layer.provide(controlLayer))),
      offlineModels,
    ],
  ).pipe(Layer.provideMerge(controlLayer)),
)

const setup = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const marker = path.join(tmp.path, "command-side-effect.txt")
  const session = yield* Session.Service
  const created = yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }) })
  const locations = yield* LocationServiceMap.Service
  yield* Plugin.awaitActivation.pipe(Effect.provide(locations.get(created.location)))
  const commands = yield* Command.Service.pipe(Effect.provide(locations.get(created.location)))
  const store = yield* SessionStore.Service
  const inbox = yield* SessionInbox.Service
  const { db } = yield* Database.Service
  const control = yield* ExecutionControl
  const bus = yield* Bus.Service
  const ran = yield* Ref.make(0)
  const gate = yield* Deferred.make<void>()
  yield* commands.transform((editor) => {
    editor.add({
      name: "marker",
      description: "Records invocations for command recovery tests",
      execute: () =>
        Effect.gen(function* () {
          yield* Ref.update(ran, (count) => count + 1)
          yield* Effect.promise(() => fs.appendFile(marker, "applied\n"))
          yield* Deferred.await(gate)
        }),
    })
  })
  const instances = Instance.Service.of({
    provide: (info) => Effect.provide(locations.get(info.location)),
  })
  // The production notify path: the notice is admitted as a synthetic without
  // waking the model, exactly as the admission fork and the drain sweep do.
  const notify = (note: { text: string; description?: string; metadata?: Record<string, unknown> }) =>
    inbox
      .admit({
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        item: {
          type: "synthetic",
          delivery: "steer",
          payload: SessionInbox.SyntheticPayload.make({
            text: note.text,
            description: note.description,
            metadata: note.metadata,
          }),
        },
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => Effect.void),
        Effect.asVoid,
      )
  const started = (id: SessionMessage.ID) =>
    store.message(id).pipe(
      Effect.map((found) => found?.sessionID === created.id && found.message.type === "shell"),
      Effect.orElseSucceed(() => false),
    )
  return { tmp, session, created, control, marker, ran, gate, notify, started, db, bus, inbox, store, instances }
})

// A pending command row with no starter, as a crash between admission and
// start leaves it. The row is crafted through the durable enqueue event so no
// admission fork exists for it.
const enqueueCommand = (fixture: Effect.Success<typeof setup>, text = "hello command") =>
  Effect.gen(function* () {
    const id = SessionMessage.ID.create()
    yield* fixture.bus.publish(SessionEvent.InboxEnqueued, {
      sessionID: fixture.created.id,
      inboxID: id,
      item: {
        type: "command",
        payload: CommandPayload.make({ command: "marker", text }),
        delivery: "steer",
      },
    })
    return id
  })

// What the execution drain's recovery sweep does per pending operation.
const recover = (fixture: Effect.Success<typeof setup>, id: SessionMessage.ID) =>
  Effect.gen(function* () {
    const pending = yield* SessionInbox.pendingOperations(fixture.db, fixture.created.id)
    const operation = pending.find((item) => item.id === id)
    if (!operation) return yield* Effect.die(new Error("pending command row is missing"))
    yield* SessionOperation.run({
      session: fixture.created,
      operation,
      bus: fixture.bus,
      db: fixture.db,
      notify: fixture.notify,
      started: fixture.started,
    }).pipe(Effect.provideService(Instance.Service, fixture.instances))
  })

const poll = <A>(effect: Effect.Effect<A>, until: (value: A) => boolean) =>
  effect.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("5 seconds"),
  )

const inboxTypes = (fixture: Effect.Success<typeof setup>) =>
  fixture.session.inbox(fixture.created.id).pipe(Effect.map((items) => items.map((item) => item.type)))

const readMarker = (fixture: Effect.Success<typeof setup>) =>
  Effect.promise(() => fs.readFile(fixture.marker, "utf8").catch(() => ""))

const interruption = (fixture: Effect.Success<typeof setup>) =>
  fixture.session.inbox(fixture.created.id).pipe(
    Effect.map((items) =>
      items.find((item) => item.type === "synthetic" && item.payload.metadata?.["state"] === "interrupted"),
    ),
  )

describe("Session command recovery", () => {
  it.live("auto-starts a command admitted but never started", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const id = yield* enqueueCommand(fixture)
      const fiber = yield* recover(fixture, id).pipe(Effect.forkScoped)
      // The definition runs while the completion is still unsettled: the row
      // stays pending for exactly the in-flight window.
      yield* poll(Ref.get(fixture.ran), (count) => count === 1)
      expect(yield* inboxTypes(fixture)).toContain("command")
      yield* Deferred.succeed(fixture.gate, undefined)
      yield* Fiber.join(fiber)

      expect(yield* readMarker(fixture)).toBe("applied\n")
      expect(yield* inboxTypes(fixture)).toEqual([])
      expect(yield* interruption(fixture)).toBeUndefined()
      expect(fixture.control.wakes).toEqual([])
    }),
  )

  it.live("surfaces interrupted/unknown without re-running a start that never settled", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const id = yield* enqueueCommand(fixture)
      // A previous process claimed the first start and died before settling;
      // the definition it ran had no side effect to observe.
      expect(yield* SessionInbox.markStarted(fixture.db, { sessionID: fixture.created.id, id })).toBe("marked")

      yield* recover(fixture, id)

      expect(yield* readMarker(fixture)).toBe("")
      const notice = yield* interruption(fixture)
      if (!notice || notice.type !== "synthetic") return yield* Effect.die(new Error("missing interruption notice"))
      expect(notice.payload.metadata).toEqual({ source: "command", state: "interrupted" })
      expect(notice.payload.text).toContain("/marker")
      expect(notice.payload.text).toContain("NOT run again")
      expect(notice.payload.text).toContain("hello command")
      expect(yield* inboxTypes(fixture)).toEqual(["synthetic"])
      expect(fixture.control.wakes).toEqual([])
    }),
  )

  it.live("does not apply the side effect twice when the lost start already applied it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const id = yield* enqueueCommand(fixture, "write the marker file")
      // The lost start's effect, applied before the crash.
      yield* Effect.promise(() => fs.appendFile(fixture.marker, "applied\n"))
      expect(yield* SessionInbox.markStarted(fixture.db, { sessionID: fixture.created.id, id })).toBe("marked")

      yield* recover(fixture, id)

      // Exactly the one line the lost start wrote: recovery added nothing.
      expect(yield* readMarker(fixture)).toBe("applied\n")
      const notice = yield* interruption(fixture)
      if (!notice || notice.type !== "synthetic") return yield* Effect.die(new Error("missing interruption notice"))
      expect(notice.payload.metadata).toEqual({ source: "command", state: "interrupted" })
      expect(notice.payload.text).toContain("write the marker file")
      expect(yield* inboxTypes(fixture)).toEqual(["synthetic"])
      expect(fixture.control.wakes).toEqual([])
    }),
  )

  it.live("runs a pending command exactly once under a concurrent duplicate start", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const id = yield* enqueueCommand(fixture)
      const first = yield* recover(fixture, id).pipe(Effect.forkScoped)
      const second = yield* recover(fixture, id).pipe(Effect.forkScoped)
      yield* poll(Ref.get(fixture.ran), (count) => count === 1)
      yield* Deferred.succeed(fixture.gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      expect(yield* readMarker(fixture)).toBe("applied\n")
      expect(yield* inboxTypes(fixture)).toEqual([])
      expect(yield* interruption(fixture)).toBeUndefined()
      expect(fixture.control.wakes).toEqual([])
    }),
  )

  it.live("claims the first start exactly once under concurrent markStarted", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const id = yield* enqueueCommand(fixture)
      const ref = { sessionID: fixture.created.id, id }
      const [first, second] = yield* Effect.all(
        [SessionInbox.markStarted(fixture.db, ref), SessionInbox.markStarted(fixture.db, ref)],
        { concurrency: 2 },
      )
      // Exactly one starter owns the first start; the loser sees the claim.
      expect([first, second].sort()).toEqual(["marked", "started"])
    }),
  )

  it.live("leaves the row pending when the start claim fails", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const id = yield* enqueueCommand(fixture)
      const pending = yield* SessionInbox.pendingOperations(fixture.db, fixture.created.id)
      const operation = pending.find((item) => item.id === id)
      if (!operation) return yield* Effect.die(new Error("pending command row is missing"))
      // The claim's UPDATE dies (a database failure mid-claim): the row must
      // stay pending so the next drain retries it, not consumed by a
      // finalizer that publishes InboxDelivered unconditionally.
      const failingDb = new Proxy(fixture.db, {
        get: (target, prop) => {
          if (prop === "update") {
            return () => {
              throw new Error("start-claim database failure")
            }
          }
          const value = (target as Record<PropertyKey, unknown>)[prop]
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      const exit = yield* SessionOperation.run({
        session: fixture.created,
        operation,
        bus: fixture.bus,
        db: failingDb,
        notify: fixture.notify,
        started: fixture.started,
      }).pipe(Effect.exit, Effect.provideService(Instance.Service, fixture.instances))
      expect(Exit.isFailure(exit)).toBe(true)

      expect(yield* Ref.get(fixture.ran)).toBe(0)
      expect(yield* inboxTypes(fixture)).toContain("command")
      expect(yield* interruption(fixture)).toBeUndefined()

      // The next drain settles the still-pending row normally.
      yield* Deferred.succeed(fixture.gate, undefined)
      yield* recover(fixture, id)

      expect(yield* readMarker(fixture)).toBe("applied\n")
      expect(yield* inboxTypes(fixture)).toEqual([])
      expect(yield* interruption(fixture)).toBeUndefined()
      expect(fixture.control.wakes).toEqual([])
    }),
  )
})
