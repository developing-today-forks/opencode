export * as ProviderQuota from "./provider-quota.js"

import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import {
  fetchOpenDesignSessionQuota,
  normalizeOpenDesignCredential,
  type QuotaContext,
  type QuotaResult,
} from "@opencode/ai/quota"
import { Effect } from "effect"

export type FetchImpl = typeof fetch

const emptyContext = (fetchImpl?: FetchImpl): QuotaContext => ({
  credentials: [],
  disabledProviders: new Set(),
  instances: new Map(),
  providerConfig: {},
  ...(fetchImpl ? { fetchImpl } : {}),
})

/**
 * The quota of a provider that is answered from the session cookie the server holds for it (code#5060).
 * The cookie is used here, inside the server, and only the quota result leaves: no caller receives the
 * cookie, and the result carries none. Resolves undefined when the provider has no session-cookie quota or
 * no session-cookie credential is stored for it.
 */
export const sessionCookie = Effect.fn("ProviderQuota.sessionCookie")(function* (
  providerID: string,
  options?: { readonly fetchImpl?: FetchImpl },
) {
  if (providerID !== "opendesign") return undefined
  const credentials = yield* Credential.Service
  const stored = yield* credentials.list(Integration.ID.make(providerID))
  const cookie = stored.map((credential) => credential.value).findLast(Credential.isSessionCookie)
  if (!cookie) return undefined
  const credential = normalizeOpenDesignCredential({ cookie: cookie.cookie, workspaceId: cookie.workspaceID })
  if (!credential) return undefined
  const result: QuotaResult = yield* Effect.promise(() =>
    fetchOpenDesignSessionQuota(emptyContext(options?.fetchImpl), credential),
  )
  return result
})
