import { expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

it.live("creates a child at its parent's location and lists it under the parent", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const create = (body: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://opencode.local/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(SessionResponse)(await response.json()).data
      })
    const parent = yield* create({ title: "Parent" })
    const child = yield* create({ parentID: parent.id, title: "Child", location: { directory: "/unused" } })
    const response = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session?parentID=${parent.id}`)),
    )
    expect(response.status).toBe(200)
    const children = Schema.decodeUnknownSync(SessionsResponse)(yield* Effect.promise(() => response.json()))

    expect(child).toMatchObject({ parentID: parent.id, location: parent.location })
    expect(children.data.map((session) => session.id)).toEqual([child.id])
  }).pipe(Effect.scoped),
)

it.live("accepts detached mode on session creation and inherits it in children", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const create = (body: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://opencode.local/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(SessionResponse)(await response.json()).data
      })

    const parent = yield* create({ detached: true })
    const child = yield* create({ parentID: parent.id })

    expect(parent.detached).toBe(true)
    expect(child.detached).toBe(true)
  }).pipe(Effect.scoped),
)

it.live("returns not found when creating a child of a missing session", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const parentID = Session.ID.create()
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentID, title: "Child" }),
        }),
      ),
    )
    expect(response.status).toBe(404)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "SessionNotFoundError",
      sessionID: parentID,
    })
  }).pipe(Effect.scoped),
)

it.live("honors the ?directory= query parameter for a root session (#1570)", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const directory = mkdtempSync(join(tmpdir(), "opencode-session-directory-"))
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://opencode.local/api/session?directory=${encodeURIComponent(directory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Root" }),
        }),
      ),
    )
    expect(response.status).toBe(200)
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json())).data
    expect(session.location.directory).toBe(directory)
  }).pipe(Effect.scoped),
)

it.live("the payload location takes precedence over ?directory= (#1570)", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const queryDirectory = mkdtempSync(join(tmpdir(), "opencode-session-query-"))
    const payloadDirectory = mkdtempSync(join(tmpdir(), "opencode-session-payload-"))
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://opencode.local/api/session?directory=${encodeURIComponent(queryDirectory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Root", location: { directory: payloadDirectory } }),
        }),
      ),
    )
    expect(response.status).toBe(200)
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json())).data
    expect(session.location.directory).toBe(payloadDirectory)
  }).pipe(Effect.scoped),
)

it.live("rejects ?directory= combined with a parentID (#1570)", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const parentResponse = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Parent" }),
        }),
      ),
    )
    expect(parentResponse.status).toBe(200)
    const parent = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => parentResponse.json())).data
    const directory = mkdtempSync(join(tmpdir(), "opencode-session-directory-"))
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://opencode.local/api/session?directory=${encodeURIComponent(directory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentID: parent.id, title: "Child" }),
        }),
      ),
    )
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "InvalidRequestError" })
  }).pipe(Effect.scoped),
)
