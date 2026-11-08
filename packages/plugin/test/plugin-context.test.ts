import { expect, test } from "bun:test"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { SessionsCursor } from "@opencode/protocol/groups/session"
import { Effect, Schema } from "effect"
import { fromPromise } from "../src/promise/adapter.js"
import type { Plugin } from "../src/promise/plugin.js"

const child = Schema.decodeUnknownSync(Session.Info)({
  id: "ses_child_1",
  parentID: "ses_parent_1",
  projectID: "prj_test",
  cost: 0,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
  location: { directory: "/tmp/opencode-test" },
  title: "child session",
})

const childCursor = SessionsCursor.make({
  anchor: { id: Session.ID.make("ses_child_1"), time: 1_700_000_001_000, direction: "next" },
})

const received: unknown[] = []

// Only session.list and serverUrl are exercised; every other domain fails
// loudly if the test plugin touches it. The container cast keeps the stub
// focused: full Effect Context conformance is covered by core's test host.
const die = () => Effect.die(new Error("unused domain"))
const stub = {
  app: { name: "test", version: "test", channel: "test" },
  location: new Location.Info({
    directory: "/tmp/opencode-test",
    project: { id: Project.ID.make("prj_test"), directory: "/tmp/opencode-test", canonical: "/tmp/opencode-test" },
  }),
  options: {},
  serverUrl: "http://127.0.0.1:4096",
  agent: { get: die, list: die, transform: die, reload: die },
  aisdk: { hook: die },
  command: { list: die, transform: die, reload: die },
  credential: { activate: die },
  event: { subscribe: die },
  experimental: { terminal: { read: die } },
  generate: { text: die },
  model: { list: die, default: die, transform: die, reload: die },
  provider: { list: die, get: die, transform: die, reload: die },
  integration: {
    list: die,
    get: die,
    connect: { key: die, external: die },
    oauth: { connect: die, status: die, complete: die, cancel: die },
    command: { connect: die, status: die, cancel: die },
    reload: die,
    connection: { active: die, resolve: die, status: die },
    transform: die,
  },
  mcp: { list: die, transform: die, reload: die },
  messaging: {
    send: die,
    user: die,
    query: die,
    inspect: die,
    visibility: die,
    settings: die,
    subscribe: die,
    topic: die,
    topics: die,
    chain: die,
    sessions: die,
    log: die,
    vars: die,
    setVar: die,
    model: { status: die, configure: die },
    kinds: { register: die, list: die },
    write: die,
  },
  permission: { hook: die, list: die, get: die, reply: die, assert: die },
  plugin: { list: die },
  reference: { list: die, transform: die, reload: die },
  rpc: () => Effect.die(new Error("unused rpc")),
  skill: { list: die, transform: die, reload: die },
  storage: { get: die, set: die, remove: die, scan: die },
  tool: { reload: die, list: die, transform: die, hook: die },
  vcs: {
    get: die,
    base: die,
    branch: { list: die },
    status: die,
    diff: die,
    transform: die,
    reload: die,
  },
  websearch: { providers: die, query: die, reload: die, transform: die },
  worktree: { list: die, create: die, remove: die, refresh: die, reload: die, transform: die },
  session: {
    hook: die,
    list: (input: unknown) => {
      received.push(input)
      return Effect.succeed({ data: [child], cursor: { next: childCursor } })
    },
    create: die,
    get: die,
    remove: die,
    switchAgent: die,
    switchModel: die,
    prompt: die,
    generate: die,
    command: die,
    compact: die,
    synthetic: die,
    interrupt: die,
    update: die,
    move: die,
    wait: die,
    context: die,
  },
  shell: { hook: die },
}

test("plugin reads serverUrl and lists child sessions through the session domain", async () => {
  const seen: { serverUrl?: string; childIDs?: string[]; nextCursor?: string } = {}
  const plugin: Plugin = {
    id: "test-context",
    setup: async (ctx) => {
      seen.serverUrl = ctx.serverUrl
      const children = await ctx.session.list({ parentID: null })
      seen.childIDs = children.data.map((session) => session.id)
      seen.nextCursor = children.cursor.next
      await ctx.session.list()
    },
  }
  await Effect.runPromise(Effect.scoped(fromPromise(plugin).effect(stub as never)))
  expect(seen.serverUrl).toBe("http://127.0.0.1:4096")
  expect(seen.childIDs).toEqual(["ses_child_1"])
  expect(seen.nextCursor).toBe(childCursor)
  expect(received).toEqual([{ parentID: null }, {}])
})
