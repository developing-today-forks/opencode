import { describe, expect, setDefaultTimeout } from "bun:test"
import path from "path"
import { Effect, Layer, Schedule } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Plugin } from "@opencode/core/plugin"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionOperation } from "@opencode/core/session/operation"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

setDefaultTimeout(30_000)

// Recovery runs through the real SessionExecution drain, which needs a runner; stub it out so admits stay pending.
const executionLayer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    return SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    })
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Instance.node, Session.node, SessionInbox.node, SessionExecution.node, LocationServiceMap.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
    SessionExecution.node.replace(executionLayer),
    offlineModels,
  ]),
)

const setup = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const countFile = path.join(tmp.path, "command-count.txt")
  yield* Effect.promise(() =>
    Bun.write(
      path.join(tmp.path, ".opencode/plugins/commands.ts"),
      [
        `import { appendFile } from "node:fs/promises"`,
        `export default {`,
        `  id: "test-commands",`,
        `  async setup(ctx) {`,
        `    await ctx.command.transform((editor) =>`,
        `      editor.add({`,
        `        name: "marker",`,
        `        description: "Appends one line per invocation to the count file",`,
        `        execute: async (invocation) => {`,
        `          await appendFile(${JSON.stringify(countFile)}, invocation.prompt.text + "\\n")`,
        `        },`,
        `      }),`,
        `    )`,
        `  },`,
        `}`,
        ``,
      ].join("\n"),
    ),
  )
  const session = yield* Session.Service
  const created = yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }) })
  const locations = yield* LocationServiceMap.Service
  yield* Plugin.awaitActivation.pipe(Effect.provide(locations.get(created.location)))
  return { tmp, session, created, countFile }
})

const admitCommand = Effect.fn(function* (fixture: Effect.Success<typeof setup>, text: string) {
  const admission = yield* SessionInbox.Service
  return yield* admission.admit({
    id: SessionMessage.ID.create(),
    sessionID: fixture.created.id,
    item: {
      type: "command",
      payload: SessionInbox.CommandPayload.make({ command: "marker", text }),
      delivery: "steer",
    },
  })
})

type Note = { readonly text: string; readonly metadata?: Record<string, unknown> }

const recover = Effect.fn(function* (fixture: Effect.Success<typeof setup>, operation: SessionInbox.Operation) {
  const notes: Note[] = []
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const instances = yield* Instance.Service
  yield* SessionOperation.run({
    session: fixture.created,
    operation,
    db,
    bus,
    notify: (note) => Effect.sync(() => notes.push({ text: note.text, metadata: note.metadata })),
    started: () => Effect.succeed(false),
  }).pipe(Effect.provideService(Instance.Service, instances))
  return notes
})

const inboxSettled = (fixture: Effect.Success<typeof setup>) =>
  Effect.gen(function* () {
    const inbox = yield* fixture.session.inbox(fixture.created.id)
    return inbox.every((entry) => entry.type !== "command")
  }).pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("5 seconds"),
  )

const countLines = (file: string) =>
  Effect.promise(() => Bun.file(file).exists()).pipe(
    Effect.flatMap((exists) => (exists ? Effect.promise(() => Bun.file(file).text()) : Effect.succeed(""))),
    Effect.map((text) => text.split("\n").filter((line) => line.length > 0)),
  )

describe("Session command recovery", () => {
  it.live("runs a never-started command on recovery", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const { db } = yield* Database.Service
      const item = yield* admitCommand(fixture, "first run")
      if (item.type !== "command") return yield* Effect.die("Expected a command admission")
      expect(yield* SessionInbox.hasStarted(db, fixture.created.id, item.id)).toBe(false)

      const notes = yield* recover(fixture, item)
      expect(notes).toEqual([])
      expect(yield* countLines(fixture.countFile)).toEqual(["first run"])
      yield* inboxSettled(fixture)
      expect(yield* fixture.session.inbox(fixture.created.id)).toEqual([])
    }),
  )

  it.live("surfaces interrupted instead of rerunning a started command", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const { db } = yield* Database.Service
      const item = yield* admitCommand(fixture, "hello")
      if (item.type !== "command") return yield* Effect.die("Expected a command admission")

      // The crash happened after the start marker became durable, with no
      // side effect recorded: the outcome is still unknown, so recovery must
      // not rerun the definition.
      yield* SessionInbox.markStarted(db, fixture.created.id, item.id)
      expect(yield* SessionInbox.hasStarted(db, fixture.created.id, item.id)).toBe(true)

      const notes = yield* recover(fixture, item)
      expect(notes).toHaveLength(1)
      expect(notes[0]?.text).toContain("interrupted")
      expect(notes[0]?.text).toContain("/marker")
      expect(notes[0]?.metadata).toMatchObject({ source: "command", state: "interrupted" })
      expect(yield* countLines(fixture.countFile)).toEqual([])

      yield* inboxSettled(fixture)
      expect(yield* fixture.session.inbox(fixture.created.id)).toEqual([])
    }),
  )

  it.live("does not apply side effects twice when the crash came after them", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const { db } = yield* Database.Service
      const item = yield* admitCommand(fixture, "only once")
      if (item.type !== "command") return yield* Effect.die("Expected a command admission")

      // Simulate the lost execution: it wrote its side effect, then crashed
      // before the terminal record.
      yield* Effect.promise(() => Bun.write(fixture.countFile, "only once\n"))
      yield* SessionInbox.markStarted(db, fixture.created.id, item.id)

      const notes = yield* recover(fixture, item)
      expect(notes).toHaveLength(1)
      expect(notes[0]?.metadata).toMatchObject({ source: "command", state: "interrupted" })
      expect(yield* countLines(fixture.countFile)).toEqual(["only once"])

      yield* inboxSettled(fixture)
      expect(yield* fixture.session.inbox(fixture.created.id)).toEqual([])
    }),
  )

  it.live("start marker is first-start-wins", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const { db } = yield* Database.Service
      const item = yield* admitCommand(fixture, "sticky")
      if (item.type !== "command") return yield* Effect.die("Expected a command admission")

      yield* SessionInbox.markStarted(db, fixture.created.id, item.id)
      yield* SessionInbox.markStarted(db, fixture.created.id, item.id)
      expect(yield* SessionInbox.hasStarted(db, fixture.created.id, item.id)).toBe(true)
    }),
  )
})
