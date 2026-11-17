import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("session.inbox.cancel maps an unknown inbox item to a conflict instead of an empty success", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const call = (path: string, method: "POST" | "DELETE", body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return response
      })

    const createdResponse = yield* call("/api/session", "POST", { metadata: { source: "session-inbox-cancel" } })
    expect(createdResponse.status).toBe(200)
    const created = (yield* Effect.promise(() => createdResponse.json())) as { data: { id: string } }

    const unknownInbox = yield* call(`/api/session/${created.data.id}/inbox/msg_inbox_probe_unknown`, "DELETE")
    expect(unknownInbox.status).toBe(409)

    const unknownSession = yield* call("/api/session/ses_inbox_probe_missing/inbox/msg_inbox_probe_unknown", "DELETE")
    expect(unknownSession.status).toBe(404)
  }).pipe(Effect.scoped),
)
