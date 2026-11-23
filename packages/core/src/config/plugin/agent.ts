export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigAgentDocuments } from "../agent-documents.js"
import { ConfigEntryObserver } from "./entry-observer.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Permission } from "../../permission.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"

type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name

export const Plugin = define({
  id: "opencode.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const loadEntry = (entry: Entry) => ConfigAgentDocuments.expandEntry(fs, entry)
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = yield* ConfigEntryObserver.observeSources({
      config,
      event: ctx.event,
      directories: ConfigAgentDocuments.sourceDirectories,
      load,
      reload: ctx.agent.reload(),
      sections: ["agents", "permissions", "default_agent"],
    })
    yield* ctx.agent.transform((editor) => {
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          const agentID = Agent.ID.make(id)
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          const exists = editor.get(agentID) !== undefined
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            if (item.models !== undefined) agent.models = [...item.models]
            if (item.excluded_models !== undefined) agent.excludedModels = [...item.excluded_models]
            if (item.subagent_models !== undefined) agent.subagentModels = [...item.subagent_models]
            if (item.subagent_excluded_models !== undefined)
              agent.subagentExcludedModels = [...item.subagent_excluded_models]
            if (item.max_depth !== undefined) agent.maxDepth = item.max_depth
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            if (item.system !== undefined) agent.system = item.system
            if (item.description !== undefined) agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined) agent.steps = item.steps
            if (item.permissions !== undefined) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return (Permission.pathActions satisfies readonly PathAction[]).some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

