import { createRemoteJWKSet, type JWTPayload } from "jose"

const remoteJWKSetByURL = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

// Option values are part of the cache key (#1898): a set is built once with the
// options of its first call, so keying by URL alone silently handed later callers
// a set governed by options they never passed. Plain option data is serialized
// with sorted keys; function values (jose's customFetch) key by identity.
const functionIDs = new WeakMap<object, number>()
let nextFunctionID = 0

const optionKeyPart = (value: unknown): string => {
  if (typeof value === "function") {
    let id = functionIDs.get(value)
    if (id === undefined) {
      id = ++nextFunctionID
      functionIDs.set(value, id)
    }
    return "fn:" + id
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return "[" + value.map(optionKeyPart).join(",") + "]"
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + optionKeyPart(entry)).join(",") + "}"
}

/**
 * The shared remote JWK set for a JWKS URL, created lazily once and reused across
 * requests (#1112). `createRemoteJWKSet` is designed for this: each instance keeps
 * its own in-memory cache (10-minute default max-age) and refreshes it when a token
 * arrives with an unknown `kid`, so key rotation keeps working. Building a fresh set
 * inside a request handler — as the token exchange used to — leaves the cache
 * permanently cold and makes every verification fetch the JWKS document live.
 * Keyed by URL and options so distinct issuers (and tests, with their own counting
 * endpoints) never share a cache, and a caller never silently gets a set built
 * with another caller's options (#1898).
 */
export const githubActionsJWKSet = (
  jwksURL: URL,
  options?: Parameters<typeof createRemoteJWKSet>[1],
): ReturnType<typeof createRemoteJWKSet> => {
  const key = options === undefined ? jwksURL.href : jwksURL.href + "\n" + optionKeyPart(options)
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
