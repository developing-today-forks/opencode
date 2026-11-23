import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const AskResponse = Schema.Struct({ data: Schema.Struct({ id: Schema.String, effect: Schema.String }) })
const RequestResponse = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })

it.live(
  "get and reply stop serving a removed session's permission requests",
  () =>
    Effect.gen(function* () {
      const handler = yield* ServerFetch.make({
        app: { version: "test" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      })
      const request = (path: string, method: string, body?: unknown) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request(`http://opencode.local${path}`, {
              method,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          )
          return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
        })

      const session = Schema.decodeUnknownSync(SessionResponse)(
        (yield* request("/api/session", "POST", {
          permissions: [{ action: "deploy", resource: "*", effect: "ask" }],
        })).body,
      )
      // The issue's repro: create N unanswered asks against one session.
      const ids: string[] = []
      for (const resource of ["one", "two", "three"]) {
        const asked = Schema.decodeUnknownSync(AskResponse)(
          (yield* request(`/api/session/${session.data.id}/permission`, "POST", {
            action: "deploy",
            resources: [resource],
          })).body,
        )
        expect(asked.data.effect).toBe("ask")
        ids.push(asked.data.id)
      }
      // While the session lives, get serves its requests and list shows all three.
      expect(
        Schema.decodeUnknownSync(RequestResponse)(
          (yield* request(`/api/session/${session.data.id}/permission/${ids[0]}`, "GET")).body,
        ).data.id,
      ).toBe(ids[0])
      expect((yield* request(`/api/session/${session.data.id}/permission`, "GET")).body.data).toHaveLength(3)

      expect((yield* request(`/api/session/${session.data.id}`, "DELETE")).status).toBe(204)

      // After removal every orphan reads not-found, consistent with list.
      for (const id of ids) {
        expect((yield* request(`/api/session/${session.data.id}/permission/${id}`, "GET")).status).toBe(404)
        expect(
          (yield* request(`/api/session/${session.data.id}/permission/${id}/reply`, "POST", { decision: "once" }))
            .status,
        ).toBe(404)
      }
      expect((yield* request(`/api/session/${session.data.id}/permission`, "GET")).status).toBe(404)
    }).pipe(Effect.scoped),
  // Booting the full server plus nine requests is slow on a loaded machine; the
  // default 5s per-test timeout is too tight.
  30_000,
)
