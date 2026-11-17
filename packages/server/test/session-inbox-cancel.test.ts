import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

// Oracle: the endpoint contract for session.inbox.cancel — a cancel that
// matched no pending inbox row is a 409 conflict (the same answer steer/queue
// give for the same core InboxConflictError), a cancel against a missing
// session is a 404, and only a cancel that removed a pending row is a 204.
it.live("returns 409 when cancelling an unknown inbox item", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const created = yield* Effect.promise(async () => {
      const response = await handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Inbox cancel" }),
        }),
      )
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(SessionResponse)(await response.json()).data
    })
    const inboxID = SessionMessage.ID.create()
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session/" + created.id + "/inbox/" + inboxID, { method: "DELETE" }),
      ),
    )
    expect(response.status).toBe(409)
  }).pipe(Effect.scoped),
)

it.live("returns 404 when cancelling an inbox item of a missing session", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const sessionID = Session.ID.create()
    const inboxID = SessionMessage.ID.create()
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session/" + sessionID + "/inbox/" + inboxID, { method: "DELETE" }),
      ),
    )
    expect(response.status).toBe(404)
  }).pipe(Effect.scoped),
)
