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

type CacheEntry = { expiresAt: number; settled: boolean; result: Promise<QuotaResult> }

const answers = new Map<string, CacheEntry>()

const shared = (key: string, now: number, fetchQuota: () => Promise<QuotaResult>) => {
  for (const [stale, entry] of answers) if (entry.expiresAt <= now) answers.delete(stale)
  const cached = answers.get(key)
  if (cached) return cached
  // Keep slow requests shareable; the result-specific TTL starts when a caller observes settlement.
  const entry: CacheEntry = { expiresAt: Number.POSITIVE_INFINITY, settled: false, result: fetchQuota() }
  answers.set(key, entry)
  // A rejected fetch is not an answer: drop it so the next caller retries.
  entry.result.then(undefined, () => {
    if (answers.get(key) === entry) answers.delete(key)
  })
  return entry
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
  const key = [providerID, selected.id, cookie.workspaceID, SharedCache.fingerprint(cookie.cookie)].join("\u0000")
  const entry = shared(key, now, () => fetchOpenDesignSessionQuota(emptyContext(options?.fetchImpl), credential))
  const result: QuotaResult = yield* Effect.promise(() => entry.result)
  if (!entry.settled) {
    const settledAt = yield* Clock.currentTimeMillis
    if (!entry.settled) {
      entry.settled = true
      if (answers.get(key) === entry) entry.expiresAt = settledAt + reusedFor(result)
    }
  }
  return result
})
