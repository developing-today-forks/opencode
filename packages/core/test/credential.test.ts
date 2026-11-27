import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { CredentialTable } from "@opencode/core/credential/sql"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/core/workspace"
import { Event } from "@opencode/schema/event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Integration } from "@opencode/core/integration"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Bus.node, Database.node])))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const additional = yield* credentials.create({
        integrationID,
        label: "Additional",
        value: Credential.Key.make({ type: "key", key: "additional" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({ id: created.id, label: "Personal" }),
        additional,
      ])

      yield* credentials.remove(additional.id)
      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({ id: created.id, label: "Personal" }),
      ])
    }),
  )

  it.effect("reads key form answers stored in configuration before v2.1 as metadata", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const db = (yield* Database.Service).db
      const integrationID = Integration.ID.make("azure")
      // A row from an earlier release, which the current schema would otherwise strip.
      const legacy = {
        type: "key",
        key: "secret",
        metadata: { imported: true, resourceName: "older" },
        configuration: { resourceName: "answered" },
      }
      yield* db.run(
        sql`INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES ('cred_legacy', ${integrationID}, 'Legacy', ${JSON.stringify(legacy)}, 1, 0, 0)`,
      )

      expect((yield* credentials.get(Credential.ID.make("cred_legacy")))?.value).toEqual({
        type: "key",
        key: "secret",
        metadata: { imported: true, resourceName: "answered" },
      })
    }),
  )

  it.effect("skips a corrupt stored row instead of dying the whole read", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const db = (yield* Database.Service).db
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Good",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })
      // A persisted value matching none of the known credential shapes.
      yield* db.run(
        sql`INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES ('cred_corrupt', ${integrationID}, 'Corrupt', ${JSON.stringify({ type: "unknown-kind", wat: true })}, 0, 1, 1)`,
      )

      expect(yield* credentials.list(integrationID)).toEqual([created])
      expect(yield* credentials.all()).toEqual([created])
      expect(yield* credentials.get(Credential.ID.make("cred_corrupt"))).toBeUndefined()
      expect(yield* credentials.get(created.id)).toEqual(created)
    }),
  )

  it.effect("publishes global events only for observable credential mutations", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const bus = yield* Bus.Service
      const integrationID = Integration.ID.make("openai")
      const events = new Array<Event.Payload>()
      yield* bus.listen((event) => Effect.sync(() => events.push(event)))

      const older = yield* credentials
        .create({ integrationID, value: Credential.Key.make({ type: "key", key: "older" }) })
        .pipe(
          Effect.provideService(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make("project"), workspaceID: Workspace.ID.make("wrk_test") }),
            ),
          ),
        )
      const newer = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "newer" }),
      })

      yield* credentials.activate(newer.id)
      yield* credentials.activate(Credential.ID.create())
      yield* credentials.activate(older.id)
      yield* credentials.activate(older.id)
      yield* credentials.update(older.id, {})
      yield* credentials.update(Credential.ID.create(), { label: "Missing" })
      yield* credentials.update(older.id, { label: "default" })
      yield* credentials.update(older.id, { value: Credential.Key.make({ type: "key", key: "refreshed" }) })
      yield* credentials.update(older.id, { label: "Renamed" })
      yield* credentials.remove(Credential.ID.create())
      yield* credentials.remove(newer.id)
      yield* credentials.remove(newer.id)
      expect((yield* credentials.list(integrationID)).at(-1)?.id).toBe(older.id)

      const replacement = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      yield* credentials.remove(replacement.id)
      expect((yield* credentials.list(integrationID)).at(-1)?.id).toBe(older.id)
      yield* credentials.remove(older.id)
      expect(yield* credentials.list(integrationID)).toEqual([])

      expect(events.map((event) => ({ type: event.type, data: event.data }))).toEqual([
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: newer.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: newer.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: newer.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: replacement.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: replacement.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: replacement.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: null } },
      ])
      expect(events.every((event) => !("location" in event))).toBeTrue()
    }),
  )

  it.effect("promotes the newest remaining legacy credential when the effective selection is removed", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const bus = yield* Bus.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("openai")
      const oldest = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "oldest" }),
      })
      const newer = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "newer" }),
      })
      const newest = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "newest" }),
      })
      yield* database.db
        .update(CredentialTable)
        .set({ active: null })
        .where(eq(CredentialTable.integration_id, integrationID))
        .run()
        .pipe(Effect.orDie)

      const events = new Array<Event.Payload>()
      yield* bus.listen((event) => Effect.sync(() => events.push(event)))
      yield* credentials.activate(newest.id)
      yield* credentials.remove(oldest.id)
      yield* credentials.remove(newest.id)

      expect(yield* credentials.list(integrationID)).toEqual([newer])
      expect(
        yield* database.db
          .select({ active: CredentialTable.active })
          .from(CredentialTable)
          .where(eq(CredentialTable.id, newer.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ active: true })
      expect(events.map((event) => ({ type: event.type, data: event.data }))).toEqual([
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: oldest.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: newest.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: newer.id } },
      ])
    }),
  )

  it.effect("activates older credentials without affecting other integrations", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const otherIntegrationID = Integration.ID.make("anthropic")
      const older = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "older" }),
      })
      const newer = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "newer" }),
      })
      const otherOlder = yield* credentials.create({
        integrationID: otherIntegrationID,
        value: Credential.Key.make({ type: "key", key: "other-older" }),
      })
      const otherNewer = yield* credentials.create({
        integrationID: otherIntegrationID,
        value: Credential.Key.make({ type: "key", key: "other-newer" }),
      })

      yield* credentials.activate(older.id)
      expect(yield* credentials.list(integrationID)).toEqual([newer, older])
      expect(yield* credentials.list(otherIntegrationID)).toEqual([otherOlder, otherNewer])

      yield* credentials.activate(Credential.ID.create())
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(older)

      yield* credentials.activate(otherOlder.id)
      expect(yield* credentials.list(otherIntegrationID)).toEqual([otherNewer, otherOlder])
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(older)

      yield* credentials.remove(older.id)
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(newer)
      expect((yield* credentials.list(otherIntegrationID)).at(-1)).toEqual(otherOlder)
    }),
  )

  it.effect("creates credentials with a requested ID without taking over the current selection", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const bus = yield* Bus.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("openai")
      const events = new Array<Event.Payload>()
      yield* bus.listen((event) => Effect.sync(() => events.push(event)))

      const first = yield* credentials.create({
        id: Credential.ID.make("cred_0000imported"),
        integrationID,
        value: Credential.Key.make({ type: "key", key: "first" }),
        activate: false,
      })
      expect(first.id).toBe(Credential.ID.make("cred_0000imported"))
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(first)

      const legacy = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "legacy" }),
      })
      yield* database.db
        .update(CredentialTable)
        .set({ active: null })
        .where(eq(CredentialTable.integration_id, integrationID))
        .run()
        .pipe(Effect.orDie)
      const imported = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "imported" }),
        activate: false,
      })

      expect(yield* credentials.list(integrationID)).toEqual([first, imported, legacy])
      expect(events.map((event) => ({ type: event.type, data: event.data }))).toEqual([
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: first.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: first.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: legacy.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: legacy.id } },
        { type: Credential.Event.Updated.type, data: { integrationID, credentialID: imported.id } },
      ])
    }),
  )

  it.effect("stores session-cookie credentials through the existing credential service", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("opendesign")
      const value = Credential.SessionCookie.make({
        type: "session-cookie",
        cookie: "fixture-cookie",
        workspaceID: "wrk_fixture",
        metadata: { externalRefresh: true },
      })
      const created = yield* credentials.create({ integrationID, label: "OpenDesign", value })
      expect(created.value).toEqual(value)
      expect(yield* credentials.get(created.id)).toEqual(created)
      expect(yield* credentials.list(integrationID)).toEqual([created])

      const row = yield* database.db
        .select({ value: CredentialTable.value })
        .from(CredentialTable)
        .where(eq(CredentialTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.value).toEqual(value)

      const renewed = Credential.SessionCookie.make({
        type: "session-cookie",
        cookie: "fixture-cookie-renewed",
        workspaceID: "wrk_fixture",
        metadata: { externalRefresh: true },
      })
      yield* credentials.update(created.id, { value: renewed })
      expect((yield* credentials.get(created.id))?.value).toEqual(renewed)

      yield* credentials.remove(created.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("redacts session-cookie values for generic reads and passes other kinds through", () =>
    Effect.gen(function* () {
      const value = Credential.SessionCookie.make({
        type: "session-cookie",
        cookie: "fixture-cookie",
        workspaceID: "wrk_fixture",
        metadata: { externalRefresh: true },
      })
      const redacted = Credential.redactedValue(value)
      expect(redacted).toEqual({
        type: "session-cookie",
        cookie: "",
        workspaceID: "wrk_fixture",
        metadata: { externalRefresh: true },
      })
      expect(JSON.stringify(redacted)).not.toContain("fixture-cookie")
      expect(Credential.isSessionCookie(value)).toBeTrue()
      expect(Credential.isSessionCookie(redacted)).toBeTrue()

      const key = Credential.Key.make({ type: "key", key: "secret" })
      expect(Credential.redactedValue(key)).toBe(key)
      const oauth = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("fixture"),
        refresh: "refresh",
        access: "access",
        expires: 1,
      })
      expect(Credential.redactedValue(oauth)).toBe(oauth)
    }),
  )
})
