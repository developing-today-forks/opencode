// Claude Code provider (#6117) — a native wire-protocol emulation of the
// Claude Code CLI, in the fleet's direct-provider pattern (cf. vibe,
// antigravity): no `claude` subprocess at inference time. The CLI speaks
// the Anthropic Messages API with its claude.ai subscription OAuth
// credential, so this provider reuses that protocol through the
// ClaudeCodeMessages wrapper (protocols/claude-code-messages.ts), which
// adds the OAuth-gated shape — the identity system block, the
// claude-code/oauth beta flags, and the CLI's client headers — while
// claude-code-auth.ts supplies the credential the claude.ai OAuth
// sign-in provisions (~/.claude/.credentials.json) — the CLI's own, or
// the provider's in-product sign-in (#1852) — read in place.
//
// This replaces the retired shape seated in the deployed config: an
// OpenAI-compatible block pointing at bin/claude-code-proxy.mjs
// (developing-today/code), a bridge that ran the CLI per conversation
// and could not emit client tool calls at all — request tools were
// ignored and history was flattened to prose (code#6117). Here, tools
// lower to real Anthropic tool_use/tool_result blocks and stream back
// as real client tool calls, byte-identical in shape to the anthropic
// provider's. The provider stays disabled in the deployed config until
// the coordinator repoints the config block at this package; nothing
// here re-enables it.
//
// Live-verification status (2026-11-06): the org-level OAuth denial
// below is RESOLVED - Drew enabled Claude Max on the account and the
// provider's exact wire shape (identity block, claude-code/oauth
// betas, CLI headers, OAuth bearer) now returns 200 from
// api.anthropic.com for both the fleet model ids (claude-haiku-5-5,
// claude-sonnet-5-5) and catalog ids. The 2026-11-05 status was:
// two probes in this provider's exact shape reached api.anthropic.com
// and were refused 403 oauth_not_allowed_for_organization - the same
// org-level OAuth denial bin/claude-code-proxy.mjs documented for
// GET /v1/models on 2026-10-28. Separately, the deployed binary's
// requests 404ed until the AnthropicMessages DEFAULT_BASE_URL fix
// (bare origin; the endpoint render appends "/messages", and the
// old "/v1"-suffixed base produced /v1/v1/messages).

import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { ClaudeCodeMessages } from "../protocols/claude-code-messages.js"
import { Auth } from "../route/auth.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import { ClaudeCodeAuth, type CredentialSources } from "./claude-code-auth.js"

export const id = ProviderID.make("_claude")

export type ProviderOptionsInput = ClaudeCodeMessages.ProviderOptionsInput
export type OptionsInput = ProviderOptionsInput

export type Config = Omit<RouteDefaultsInput, "providerOptions"> & {
  readonly baseURL?: string
  /** Explicit auth override (tests, embedding hosts). Wins over every credential tier. */
  readonly auth?: Auth.Definition
  /** Static OAuth access token (tests/offline). Wins over the credentials file and env. */
  readonly accessToken?: string
  /** Injectable credential sources (tests). */
  readonly sources?: CredentialSources
  readonly providerOptions?: ProviderOptionsInput
}

export type Settings = ProviderPackage.Settings &
  ProviderOptionsInput & {
    readonly baseURL?: string
    readonly accessToken?: string
  }

/**
 * The models the fleet's Claude Code account has provably served: the
 * ids below are the ones recorded in the CLI's own session records
 * (~/.claude/projects message.model fields — the same verified floor
 * bin/claude-code-proxy.mjs serves) and the deployed config's catalog.
 * No limits or costs are invented for them; deployments declare those
 * in config.
 */
export interface ModelPreset {
  readonly id: string
  readonly name: string
}

export const DEFAULT_MODEL_ID = "claude-haiku-5-5"

export const MODELS: ReadonlyArray<ModelPreset> = [
  { id: "claude-haiku-5-5", name: "Haiku 5.5 (Claude Code)" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5 (Claude Code)" },
  { id: "claude-opus-5-5", name: "Opus 5.5 (Claude Code)" },
]

export const route = ClaudeCodeMessages.route
export const routes = [route]

const configuredRoute = (input: Config) => {
  const { baseURL, auth, accessToken, sources, ...rest } = input
  return ClaudeCodeMessages.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? AnthropicMessages.DEFAULT_BASE_URL },
    auth: ClaudeCodeAuth.claudeCodeAuth({ auth, accessToken, sources }),
  })
}

export const configure = (input: Config = {}) => {
  return {
    id,
    model: (modelID: string | ModelID) => configuredRoute(input).model<ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, ProviderOptionsInput>["model"] = (
  modelID,
  { baseURL, accessToken, body, headers, ...providerOptions },
) =>
  configure({
    baseURL,
    accessToken,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  }).model(modelID)

export * as ClaudeCode from "./claude-code.js"
