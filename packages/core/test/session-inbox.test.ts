import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionInboxTable, SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, Bus.node, SessionInbox.node])))

describe("SessionInbox", () => {
  it.effect("skips corrupt stored rows instead of dying the whole read", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = Session.ID.make("ses_inbox_corrupt")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: sessionID,
          directory: "/project",
          title: sessionID,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const healthyUser = SessionMessage.ID.create()
      const corruptUser = SessionMessage.ID.create()
      const healthyShell = SessionMessage.ID.create()
      const corruptShell = SessionMessage.ID.create()
      const corruptTimestamp = SessionMessage.ID.create()
      yield* db
        .insert(SessionInboxTable)
        .values([
          {
            id: healthyUser,
            session_id: sessionID,
            type: "user" as const,
            payload: { text: "queued prompt" },
            delivery: "queue" as const,
            enqueued_seq: 1,
            time_created: 1_700_000_000_000,
          },
          {
            id: corruptUser,
            session_id: sessionID,
            type: "user" as const,
            // A persisted payload matching none of the known inbox shapes.
            payload: { bogus: true } as never,
            delivery: "queue" as const,
            enqueued_seq: 2,
            time_created: 1_700_000_000_000,
          },
          {
            id: healthyShell,
            session_id: sessionID,
            type: "shell" as const,
            payload: { command: "echo ok" },
            delivery: "queue" as const,
            enqueued_seq: 3,
            time_created: 1_700_000_000_000,
          },
          {
            id: corruptShell,
            session_id: sessionID,
            type: "shell" as const,
            payload: { bogus: true } as never,
            delivery: "queue" as const,
            enqueued_seq: 4,
            time_created: 1_700_000_000_000,
          },
          {
            id: corruptTimestamp,
            session_id: sessionID,
            type: "user" as const,
            payload: { text: "bad clock" },
            delivery: "queue" as const,
            enqueued_seq: 5,
            // Beyond the representable DateTime range: makeUnsafe would throw.
            time_created: 9_007_199_254_740_991,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const listed = yield* SessionInbox.list(db, sessionID)
      expect(listed.map((item) => item.id)).toEqual([healthyUser, healthyShell])

      const listedWithRefs = yield* SessionInbox.listWithRefs(db, sessionID)
      expect(listedWithRefs.map((item) => item.id)).toEqual([healthyUser, healthyShell])

      expect((yield* SessionInbox.find(db, healthyUser))?.id).toBe(healthyUser)
      expect(yield* SessionInbox.find(db, corruptUser)).toBeUndefined()
      expect(yield* SessionInbox.find(db, corruptTimestamp)).toBeUndefined()

      const operations = yield* SessionInbox.pendingOperations(db, sessionID)
      expect(operations.map((item) => item.id)).toEqual([healthyShell])
    }),
  )
})
