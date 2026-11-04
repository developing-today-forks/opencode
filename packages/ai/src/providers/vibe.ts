// Mistral Vibe provider (#1653) — a native wire-protocol emulation of the
// mistral-vibe CLI binary, in the fleet's direct-provider pattern (cf.
// antigravity): no vibe subprocess, no ACP host. The binary talks to the
// Mistral API with the official SDK — POST {api_base}/chat/completions,
// streamed, `Authorization: Bearer <key>` as the only auth header — and
// its preset api_base (https://api.mistral.ai/v1) is exactly this repo's
// MistralChat route, so the provider reuses that protocol unchanged and
// differs from the plain `mistral` provider only in branding, model
// presets/defaults, and credential resolution: the key comes from the
// binary's own resolution (env -> ~/.vibe/.env -> OS keyring) via
// vibe-auth.ts, i.e. the credential the one-time `vibe --setup` browser
// sign-in provisions.
import type { ProviderPackage } from "../provider-package.js"
import { MistralChat } from "../protocols/mistral-chat.js"
import { Auth } from "../route/auth.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import { VibeAuth, type CredentialSources } from "./vibe-auth.js"

export const id = ProviderID.make("vibe")

export type ProviderOptionsInput = MistralChat.ProviderOptionsInput
export type OptionsInput = ProviderOptionsInput

export type Config = Omit<RouteDefaultsInput, "providerOptions"> & {
  readonly baseURL?: string
  /** Explicit auth override (tests, embedding hosts). Wins over every credential tier. */
  readonly auth?: Auth.Definition
  /** Static API key (tests/offline). Wins over env, ~/.vibe/.env, and the keyring. */
  readonly apiKey?: string
  /** Injectable credential sources (tests). */
  readonly sources?: CredentialSources
  readonly providerOptions?: ProviderOptionsInput
}

export type Settings = ProviderPackage.Settings &
  ProviderOptionsInput & {
    readonly baseURL?: string
    readonly apiKey?: string
  }

/**
 * One of Vibe's own model presets (core/config in the mistral-vibe
 * package). Only the default model's limits, costs, and request defaults
 * were verified from the binary's source (its DEFAULT_ACTIVE_MODEL_CONFIG);
 * the remaining entries are the selectable preset ids from Vibe's catalog,
 * listed so deployments can declare them in config — no defaults are
 * invented for them.
 */
export interface ModelPreset {
  readonly id: string
  readonly name: string
  readonly alias?: string
  readonly context?: number
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead?: number }
  readonly images?: boolean
  readonly defaults?: { readonly temperature?: number; readonly reasoningEffort?: string }
}

export const DEFAULT_MODEL_ID = "mistral-vibe-cli-latest"

export const MODELS: ReadonlyArray<ModelPreset> = [
  {
    id: "mistral-vibe-cli-latest",
    name: "Mistral Medium 3.5",
    alias: "mistral-medium-3.5",
    context: 262144,
    cost: { input: 1.5, output: 7.5, cacheRead: 0.15 },
    images: true,
    // The binary's active-model config: temperature 1.0 (top_p is then
    // suppressed — Mistral rejects both) and thinking "high".
    defaults: { temperature: 1.0, reasoningEffort: "high" },
  },
  { id: "mistral-medium-latest", name: "Mistral Medium" },
  { id: "mistral-large-latest", name: "Mistral Large" },
  { id: "mistral-small-latest", name: "Mistral Small" },
  { id: "codestral-latest", name: "Codestral" },
  { id: "ministral-14b-latest", name: "Ministral 14B" },
  { id: "ministral-8b-latest", name: "Ministral 8B" },
  { id: "ministral-3b-latest", name: "Ministral 3B" },
]

export const route = MistralChat.route.with({ provider: id })
export const routes = [route]

const presetFor = (modelID: string) => MODELS.find((preset) => preset.id === modelID || preset.alias === modelID)

/** The preset's request defaults sit UNDER the caller's explicit config. */
const withPresetDefaults = (input: Config, modelID: string): Config => {
  const defaults = presetFor(modelID)?.defaults
  if (!defaults) return input
  return {
    ...input,
    generation: {
      ...(defaults.temperature === undefined ? {} : { temperature: defaults.temperature }),
      ...input.generation,
    },
    providerOptions: {
      ...(defaults.reasoningEffort === undefined ? {} : { reasoningEffort: defaults.reasoningEffort }),
      ...input.providerOptions,
    },
  }
}

const configuredRoute = (input: Config) => {
  const { baseURL, auth, apiKey, sources, ...rest } = input
  return MistralChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? MistralChat.DEFAULT_BASE_URL },
    auth: VibeAuth.vibeAuth({ auth, apiKey, sources }),
  })
}

export const configure = (input: Config = {}) => {
  return {
    id,
    model: (modelID: string | ModelID) =>
      configuredRoute(withPresetDefaults(input, String(modelID))).model<ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, ProviderOptionsInput>["model"] = (
  modelID,
  { baseURL, apiKey, body, headers, ...providerOptions },
) =>
  configure({
    baseURL,
    apiKey,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  }).model(modelID)

export * as Vibe from "./vibe.js"
