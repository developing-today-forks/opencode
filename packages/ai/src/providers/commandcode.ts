// Command Code provider (#6117) — a native wire-protocol emulation of
// the Command Code CLI, in the fleet's direct-provider pattern (cf.
// vibe, antigravity): no `cmd` subprocess at inference time. The CLI
// speaks a private streaming protocol to
// https://api.commandcode.ai/alpha/generate with the API key its
// `cmd login` provisions; protocols/commandcode.ts reproduces that wire
// (extracted from the installed CLI bundle, command-code 1.74.1) and
// commandcode-auth.ts supplies the credential, read in place from
// ~/.commandcode/auth.json.
//
// This replaces the retired shape seated in the deployed config: an
// OpenAI-compatible block pointing at bin/commandcode-proxy.mjs
// (developing-today/code), a bridge that ran the CLI per request and
// could not emit client tool calls at all — in its "agency" mode the
// client's tools were reduced to a name/description prose manifest
// (parameter schemas dropped) and the CLI's own tools did the work,
// returning only a text summary (code#6117). Here, client tools are
// declared on the wire and stream back as real client tool calls.
//
// The vendor's hosted Provider API (api.commandcode.ai/provider/v1) is
// NOT this provider's wire: it rejects the fleet's Go plan with 403
// upgrade_required (opencode#1411), while /alpha/generate — the CLI's
// own endpoint — serves the plan. The provider stays disabled in the
// deployed config (Drew, 2026-10-31: credits exhausted) until the
// coordinator repoints the config block at this package; nothing here
// re-enables it.
import type { ProviderPackage } from "../provider-package.js"
import { CommandCode } from "../protocols/commandcode.js"
import { Auth } from "../route/auth.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import { CommandCodeAuth, type CredentialSources } from "./commandcode-auth.js"

export const id = ProviderID.make("_commandcode")

export type ProviderOptionsInput = CommandCode.ProviderOptionsInput
export type OptionsInput = ProviderOptionsInput

export type Config = Omit<RouteDefaultsInput, "providerOptions"> & {
  readonly baseURL?: string
  /** Explicit auth override (tests, embedding hosts). Wins over every credential tier. */
  readonly auth?: Auth.Definition
  /** Static API key (tests/offline). Wins over env and ~/.commandcode/auth.json. */
  readonly apiKey?: string
  /** Injectable credential sources (tests). */
  readonly sources?: CredentialSources
  /** x-command-code-version header value; defaults to the tracked CLI version (commandcode-auth). */
  readonly cliVersion?: string
  readonly providerOptions?: ProviderOptionsInput
}

export type Settings = ProviderPackage.Settings &
  ProviderOptionsInput & {
    readonly baseURL?: string
    readonly apiKey?: string
    readonly cliVersion?: string
  }

/**
 * A floor of the provider's model catalog — the ids the deployed config
 * declares for this provider (themselves the CLI's --list-models floor
 * in bin/commandcode-proxy.mjs). The full catalog is the CLI's live
 * list; deployments declare their models in config, as they do today.
 */
export interface ModelPreset {
  readonly id: string
  readonly name: string
}

export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash"

export const MODELS: ReadonlyArray<ModelPreset> = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek v4 Flash (Command Code)" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek v4 Pro (Command Code)" },
  { id: "moonshotai/kimi-k2.6", name: "Kimi k2.6 (Command Code)" },
  { id: "zai-org/glm-5.2", name: "GLM 5.2 (Command Code)" },
  { id: "minimaxai/minimax-m3", name: "MiniMax m3 (Command Code)" },
  { id: "xiaomi/mimo-v2.5", name: "MiMo v2.5 (Command Code)" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5 (Command Code)" },
  { id: "gpt-5.6-terra", name: "GPT 5.6 Terra (Command Code)" },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash (Command Code)" },
  { id: "xai/grok-4.5", name: "Grok 4.5 (Command Code)" },
]

export const route = CommandCode.route
export const routes = [route]

/**
 * The models.dev catalog entry for this provider id describes the hosted
 * Provider API of the vendor (https://api.commandcode.ai/provider/v1, for
 * the @ai-sdk/openai-compatible package), and the catalog layer seeds that
 * URL as the baseURL setting of the provider. This native provider does
 * not speak that API - its wire is the /alpha/generate endpoint of the CLI
 * on https://api.commandcode.ai - so a seeded hosted-API base URL must
 * never reach the endpoint: requests addressed to the hosted base plus
 * /alpha/generate return 404 (verified live 2026-11-06 against the
 * deployed build, whose sessions failed with the verbatim gateway error
 * naming POST https://api.commandcode.ai/provider/v1/alpha/generate as
 * not a registered API route). An explicitly configured base URL for any
 * other target (a test listener, a mirror) is honored unchanged.
 */
export const HOSTED_PROVIDER_API_BASE_URL = "https://api.commandcode.ai/provider/v1"

const resolveBaseURL = (baseURL: string | undefined): string => {
  if (baseURL === undefined) return CommandCode.DEFAULT_BASE_URL
  return baseURL.replace(/\/+$/, "") === HOSTED_PROVIDER_API_BASE_URL ? CommandCode.DEFAULT_BASE_URL : baseURL
}

const configuredRoute = (input: Config) => {
  const { baseURL, auth, apiKey, sources, cliVersion, ...rest } = input
  return CommandCode.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: resolveBaseURL(baseURL) },
    auth: CommandCodeAuth.commandCodeAuth({ auth, apiKey, sources, cliVersion }),
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
  { baseURL, apiKey, cliVersion, body, headers, ...providerOptions },
) =>
  configure({
    baseURL,
    apiKey,
    cliVersion,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  }).model(modelID)

export * as Commandcode from "./commandcode.js"
