import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode, makeGlobalNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"
import { Tool } from "@opencode/core/tool"
import { Plugin } from "@opencode/core/plugin"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { codeModeListings, executeTool, toolIdentity, registerToolPlugin } from "./lib/tool"
import { readInitial } from "./lib/instructions"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { CodeModeRules } from "@opencode/core/codemode/rules"
import { clearProjectedTools, extractToolsFromScript } from "../src/tool/plugin/mcpx-projection"
import { setSecretTiming } from "../src/tool/plugin/mcpx-secrets"

const sessionID = Session.ID.make("ses_mcpx_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const permission = permissionLayer({ assert: () => Effect.void })

// The tool hooks the mcpx plugin registers, so tests can play the part of the tool host
const toolHooks = new Map<string, (event: any) => Effect.Effect<void>>()

const mcpxPluginSupervisor = makeLocationNode({
  name: "test/mcpx-plugins",
  layer: Layer.effectDiscard(
    registerToolPlugin(
      McpxTool.Plugin,
      {
        shell: {
          hook: () => Effect.succeed({ dispose: Effect.void }),
        },
      },
      (name: string, callback: unknown) => {
        toolHooks.set(name, callback as (event: any) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    ),
  ),
  deps: [Config.node, Environment.node, FileAccess.node, Permission.node, Tool.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
])

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const it = testEffect(
  AppNodeBuilder.build(nodes, [
    SessionExecution.node.replace(executionNode),
    Permission.node.replace(permission),
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(mcpxPluginSupervisor),
  ]),
)

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({ id: sessionID, title: "mcpx test", location, model: sessionModel })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = []
        }),
      )
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

describe("McpxTool", () => {
  it.live("registers mcpx_exec, mcpx_discover, and mcpx_observe tools", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* withSession(tmp.path, (registry) =>
        Effect.gen(function* () {
          const tools = yield* registry.list()
          const names = tools.map((t) => t.name)
          expect(names).toContain("mcpx_exec")
          expect(names).toContain("mcpx_discover")
          expect(names).toContain("mcpx_observe")
          expect(names).toContain("mcpx_project")
          expect(names).toContain("mcpx_retract")
        }),
      )
    }),
  )

  it.live("projects daemon tools into the registry, calls them, and retracts them", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const requests: Array<{ path: string; body?: any }> = []
      const daemon = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
          requests.push({ path, body })
          if (path === "/v1/tools") return Response.json(neonTools)
          if (path === "/v1/call") return Response.json({ result: { rows: 2 } })
          return Response.json({ status: "ok" })
        },
      })
      const previous = process.env.MCPX_DAEMON_ENDPOINT
      process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${daemon.port}`
      try {
        yield* withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const names = () => registry.list().pipe(Effect.map((tools) => tools.map((tool) => tool.name)))
            expect(yield* names()).not.toContain("neon_run_sql")

            const projected = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-project", name: "mcpx_project", input: { namespaces: ["neon"] } },
            })
            expect(projected.status).toBe("completed")
            expect(yield* names()).toContain("neon_run_sql")

            const called = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-neon", name: "neon_run_sql", input: { query: "select 1" } },
            })
            expect(called.status).toBe("completed")
            expect(requests.find((request) => request.path === "/v1/call")?.body).toMatchObject({
              server: "neon",
              tool: "run_sql",
              arguments: { query: "select 1" },
            })

            const retracted = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-retract", name: "mcpx_retract", input: { targets: ["neon"] } },
            })
            expect(retracted.status).toBe("completed")
            expect(yield* names()).not.toContain("neon_run_sql")
          }),
        )
      } finally {
        daemon.stop(true)
        if (previous === undefined) delete process.env.MCPX_DAEMON_ENDPOINT
        else process.env.MCPX_DAEMON_ENDPOINT = previous
      }
    }),
  )

  it.live("steps projection TTL once per assistant message and gives typo hints", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = Bun.serve({
        port: 0,
        fetch: (request) =>
          new URL(request.url).pathname === "/v1/tools" ? Response.json(neonTools) : Response.json({ status: "ok" }),
      })
      const previous = process.env.MCPX_DAEMON_ENDPOINT
      process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${daemon.port}`
      try {
        yield* withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const names = () => registry.list().pipe(Effect.map((tools) => tools.map((tool) => tool.name)))
            const project = (id: string) =>
              executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id, name: "mcpx_project", input: { namespaces: ["neon"], ttl: 2 } },
              })
            yield* project("call-project-ttl")
            expect(yield* names()).toContain("neon_run_sql")

            const beforeTool = toolHooks.get("execute.before")
            const afterTool = toolHooks.get("execute.after")
            expect(beforeTool).toBeDefined()
            expect(afterTool).toBeDefined()
            if (!beforeTool || !afterTool) return

            // Two tool calls in one assistant message are one turn; the next message is the second turn
            yield* beforeTool({ messageID: "msg_turn_one" } as any)
            yield* beforeTool({ messageID: "msg_turn_one" } as any)
            expect(yield* names()).toContain("neon_run_sql")
            yield* beforeTool({ messageID: "msg_turn_two" } as any)
            expect(yield* names()).not.toContain("neon_run_sql")

            // A failed call to a misspelled projected tool gets a typo hint with the real name
            yield* project("call-project-typo")
            const failure = {
              tool: "neon_run_sq",
              sessionID,
              agent: toolIdentity.agent,
              messageID: toolIdentity.messageID,
              id: "call-typo",
              input: { query: "select 1" },
              status: "error",
              error: { message: "Unknown tool" },
            }
            yield* afterTool(failure as any)
            expect(failure.error.message).toContain("Typo Detected")
            expect(failure.error.message).toContain("neon_run_sql")

            yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-retract-typo", name: "mcpx_retract", input: { targets: ["neon"] } },
            })
          }),
        )
      } finally {
        daemon.stop(true)
        if (previous === undefined) delete process.env.MCPX_DAEMON_ENDPOINT
        else process.env.MCPX_DAEMON_ENDPOINT = previous
      }
    }),
  )
})

const neonTools = [
  {
    namespace: "neon",
    tool: "run_sql",
    description: "Run SQL",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
]

interface Recorded {
  readonly path: string
  readonly body: any
  readonly headers: Record<string, string>
}

interface SecretRequestRecord {
  readonly id: string
  readonly server: string
  readonly secrets: readonly string[]
  status: "pending" | "resolved" | "declined"
  polls: number
}

interface FakeDaemon {
  readonly port: number | undefined
  readonly recorded: Recorded[]
  readonly requests: Map<string, SecretRequestRecord>
  setSecret(name: string): void
  decline(id: string): void
  stop(): void
}

interface FakeOptions {
  /** Servers and the secrets each requires. Defaults to neon, which needs NEON_API_KEY. */
  readonly servers?: Record<string, string[]>
  /** Runs on every poll of a secret request, before its status is read. */
  readonly onPoll?: (request: SecretRequestRecord, daemon: FakeDaemon) => void
  /** Refuses every call with these secrets named, even when the server looks active. */
  readonly refuseCalls?: string[]
  /** A daemon from before the secrets API: no preflight, server state, or requests, and no activity checks. */
  readonly legacy?: boolean
}

// The daemon's static reading of a script: tools.<ns>.<tool> and tools["ns"]["tool"]. Written separately from the core
// regex, so the agreement test compares two readings of the same samples.
const daemonReferences = (source: string) => {
  const found = new Set<string>()
  for (const match of source.matchAll(/\btools\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) if (match[1]) found.add(match[1])
  for (const match of source.matchAll(/\btools\["([^"]+)"\]\["[^"]+"\]/g)) if (match[1]) found.add(match[1])
  for (const match of source.matchAll(/\btools\['([^']+)'\]\['[^']+'\]/g)) if (match[1]) found.add(match[1])
  return [...found].sort()
}

// A stand-in for the mcpx daemon. It keeps secret state and answers the routes the contract names. The Go daemon is
// not built here, so these tests verify the core against this fake only.
const fakeDaemon = (options: FakeOptions = {}): FakeDaemon => {
  const servers = options.servers ?? { neon: ["NEON_API_KEY"] }
  const set = new Set<string>()
  const requests = new Map<string, SecretRequestRecord>()
  const recorded: Recorded[] = []
  const missing = (server: string) => (servers[server] ?? []).filter((name) => !set.has(name))
  const requestFor = (server: string, names: string[]) => {
    const secrets = [...names].sort()
    const pending = [...requests.values()].find(
      (request) =>
        request.status === "pending" && request.server === server && request.secrets.join() === secrets.join(),
    )
    if (pending) return pending
    const created: SecretRequestRecord = {
      id: `req_${requests.size + 1}`,
      server,
      secrets,
      status: "pending",
      polls: 0,
    }
    requests.set(created.id, created)
    return created
  }
  const refusal = (server: string, names: string[]) => ({
    code: "secret_required",
    server,
    secrets: names,
    message: `server ${server} needs ${names.join(", ")}`,
    requestId: requestFor(server, names).id,
  })
  let daemon: FakeDaemon
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const body: any = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      recorded.push({ path, body, headers: Object.fromEntries(request.headers) })
      const json = (value: unknown, status = 200) => Response.json(value, { status })
      const legacy = options.legacy === true
      if (path === "/v1/tools") return json(neonTools)
      if (path === "/v1/preflight") {
        if (legacy) return json({ error: "not found" }, 404)
        const names = daemonReferences(body.source)
        const known = names.filter((name) => name in servers)
        const blocked = known.filter((name) => missing(name).length > 0)
        const missingList = blocked.map((name) => ({ server: name, secrets: missing(name) }))
        return json({
          namespaces: names,
          unknown: names.filter((name) => !(name in servers)),
          ready: blocked.length === 0,
          missing: missingList,
          requests: missingList.map((item) => requestFor(item.server, item.secrets).id),
        })
      }
      if (path.startsWith("/v1/servers/")) {
        if (legacy) return json({ error: "not found" }, 404)
        const name = decodeURIComponent(path.slice("/v1/servers/".length))
        if (!(name in servers)) return json({ error: "unknown server" }, 404)
        return json({
          name,
          active: missing(name).length === 0,
          requiresSecrets: servers[name],
          missingSecrets: missing(name),
        })
      }
      if (path.startsWith("/v1/secret-requests/")) {
        if (legacy) return json({ error: "not found" }, 404)
        const record = requests.get(path.slice("/v1/secret-requests/".length))
        if (!record) return json({ error: "unknown request" }, 404)
        record.polls += 1
        options.onPoll?.(record, daemon)
        if (record.status === "pending" && record.secrets.every((name) => set.has(name))) record.status = "resolved"
        return json({
          id: record.id,
          server: record.server,
          secrets: record.secrets,
          status: record.status,
          createdAt: new Date().toISOString(),
          message: "",
        })
      }
      if (path === "/v1/call") {
        if (options.refuseCalls) return json(refusal(body.server, options.refuseCalls), 409)
        if (!legacy && missing(body.server).length > 0) return json(refusal(body.server, missing(body.server)), 409)
        return json({ result: { rows: 2 } })
      }
      if (path === "/v1/exec") {
        const blocked = legacy
          ? undefined
          : daemonReferences(body.source).find((name) => name in servers && missing(name).length > 0)
        if (blocked) return json(refusal(blocked, missing(blocked)), 409)
        return json({ output: "ran" })
      }
      return json({ status: "ok" })
    },
  })
  daemon = {
    port: server.port,
    recorded,
    requests,
    setSecret: (name) => {
      set.add(name)
    },
    decline: (id) => {
      const record = requests.get(id)
      if (record) record.status = "declined"
    },
    stop: () => {
      server.stop(true)
    },
  }
  return daemon
}

// Points the plugin at one fake daemon for a test, then clears projections and restores the wait bounds.
const withFakeDaemon = <A, E, R>(daemon: FakeDaemon, effect: Effect.Effect<A, E, R>) => {
  const previous = process.env.MCPX_DAEMON_ENDPOINT
  return Effect.sync(() => {
    process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${daemon.port}`
  }).pipe(
    Effect.flatMap(() => effect),
    Effect.ensuring(
      Effect.sync(() => {
        daemon.stop()
        if (previous === undefined) delete process.env.MCPX_DAEMON_ENDPOINT
        else process.env.MCPX_DAEMON_ENDPOINT = previous
        clearProjectedTools()
        setSecretTiming()
      }),
    ),
  )
}

const invoke = (registry: Tool.Interface, id: string, name: string, input: Record<string, unknown>) =>
  executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id, name, input } })

const daemonCalls = (daemon: FakeDaemon, path: string) => daemon.recorded.filter((request) => request.path === path)

const secretHeaders = (daemon: FakeDaemon) =>
  daemon.recorded.flatMap((request) =>
    Object.keys(request.headers).filter(
      (name) => name.startsWith("x-mcpx-secret") || name === "x-mcpx-injected-secrets",
    ),
  )

const scriptReadingNeon = `return await tools.neon.run_sql({ query: "select 1" })`

describe("McpxTool entry points, projections, and secrets", () => {
  it.live("mcpx_discover names the built-in comms namespace and answers for it locally", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon()
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const listed = yield* registry.list()
            expect(listed.find((tool) => tool.name === "mcpx_discover")?.description).toContain("comms")
            expect(listed.find((tool) => tool.name === "mcpx_exec")?.description).toContain("tools.comms.msg")

            const comms = yield* invoke(registry, "call-discover-comms", "mcpx_discover", { namespace: "comms" })
            expect(comms.status).toBe("completed")
            expect(comms.output?.output).toContain("tools.comms.msg")
            expect(comms.output?.output).toContain("tools.comms.topics")
            expect(comms.output?.output).toContain("tools.comms.sessions")
            expect(daemonCalls(daemon, "/v1/types")).toHaveLength(0)

            const all = yield* invoke(registry, "call-discover-all", "mcpx_discover", {})
            expect(all.status).toBe("completed")
            expect(all.output?.output).toContain("comms")
          }),
        ),
      )
    }),
  )

  it.live("lists the entry points as native tools and keeps mcpx_observe in the Code Mode catalog", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon()
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const toolSet = yield* registry.snapshot()
            const native = toolSet.definitions.map((definition) => definition.name)
            expect(native).toEqual(
              expect.arrayContaining(["mcpx_exec", "mcpx_discover", "mcpx_project", "mcpx_retract"]),
            )
            expect(native).not.toContain("mcpx_observe")
            expect(native).not.toContain("opencode_mcpx_exec")

            const paths = codeModeListings(toolSet.codeModeCatalog ?? { tools: [] }).map((listing) => listing.path)
            expect(paths).toContain("opencode.mcpx_observe")
            expect(paths).not.toContain("opencode.mcpx_exec")
          }),
        ),
      )
    }),
  )

  it.live("exposes a projected tool natively and in Code Mode, and both reach /v1/call with one body", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({ servers: { neon: [] } })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* invoke(registry, "call-project", "mcpx_project", { namespaces: ["neon"] })
            const toolSet = yield* registry.snapshot()
            expect(toolSet.definitions.map((definition) => definition.name)).toContain("neon_run_sql")
            const paths = codeModeListings(toolSet.codeModeCatalog ?? { tools: [] }).map((listing) => listing.path)
            expect(paths).toContain("neon.run_sql")

            const native = yield* invoke(registry, "call-native", "neon_run_sql", { query: "select 1" })
            const scripted = yield* invoke(registry, "call-script", "execute", { code: scriptReadingNeon })
            expect(native.status).toBe("completed")
            expect(scripted.status).toBe("completed")

            const bodies = daemonCalls(daemon, "/v1/call").map((request) => request.body)
            expect(bodies).toHaveLength(2)
            expect(bodies[1]).toEqual(bodies[0])
          }),
        ),
      )
    }),
  )

  it.live("mcpx_exec never calls /v1/exec while a secret is missing, and names the server and the secret", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon()
      setSecretTiming({ pollMs: 5, timeoutMs: 30 })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* invoke(registry, "call-exec", "mcpx_exec", { source: scriptReadingNeon })
            expect(result.status).toBe("error")
            expect(result.error?.message).toContain('NEON_API_KEY (server "neon")')
            expect(result.error?.message).toContain("`mcpx secrets set NEON_API_KEY`")
            expect(result.error?.message).toContain("Nothing ran.")
            expect(daemonCalls(daemon, "/v1/exec")).toHaveLength(0)
          }),
        ),
      )
    }),
  )

  it.live("runs the script once the pending secret request resolves", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({
        onPoll: (request, fake) => {
          if (request.polls === 2) fake.setSecret("NEON_API_KEY")
        },
      })
      setSecretTiming({ pollMs: 5, timeoutMs: 5000 })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* invoke(registry, "call-exec", "mcpx_exec", { source: scriptReadingNeon })
            expect(result.status).toBe("completed")
            expect(result.output?.output).toBe("ran")
            expect(daemonCalls(daemon, "/v1/exec")).toHaveLength(1)
            expect(secretHeaders(daemon)).toEqual([])
          }),
        ),
      )
    }),
  )

  it.live("fails the script at once when its secret request is declined", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({
        onPoll: (request, fake) => {
          fake.decline(request.id)
        },
      })
      setSecretTiming({ pollMs: 1000, timeoutMs: 60_000 })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const started = Date.now()
            const result = yield* invoke(registry, "call-exec", "mcpx_exec", { source: scriptReadingNeon })
            expect(Date.now() - started).toBeLessThan(500)
            expect(result.status).toBe("error")
            expect(result.error?.message).toContain("was declined")
            expect(result.error?.message).toContain("(request req_1)")
            expect(daemonCalls(daemon, "/v1/exec")).toHaveLength(0)
          }),
        ),
      )
    }),
  )

  it.live("stops waiting at the bound: a request still pending then fails the script", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon()
      setSecretTiming({ pollMs: 5, timeoutMs: 40 })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* invoke(registry, "call-exec", "mcpx_exec", { source: scriptReadingNeon })
            expect(result.status).toBe("error")
            expect(result.error?.message).toContain("within 40 ms")

            // Once the bound has passed, polling stops; at most the poll already in flight can still land.
            const polls = daemon.requests.get("req_1")?.polls ?? 0
            expect(polls).toBeGreaterThan(1)
            yield* Effect.sleep(60)
            expect((daemon.requests.get("req_1")?.polls ?? 0) - polls).toBeLessThanOrEqual(1)
          }),
        ),
      )
    }),
  )

  it.live("a projected call waits for its server's secret, then calls", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({
        onPoll: (request, fake) => {
          if (request.polls === 2) fake.setSecret("NEON_API_KEY")
        },
      })
      setSecretTiming({ pollMs: 5, timeoutMs: 5000 })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* invoke(registry, "call-project", "mcpx_project", { namespaces: ["neon"] })
            const result = yield* invoke(registry, "call-native", "neon_run_sql", { query: "select 1" })
            expect(result.status).toBe("completed")
            expect(daemonCalls(daemon, "/v1/call")).toHaveLength(1)
            // The wait files its request with a static reference to the tool, not with a call.
            expect(daemonCalls(daemon, "/v1/preflight")[0]?.body.source).toBe('tools["neon"]["run_sql"]')
            expect(secretHeaders(daemon)).toEqual([])
          }),
        ),
      )
    }),
  )

  it.live("a projected call fails at once when its secret request is declined, and never calls", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({
        onPoll: (request, fake) => {
          fake.decline(request.id)
        },
      })
      setSecretTiming({ pollMs: 1000, timeoutMs: 60_000 })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* invoke(registry, "call-project", "mcpx_project", { namespaces: ["neon"] })
            const result = yield* invoke(registry, "call-native", "neon_run_sql", { query: "select 1" })
            expect(result.status).toBe("error")
            expect(result.error?.message).toContain("was declined")
            expect(daemonCalls(daemon, "/v1/call")).toHaveLength(0)
          }),
        ),
      )
    }),
  )

  it.live("a call refused with 409 fails with the request id and sends no secret header", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({ servers: { neon: [] }, refuseCalls: ["NEON_API_KEY"] })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* invoke(registry, "call-project", "mcpx_project", { namespaces: ["neon"] })
            const result = yield* invoke(registry, "call-native", "neon_run_sql", { query: "select 1" })
            expect(result.status).toBe("error")
            expect(result.error?.message).toContain('NEON_API_KEY (server "neon")')
            expect(result.error?.message).toContain("(request req_1)")
            expect(secretHeaders(daemon)).toEqual([])
          }),
        ),
      )
    }),
  )

  it.live("runs a script against a daemon from before the secrets API", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon({ legacy: true })
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* invoke(registry, "call-exec", "mcpx_exec", { source: scriptReadingNeon })
            expect(result.status).toBe("completed")
            expect(result.output?.output).toBe("ran")
            expect(daemonCalls(daemon, "/v1/exec")).toHaveLength(1)
          }),
        ),
      )
    }),
  )

  it.live("the daemon's reading of a script and extractToolsFromScript name the same servers", () =>
    Effect.sync(() => {
      const samples = [
        `await tools.neon.run_sql({ query: "select 1" })`,
        `await tools["neon"]["run_sql"]({ query: "select 1" })`,
        `await tools['github']['create_issue']({ title: "x" })`,
        `const rows = await tools.neon.run_sql({}); return tools.chrome_devtools.navigate_page({ url: "x" })`,
        `await tools["my-server"]["my-tool"]({})`,
        `await tools.neon.run_sql({}); await tools.neon.describe({})`,
        `tools.neon; mytools.neon.run_sql({}); return 1`,
      ]
      for (const sample of samples) {
        const core = [...new Set(extractToolsFromScript(sample).map((reference) => reference.namespace))].sort()
        expect(core).toEqual(daemonReferences(sample))
      }
    }),
  )

  it.live("the mcpx descriptions and the Code Mode instructions state the same rule", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = fakeDaemon()
      yield* withFakeDaemon(
        daemon,
        withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* invoke(registry, "call-project", "mcpx_project", { namespaces: ["neon"] })
            const toolSet = yield* registry.snapshot()
            const listed = yield* registry.list()
            const mcpx = listed.filter((tool) => tool.name.startsWith("mcpx_"))
            expect(mcpx.map((tool) => tool.name).sort()).toEqual([
              "mcpx_discover",
              "mcpx_exec",
              "mcpx_observe",
              "mcpx_project",
              "mcpx_retract",
            ])
            for (const tool of mcpx) expect(tool.description).toContain(CodeModeRules.canonical)

            const discover = listed.find((tool) => tool.name === "mcpx_discover")
            expect(discover?.description).toContain("the tools scripts can call")
            expect(discover?.description).toContain("the tools that can be projected")

            const namespace = toolSet.codeModeCatalog?.tools.find(
              (entry) => entry.type === "namespace" && entry.name === "neon",
            )
            expect(namespace?.type === "namespace" ? namespace.description : undefined).toContain(
              CodeModeRules.canonical,
            )

            const instructions = (yield* readInitial(CodeModeInstructions.make(toolSet.codeModeCatalog))).text
            expect(instructions).toContain(CodeModeRules.canonical)
            expect(instructions).toContain("mcpx_discover lists can be called in an mcpx_exec script")
          }),
        ),
      )
    }),
  )
})
