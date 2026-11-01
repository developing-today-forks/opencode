import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type ModelInfo, type OpenCodeEvent, type Project, type SessionInfo } from "../src/promise"

const session = (viewed: number): SessionInfo => ({
  id: "ses_refresh",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 2, viewed },
  location: { directory: "/project" },
})

test("uses the configured initial window and retains normal cursor page sizes", async () => {
  const requests: { limit: string | null; cursor: string | null }[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      const cursor = url.searchParams.get("cursor")
      requests.push({ limit: url.searchParams.get("limit"), cursor })
      return Response.json({
        data: [{ id: cursor ? "msg_1" : "msg_2", type: "user", text: "History", time: { created: cursor ? 1 : 2 } }],
        cursor: cursor ? {} : { next: "older" },
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      initialMessageLimit: () => 40,
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))
  try {
    await setup.data.session.message.sync("ses_refresh")
    await setup.data.session.message.sync("ses_refresh")
    expect(requests).toEqual([{ limit: "40", cursor: null }])
    await setup.data.session.message.loadMore("ses_refresh")
    expect(requests).toEqual([
      { limit: "40", cursor: null },
      { limit: "20", cursor: "older" },
    ])
    expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(["msg_1", "msg_2"])
  } finally {
    setup.dispose()
  }
})

test("counts every subagent page in a root session's cost", async () => {
  const child = (index: number): SessionInfo => ({
    ...session(0),
    id: `ses_child_${index}`,
    parentID: "ses_root",
    cost: 1,
  })
  const requests: string[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      requests.push(`${url.pathname}?${url.searchParams}`)

      if (url.pathname === "/api/session/ses_root") return Response.json({ data: { ...session(0), id: "ses_root", cost: 0.5 } })

      if (url.searchParams.get("cursor") === "page_2")
        return Response.json({ data: Array.from({ length: 50 }, (_, index) => child(200 + index)), cursor: { next: "page_3" } })

      if (url.searchParams.get("parentID") !== "ses_root") return Response.json({ data: [], cursor: {} })

      return Response.json({ data: Array.from({ length: 200 }, (_, index) => child(index)), cursor: { next: "page_2" } })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_root", { children: true })
    expect(setup.data.session.family("ses_root")).toHaveLength(251)
    expect(setup.data.session.cost("ses_root")).toBe(250.5)
    const nested = requests.filter((request) => request.includes("parentID=ses_child_"))
    expect(requests.filter((request) => !request.includes("parentID=ses_child_")).toSorted()).toEqual([
      "/api/session/ses_root?",
      "/api/session?limit=200&cursor=page_2",
      "/api/session?limit=200&order=desc&parentID=ses_root",
    ])
    // Each subagent is asked once for subagents of its own.
    expect(new Set(nested).size).toBe(250)
    expect(nested).toHaveLength(250)
  } finally {
    setup.dispose()
  }
})

test("registers fork descendants in the source family and includes their cost", async () => {
  const sessions: Record<string, SessionInfo> = {
    ses_root: { ...session(0), id: "ses_root", cost: 0.5 },
    ses_child: { ...session(0), id: "ses_child", parentID: "ses_root", cost: 1 },
    ses_fork: {
      ...session(0),
      id: "ses_fork",
      fork: { sessionID: "ses_child", boundary: { type: "through", messageID: "msg_boundary" } },
      cost: 2,
    },
    ses_grandchild: { ...session(0), id: "ses_grandchild", parentID: "ses_fork", cost: 3 },
  }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      const sessionID = url.pathname.match(/^\/api\/session\/(.+)$/)?.[1]
      if (sessionID) return Response.json({ data: sessions[sessionID] })

      const parentID = url.searchParams.get("parentID")
      return Response.json({
        data: Object.values(sessions).filter((item) => item.parentID === parentID),
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_root", { children: true })
    await setup.data.session.sync("ses_fork", { children: true })

    expect(setup.data.session.root("ses_grandchild")).toBe("ses_root")
    expect(setup.data.session.family("ses_root").toSorted()).toEqual([
      "ses_child",
      "ses_fork",
      "ses_grandchild",
      "ses_root",
    ])
    expect(setup.data.session.cost("ses_root")).toBe(6.5)
  } finally {
    setup.dispose()
  }
})

test("discovers nested subagents at any depth, publishing each listing as it resolves", async () => {
  const parents: Record<string, string> = {
    ses_a: "ses_root",
    ses_b: "ses_root",
    ses_a1: "ses_a",
    ses_a2: "ses_a",
    ses_a1x: "ses_a1",
    ses_a2x: "ses_a2",
  }
  const deepest = Promise.withResolvers<void>()
  const requests: string[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      requests.push(`${url.pathname}?${url.searchParams}`)
      if (url.pathname === "/api/session/ses_root") return Response.json({ data: { ...session(0), id: "ses_root" } })
      const parentID = url.searchParams.get("parentID")
      if (parentID === "ses_a1") await deepest.promise
      return Response.json({
        data: Object.entries(parents)
          .filter(([, parent]) => parent === parentID)
          .map(([id, parent]) => ({ ...session(0), id, parentID: parent })),
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    const synced = setup.data.session.sync("ses_root", { children: true })
    // a2's listing publishes its child while a1's listing on the same level is still pending.
    await wait(() => setup.data.session.get("ses_a2x") !== undefined)
    expect(setup.data.session.get("ses_a1x")).toBeUndefined()
    deepest.resolve()
    await synced

    expect(setup.data.session.family("ses_root")).toEqual([
      "ses_root",
      "ses_a",
      "ses_b",
      "ses_a1",
      "ses_a2",
      "ses_a2x",
      "ses_a1x",
    ])
    expect(setup.data.session.root("ses_a1x")).toBe("ses_root")
    expect(requests.toSorted()).toEqual(
      [
        "/api/session/ses_root?",
        ...["ses_root", "ses_a", "ses_b", "ses_a1", "ses_a2", "ses_a1x", "ses_a2x"].map(
          (id) => `/api/session?limit=200&order=desc&parentID=${id}`,
        ),
      ].toSorted(),
    )
  } finally {
    deepest.resolve()
    setup.dispose()
  }
})

test("shares one listing limit across concurrent walks and keeps a tree whose nested listing fails", async () => {
  const children: Record<string, string[]> = Object.fromEntries(
    ["ses_one", "ses_two"].map((root) => [root, Array.from({ length: 10 }, (_, index) => `${root}_c${index}`)]),
  )
  const gate = Promise.withResolvers<void>()
  const flight = { now: 0, most: 0 }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      const root = url.pathname.match(/^\/api\/session\/(ses_one|ses_two)$/)?.[1]
      if (root) return Response.json({ data: { ...session(0), id: root } })
      const parentID = url.searchParams.get("parentID") ?? ""
      const direct = children[parentID]
      if (direct) return Response.json({ data: direct.map((id) => ({ ...session(0), id, parentID })), cursor: {} })
      flight.now++
      flight.most = Math.max(flight.most, flight.now)
      await gate.promise
      flight.now--
      if (parentID === "ses_one_c0") return new Response(null, { status: 500 })
      return Response.json({
        data: parentID === "ses_two_c1" ? [{ ...session(0), id: "ses_two_c1_child", parentID }] : [],
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    const synced = Promise.all(["ses_one", "ses_two"].map((root) => setup.data.session.sync(root, { children: true })))
    // All twenty direct children wait for a listing, but both walks together start only eight.
    await wait(
      () =>
        flight.now === 8 &&
        Object.values(children)
          .flat()
          .every((id) => setup.data.session.get(id)),
    )
    expect(flight.most).toBe(8)
    gate.resolve()
    await synced

    expect(flight.most).toBe(8)
    expect(setup.data.session.get("ses_two_c1_child")?.parentID).toBe("ses_two_c1")
    expect(setup.data.session.family("ses_one")).toHaveLength(11)
    expect(setup.data.session.family("ses_two")).toHaveLength(12)
  } finally {
    gate.resolve()
    setup.dispose()
  }
})

test("keeps a live rename that lands while discovery lists the renamed subagent", async () => {
  const listed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const info = (id: string, parentID?: string): SessionInfo => ({ ...session(0), id, parentID, title: "Old title" })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_root") return Response.json({ data: info("ses_root") })
      if (url.pathname === "/api/session/ses_grandchild")
        return Response.json({ data: info("ses_grandchild", "ses_child") })
      const parentID = url.searchParams.get("parentID")
      if (parentID === "ses_root") return Response.json({ data: [info("ses_child", "ses_root")], cursor: {} })
      if (parentID !== "ses_child") return Response.json({ data: [], cursor: {} })
      // The listing reads the grandchild before the rename, and its response lands after it.
      listed.resolve()
      await release.promise
      return Response.json({ data: [info("ses_grandchild", "ses_child")], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_grandchild")
    const synced = setup.data.session.sync("ses_root", { children: true })
    await listed.promise
    const renamed: OpenCodeEvent = {
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: "ses_grandchild", seq: 1, version: 1 },
      data: { sessionID: "ses_grandchild", title: "New title" },
    }
    listeners.forEach((listener) => listener({ name: renamed.type, details: renamed }))
    await wait(() => setup.data.session.get("ses_grandchild")?.title === "New title")
    release.resolve()
    await synced

    expect(setup.data.session.get("ses_grandchild")?.title).toBe("New title")
    expect(setup.data.session.family("ses_root").toSorted()).toEqual(["ses_child", "ses_grandchild", "ses_root"])
  } finally {
    release.resolve()
    setup.dispose()
  }
})

test("fills a subagent from discovery while its own read is in flight, and keeps it when that read fails", async () => {
  const reading = Promise.withResolvers<void>()
  const failRead = Promise.withResolvers<void>()
  const info = (id: string, parentID?: string): SessionInfo => ({ ...session(0), id, parentID })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_root") return Response.json({ data: info("ses_root") })
      if (url.pathname === "/api/session/ses_grandchild") {
        reading.resolve()
        await failRead.promise
        return new Response(null, { status: 503 })
      }
      const parentID = url.searchParams.get("parentID")
      if (parentID === "ses_root") return Response.json({ data: [info("ses_child", "ses_root")], cursor: {} })
      if (parentID === "ses_child") return Response.json({ data: [info("ses_grandchild", "ses_child")], cursor: {} })
      return Response.json({ data: [], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    // Something else, such as a notification, starts the grandchild's own read before discovery lists it.
    const read = setup.data.session.sync("ses_grandchild").catch(() => undefined)
    await reading.promise
    await setup.data.session.sync("ses_root", { children: true })
    failRead.resolve()
    await read

    expect(setup.data.session.get("ses_grandchild")?.parentID).toBe("ses_child")
    expect(setup.data.session.family("ses_root").toSorted()).toEqual(["ses_child", "ses_grandchild", "ses_root"])
  } finally {
    failRead.resolve()
    setup.dispose()
  }
})

test("syncing a nested subagent by ID also loads its ancestors (#631)", async () => {
  const info = (id: string, parentID?: string): SessionInfo => ({ ...session(0), id, parentID })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_root") return Response.json({ data: info("ses_root") })
      if (url.pathname === "/api/session/ses_child")
        return Response.json({ data: info("ses_child", "ses_root") })
      if (url.pathname === "/api/session/ses_grandchild")
        return Response.json({ data: info("ses_grandchild", "ses_child") })
      if (url.pathname === "/api/session/ses_great_grandchild")
        return Response.json({ data: info("ses_great_grandchild", "ses_grandchild") })
      if (url.pathname === "/api/session/ses_grandchild_missing")
        return Response.json({ data: info("ses_grandchild_missing", "ses_child") })
      // The session list (and every children listing) only ever surfaces the root,
      // matching a subagent chain that has not been loaded into the list cache yet.
      return Response.json({ data: [info("ses_root")], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    // A plain sync leaves the chain unloaded: callers that walk ancestors themselves
    // (the TUI's family discovery, with its own retry backoff) keep their semantics.
    await setup.data.session.sync("ses_great_grandchild")
    expect(setup.data.session.get("ses_grandchild")).toBeUndefined()
    expect(setup.data.session.get("ses_child")).toBeUndefined()

    await setup.data.session.sync("ses_great_grandchild", { children: true })
    expect(setup.data.session.get("ses_grandchild")?.parentID).toBe("ses_child")
    expect(setup.data.session.get("ses_child")?.parentID).toBe("ses_root")
    expect(setup.data.session.get("ses_root")?.id).toBe("ses_root")
    expect(setup.data.session.root("ses_great_grandchild")).toBe("ses_root")
    expect(setup.data.session.family("ses_great_grandchild").toSorted()).toEqual([
      "ses_child",
      "ses_grandchild",
      "ses_great_grandchild",
      "ses_root",
    ])
  } finally {
    setup.dispose()
  }
})

test("retries the ancestor walk on the next sync after a parent read failed", async () => {
  const failures = { root: 1 }
  const rootGets: string[] = []
  const info = (id: string, parentID?: string): SessionInfo => ({ ...session(0), id, parentID })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_grandchild")
        return Response.json({ data: info("ses_grandchild", "ses_child") })
      if (url.pathname === "/api/session/ses_child") return Response.json({ data: info("ses_child", "ses_root") })
      if (url.pathname === "/api/session/ses_root") {
        rootGets.push("get")
        if (failures.root > 0) {
          failures.root--
          return new Response(null, { status: 500 })
        }
        return Response.json({ data: info("ses_root") })
      }
      // No children anywhere: the family is just the ancestor chain.
      return Response.json({ data: [], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_grandchild", { children: true })
    expect(setup.data.session.get("ses_root")).toBeUndefined()
    // The root resolves by parent link but its info is still missing, so the
    // family groups tentatively without it.
    expect(setup.data.session.root("ses_grandchild")).toBe("ses_root")
    expect(setup.data.session.family("ses_grandchild").toSorted()).toEqual(["ses_child", "ses_grandchild"])

    await setup.data.session.sync("ses_grandchild", { children: true })
    expect(rootGets).toHaveLength(2)
    expect(setup.data.session.get("ses_root")?.id).toBe("ses_root")
    expect(setup.data.session.root("ses_grandchild")).toBe("ses_root")
    expect(setup.data.session.family("ses_grandchild").toSorted()).toEqual([
      "ses_child",
      "ses_grandchild",
      "ses_root",
    ])
  } finally {
    setup.dispose()
  }
})

test("family sync does not overwrite an ancestor updated during the walk (#1038)", async () => {
  const walk = Promise.withResolvers<void>()
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let parentReads = 0
  const info = (id: string, parentID?: string, title?: string): SessionInfo => ({ ...session(0), id, parentID, title })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_child") return Response.json({ data: info("ses_child", "ses_parent") })
      if (url.pathname === "/api/session/ses_grandparent") return Response.json({ data: info("ses_grandparent") })
      if (url.pathname === "/api/session/ses_parent") {
        parentReads++
        // The read the walk makes is held open; a read the rename refresh makes
        // returns the same snapshot and the event applies the new title after.
        if (parentReads === 1) await walk.promise
        return Response.json({ data: info("ses_parent", "ses_grandparent", "Walk snapshot title") })
      }
      return Response.json({ data: [], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    const initial = setup.data.session.sync("ses_child", { children: true })
    await wait(() => parentReads === 1)
    const event: OpenCodeEvent = {
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: "ses_parent", seq: 1, version: 1 },
      data: { sessionID: "ses_parent", title: "Generated title" },
    }
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    // The rename refresh loads ses_parent and applies the live title while the
    // family walk is still holding its older snapshot of that ancestor.
    await wait(() => setup.data.session.get("ses_parent")?.title === "Generated title")
    walk.resolve()
    await initial

    expect(setup.data.session.get("ses_parent")?.title).toBe("Generated title")
    expect(setup.data.session.get("ses_grandparent")?.id).toBe("ses_grandparent")
  } finally {
    walk.resolve()
    setup.dispose()
  }
})

test("family sync does not overwrite its target updated during the walk (#1051)", async () => {
  const walk = Promise.withResolvers<void>()
  let parentReads = 0
  let childGets = 0
  const info = (id: string, parentID: string | undefined, directory: string): SessionInfo => ({
    ...session(0),
    id,
    parentID,
    location: { directory },
  })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_child") {
        childGets++
        // The family sync's first read sees the old location; every later read
        // (the concurrent plain sync) sees the moved one.
        return Response.json({ data: info("ses_child", "ses_parent", childGets === 1 ? "/old" : "/new") })
      }
      if (url.pathname === "/api/session/ses_parent") {
        parentReads++
        await walk.promise
        return Response.json({ data: info("ses_parent", undefined, "/project") })
      }
      return Response.json({ data: [], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    const family = setup.data.session.sync("ses_child", { children: true })
    await wait(() => parentReads === 1)
    // A concurrent plain sync (a different sync key than the family sync)
    // re-reads the moved target and publishes it while the walk is held.
    await setup.data.session.sync("ses_child")
    expect(setup.data.session.get("ses_child")?.location.directory).toBe("/new")
    walk.resolve()
    await family

    // The family sync's older first-read snapshot must not revert the target,
    // and the ancestor the walk read is still published.
    expect(setup.data.session.get("ses_child")?.location.directory).toBe("/new")
    expect(setup.data.session.get("ses_parent")?.id).toBe("ses_parent")
  } finally {
    walk.resolve()
    setup.dispose()
  }
})

test("family sync retries its target when the covering plain sync fails (#1053)", async () => {
  const walk = Promise.withResolvers<void>()
  const cover = Promise.withResolvers<void>()
  let parentReads = 0
  let childGets = 0
  const info = (id: string, parentID: string | undefined, directory: string): SessionInfo => ({
    ...session(0),
    id,
    parentID,
    location: { directory },
  })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_child") {
        childGets++
        // The first read publishes the pre-walk snapshot; the family sync's read
        // holds the newer one; the covering plain sync's read is held, then fails.
        if (childGets === 1) return Response.json({ data: info("ses_child", "ses_parent", "/old") })
        if (childGets === 2) return Response.json({ data: info("ses_child", "ses_parent", "/mid") })
        if (childGets === 3) {
          await cover.promise
          return new Response(null, { status: 500 })
        }
        return Response.json({ data: info("ses_child", "ses_parent", "/mid") })
      }
      if (url.pathname === "/api/session/ses_parent") {
        parentReads++
        await walk.promise
        return Response.json({ data: info("ses_parent", undefined, "/project") })
      }
      return Response.json({ data: [], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_child")
    expect(setup.data.session.get("ses_child")?.location.directory).toBe("/old")
    setup.data.session.invalidate("ses_child")

    const family = setup.data.session.sync("ses_child", { children: true })
    await wait(() => parentReads === 1)
    // A concurrent plain sync (a different sync key than the family sync) starts
    // its covering read while the walk is held, and is still in flight when the
    // family sync publishes, so the family sync drops its /mid snapshot.
    const covering = setup.data.session.sync("ses_child")
    await wait(() => childGets === 3)
    walk.resolve()
    await family
    expect(setup.data.session.get("ses_child")?.location.directory).toBe("/old")

    // The covering read fails and publishes nothing.
    cover.resolve()
    await expect(covering).rejects.toThrow()

    // The family key was not kept, so the next family sync re-reads the target
    // instead of no-oping on the completed family key, and the target recovers
    // to the snapshot the failed covering read never replaced.
    await setup.data.session.sync("ses_child", { children: true })
    expect(childGets).toBeGreaterThan(3)
    expect(setup.data.session.get("ses_child")?.location.directory).toBe("/mid")
  } finally {
    walk.resolve()
    cover.resolve()
    setup.dispose()
  }
})

test("lists a branch again on the next sync after its listing failed", async () => {
  const failures = { left: 1 }
  const info = (id: string, parentID?: string): SessionInfo => ({ ...session(0), id, parentID })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (url.pathname === "/api/session/ses_root") return Response.json({ data: info("ses_root") })
      const parentID = url.searchParams.get("parentID")
      if (parentID === "ses_root") return Response.json({ data: [info("ses_child", "ses_root")], cursor: {} })
      if (parentID === "ses_child" && failures.left > 0) {
        failures.left--
        return new Response(null, { status: 500 })
      }
      if (parentID === "ses_child") return Response.json({ data: [info("ses_grandchild", "ses_child")], cursor: {} })
      return Response.json({ data: [], cursor: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_root", { children: true })
    expect(setup.data.session.get("ses_grandchild")).toBeUndefined()

    await setup.data.session.sync("ses_root", { children: true })
    expect(setup.data.session.get("ses_grandchild")?.parentID).toBe("ses_child")
    expect(setup.data.session.family("ses_root").toSorted()).toEqual(["ses_child", "ses_grandchild", "ses_root"])
  } finally {
    setup.dispose()
  }
})

test("lists each session once when parent links form a cycle", async () => {
  const requests: string[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      requests.push(`${url.pathname}?${url.searchParams}`)
      if (url.pathname === "/api/session/ses_x")
        return Response.json({ data: { ...session(0), id: "ses_x", parentID: "ses_y" } })
      const parentID = url.searchParams.get("parentID")
      return Response.json({
        data: [{ ...session(0), id: parentID === "ses_x" ? "ses_y" : "ses_x", parentID }],
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    await setup.data.session.sync("ses_x", { children: true })
    expect(setup.data.session.get("ses_y")?.parentID).toBe("ses_x")
    // The ancestor read for ses_y (#631) is a by-ID get, not a listing: each
    // session is still listed exactly once, and the cycle still terminates.
    expect(requests.toSorted()).toEqual([
      "/api/session/ses_x?",
      "/api/session/ses_y?",
      "/api/session?limit=200&order=desc&parentID=ses_x",
      "/api/session?limit=200&order=desc&parentID=ses_y",
    ])
  } finally {
    setup.dispose()
  }
})

test("keeps the previous model in a live variant notice until the projected message arrives", async () => {
  const projected = Promise.withResolvers<void>()
  const previous = { providerID: "provider", id: "model", variant: "high" }
  const model = { providerID: "provider", id: "model" }
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (pathname === "/api/session/ses_refresh/message") return Response.json({ data: [], cursor: {} })
      if (pathname === "/api/session/ses_refresh/message/msg_variant") {
        await projected.promise
        return Response.json({
          data: {
            id: "msg_variant",
            type: "model-switched",
            model,
            previous,
            metadata: { refetched: true },
            time: { created: 2 },
          },
        })
      }
      throw new Error(`Unexpected request: ${request.url}`)
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    const event: OpenCodeEvent = {
      id: "evt_variant",
      created: 2,
      type: "session.model.selected",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: { sessionID: "ses_refresh", model, previous },
    }
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    expect(setup.data.session.message.get("ses_refresh", "msg_variant")).toMatchObject({
      type: "model-switched",
      model,
      previous,
    })
    projected.resolve()
    await wait(() => setup.data.session.message.get("ses_refresh", "msg_variant")?.metadata?.refetched === true)
  } finally {
    projected.resolve()
    setup.dispose()
  }
})

test("reconciles a stale running tool when execution settles", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let completed = false
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () => {
      requests++
      return Response.json({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "provider", id: "model" },
            time: { created: 1, ...(completed ? { completed: 2 } : {}) },
            content: [
              {
                type: "tool",
                id: "call_execute",
                name: "execute",
                time: { created: 1, ran: 1, ...(completed ? { completed: 2 } : {}) },
                state: completed
                  ? { status: "completed", input: {}, metadata: {}, content: [] }
                  : { status: "running", input: {}, metadata: {} },
              },
            ],
          },
        ],
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  try {
    await setup.data.session.message.sync("ses_refresh")
    completed = true
    const interrupted: OpenCodeEvent = {
      id: "evt_interrupted",
      created: 3,
      type: "session.execution.interrupted",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: { sessionID: "ses_refresh", reason: "user" },
    }
    listeners.forEach((listener) => listener({ name: interrupted.type, details: interrupted }))

    await wait(
      () =>
        setup.data.session.message.get("ses_refresh", "msg_assistant")?.content[0]?.type === "tool" &&
        setup.data.session.message.get("ses_refresh", "msg_assistant")?.content[0]?.state.status === "completed",
    )
    expect(requests).toBe(2)
    expect(setup.data.session.message.get("ses_refresh", "msg_assistant")?.content[0]).toMatchObject({
      state: { status: "completed" },
    })
  } finally {
    setup.dispose()
  }
})

test("revalidates after an event overtakes an active session read", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_refresh")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      if (requests === 1) {
        await gate
        return Response.json({ data: session(1) })
      }
      return Response.json({ data: session(2) })
    },
  })
  const event: CreateDataInput["event"] = {
    on:
      <Type extends OpenCodeEvent["type"]>(
        _type: Type,
        _handler: (event: Extract<OpenCodeEvent, { type: Type }>) => void,
      ) =>
      () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    setup.data.session.remember(session(1))
    setup.data.session.invalidate("ses_refresh")
    const initial = setup.data.session.sync("ses_refresh")
    await wait(() => requests === 1)

    const viewed: OpenCodeEvent = {
      id: "evt_viewed",
      created: 2,
      type: "session.viewed",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: { sessionID: "ses_refresh", idle: 2 },
    }
    listeners.forEach((listener) => listener({ name: viewed.type, details: viewed }))
    await Bun.sleep(20)
    release()
    await initial

    await wait(() => requests === 2 && setup.data.session.get("ses_refresh")?.time.viewed === 2)
  } finally {
    setup.dispose()
  }
})

test("preserves a live session rename across concurrent session and family reads", async () => {
  const family = Promise.withResolvers<void>()
  const renamed = Promise.withResolvers<void>()
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const stale = { ...session(0), title: undefined }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith(`/api/session/${stale.id}`)) return Response.json({ data: [], cursor: {} })
      requests++
      await (requests === 1 ? family.promise : renamed.promise)
      return Response.json({ data: stale })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    const initial = setup.data.session.sync(stale.id, { children: true })
    await wait(() => requests === 1)
    const event: OpenCodeEvent = {
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: stale.id, seq: 1, version: 1 },
      data: { sessionID: stale.id, title: "Generated title" },
    }
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    await wait(() => requests === 2)
    renamed.resolve()
    await wait(() => setup.data.session.get(stale.id) !== undefined)
    family.resolve()
    await initial
    await Bun.sleep(0)

    expect(setup.data.session.get(stale.id)?.title).toBe("Generated title")
  } finally {
    family.resolve()
    renamed.resolve()
    setup.dispose()
  }
})

test("updates authoritative cached project metadata from live events", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const original: Project = {
    id: "project_renamed",
    canonical: "/projects/original",
    name: "Original custom name",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  const unrelated: Project = {
    id: "project_unrelated",
    canonical: "/projects/unrelated",
    name: "Unrelated project",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/project")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      return Response.json([original, unrelated])
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/projects/original", event }),
    dispose,
  }))

  try {
    await setup.data.project.sync()
    expect(setup.data.project.get(original.id)).toEqual(original)

    const updated: OpenCodeEvent = {
      id: "evt_project_renamed",
      created: 2,
      type: "project.updated",
      data: {
        ...original,
        canonical: "/projects/renamed",
        name: "Updated custom name",
        time: { ...original.time, updated: 2 },
      },
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed")
    expect(setup.data.project.get(original.id)?.name).toBe("Updated custom name")
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)

    const reset: OpenCodeEvent = {
      id: "evt_project_name_reset",
      created: 3,
      type: "project.updated",
      data: {
        id: original.id,
        canonical: "/projects/renamed-again",
        time: { ...original.time, updated: 3 },
        sandboxes: [],
      },
    }
    listeners.forEach((listener) => listener({ name: reset.type, details: reset }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed-again")
    expect(setup.data.project.get(original.id)?.name).toBeUndefined()
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)
  } finally {
    setup.dispose()
  }
})

test("adopts cached directory-project sessions when their repository is resolved", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const refreshed: SessionInfo = {
    ...session(0),
    id: "ses_uncached",
    projectID: "repository",
    location: { directory: "/unknown-alias" },
    subpath: "app",
  }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_uncached")) throw new Error(`Unexpected request: ${request.url}`)
      return Response.json({ data: refreshed })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/repo",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    const sessions: SessionInfo[] = [
      { ...session(0), id: "ses_root", projectID: "directory-root", location: { directory: "/repo" } },
      { ...session(0), id: "ses_nested", projectID: "directory-nested", location: { directory: "/repo/app" } },
      {
        ...session(0),
        id: "ses_alias",
        projectID: "directory-nested",
        location: { directory: "/repo/alias/../app" },
      },
      { ...session(0), id: "ses_symlink", projectID: "directory-nested", location: { directory: "/shortcut" } },
      { ...refreshed, projectID: "directory-uncached" },
      { ...session(0), id: "ses_global", projectID: "global", location: { directory: "/repo/legacy" } },
      { ...session(0), id: "ses_escaped", projectID: "global", location: { directory: "/repo/../other" } },
      { ...session(0), id: "ses_other", projectID: "other-repository", location: { directory: "/repo/vendor" } },
      { ...session(0), id: "ses_sibling", projectID: "global", location: { directory: "/repo-other" } },
      {
        ...session(0),
        id: "ses_remote",
        projectID: "directory-root",
        location: { directory: "/repo" },
      },
    ]
    sessions.forEach((item) => setup.data.session.remember(item))
    for (const project of [
      { id: "directory-root", canonical: "/repo" },
      { id: "directory-nested", canonical: "/repo/app" },
    ]) {
      const updated: OpenCodeEvent = {
        id: `evt_${project.id}`,
        created: 0,
        type: "project.updated",
        data: { ...project, time: { created: 0, updated: 0 }, sandboxes: [] },
      }
      listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    }

    const resolved: OpenCodeEvent = {
      id: "evt_repository_resolved",
      created: 1,
      type: "worktree.resolved",
      durable: { aggregateID: "repository", seq: 0, version: 1 },
      data: {
        projectID: "repository",
        directory: "/repo",
        previous: "global",
        adopted: ["directory-root", "directory-nested", "directory-uncached"],
      },
    }
    listeners.forEach((listener) => listener({ name: resolved.type, details: resolved }))

    expect(setup.data.session.get("ses_root")?.projectID).toBe("repository")
    expect(setup.data.session.get("ses_root")?.subpath).toBeUndefined()
    expect(setup.data.session.get("ses_nested")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_alias")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_symlink")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_global")).toMatchObject({ projectID: "repository", subpath: "legacy" })
    expect(setup.data.session.get("ses_escaped")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_other")?.projectID).toBe("other-repository")
    expect(setup.data.session.get("ses_sibling")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_remote")?.projectID).toBe("repository")
    await wait(() => setup.data.session.get("ses_uncached")?.projectID === "repository")
    expect(setup.data.session.get("ses_uncached")?.subpath).toBe("app")
  } finally {
    setup.dispose()
  }
})

test("refreshes global credential events across every loaded location", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      return Response.json({
        location: {
          directory,
          project: { id: "project", directory, canonical: directory },
        },
        data: [],
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const locations = [{ directory: "/project" }, { directory: "/other" }]

  try {
    await Promise.all(
      locations.flatMap((location) => [
        setup.data.location.integration.sync(location),
        setup.data.location.model.sync(location),
        setup.data.location.provider.sync(location),
        setup.data.location.reference.sync(location),
      ]),
    )
    const references = locations.map((location) => setup.data.location.reference.list(location))
    requests.length = 0

    const updated: OpenCodeEvent = {
      id: "evt_credential.updated",
      created: 1,
      type: "credential.updated",
      data: {},
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => requests.length === 2)
    expect(requests.map((url) => [url.pathname, url.searchParams.get("location[directory]")])).toEqual([
      ["/api/integration", "/project"],
      ["/api/integration", "/other"],
    ])
    requests.length = 0

    for (const credentialID of ["credential", null]) {
      const switched: OpenCodeEvent = {
        id: `evt_credential.switched.${credentialID}`,
        created: 2,
        type: "credential.switched",
        data: { credentialID, integrationID: "integration" },
      }
      listeners.forEach((listener) => listener({ name: switched.type, details: switched }))
      await wait(() => requests.length === 4)
      expect(requests.map((url) => [url.pathname, url.searchParams.get("location[directory]")])).toEqual(
        expect.arrayContaining([
          ["/api/model", "/project"],
          ["/api/provider", "/project"],
          ["/api/model", "/other"],
          ["/api/provider", "/other"],
        ]),
      )
      locations.forEach((location, index) =>
        expect(setup.data.location.reference.list(location)).toBe(references[index]),
      )
      requests.length = 0
    }
  } finally {
    setup.dispose()
  }
})

for (const resource of ["provider", "model"] as const) {
  test(`refreshes ${resource} values only at the location named by ${resource}.updated`, async () => {
    const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
    const requests: URL[] = []
    const current = { name: "Before" }
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push(url)
        const directory = url.searchParams.get("location[directory]") ?? "/project"
        if (url.pathname !== "/api/provider" && url.pathname !== "/api/model")
          throw new Error(`Unexpected request: ${request.url}`)
        return Response.json({
          location: { directory, project: { id: directory, directory, canonical: directory } },
          data:
            url.pathname === "/api/provider"
              ? [{ id: "company", name: current.name, activation: "enabled", package: "aisdk:@ai-sdk/openai" }]
              : [modelInfo(current.name)],
        })
      },
    })
    const setup = createRoot((dispose) => ({
      data: createData({
        api: () => api,
        directory: "/project",
        event: {
          on: () => () => {},
          listen(handler) {
            listeners.add(handler)
            return () => listeners.delete(handler)
          },
        },
        connection: { status: () => "connected" },
      }),
      dispose,
    }))
    const project = { directory: "/project" }
    const other = { directory: "/other" }
    const unaffected = resource === "provider" ? "model" : "provider"

    try {
      await Promise.all(
        [project, other].flatMap((location) => [
          setup.data.location.provider.sync(location),
          setup.data.location.model.sync(location),
        ]),
      )
      const untouchedResource = setup.data.location[unaffected].list(project)
      const untouchedLocation = setup.data.location[resource].list(other)
      requests.length = 0
      current.name = "After"
      const event: OpenCodeEvent = {
        id: `evt_${resource}_updated`,
        created: 1,
        type: `${resource}.updated`,
        location: project,
        data: {},
      }
      listeners.forEach((listener) => listener({ name: event.type, details: event }))

      await wait(() => setup.data.location[resource].list(project)?.[0]?.name === "After")
      expect(requests.map((url) => [url.pathname, url.searchParams.get("location[directory]")])).toEqual([
        [`/api/${resource}`, "/project"],
      ])
      expect(setup.data.location[unaffected].list(project)).toBe(untouchedResource)
      expect(setup.data.location[resource].list(other)).toBe(untouchedLocation)
      expect(setup.data.location[unaffected].list(project)?.[0]?.name).toBe("Before")
      expect(setup.data.location[resource].list(other)?.[0]?.name).toBe("Before")
    } finally {
      setup.dispose()
    }
  })
}

test("revalidates model discovery when an update overtakes an in-flight model list", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname !== "/api/model") throw new Error(`Unexpected request: ${request.url}`)
      const initial = ++requests === 1
      if (initial) {
        started.resolve()
        await release.promise
      }
      return Response.json({
        location: { directory: "/project" },
        data: [modelInfo(initial ? "Before discovery" : "Discovered model")],
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))

  try {
    const initial = setup.data.location.model.sync()
    await started.promise
    const event: OpenCodeEvent = {
      id: "evt_models_discovered",
      created: 1,
      type: "model.updated",
      location: { directory: "/project" },
      data: {},
    }
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    release.resolve()
    await initial
    await wait(() => setup.data.location.model.list()?.[0]?.name === "Discovered model")
    expect(requests).toBe(2)
  } finally {
    release.resolve()
    setup.dispose()
  }
})

test("refreshes references for the location an update names", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      return Response.json({
        location: {
          directory,
          project: { id: "project", directory, canonical: directory },
        },
        data: [],
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const other = { directory: "/other" }

  try {
    await Promise.all([setup.data.location.reference.sync(), setup.data.location.reference.sync(other)])
    requests.length = 0

    const updated: OpenCodeEvent = {
      id: "evt_reference.updated",
      created: 1,
      type: "reference.updated",
      location: other,
      data: {},
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => requests.length === 1)
    expect([requests[0]!.pathname, requests[0]!.searchParams.get("location[directory]")]).toEqual([
      "/api/reference",
      "/other",
    ])
  } finally {
    setup.dispose()
  }
})

test("preserves sibling catalogs through location preload, branch, shell, and websearch updates", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const location = { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } }
  const requests: string[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      requests.push(pathname)
      if (pathname === "/api/session/active") return Response.json({})
      if (pathname === "/api/project") return Response.json([])
      if (pathname === "/api/location") return Response.json(location)
      if (pathname === "/api/vcs")
        return Response.json({ location, data: { branch: { current: "main", default: "main" } } })
      if (pathname === "/api/reference")
        return Response.json({
          location,
          data: [{ name: "docs", path: "/docs", source: { type: "local", path: "/docs" } }],
        })
      if (pathname === "/api/websearch/provider")
        return Response.json({ location, data: [{ id: "search", name: "Search" }] })
      throw new Error(`Unexpected request: ${pathname}`)
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  const emit = (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details }))
  const shell = {
    id: "sh_first",
    status: "running" as const,
    command: "echo hello",
    cwd: location.directory,
    shell: "/bin/sh",
    file: "/shell-output",
    metadata: {},
    time: { started: 1 },
  }

  try {
    // A live event may arrive before any location reads have populated this key.
    emit({ type: "shell.created", location, data: { info: shell } })
    expect(setup.data.shell.get(shell.id)).toMatchObject(shell)
    const first = setup.data.shell.get(shell.id)
    await Promise.all([setup.data.location.reference.sync(), setup.data.location.vcs.sync()])
    const references = setup.data.location.reference.list()
    expect(references?.map((reference) => [reference.name, reference.path])).toEqual([["docs", "/docs"]])
    expect(setup.data.shell.get(shell.id)).toBe(first)

    emit({ type: "vcs.branch.updated", location, data: { branch: "feature" } })
    expect(setup.data.location.vcs.info()?.branch).toEqual({ current: "feature", default: "main" })
    expect(setup.data.location.reference.list()).toBe(references)
    emit({ type: "shell.created", location, data: { info: { ...shell, id: "sh_second" } } })
    expect(setup.data.shell.list().map((shell) => shell.id)).toEqual(["sh_first", "sh_second"])
    expect(setup.data.location.reference.list()).toBe(references)
    emit({ type: "shell.deleted", location, data: { id: "sh_second" } })
    expect(setup.data.shell.list().map((shell) => shell.id)).toEqual(["sh_first"])
    expect(setup.data.shell.get(shell.id)).toBe(first)
    expect(setup.data.location.reference.list()).toBe(references)

    await setup.data.location.websearch.refresh()
    expect(setup.data.location.websearch.list()).toEqual([{ id: "search", name: "Search" }])
    expect(setup.data.location.reference.list()).toBe(references)
    emit({ type: "server.connected", data: {} })
    await wait(() => setup.data.location.info() !== undefined)
    expect(setup.data.location.info()).toMatchObject(location)
    expect(setup.data.location.reference.list()).toBe(references)
    expect(setup.data.shell.get(shell.id)).toBe(first)
    expect(setup.data.location.vcs.info()?.branch).toEqual({ current: "feature", default: "main" })
    expect(requests.toSorted()).toEqual([
      "/api/location",
      "/api/project",
      "/api/reference",
      "/api/session/active",
      "/api/vcs",
      "/api/websearch/provider",
    ])
  } finally {
    setup.dispose()
  }
})

test("reports optimistic sessions as creating until the request settles", async () => {
  const release = Promise.withResolvers<void>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session")) throw new Error(`Unexpected request: ${request.url}`)
      await release.promise
      return Response.json({ data: session(0) })
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen: () => () => {},
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    const created = setup.data.session.create({ id: "ses_refresh", location: { directory: "/project" } })
    expect(setup.data.session.creating(created.id)).toBe(true)
    release.resolve()
    await created.request
    expect(setup.data.session.creating(created.id)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("loads bounded message pages", async () => {
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      return Response.json({ data: [], cursor: requests.length === 1 ? { next: "next" } : {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    await setup.data.session.message.loadMore("ses_refresh")

    expect(requests).toHaveLength(2)
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ limit: "20", order: "desc" })
    expect(Object.fromEntries(requests[1].searchParams)).toEqual({ cursor: "next", limit: "20" })
  } finally {
    setup.dispose()
  }
})

test.each(["success", "failure", "cancel", "cancel-retry", "cancel-page", "join-cancel", "join-failure"])(
  "bulk history (%s)",
  async (mode) => {
    const messages = [1, 2, 3].map((index) => ({
      id: `msg_${index}`,
      type: "user",
      text: `Message ${index}`,
      time: { created: index },
    }))
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    const requests: URL[] = []
    const publications: string[][] = []
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(url)
        const cursor = url.searchParams.get("cursor")
        if (!cursor) return Response.json({ data: [messages[2]], cursor: { next: "recent" } })
        if (cursor === "recent") {
          if (mode.startsWith("join")) await release.promise
          if (mode === "join-failure") return Response.json({ message: "offline" }, { status: 503 })
          return Response.json({ data: [messages[2], messages[1]], cursor: { next: "oldest" } })
        }
        if (cursor === "oldest") return Response.json({ data: [messages[0]], cursor: { next: "empty" } })
        expect(init?.signal).toBe(requests.length === 4 ? controller.signal : undefined)
        await release.promise
        if (mode === "failure") return Response.json({ message: "offline" }, { status: 503 })
        return Response.json({ data: [], cursor: {} })
      },
    })
    const setup = createRoot((dispose) => {
      const data = createData({
        api: () => api,
        directory: "/project",
        event: { on: () => () => {}, listen: () => () => {} },
      })
      return { data, dispose }
    })

    try {
      await setup.data.session.message.sync("ses_refresh")
      const newest = setup.data.session.message.get("ses_refresh", "msg_3")
      const load = setup.data.session.message.loadMore(
        "ses_refresh",
        mode.startsWith("join")
          ? undefined
          : {
              all: true,
              signal: controller.signal,
              beforePublish: () => {
                publications.push(setup.data.session.message.list("ses_refresh").map((message) => message.id))
                expect(setup.data.session.message.get("ses_refresh", "msg_3")).toBe(newest)
              },
            },
      )
      const joined = setup.data.session.message.loadMore("ses_refresh", { all: true, signal: controller.signal })
      const settled = Promise.allSettled([load, joined])
      if (mode.startsWith("join")) {
        await wait(() => requests.length === 2)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
        controller.abort()
        let cancelled = false
        void joined.then(() => {
          cancelled = true
        })
        await wait(() => cancelled)
        expect(setup.data.session.message.loading("ses_refresh")).toBe(true)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        release.resolve()
        expect((await settled).map((result) => result.status)).toEqual(
          mode === "join-failure" ? ["rejected", "fulfilled"] : ["fulfilled", "fulfilled"],
        )
        expect(requests.at(-1)?.searchParams.get("limit")).toBe("20")
        expect(requests).toHaveLength(2)
        expect(setup.data.session.message.more("ses_refresh")).toBe(true)
        expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(
          mode === "join-failure" ? ["msg_3"] : ["msg_2", "msg_3"],
        )
        return
      }
      await wait(() => requests.length === 4)
      expect(setup.data.session.message.loading("ses_refresh")).toBe(true)
      expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(["msg_3"])
      expect(requests.slice(1).map((url) => url.searchParams.get("limit"))).toEqual(["200", "200", "200"])
      if (mode.startsWith("cancel")) controller.abort()
      const retry =
        mode === "cancel-retry" || mode === "cancel-page"
          ? setup.data.session.message.loadMore("ses_refresh", mode === "cancel-retry" ? { all: true } : undefined)
          : undefined
      release.resolve()
      expect((await settled).map((result) => result.status)).toEqual(
        mode === "failure" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
      )
      await retry
      const success = mode === "success" || mode === "cancel-retry"
      expect(setup.data.session.message.loading("ses_refresh")).toBe(false)
      expect(setup.data.session.message.more("ses_refresh")).toBe(!success)
      expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(
        success ? ["msg_1", "msg_2", "msg_3"] : mode === "cancel-page" ? ["msg_2", "msg_3"] : ["msg_3"],
      )
      expect(setup.data.session.message.get("ses_refresh", "msg_3")).toBe(newest)
      expect(requests).toHaveLength(mode === "cancel-retry" ? 7 : mode === "cancel-page" ? 5 : 4)
      if (mode === "cancel-page") expect(requests.at(-1)?.searchParams.get("limit")).toBe("20")
      expect(publications).toEqual(mode === "success" ? [["msg_3"]] : [])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    } finally {
      release.resolve()
      setup.dispose()
    }
  },
)

test.each([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.started",
  "session.deleted",
] as const)("preserves %s activity when an older snapshot arrives", async (type) => {
  const release = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const setup = activityFixture(async () => {
    requested.resolve()
    await release.promise
    return Response.json({
      data: {
        ...(type === "session.execution.started" ? {} : { ses_refresh: { type: "running" } }),
        ses_hydrated: { type: "running" },
      },
    })
  })

  try {
    if (type !== "session.execution.started") setup.data.session.setStatus("ses_refresh", "running")
    setup.emit({ type: "server.connected", data: {} })
    await requested.promise
    setup.emit({
      id: "evt_activity",
      created: 2,
      type,
      durable: { aggregateID: "ses_refresh", seq: 2, version: 1 },
      data: {
        sessionID: "ses_refresh",
        reason: "user",
        ...(type === "session.execution.failed"
          ? { error: { type: "provider.no-route", message: "Model unavailable: opencode/gpt-5.2" } }
          : {}),
      },
    })
    expect(setup.data.session.status("ses_refresh")).toBe(type === "session.execution.started" ? "running" : "idle")
    if (type === "session.execution.failed") {
      expect(setup.data.session.message.list("ses_refresh").at(-1)).toEqual({
        id: "msg_activity",
        type: "idle",
        outcome: "failed",
        error: { type: "provider.no-route", message: "Model unavailable: opencode/gpt-5.2" },
        time: { created: 2 },
      })
    }
    release.resolve()
    await wait(() => setup.data.session.status("ses_hydrated") === "running")
    expect(setup.data.session.status("ses_refresh")).toBe(type === "session.execution.started" ? "running" : "idle")
  } finally {
    release.resolve()
    setup.dispose()
  }
})

test("a resync refetches activity like a fresh connection", async () => {
  const reads: string[] = []
  const setup = activityFixture(() => {
    reads.push("active")
    return Response.json({ data: { ses_resync: { type: "running" } } })
  })

  try {
    setup.emit({ type: "server.resync", data: {} })
    await wait(() => setup.data.session.status("ses_resync") === "running")
    expect(reads).toEqual(["active"])
  } finally {
    setup.dispose()
  }
})

test("ignores activity snapshots from an older connection", async () => {
  const reads: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const setup = activityFixture(() => {
    const read = Promise.withResolvers<Response>()
    reads.push(read)
    return read.promise
  })

  try {
    setup.emit({ type: "server.connected", data: {} })
    await wait(() => reads.length === 1)
    setup.emit({ type: "server.connected", data: {} })
    await wait(() => reads.length === 2)
    reads[1]?.resolve(Response.json({ data: { ses_new: { type: "running" } } }))
    await wait(() => setup.data.session.status("ses_new") === "running")
    reads[0]?.resolve(Response.json({ data: { ses_old: { type: "running" } } }))
    await Bun.sleep(20)
    expect(setup.data.session.status("ses_new")).toBe("running")
    expect(setup.data.session.status("ses_old")).toBe("idle")
  } finally {
    reads.forEach((read) => read.resolve(Response.json({ data: {} })))
    setup.dispose()
  }
})

test("projects background user shell metadata from durable shell data", () => {
  const setup = activityFixture(() => Response.json({ data: {} }))
  try {
    setup.emit({
      id: "evt_user_shell",
      created: 1,
      type: "session.shell.started",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: {
        sessionID: "ses_refresh",
        shell: {
          id: "sh_user",
          status: "running",
          command: "pwd",
          cwd: "/project",
          shell: "/bin/sh",
          file: "/project/shell.out",
          metadata: { sessionID: "ses_refresh", background: true },
          time: { started: 1 },
        },
      },
    })
    expect(setup.data.session.message.list("ses_refresh")).toMatchObject([
      { type: "shell", shellID: "sh_user", status: "running", metadata: { background: true } },
    ])
  } finally {
    setup.dispose()
  }
})

function modelInfo(name: string): ModelInfo {
  return {
    id: "chat",
    modelID: "chat",
    providerID: "company",
    name,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 8192, output: 1024 },
  }
}

function activityFixture(read: () => Response | Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return read()
      if (path === "/api/project") return Response.json([])
      if (path === "/api/location") return Response.json({ directory: "/project" })
      return Response.json({ location: { directory: "/project" }, data: { branch: "main" } })
    },
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    emit: (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
    dispose,
  }))
}

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
