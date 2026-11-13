import { describe, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose"
import { githubActionsJWKSet, parseRepositoryClaim } from "../src/github"

describe("parseRepositoryClaim", () => {
  test("reads repository identity with a legacy subject", () => {
    expect(
      parseRepositoryClaim({
        repository: "octocat/my-repo",
        sub: "repo:octocat/my-repo:ref:refs/heads/main",
      }),
    ).toEqual({ owner: "octocat", repo: "my-repo" })
  })

  test("reads repository identity with an immutable subject", () => {
    expect(
      parseRepositoryClaim({
        repository: "octocat/my-repo",
        sub: "repo:octocat@123456/my-repo@456789:ref:refs/heads/main",
      }),
    ).toEqual({ owner: "octocat", repo: "my-repo" })
  })

  test("does not depend on a repository path in a customized subject", () => {
    expect(
      parseRepositoryClaim({
        repository: "octocat/my-repo",
        sub: "repository_owner:octocat:repository_visibility:private",
      }),
    ).toEqual({ owner: "octocat", repo: "my-repo" })
  })

  test("rejects a missing repository claim", () => {
    expect(() => parseRepositoryClaim({})).toThrow("Repository claim is missing")
  })

  test("rejects an invalid repository claim", () => {
    expect(() => parseRepositoryClaim({ repository: "octocat" })).toThrow("Repository claim is invalid")
  })
})

describe("githubActionsJWKSet (#1112)", () => {
  const issuer = "https://token.actions.githubusercontent.com"
  const audience = "opencode-github-action"

  const serveJWKS = (state: { keys: JWK[]; fetches: number }) => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        state.fetches++
        return Response.json({ keys: state.keys })
      },
    })
    return { url: new URL(`http://127.0.0.1:${server.port}/.well-known/jwks`), stop: () => server.stop(true) }
  }

  const sign = (privateKey: Parameters<SignJWT["sign"]>[0], kid: string) =>
    new SignJWT({ repository: "octocat/my-repo", sub: "repo:octocat/my-repo:ref:refs/heads/main" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(privateKey)

  test("fetches the JWKS document once across verifications and refreshes on key rotation", async () => {
    const first = await generateKeyPair("RS256")
    const state = {
      keys: [{ ...(await exportJWK(first.publicKey)), kid: "key-1", alg: "RS256", use: "sig" }],
      fetches: 0,
    }
    const server = serveJWKS(state)
    try {
      // cooldownDuration 0 so the rotation refresh below is not throttled;
      // production uses jose's defaults via api.ts.
      const verify = (token: string) =>
        jwtVerify(token, githubActionsJWKSet(server.url, { cooldownDuration: 0 }), { issuer, audience })

      await verify(await sign(first.privateKey, "key-1"))
      await verify(await sign(first.privateKey, "key-1"))
      expect(state.fetches).toBe(1)

      const rotated = await generateKeyPair("RS256")
      state.keys = [{ ...(await exportJWK(rotated.publicKey)), kid: "key-2", alg: "RS256", use: "sig" }]
      await verify(await sign(rotated.privateKey, "key-2"))
      expect(state.fetches).toBe(2)

      const rogue = await generateKeyPair("RS256")
      await expect(verify(await sign(rogue.privateKey, "key-3"))).rejects.toThrow()
    } finally {
      server.stop()
    }
  })

  test("does not silently reuse a set built with different options for the same URL (#1898)", () => {
    // Set construction is lazy (nothing is fetched until a verification), so an
    // unroutable URL is safe here. Oracle: set identity — jose sets are opaque,
    // so identity is exactly what decides whose options govern a verification.
    const url = new URL("http://127.0.0.1:9/.well-known/jwks")
    const first = githubActionsJWKSet(url, { cooldownDuration: 0 })
    expect(githubActionsJWKSet(url, { cooldownDuration: 0 })).toBe(first)
    expect(githubActionsJWKSet(url, { cooldownDuration: 30_000 })).not.toBe(first)
    const noOptions = githubActionsJWKSet(url)
    expect(noOptions).not.toBe(first)
    expect(githubActionsJWKSet(url)).toBe(noOptions)
  })
})
