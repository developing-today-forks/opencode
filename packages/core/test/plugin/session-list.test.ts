import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { PluginServerUrl } from "@opencode/core/plugin/server-url"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("Effect plugins can list child sessions", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    const parent = yield* context.session.create({ title: "Plugin list parent" })
    const child = yield* context.session.create({ parentID: parent.id, title: "Plugin list child" })

    const children = yield* context.session.list({ parentID: parent.id })
    expect(children.data.map((session) => session.id)).toEqual([child.id])

    const ordered = yield* context.session.list({ parentID: parent.id, limit: 10, order: "asc" })
    expect(ordered.data.map((session) => session.id)).toEqual([child.id])

    // A cursor replaces the request filters and advances past the seen page.
    const advanced = yield* context.session.list({ parentID: parent.id, cursor: children.cursor.next })
    expect(advanced.data.map((session) => session.id)).not.toContain(child.id)

    const roots = yield* context.session.list({ parentID: null })
    expect(roots.data.map((session) => session.id)).toContain(parent.id)
    expect(roots.data.map((session) => session.id)).not.toContain(child.id)

    const directory = yield* context.session.list({ directory: context.location.directory })
    expect(directory.data.map((session) => session.id)).toContain(parent.id)

    const project = yield* context.session.list({ project: parent.projectID })
    expect(project.data.map((session) => session.id)).toContain(parent.id)
  }),
)

it.live("Promise plugins read serverUrl and list child sessions", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    PluginServerUrl.setServerUrl("http://127.0.0.1:4096")
    try {
      const parent = yield* context.session.create({ title: "Promise list parent" })
      const child = yield* context.session.create({ parentID: parent.id, title: "Promise list child" })
      const seen: { serverUrl?: string; children?: string[] } = {}
      yield* PluginPromise.fromPromise({
        id: "test.session-list",
        async setup(ctx) {
          seen.serverUrl = ctx.serverUrl
          const page = await ctx.session.list({ parentID: parent.id })
          seen.children = page.data.map((session) => session.id)
        },
      }).effect(context)
      expect(seen.serverUrl).toBe("http://127.0.0.1:4096")
      expect(seen.children).toEqual([child.id])
    } finally {
      PluginServerUrl.setServerUrl(undefined)
    }
  }),
)

it.live("Plugin session.list normalises an unusable limit before the store", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    for (const title of ["Plugin limit a", "Plugin limit b", "Plugin limit c"]) {
      yield* context.session.create({ title })
    }

    const all = yield* context.session.list({ parentID: null })
    expect(all.data.length).toBeGreaterThanOrEqual(3)

    // SQLite reads a negative LIMIT as "unlimited": it must clamp to a positive page.
    const negative = yield* context.session.list({ parentID: null, limit: -5 })
    expect(negative.data).toHaveLength(1)

    // Zero is not a page size either; it clamps to the same positive minimum.
    const zero = yield* context.session.list({ parentID: null, limit: 0 })
    expect(zero.data).toHaveLength(1)

    // A fractional limit used to reach the store as-is and defect; it floors.
    const fractional = yield* context.session.list({ parentID: null, limit: 2.5 })
    expect(fractional.data).toHaveLength(2)

    // A non-finite limit falls back to the default page instead of defecting.
    const nan = yield* context.session.list({ parentID: null, limit: Number.NaN })
    expect(nan.data).toHaveLength(all.data.length)
  }),
)

it.live("Plugin session list defaults to the newest 50 and the cursor reaches the remainder", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    const parent = yield* context.session.create({ title: "Plugin list default parent" })
    const ids: Array<typeof parent.id> = []
    for (let i = 0; i < 55; i++) {
      const child = yield* context.session.create({ parentID: parent.id, title: `Plugin list default child ${i}` })
      ids.push(child.id)
    }

    const page = yield* context.session.list({ parentID: parent.id })
    expect(page.data).toHaveLength(50)
    expect(page.cursor.next).toBeDefined()

    const rest = yield* context.session.list({ parentID: parent.id, cursor: page.cursor.next })
    expect(rest.data).toHaveLength(5)

    const combined = [...page.data, ...rest.data].map((session) => session.id)
    expect(new Set(combined).size).toBe(55)
    expect(new Set(combined)).toEqual(new Set(ids))

    const explicit = yield* context.session.list({ parentID: parent.id, limit: 100 })
    expect(explicit.data).toHaveLength(55)

    const small = yield* context.session.list({ parentID: parent.id, limit: 2 })
    expect(small.data).toHaveLength(2)
  }),
)
