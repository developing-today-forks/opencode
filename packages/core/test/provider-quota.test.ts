import { describe, expect } from "bun:test"
import { Effect, Logger } from "effect"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Integration } from "@opencode/core/integration"
import { ProviderQuota } from "@opencode/core/provider-quota"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Bus.node, Database.node])))

const FIXTURE_COOKIE = "fixture-session-token-7f3a9c"
const FIXTURE_WORKSPACE = "wrk_fixture"

const usagePayload = {
  windows: [
    { durationSeconds: 18000, limitCredits: 100, remainingCredits: 60, resetsAt: 1793491200000 },
    { durationSeconds: 604800, limitCredits: 1000, remainingCredits: 250, resetsAt: 1793491200000 },
  ],
}

/** A stubbed upstream: the session answers, and the usage endpoint answers with `usage`. */
const upstream = (usage: { status: number; body: unknown }) => {
  const seen: { url: string; cookie: string | null }[] = []
  const fetchImpl = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = String(input)
    const cookie = new Headers(init?.headers).get("cookie")
    seen.push({ url, cookie })
    if (url.endsWith("/auth/get-session")) return Response.json({ user: { id: "usr_fixture" } })
    return Response.json(usage.body, { status: usage.status })
  }) as typeof fetch
  return { fetchImpl, seen }
}

/** Log messages the effect emits while it runs; the oracle checks them for the cookie. */
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const messages: string[] = []
  const logger = Logger.make(({ message }) => {
    messages.push(JSON.stringify(message))
  })
  return effect.pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.map((value) => ({ value, logs: messages })),
  )
}

const storeCookie = () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: Integration.ID.make("opendesign"),
      label: "Open Design",
      value: Credential.SessionCookie.make({
        type: "session-cookie",
        cookie: FIXTURE_COOKIE,
        workspaceID: FIXTURE_WORKSPACE,
      }),
    })
  })

describe("ProviderQuota.sessionCookie", () => {
  it.effect(
    "answers the opendesign quota with the stored cookie, and the cookie is absent from every emitted surface",
    () =>
      Effect.gen(function* () {
        yield* storeCookie()
        const stub = upstream({ status: 200, body: usagePayload })
        const { value, logs } = yield* captureLogs(
          ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl }),
        )

        // The quota answer itself is returned successfully.
        expect(value).toBeDefined()
        expect(value).toMatchObject({
          providerId: "opendesign",
          ok: true,
          configured: true,
          usage: { windows: { "5h": { usedPercent: 40, valueLabel: "60 / 100 credits" } } },
        })
        // The cookie was used by the server against the upstream...
        expect(stub.seen.map((request) => request.cookie)).toContain(`better-auth.session_token=${FIXTURE_COOKIE}`)
        // ...and it appears in no response body, error, or log line: the oracle is the fixture string's absence.
        expect(JSON.stringify(value)).not.toContain(FIXTURE_COOKIE)
        expect(logs.join("\n")).not.toContain(FIXTURE_COOKIE)
      }),
  )

  it.effect("returns a failed quota result without the cookie when the upstream rejects the session", () =>
    Effect.gen(function* () {
      yield* storeCookie()
      const stub = upstream({ status: 403, body: {} })
      const { value, logs } = yield* captureLogs(
        ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl }),
      )

      expect(value).toMatchObject({ providerId: "opendesign", ok: false, configured: true })
      expect(JSON.stringify(value)).not.toContain(FIXTURE_COOKIE)
      expect(logs.join("\n")).not.toContain(FIXTURE_COOKIE)
    }),
  )

  it.effect("resolves undefined for a provider without a session-cookie quota or a stored cookie", () =>
    Effect.gen(function* () {
      const stub = upstream({ status: 200, body: usagePayload })
      expect(yield* ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })).toBeUndefined()
      expect(yield* ProviderQuota.sessionCookie("openai", { fetchImpl: stub.fetchImpl })).toBeUndefined()
      expect(stub.seen).toEqual([])
    }),
  )
})
