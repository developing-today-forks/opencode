import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@opencode/core/database/database"
import { RouteAttemptTable } from "@opencode/core/model-route-log/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, SessionStore.node])))

const directory = AbsolutePath.make("/a")
const servedID = SessionID.make("ses_route_usage_served")
const unservedID = SessionID.make("ses_route_usage_unserved")

const seed = Effect.fn(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      { id: servedID, project_id: Project.ID.global, directory, slug: "served", version: "test" },
      { id: unservedID, project_id: Project.ID.global, directory, slug: "unserved", version: "test" },
    ])
    .run()
    .pipe(Effect.orDie)
  // One turn, two attempts sharing an assistant message: the first leaf failed and recorded
  // its failover destination; the second leaf served the step.
  yield* db
    .insert(RouteAttemptTable)
    .values([
      {
        time_started: 1_000,
        time_ended: 1_400,
        route_id: "workhorse",
        provider_id: "anthropic",
        model_id: "claude-sonnet",
        variant: "high",
        assistant_message_id: "msg_route_usage",
        outcome: "failure",
        failed_over_to: "openai/gpt-6-luna",
        output_started: false,
        session_id: servedID,
      },
      {
        time_started: 1_500,
        time_ended: 2_000,
        route_id: "workhorse",
        provider_id: "openai",
        model_id: "gpt-6-luna",
        variant: "max",
        assistant_message_id: "msg_route_usage",
        outcome: "success",
        output_started: true,
        session_id: servedID,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

describe("SessionStore route_usage (#2696)", () => {
  it.effect("a session with recorded attempts carries route_usage.lastServing naming the serving leaf and variant", () =>
    Effect.gen(function* () {
      yield* seed()
      const store = yield* SessionStore.Service
      const info = yield* store.get(servedID)
      expect(info?.route_usage?.lastServing).toMatchObject({
        leaf: "openai/gpt-6-luna",
        providerID: "openai",
        modelID: "gpt-6-luna",
        variant: "max",
        routeID: "workhorse",
        outcome: "success",
        attemptedLeaf: "anthropic/claude-sonnet",
        failedOver: true,
        failedOverTo: "openai/gpt-6-luna",
        hedged: false,
        timeStarted: 1_500,
      })
      // The wire shape the fleet-queue claim path reads: the snake_case key, plain strings.
      const wire = Schema.encodeUnknownSync(Session.Info)(info!) as {
        route_usage?: { lastServing: { providerID: string; modelID: string; variant: string | null } }
      }
      expect(wire.route_usage?.lastServing.providerID).toBe("openai")
      expect(wire.route_usage?.lastServing.modelID).toBe("gpt-6-luna")
      expect(wire.route_usage?.lastServing.variant).toBe("max")
    }),
  )

  it.effect("a session with no attempts carries no route_usage key at all", () =>
    Effect.gen(function* () {
      yield* seed()
      const store = yield* SessionStore.Service
      const info = yield* store.get(unservedID)
      expect(info).toBeDefined()
      expect(info?.route_usage).toBeUndefined()
      const wire = Schema.encodeUnknownSync(Session.Info)(info!) as Record<string, unknown>
      expect("route_usage" in wire).toBe(false)
    }),
  )
})
