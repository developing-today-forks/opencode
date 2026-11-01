import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schedule, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { AISDK } from "@opencode/core/aisdk"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { FileSystem } from "@opencode/core/filesystem"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Form } from "@opencode/core/form"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { Mcp } from "@opencode/core/mcp/index"
import { Messaging } from "@opencode/core/messaging"
import { MessagingEmbedding } from "@opencode/core/messaging/embedding"
import { MessagingTemplate } from "@opencode/core/messaging/template"
import { MessagingVars } from "@opencode/core/messaging/vars"
import { Model } from "@opencode/core/model"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Reference } from "@opencode/core/reference"
import { Rpc } from "@opencode/core/rpc"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { Tool } from "@opencode/core/tool"
import { MessagingTools } from "@opencode/core/tool/plugin/messaging"
import { Vcs } from "@opencode/core/vcs"
import { WebSearch } from "@opencode/core/websearch"
import { Worktree } from "@opencode/core/worktree"
import { WorktreeStrategies } from "@opencode/core/worktree/strategies"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Npm } from "@opencode/util/npm"
import { Document, Event as ConfigEvent, Info } from "@opencode/schema/config"
import { ConfigMessaging } from "@opencode/schema/config/messaging"
import { AppProcess } from "@opencode/util/process"
import { tempLocationLayer } from "./fixture/location"
import { emptyMcpLayer } from "./fixture/mcp"
import { testEffect } from "./lib/effect"
import { codeModeListings, executeTool, toolIdentity } from "./lib/tool"

const config = Config.testLayer()

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      FileSystem.node,
      FileAccess.node,
      Location.node,
      Npm.node,
      Credential.node,
      Config.node,
      Database.node,
      Bus.node,
      Form.node,
      Generate.node,
      LayerNodePlatform.httpClient,
      Plugin.node,
      Agent.node,
      AISDK.node,
      Provider.node,
      Model.node,
      Command.node,
      Integration.node,
      KV.node,
      ManagedPolicy.node,
      Mcp.node,
      Session.node,
      PersistentPty.node,
      LocationServiceMap.node,
      Permission.node,
      PluginHooks.node,
      Reference.node,
      Rpc.node,
      Skill.node,
      SkillDiscovery.node,
      Tool.node,
      Vcs.node,
      Watcher.node,
      WebSearch.node,
      Worktree.node,
      WorktreeStrategies.node,
      MessagingVars.node,
      MessagingEmbedding.node,
      Messaging.node,
    ]),
    [
      Location.node.replace(tempLocationLayer),
      Npm.node.replace(
        Layer.succeed(
          Npm.Service,
          Npm.Service.of({
            add: (name) => Effect.succeed({ directory: "", name }),
            resolve: (name) => Effect.succeed({ directory: "", name }),
            check: () => Effect.succeed(false),
            update: (name) => Effect.succeed({ directory: "", name }),
            which: () => Effect.undefined,
          }),
        ),
      ),
      Config.node.replace(config),
      Mcp.node.replace(emptyMcpLayer),
      Generate.node.replace(
        Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed('["2", "1"]') })),
      ),
    ],
  ).pipe(Layer.provideMerge(config)),
)

const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  const pluginHost = yield* PluginHost.make(plugins)
  yield* MessagingTools.Plugin.effect(pluginHost)
  const root = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }), title: "Lead" })
  const child = yield* sessions.create({ parentID: root.id, title: "Worker" })
  const registry = yield* Tool.Service
  const run = (sessionID: Session.ID, code: string) =>
    executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: `call-${code}`, name: "execute", input: { code } },
    }).pipe(
      Effect.map((result) => {
        const text = result.content?.[0]?.type === "text" ? result.content[0].text : ""
        // Code Mode returns the script value as JSON text, or the error text when a tool throws.
        return { status: result.status, text, value: /^[[{]/.test(text) ? JSON.parse(text) : undefined }
      }),
    )
  return { root, child, registry, run }
})

describe("MessagingTools", () => {
  it.effect("registers three Code Mode tools in the comms namespace", () =>
    Effect.gen(function* () {
      const { registry } = yield* setup
      const catalog = (yield* registry.snapshot()).codeModeCatalog
      expect(catalog).toBeDefined()
      const listed = catalog ? codeModeListings(catalog) : []
      expect(listed.filter((tool) => tool.path.startsWith("comms.")).map((tool) => tool.path)).toEqual([
        "comms.msg",
        "comms.sessions",
        "comms.topics",
      ])
    }),
  )

  it.effect("sends, awaits and reads messages between sessions as the calling session", () =>
    Effect.gen(function* () {
      const { root, child, run } = yield* setup
      const sent = yield* run(
        child.id,
        `return await tools.comms.msg({ to: "parent", text: "API ready?", deliver: "none" })`,
      )
      expect(sent.value).toMatchObject({ topic: `${root.id}/bidi/${child.id}`, seq: 1 })

      const unread = yield* run(root.id, `return await tools.comms.msg({ mode: "unread" })`)
      expect(unread.value.messages).toEqual([
        expect.objectContaining({ ref: `${root.id}/bidi/${child.id}#1`, from: child.id, text: "API ready?" }),
      ])
      const replied = yield* run(
        root.id,
        `return await tools.comms.msg({ to: "${child.id}", text: "Yes", seq: 1, deliver: "none" })`,
      )
      expect(replied.value).toMatchObject({ seq: 2 })
      const thread = yield* run(child.id, `return await tools.comms.msg({ to: "parent" })`)
      expect(thread.value.messages.map((message: { text: string }) => message.text)).toEqual(["API ready?", "Yes"])
    }),
  )

  it.effect("hides, inspects and searches with advanced reranking", () =>
    Effect.gen(function* () {
      const { child, run } = yield* setup
      yield* run(
        child.id,
        `await tools.comms.msg({ topic: "notes", text: "rollout plan for friday" }); return await tools.comms.msg({ topic: "notes", text: "rollback steps" })`,
      )
      const hid = yield* run(
        child.id,
        `return await tools.comms.msg({ mode: "hide", topic: "notes", seq: 1, reason: "stale" })`,
      )
      expect(hid.value).toMatchObject({ targets: [1], default: false })
      const visible = yield* run(child.id, `return await tools.comms.msg({ topic: "notes" })`)
      expect(visible.value.messages.map((message: { text: string }) => message.text)).toEqual(["rollback steps"])
      const inspected = yield* run(
        child.id,
        `return await tools.comms.msg({ mode: "inspect", topic: "notes", seq: 1 })`,
      )
      expect(inspected.value).toMatchObject({
        hidden: true,
        ops: [expect.objectContaining({ kind: "delete", reason: "stale" })],
      })

      // The stub model ranks message 2 above message 1.
      const advanced = yield* run(
        child.id,
        `return await tools.comms.msg({ query: "roll", match: "advanced", hidden: "include", kinds: ["message"] })`,
      )
      expect(advanced.value.messages.map((message: { text: string }) => message.text)).toEqual([
        "rollback steps",
        "rollout plan for friday",
      ])
      expect(advanced.value.match).toBe("advanced")

      // HTTP, plugin and CLI searches pass no reranker and get the location's.
      const messaging = yield* Messaging.Service
      const direct = yield* messaging.query({
        as: child.id,
        query: "roll",
        match: "advanced",
        hidden: "include",
        kinds: ["message"],
      })
      expect(direct.match).toBe("advanced")
      expect(direct.messages.map((message) => message.data)).toEqual(["rollback steps", "rollout plan for friday"])
    }),
  )

  it.effect("shows the chain, lists presets and topics, and reads logs", () =>
    Effect.gen(function* () {
      const { root, child, run } = yield* setup
      const chain = yield* run(child.id, `return await tools.comms.sessions({})`)
      expect(chain.value.chain.map((node: { id: string }) => node.id)).toEqual([child.id, root.id])
      expect(chain.value.root).toBe(root.id)

      const presets = yield* run(child.id, `return await tools.comms.topics({ mode: "presets", values: true })`)
      expect(presets.value.presets.find((preset: { name: string }) => preset.name === "family")?.value).toBe(
        `${root.id}/family`,
      )
      const topics = yield* run(child.id, `return await tools.comms.topics({})`)
      expect(topics.value.topics.map((topic: { name: string }) => topic.name)).toContain(`${child.id}/private`)

      const denied = yield* run(child.id, `return await tools.comms.msg({ topic: "private@${root.id}", text: "x" })`)
      expect(denied.text).toContain("force: true")

      const set = yield* run(
        root.id,
        `return await tools.comms.topics({ mode: "set_var", name: "goal", value: "ship it" })`,
      )
      expect(set.value).toMatchObject({ name: "goal", value: "ship it" })
      const rendered = yield* run(
        child.id,
        `return await tools.comms.topics({ mode: "presets", render: "{goal} from {parent_session_title}" })`,
      )
      expect(rendered.value.rendered).toBe("ship it from Lead")

      const log = yield* run(
        child.id,
        `return await tools.comms.sessions({ mode: "log", session: "${child.id}", op: "tail" })`,
      )
      expect(log.value).toMatchObject({ total: expect.any(Number), more: false })
      const model = yield* run(child.id, `return await tools.comms.msg({ mode: "model" })`)
      expect(model.value.tiers.map((tier: { name: string }) => tier.name)).toEqual([
        "tiny",
        "default",
        "step-up",
        "top",
      ])
    }),
  )

  it.live("applies an edited messaging section to calls that never use a tool", () =>
    Effect.gen(function* () {
      const { root, child } = yield* setup
      const test = yield* Config.Test
      const bus = yield* Bus.Service
      const messaging = yield* Messaging.Service
      yield* test.setEntries([
        new Document({
          type: "document",
          info: new Info({ messaging: new ConfigMessaging.Info({ delivery: { direct: "inbox" } }) }),
        }),
      ])
      yield* bus.publish(ConfigEvent.Updated, { sections: ["messaging"] })
      // The plugin applies the section on its own fiber; an HTTP send reads it from the global services.
      const delivered = yield* messaging.send({ as: child.id, to: "parent", text: "configured?" }).pipe(
        Effect.map((result) => result.delivered),
        Effect.repeat({
          until: (result) => result[0]?.delivery === "inbox",
          times: 50,
          schedule: Schedule.spaced("20 millis"),
        }),
      )
      expect(delivered).toEqual([{ session: root.id, delivery: "inbox" }])
    }),
  )

  it.effect("starts every request with the session start line", () =>
    Effect.gen(function* () {
      const { root, child } = yield* setup
      const hooks = yield* PluginHooks.Service
      const request = (sessionID: Session.ID) =>
        hooks.trigger("session", "context", {
          sessionID,
          model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") }),
          agent: toolIdentity.agent,
          system: [],
          messages: [],
          options: {},
          tools: {},
        })
      const created = MessagingTemplate.rfc3339(new Date(DateTime.toEpochMillis(child.time.created)))
      expect((yield* request(child.id)).system.map((part) => part.text)).toEqual([
        `Session started ${created} (${MessagingTemplate.timeZone()}). Session ID: ${child.id}. Parent session: ${root.id}. Root session: ${root.id}.`,
      ])
    }),
  )

  it.effect("rejects invalid offsets at the tool boundary like the contract", () =>
    Effect.sync(() => {
      for (const input of [MessagingTools.TopicsInput, MessagingTools.SessionsInput]) {
        const decode = Schema.decodeUnknownSync(input)
        expect(decode({ offset: 0 })).toMatchObject({ offset: 0 })
        expect(decode({ offset: 10 })).toMatchObject({ offset: 10 })
        expect(() => decode({ offset: -1 })).toThrow()
        expect(() => decode({ offset: 1.5 })).toThrow()
        expect(() => decode({ offset: NaN })).toThrow()
      }
    }),
  )

  it.effect("rejects invalid log context at the tool boundary like the contract", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(MessagingTools.SessionsInput)
      expect(decode({ context: 0 })).toMatchObject({ context: 0 })
      expect(decode({ context: 10 })).toMatchObject({ context: 10 })
      expect(() => decode({ context: -1 })).toThrow()
      expect(() => decode({ context: 1.5 })).toThrow()
      expect(() => decode({ context: NaN })).toThrow()
    }),
  )
})
