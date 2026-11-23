import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap, Stream } from "effect"
import GitHubPlugin, { GitHubTools } from "@opencode/plugin-github"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { CodeModeCatalog } from "../src/codemode/catalog"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Instance } from "@opencode/core/instance"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { Tool } from "@opencode/core/tool"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { codeModeListings, executeTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

// Written out rather than read from the plugin, so a tool that silently fails to register is caught.
const TOOLS = [
  "api",
  "artifact_download",
  "artifacts",
  "comment",
  "comment_update",
  "commits",
  "compare",
  "context",
  "copilot",
  "discussion",
  "discussion_create",
  "discussion_update",
  "discussions",
  "dispatch",
  "feedback",
  "issue",
  "issue_create",
  "issue_update",
  "issues",
  "logs",
  "pr",
  "pr_create",
  "pr_files",
  "pr_merge",
  "pr_update",
  "preferences",
  "prs",
  "release_asset",
  "release_create",
  "release_notes",
  "release_update",
  "releases",
  "repo",
  "repos",
  "respond",
  "review",
  "run",
  "run_action",
  "runs",
  "search",
  "toolset",
  "updates",
  "upload",
  "wait",
  "workflows",
]

// Administration tools start hidden; enable adds them.
const HIDDEN = [
  "actions_settings",
  "actions_settings_update",
  "alert_update",
  "alerts",
  "autolink_update",
  "autolinks",
  "branch_protection",
  "branch_protection_update",
  "collaborator_update",
  "collaborators",
  "copilot_settings",
  "copilot_settings_update",
  "deploy_key_update",
  "deploy_keys",
  "environment_update",
  "environments",
  "pages",
  "pages_update",
  "properties",
  "property_set",
  "repo_update",
  "ruleset_update",
  "rulesets",
  "secret_set",
  "secrets",
  "security",
  "security_update",
  "tag_update",
  "tags",
  "variable_set",
  "variables",
  "webhook_update",
  "webhooks",
]

// The built-in plugin list comes from the real supervisor; only the config's plugin operations are scripted.
const source: { operations: ConfigPluginSource.Operation[] } = { operations: [] }
const sourceLayer = Layer.succeed(
  ConfigPluginSource.Service,
  ConfigPluginSource.Service.of({
    operations: () => Effect.sync(() => source.operations),
    changes: () => Stream.never,
  }),
)

const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) => Instance.layer(ref, { discovery: false, plugins: [], replacements: bindings }),
      { idleTimeToLive: Duration.infinity },
    )
    const bindings: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      ConfigPluginSource.node.replace(sourceLayer),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, { provide: (session) => Effect.provide(map.get(session.location)) }),
      ),
    ]
    return map
  }),
)

const supervised = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    LocationServiceMap.node.replace(instances),
  ]),
)

const activate = (operations: ConfigPluginSource.Operation[]) =>
  Effect.gen(function* () {
    source.operations = operations
    const directory = yield* tmpdirScoped()
    const locations = yield* LocationServiceMap.Service
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      yield* plugins.awaitActivation
      const snapshot = yield* registry.snapshot()
      return {
        status: (yield* plugins.list()).find((plugin) => plugin.id === GitHubTools.ID)?.state.status,
        tools: codeModeListings(snapshot.codeModeCatalog ?? { tools: [] })
          .map((entry) => entry.path)
          .filter((entry) => entry.startsWith("github.")),
        denied: codeModeListings(
          (yield* registry.snapshot([{ action: "github_pr_merge", resource: "*", effect: "deny" }]))
            .codeModeCatalog ?? { tools: [] },
        )
          .map((entry) => entry.path)
          .filter((entry) => entry.startsWith("github.")),
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
    )
  }).pipe(Effect.ensuring(Effect.sync(() => (source.operations = []))))

describe("built-in github plugin", () => {
  supervised.live("is on by default and lists every tool not hidden by default in the Code Mode catalog", () =>
    Effect.gen(function* () {
      const result = yield* activate([])
      expect(result.status).toBe("active")
      expect(result.tools.toSorted()).toEqual(TOOLS.map((name) => `github.${name}`).toSorted())
      // A permission rule hides one tool like any other tool.
      expect(result.denied).not.toContain("github.pr_merge")
      expect(result.denied).toHaveLength(TOOLS.length - 1)
    }),
  )

  supervised.live('turns off like any other plugin with "-opencode.github"', () =>
    Effect.gen(function* () {
      const result = yield* activate([{ type: "remove", target: GitHubTools.ID }])
      expect(result.status).toBeUndefined()
      expect(result.tools).toEqual([])
    }),
  )
})

const hosted = testEffect(PluginTestLayer)

describe("github plugin through the plugin host", () => {
  hosted.live("registers a hidden fallback skill and persists preferences through Code Mode", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const skills = yield* Skill.Service
      const registry = yield* Tool.Service
      yield* GitHubPlugin.effect(yield* PluginHost.make(plugins, "test"))

      const skill = (yield* skills.list()).find((entry) => entry.id === "github")
      expect(skill?.autoinvoke).toBe(false)
      expect(skill?.content).toContain("gh equivalents")

      const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
      const execute = (code: string) =>
        executeTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: `call-${code.length}`, name: "execute", input: { code } },
        }).pipe(
          Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "null")),
        )
      expect(
        yield* execute(
          `return await tools.github.preferences({ scope: "global", set: { review_rounds: 5, notes: ["skip style nits"] } })`,
        ),
      ).toMatchObject({ global: { review_rounds: 5, notes: ["skip style nits"] }, effective: { review_rounds: 5 } })
      expect(
        yield* execute(`return await tools.github.preferences({ scope: "global", clear: ["notes"] })`),
      ).toMatchObject({ global: { review_rounds: 5 } })
      expect((yield* execute(`return await tools.github.preferences({})`)).global).toEqual({ review_rounds: 5 })
    }),
  )

  hosted.live("toolset changes the Code Mode catalog from the next step; nothing is pinned", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const registry = yield* Tool.Service
      yield* GitHubPlugin.effect(yield* PluginHost.make(plugins, "test"))
      const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
      const execute = (code: string) =>
        executeTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: `call-${code.length}`, name: "execute", input: { code } },
        }).pipe(
          Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "null")),
        )
      const listed = Effect.gen(function* () {
        const snapshot = yield* registry.snapshot()
        return codeModeListings(snapshot.codeModeCatalog ?? { tools: [] })
          .map((entry) => entry.path)
          .filter((entry) => entry.startsWith("github."))
          .map((entry) => entry.slice("github.".length))
          .toSorted()
      })
      expect(yield* listed).toEqual(TOOLS.toSorted())

      // Nothing is pinned: with no inline budget the namespace line is all a session pays for until it searches.
      const bare = CodeModeCatalog.summarize((yield* registry.snapshot()).codeModeCatalog ?? { tools: [] }, {
        budget: 0,
      })
      expect(bare.namespaces.find((namespace) => namespace.name === "github")?.entries).toEqual([])

      const enabled = yield* execute(`return await tools.github.toolset({ enable: ["secret*", "dependabot"] })`)
      expect(enabled.changed.toSorted()).toEqual([
        "alert_update",
        "alerts",
        "secret_set",
        "secrets",
        "security",
        "security_update",
      ])
      expect(yield* listed).toEqual(
        [...TOOLS, "alert_update", "alerts", "secret_set", "secrets", "security", "security_update"].toSorted(),
      )

      yield* execute(`return await tools.github.toolset({ enable: ["*"] })`)
      expect(yield* listed).toEqual([...TOOLS, ...HIDDEN].toSorted())

      yield* execute(`return await tools.github.toolset({ disable: ["*"], enable: ["pr", "feedback"] })`)
      expect(yield* listed).toEqual(["feedback", "pr", "toolset"])

      yield* execute(`return await tools.github.toolset({ reset: true })`)
      expect(yield* listed).toEqual(TOOLS.toSorted())
    }),
  )

  hosted.live("the codemode option false lists the tools natively as github_<name>", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const host = yield* PluginHost.make(plugins, "test")
      yield* GitHubPlugin.effect({ ...host, options: { codemode: false } })
      const names = (yield* toolDefinitions(registry)).map((definition) => definition.name)
      expect(names).toContain("github_feedback")
      expect(names).toContain("github_wait")
    }),
  )
})
