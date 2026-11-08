import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import { requireServerKey, rootSession, sessionHref } from "./session"

type SessionFixture = { id: string; parentID?: string; fork?: { sessionID: string } }

const lookup = (sessions: Record<string, SessionFixture>) => async (id: string) => {
  const session = sessions[id]

  if (!session) throw new Error(`Missing session: ${id}`)

  return session
}

describe("session routes", () => {
  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("resolves the root session", async () => {
    const sessions = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "root" },
      root: { id: "root" },
    } satisfies Record<string, SessionFixture>

    expect(await rootSession<SessionFixture>(sessions.child, lookup(sessions))).toBe(sessions.root)
  })

  test("resolves the root session across a fork link", async () => {
    const sessions = {
      grandchild: { id: "grandchild", parentID: "fork" },
      fork: { id: "fork", fork: { sessionID: "child" } },
      child: { id: "child", parentID: "root" },
      root: { id: "root" },
    } satisfies Record<string, SessionFixture>

    const get = lookup(sessions)

    expect(await rootSession<SessionFixture>(sessions.grandchild, get)).toBe(sessions.root)
    expect(await rootSession<SessionFixture>(sessions.fork, get)).toBe(sessions.root)
    expect(await rootSession<SessionFixture>(sessions.child, get)).toBe(sessions.root)
  })

  test("rejects a fork-link cycle", async () => {
    const sessions = {
      fork: { id: "fork", fork: { sessionID: "child" } },
      child: { id: "child", parentID: "fork" },
    } satisfies Record<string, SessionFixture>

    await expect(rootSession<SessionFixture>(sessions.fork, lookup(sessions))).rejects.toThrow("Session parent cycle: fork")
  })

  test("rejects a parent cycle", async () => {
    const sessions = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "child" },
    } satisfies Record<string, SessionFixture>

    await expect(rootSession<SessionFixture>(sessions.child, lookup(sessions))).rejects.toThrow("Session parent cycle: child")
  })
})
