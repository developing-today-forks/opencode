export * as ProviderQuota from "./provider-quota.js"

import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { SharedCache } from "./shared-cache.js"
import {
  fetchOpenDesignSessionQuota,
  normalizeOpenDesignCredential,
  OPENDESIGN_SESSION_EXPIRED_ERROR,
  type QuotaContext,
  type QuotaResult,
} from "@opencode/ai/quota"
import { Clock, Effect } from "effect"

export type FetchImpl = typeof fetch

const emptyContext = (fetchImpl?: FetchImpl): QuotaContext => ({
  credentials: [],
  disabledProviders: new Set(),
  instances: new Map(),
  providerConfig: {},
  ...(fetchImpl ? { fetchImpl } : {}),
})

/**
 * How long a session-cookie quota answer is reused (opencode#2804). Each fresh answer costs two upstream
 * calls (session, then usage, each up to 15s), so a polling quota UI or a burst of clients must not fan
 * out to upstream on every request. Callers within this window, and concurrent callers while a fetch is
 * in flight, share one fetch. The key holds the credential, its workspace and a fingerprint of the cookie
 * (never the cookie), so an edited or reselected credential is fetched fresh.
 */
export const sessionCookieQuotaTtlMillis = 30_000

/**
 * How long a failed answer is reused when the failure may pass on its own (an upstream 5xx, a timeout, a
 * dropped connection, an unreadable body), so the quota recovers soon after upstream does (opencode#2869).
 * An expired session keeps the full TTL: it stays failed until the cookie changes, and a changed cookie is a
 * new key anyway, so retrying it sooner would only call upstream again for the same refusal.
 */
export const sessionCookieQuotaRetryMillis = 5_000

const reusedFor = (result: QuotaResult) =>
  result.ok || result.error === OPENDESIGN_SESSION_EXPIRED_ERROR
    ? sessionCookieQuotaTtlMillis
    : sessionCookieQuotaRetryMillis

const answers = new Map<string, { readonly expiresAt: number; readonly result: Promise<QuotaResult> }>()

const shared = (key: string, now: number, clock: Clock.Clock, fetchQuota: () => Promise<QuotaResult>) => {
  for (const [stale, entry] of answers) if (entry.expiresAt <= now) answers.delete(stale)
  const cached = answers.get(key)
  if (cached) return cached.result
  const result = fetchQuota()
  answers.set(key, { expiresAt: now + sessionCookieQuotaTtlMillis, result })
  result.then(
    // Callers in flight shared the fetch; once it settles, a failure that may pass is kept only briefly.
    // The reuse window starts when the fetch settles, not when it started: a slow transient failure
    // (opencode#2873) must not expire before it is even cached, or the next caller refetches at once.
    (answer) => {
      const entry = answers.get(key)
      if (entry?.result === result)
        answers.set(key, { expiresAt: Effect.runSync(clock.currentTimeMillis) + reusedFor(answer), result })
    },
    // A rejected fetch is not an answer: drop it so the next caller retries.
    () => {
      if (answers.get(key)?.result === result) answers.delete(key)
    },
  )
  return result
}

/**
 * The quota of a provider that is answered from the session cookie the server holds for it (code#5060).
 * The cookie is used here, inside the server, and only the quota result leaves: no caller receives the
 * cookie, and the result carries none. The answer comes from the integration's selected credential (the
 * active one, as Credential.list orders it last); when that is not a session cookie, or no credential is
 * stored, this resolves undefined, even if a deselected session cookie is still stored (opencode#2804).
 * Resolves undefined too for a provider with no session-cookie quota.
 */
export const sessionCookie = Effect.fn("ProviderQuota.sessionCookie")(function* (
  providerID: string,
  options?: { readonly fetchImpl?: FetchImpl },
) {
  if (providerID !== "opendesign") return undefined
  const credentials = yield* Credential.Service
  const stored = yield* credentials.list(Integration.ID.make(providerID))
  const selected = stored.at(-1)
  if (!selected || !Credential.isSessionCookie(selected.value)) return undefined
  const cookie = selected.value
  const credential = normalizeOpenDesignCredential({ cookie: cookie.cookie, workspaceId: cookie.workspaceID })
  if (!credential) return undefined
  const now = yield* Clock.currentTimeMillis
  const clock = yield* Effect.clock
  const key = [providerID, selected.id, cookie.workspaceID, SharedCache.fingerprint(cookie.cookie)].join("\u0000")
  const result: QuotaResult = yield* Effect.promise(() =>
    shared(key, now, clock, () => fetchOpenDesignSessionQuota(emptyContext(options?.fetchImpl), credential)),
  )
  return result
})
