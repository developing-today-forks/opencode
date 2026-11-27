import { describe, expect } from "bun:test"
import { Effect, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
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

/** A stubbed upstream whose usage endpoint gives each answer in `usages` in turn, then repeats the last. */
const upstreamSequence = (usages: ReadonlyArray<{ status: number; body: unknown }>) => {
  const seen: string[] = []
  let reads = 0
  const fetchImpl = (async (input: Request | URL | string) => {
    const url = String(input)
    seen.push(url)
    if (url.endsWith("/auth/get-session")) return Response.json({ user: { id: "usr_fixture" } })
    const usage = usages[Math.min(reads++, usages.length - 1)]!
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

const storeCookie = (cookie = FIXTURE_COOKIE, workspaceID = FIXTURE_WORKSPACE, activate?: boolean) =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    return yield* credentials.create({
      integrationID: Integration.ID.make("opendesign"),
      label: "Open Design",
      value: Credential.SessionCookie.make({ type: "session-cookie", cookie, workspaceID }),
      ...(activate === undefined ? {} : { activate }),
    })
  })

/** The session cookies the stub upstream was called with, in order. */
const cookiesSeen = (seen: ReadonlyArray<{ cookie: string | null }>) => seen.map((request) => request.cookie)

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

  it.effect("answers from the active cookie, not a newer deselected one (opencode#2804)", () =>
    Effect.gen(function* () {
      yield* storeCookie("active-older-cookie", "wrk_active")
      // Stored later, but not selected.
      yield* storeCookie("inactive-newer-cookie", "wrk_inactive", false)
      const stub = upstream({ status: 200, body: usagePayload })
      expect(yield* ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })).toBeDefined()
      expect(stub.seen.length).toBeGreaterThan(0)
      expect(cookiesSeen(stub.seen).every((cookie) => cookie === "better-auth.session_token=active-older-cookie")).toBe(
        true,
      )
    }),
  )

  it.effect("resolves undefined when the active credential is not a session cookie (opencode#2804)", () =>
    Effect.gen(function* () {
      yield* storeCookie("deselected-cookie", "wrk_deselected")
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("opendesign"),
        label: "API key",
        value: Credential.Key.make({ type: "key", key: "fixture-api-key" }),
      })
      const stub = upstream({ status: 200, body: usagePayload })
      expect(yield* ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })).toBeUndefined()
      expect(stub.seen).toEqual([])
    }),
  )

  it.effect("reuses one upstream fetch for repeated and concurrent calls (opencode#2804)", () =>
    Effect.gen(function* () {
      yield* storeCookie("shared-fetch-cookie", "wrk_shared")
      const stub = upstream({ status: 200, body: usagePayload })
      const call = ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })
      const concurrent = yield* Effect.all([call, call, call], { concurrency: "unbounded" })
      const again = yield* call
      // One session check plus one usage read, however many callers asked.
      expect(stub.seen).toHaveLength(2)
      for (const value of [...concurrent, again]) expect(value).toEqual(concurrent[0])
    }),
  )

  it.effect("fetches fresh after the selection changes (opencode#2804)", () =>
    Effect.gen(function* () {
      const first = yield* storeCookie("reselect-first-cookie", "wrk_first")
      yield* storeCookie("reselect-second-cookie", "wrk_second")
      const stub = upstream({ status: 200, body: usagePayload })
      const call = ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })
      yield* call
      const credentials = yield* Credential.Service
      yield* credentials.activate(first.id)
      yield* call
      expect(cookiesSeen(stub.seen)).toContain("better-auth.session_token=reselect-second-cookie")
      expect(cookiesSeen(stub.seen)).toContain("better-auth.session_token=reselect-first-cookie")
      expect(stub.seen).toHaveLength(4)
    }),
  )

  it.effect("starts the transient-failure retry window when the fetch settles (opencode#2873)", () =>
    Effect.gen(function* () {
      yield* storeCookie("delayed-transient-failure-cookie", "wrk_delayed_transient")
      let releaseUsage: (response: Response) => void = () => {}
      let markUsageStarted: () => void = () => {}
      const usageStarted = new Promise<void>((resolve) => (markUsageStarted = resolve))
      const delayedUsage = new Promise<Response>((resolve) => (releaseUsage = resolve))
      const seen: string[] = []
      let usageReads = 0
      const fetchImpl = (async (input: Request | URL | string) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith("/auth/get-session")) return Response.json({ user: { id: "usr_fixture" } })
        if (usageReads++ > 0) return Response.json(usagePayload)
        markUsageStarted()
        return delayedUsage
      }) as typeof fetch
      const fiber = yield* Effect.fork(ProviderQuota.sessionCookie("opendesign", { fetchImpl }))
      yield* Effect.promise(() => usageStarted)
      yield* TestClock.adjust("6 seconds")
      releaseUsage(Response.json({}, { status: 503 }))

      expect(yield* Fiber.join(fiber)).toMatchObject({ ok: false })
      expect(yield* ProviderQuota.sessionCookie("opendesign", { fetchImpl })).toMatchObject({ ok: false })
      // The oracle is one upstream session/usage pair until five seconds after settlement.
      expect(seen).toHaveLength(2)
      yield* TestClock.adjust(ProviderQuota.sessionCookieQuotaRetryMillis)
      expect(yield* ProviderQuota.sessionCookie("opendesign", { fetchImpl })).toMatchObject({ ok: true })
      expect(seen).toHaveLength(4)
    }),
  )

  it.effect("retries a transient upstream failure well before the success TTL ends (opencode#2869)", () =>
    Effect.gen(function* () {
      yield* storeCookie("transient-failure-cookie", "wrk_transient")
      const stub = upstreamSequence([
        { status: 503, body: {} },
        { status: 200, body: usagePayload },
      ])
      const call = ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })
      // Concurrent callers still share the one failing fetch.
      const failed = yield* Effect.all([call, call], { concurrency: "unbounded" })
      for (const value of failed) expect(value).toMatchObject({ ok: false })
      expect(stub.seen).toHaveLength(2)
      // Inside the retry window the failure is reused rather than fetched again.
      expect(yield* call).toMatchObject({ ok: false })
      expect(stub.seen).toHaveLength(2)
      yield* TestClock.adjust(ProviderQuota.sessionCookieQuotaRetryMillis)
      // Upstream recovered, and so does the quota, long before 30 seconds.
      expect(ProviderQuota.sessionCookieQuotaRetryMillis).toBeLessThan(ProviderQuota.sessionCookieQuotaTtlMillis)
      expect(yield* call).toMatchObject({ ok: true })
      expect(stub.seen).toHaveLength(4)
      // The success is then kept for the full TTL.
      yield* TestClock.adjust(ProviderQuota.sessionCookieQuotaRetryMillis)
      expect(yield* call).toMatchObject({ ok: true })
      expect(stub.seen).toHaveLength(4)
    }),
  )

  it.effect("keeps an expired-session answer for the full TTL instead of retrying it (opencode#2869)", () =>
    Effect.gen(function* () {
      yield* storeCookie("expired-session-cookie", "wrk_expired")
      const stub = upstreamSequence([
        { status: 403, body: {} },
        { status: 200, body: usagePayload },
      ])
      const call = ProviderQuota.sessionCookie("opendesign", { fetchImpl: stub.fetchImpl })
      expect(yield* call).toMatchObject({ ok: false })
      yield* TestClock.adjust(ProviderQuota.sessionCookieQuotaRetryMillis)
      expect(yield* call).toMatchObject({ ok: false })
      expect(stub.seen).toHaveLength(2)
      yield* TestClock.adjust(ProviderQuota.sessionCookieQuotaTtlMillis)
      expect(yield* call).toMatchObject({ ok: true })
      expect(stub.seen).toHaveLength(4)
    }),
  )
})
