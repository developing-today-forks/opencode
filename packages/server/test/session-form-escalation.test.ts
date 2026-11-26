import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

// Regression tests for #1884 (question escalation): a subsession's pending
// question form must be visible to and answerable by its ancestors, while
// unrelated sessions and descendants of the owner stay locked out. The oracle
// is the form endpoints' before/after state plus the owning session's view.
it.live("a parent can list, get, reply to, and cancel forms owned by its descendants", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      // Hermetic like every sibling server test: without this the models.dev
      // refresh intermittently attempts a live fetch of the models catalog,
      // which the test harness's network guard fails the test for.
      models: { fetch: false },
    })
    const request = (route: string, init?: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://opencode.local${route}`, init)))
    const post = (route: string, body: unknown) =>
      request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const createSession = (body: unknown) =>
      Effect.gen(function* () {
        const response = yield* post("/api/session", body)
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json())).data
      })
    const createForm = (sessionID: string, title: string) =>
      Effect.gen(function* () {
        const response = yield* post(`/api/session/${sessionID}/form`, {
          title,
          fields: [{ key: "answer", type: "string" }],
        })
        expect(response.status).toBe(200)
        const body = (yield* Effect.promise(() => response.json())) as {
          data: { id: string; sessionID: string; title: string }
        }
        return body.data
      })
    const listFormIDs = (sessionID: string) =>
      Effect.gen(function* () {
        const response = yield* request(`/api/session/${sessionID}/form`)
        expect(response.status).toBe(200)
        const body = (yield* Effect.promise(() => response.json())) as { data: { id: string }[] }
        return body.data.map((form) => form.id)
      })

    const root = yield* createSession({ title: "Root" })
    const child = yield* createSession({ parentID: root.id, title: "Child" })
    const grandchild = yield* createSession({ parentID: child.id, title: "Grandchild" })
    const unrelated = yield* createSession({ title: "Unrelated" })

    const rootForm = yield* createForm(root.id, "Root question")
    const childForm = yield* createForm(child.id, "Child question")
    const grandchildForm = yield* createForm(grandchild.id, "Grandchild question")
    const unrelatedForm = yield* createForm(unrelated.id, "Unrelated question")

    // Pass-up visibility: each ancestor lists its descendants' pending forms,
    // carrying the owning sessionID, and nothing outside its subtree.
    expect(yield* listFormIDs(root.id)).toEqual(expect.arrayContaining([rootForm.id, childForm.id, grandchildForm.id]))
    expect(yield* listFormIDs(root.id)).not.toContain(unrelatedForm.id)
    expect(yield* listFormIDs(child.id)).toEqual(expect.arrayContaining([childForm.id, grandchildForm.id]))
    expect(yield* listFormIDs(child.id)).not.toContain(rootForm.id)
    expect(yield* listFormIDs(grandchild.id)).toEqual([grandchildForm.id])
    expect(yield* listFormIDs(unrelated.id)).toEqual([unrelatedForm.id])

    // Parent-answer path: the root can get a grandchild's form and reply with
    // the existing answer shape; the owning session then sees it answered.
    const fetched = yield* request(`/api/session/${root.id}/form/${grandchildForm.id}`)
    expect(fetched.status).toBe(200)
    expect(yield* Effect.promise(() => fetched.json())).toMatchObject({
      data: { id: grandchildForm.id, sessionID: grandchild.id, state: { status: "pending" } },
    })
    const reply = yield* post(`/api/session/${root.id}/form/${childForm.id}/reply`, {
      answer: { answer: "from the root" },
    })
    expect(reply.status).toBe(204)
    const settled = yield* request(`/api/session/${child.id}/form/${childForm.id}`)
    expect(settled.status).toBe(200)
    expect(yield* Effect.promise(() => settled.json())).toMatchObject({
      data: { state: { status: "answered", answer: { answer: "from the root" } } },
    })

    // An ancestor may also cancel a descendant's pending form.
    const cancel = yield* request(`/api/session/${root.id}/form/${grandchildForm.id}?message=no`, {
      method: "DELETE",
    })
    expect(cancel.status).toBe(204)
    const cancelled = yield* request(`/api/session/${grandchild.id}/form/${grandchildForm.id}`)
    expect(yield* Effect.promise(() => cancelled.json())).toMatchObject({
      data: { state: { status: "cancelled" } },
    })

    // No sideways or downward access: unrelated sessions and descendants of
    // the owner still get the same 404 as a missing form.
    const sideways = yield* request(`/api/session/${unrelated.id}/form/${rootForm.id}`)
    expect(sideways.status).toBe(404)
    const downward = yield* request(`/api/session/${child.id}/form/${rootForm.id}`)
    expect(downward.status).toBe(404)
    const sidewaysReply = yield* post(`/api/session/${unrelated.id}/form/${rootForm.id}/reply`, {
      answer: { answer: "wrong session" },
    })
    expect(sidewaysReply.status).toBe(404)
  }).pipe(Effect.scoped),
)

// Regression test for #2832: descendant traversal must follow the session
// list's pagination cursor. With more children than the default 50-session
// page, the first-page-only walk omitted the remaining children — and their
// whole subtrees — from the root's form list. The oracle is exact: the root
// lists every pending descendant form exactly once, across more than one
// page boundary, and nothing outside its subtree.
it.live("a root lists descendant forms past the first 50-child page, exactly once", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (route: string, init?: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://opencode.local${route}`, init)))
    const post = (route: string, body: unknown) =>
      request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const createSession = (body: unknown) =>
      Effect.gen(function* () {
        const response = yield* post("/api/session", body)
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json())).data
      })
    const createForm = (sessionID: string, title: string) =>
      Effect.gen(function* () {
        const response = yield* post(`/api/session/${sessionID}/form`, {
          title,
          fields: [{ key: "answer", type: "string" }],
        })
        expect(response.status).toBe(200)
        const body = (yield* Effect.promise(() => response.json())) as {
          data: { id: string; sessionID: string; title: string }
        }
        return body.data
      })
    const listFormIDs = (sessionID: string) =>
      Effect.gen(function* () {
        const response = yield* request(`/api/session/${sessionID}/form`)
        expect(response.status).toBe(200)
        const body = (yield* Effect.promise(() => response.json())) as { data: { id: string }[] }
        return body.data.map((form) => form.id)
      })

    const root = yield* createSession({ title: "Root" })
    const unrelated = yield* createSession({ title: "Unrelated" })
    // 105 direct children cross two 50-item page boundaries (50 + 50 + 5),
    // whichever order the pages come in.
    const children: { id: string }[] = []
    for (let index = 0; index < 105; index++) {
      children.push(yield* createSession({ parentID: root.id, title: `Child ${index}` }))
    }
    // A grandchild below the first-created child: its form is only reachable
    // if that child's subtree is traversed at all.
    const grandchild = yield* createSession({ parentID: children[0].id, title: "Grandchild" })

    const expected: string[] = []
    for (const child of children) {
      expected.push((yield* createForm(child.id, `Question from ${child.id}`)).id)
    }
    const grandchildForm = yield* createForm(grandchild.id, "Grandchild question")
    expected.push(grandchildForm.id)
    const unrelatedForm = yield* createForm(unrelated.id, "Unrelated question")

    const rootForms = yield* listFormIDs(root.id)
    expect(rootForms).toHaveLength(expected.length)
    expect(new Set(rootForms).size).toBe(expected.length)
    expect(rootForms).toEqual(expect.arrayContaining(expected))
    expect(rootForms).not.toContain(unrelatedForm.id)

    // The first-created child's own view still carries its subtree only.
    const firstChildForms = yield* listFormIDs(children[0].id)
    expect(firstChildForms).toHaveLength(2)
    expect(firstChildForms).toContain(grandchildForm.id)
    expect(yield* listFormIDs(unrelated.id)).toEqual([unrelatedForm.id])
  }).pipe(Effect.scoped),
)
