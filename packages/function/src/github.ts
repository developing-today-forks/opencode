import { createRemoteJWKSet, type JWTPayload } from "jose"

const remoteJWKSetByURL = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/**
 * The shared remote JWK set for a JWKS URL, created lazily once and reused across
 * requests (#1112). `createRemoteJWKSet` is designed for this: each instance keeps
 * its own in-memory cache (10-minute default max-age) and refreshes it when a token
 * arrives with an unknown `kid`, so key rotation keeps working. Building a fresh set
 * inside a request handler — as the token exchange used to — leaves the cache
 * permanently cold and makes every verification fetch the JWKS document live.
 * Keyed by URL so distinct issuers (and tests, with their own counting endpoints)
 * never share a cache.
 */
export const githubActionsJWKSet = (
  jwksURL: URL,
  options?: Parameters<typeof createRemoteJWKSet>[1],
): ReturnType<typeof createRemoteJWKSet> => {
  const key = jwksURL.href
  const existing = remoteJWKSetByURL.get(key)
  if (existing) return existing
  const created = createRemoteJWKSet(jwksURL, options)
  remoteJWKSetByURL.set(key, created)
  return created
}

export function parseRepositoryClaim(payload: JWTPayload) {
  const claim = payload.repository
  if (typeof claim !== "string") throw new Error("Repository claim is missing")

  const parts = claim.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Repository claim is invalid")

  return {
    owner: parts[0],
    repo: parts[1],
  }
}
