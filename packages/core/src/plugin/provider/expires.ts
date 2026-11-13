import { serverSeconds } from "../../util/number.js"

/**
 * Validation for OAuth `expires_in` values (#879). Five providers computed
 * the stored credential expiry as `now + (tokens.expires_in ?? fallback)`,
 * which only guards an ABSENT value: a negative or zero lifetime stored a
 * born-expired credential (the integration layer refreshes it on every
 * request), a non-finite one poisoned the comparison, and an oversized one
 * — the classic server bug of returning the lifetime in milliseconds —
 * disabled refresh for weeks, because the consumer treats the credential
 * as valid until the stored expiry. The xAI provider's local
 * `positiveSeconds` (xai.ts) is the precedent; this is the shared version
 * for the providers that never got the guard. Since #892 the xAI provider
 * uses it for its token/device lifetimes too (its local helper remains
 * only for the poll interval), and Poe clamps to the same bound.
 * DigitalOcean's string-spelling parser clamps to it too (#899).
 */


/**
 * The longest lifetime stored verbatim, in seconds (30 days). Real OAuth
 * access-token lifetimes are far shorter; anything past this bound is a
 * malformed or unit-confused response and takes the fallback instead.
 */
export const MAX_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60

/**
 * The lifetime to store for a token response: the response's own value when
 * it is a positive, finite number of seconds within the sane bound, else
 * the provider's existing default lifetime.
 */
export function expiresInSeconds(value: unknown, fallback: number): number {
  return serverSeconds(Number(value), { fallback, max: MAX_EXPIRES_IN_SECONDS, oversized: "fallback" })
}

/**
 * The longest device-code lifetime honored, in seconds (10 minutes) — the
 * integration layer's default attempt lifetime (`integration.ts`). A device
 * code's server-supplied `expires_in` sets the poll deadline / attempt
 * expiry outright (#900), so a millisecond-confused value such as 600000
 * would poll the token endpoint for ~6.9 days. Values past this bound are
 * treated as the bound; valid lifetimes pass through unchanged and
 * non-positive/absent values take the provider's fallback.
 */
export const MAX_DEVICE_LIFETIME_SECONDS = 10 * 60

export function deviceLifetimeSeconds(value: unknown, fallback: number): number {
  return serverSeconds(Number(value), { fallback, max: MAX_DEVICE_LIFETIME_SECONDS, oversized: "clamp" })
}
