export * as ProviderQuota from "./provider-quota.js"

import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { SharedCache } from "./shared-cache.js"
import {
  fetchOpenDesignSessionQuota,
  normalizeOpenDesignCredential,
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

const answers = new Map<string, { readonly expiresAt: number; readonly result: Promise<QuotaResult> }>()

const shared = (key: string, now: number, fetchQuota: () => Promise<QuotaResult>) => {
  for (const [stale, entry] of answers) if (entry.expiresAt <= now) answers.delete(stale)
  const cached = answers.get(key)
  if (cached) return cached.result
  const result = fetchQuota()
  answers.set(key, { expiresAt: now + sessionCookieQuotaTtlMillis, result })
  // A rejected fetch is not an answer: drop it so the next caller retries.
  result.catch(() => {
    if (answers.get(key)?.result === result) answers.delete(key)
  })
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
  const key = [providerID, selected.id, cookie.workspaceID, SharedCache.fingerprint(cookie.cookie)].join("\u0000")
  const result: QuotaResult = yield* Effect.promise(() =>
    shared(key, now, () => fetchOpenDesignSessionQuota(emptyContext(options?.fetchImpl), credential)),
  )
  return result
})
