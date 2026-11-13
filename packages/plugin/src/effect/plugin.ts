import type { CredentialApi, ExperimentalApi, GenerateApi, PluginApi } from "@opencode/client/effect/api"
import type { Location } from "@opencode/schema/location"
import type { Effect, Scope } from "effect"
import type { PluginOptions } from "../options.js"
import type { App } from "../app.js"
import type { AgentDomain } from "./agent.js"
import type { AISDKDomain } from "./aisdk.js"
import type { CommandDomain } from "./command.js"
import type { EventDomain } from "./event.js"
import type { IntegrationDomain } from "./integration.js"
import type { MCPDomain } from "./mcp.js"
import type { MessagingDomain } from "./messaging.js"
import type { ModelDomain } from "./model.js"
import type { PermissionDomain } from "./permission.js"
import type { ProviderDomain } from "./provider.js"
import type { ReferenceDomain } from "./reference.js"
import type { RpcDomain } from "./rpc.js"
import type { SessionDomain } from "./session.js"
import type { ShellDomain } from "./shell.js"
import type { SkillDomain } from "./skill.js"
import type { StorageDomain } from "./storage.js"
import type { ToolDomain } from "./tool.js"
import type { VcsDomain } from "./vcs.js"
import type { WebSearchDomain } from "./websearch.js"
import type { WorktreeDomain } from "./worktree.js"

export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  /**
   * URL of the active server listener (for example `http://127.0.0.1:4096`).
   * Undefined when no listener is active, such as embedded SDK hosts.
   *
   * In-process domain calls are already authenticated, which is the documented
   * equivalent of v1's `client`: prefer `ctx.session`, `ctx.model`, and the
   * other domains over raw HTTP. Use this only when a raw HTTP(S) URL is
   * needed, such as opening the server in a browser or handing an address to
   * a subprocess.
   */
  readonly serverUrl: string | undefined
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly credential: Pick<CredentialApi<unknown>, "activate">
  readonly event: EventDomain
  readonly experimental: {
    readonly terminal: Pick<ExperimentalApi<unknown>["persistentPty"], "read">
  }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly messaging: MessagingDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi<unknown>
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi<unknown>, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}
