import { describe, expect, test } from "bun:test"
import {
  beginClaudeCodeSignIn,
  type CredentialSources,
} from "../../src/providers/claude-code-auth.js"

const deterministic = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251)
const stateFrom = (url: string) => new URL(url).searchParams.get("state")!

const harness = () => {
  const store = new Map<string, string>()
  const calls: Array<{ url: string; body: string }> = []
  const sources: CredentialSources = {
    env: {},
    configDir: "/fixture/claude-dir",
    now: () => 1_000_000,
    randomValues: deterministic,
    readFile: (path) => store.get(path),
    writeFile: async (path, contents) => { store.set(path, contents) },
    renameFile: async (from, to) => { store.set(to, store.get(from)!); store.delete(from) },
    fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") })
      return new Response(JSON.stringify({
        access_token: "tok-signed-in", refresh_token: "ref-signed-in",
        expires_in: 3600, subscription_type: "pro", scope: "user:inference",
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    },
  }
  return { sources, store, calls }
}

describe("probe: code-only paste state handling", () => {
  test("BUG: a paste with NO #state at all is exchanged, with the sign-in's own state substituted", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    const credential = await signIn.callback("auth-code-1")
    expect(credential.accessToken).toBe("tok-signed-in")
    expect(calls).toHaveLength(1)
    const body = new URLSearchParams(calls[0]!.body)
    expect(body.get("code")).toBe("auth-code-1")
    expect(body.get("state")).toBe(stateFrom(signIn.url))
  })
  test("CONTROL: a wrong state is rejected with no exchange", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    await expect(signIn.callback("auth-code-1#wrong-state")).rejects.toThrow("state mismatch")
    expect(calls).toHaveLength(0)
  })
  test("CONTRAST: a trailing # with empty state is rejected with no exchange", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    await expect(signIn.callback("auth-code-1#")).rejects.toThrow("state mismatch")
    expect(calls).toHaveLength(0)
  })
  test("CONTROL: the correct code#state succeeds", async () => {
    const { sources, calls } = harness()
    const signIn = await beginClaudeCodeSignIn(sources)
    const credential = await signIn.callback(`auth-code-1#${stateFrom(signIn.url)}`)
    expect(credential.accessToken).toBe("tok-signed-in")
    expect(calls).toHaveLength(1)
  })
})
