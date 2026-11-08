import type { ProviderPackage } from "../provider-package.js"
import { Antigravity } from "../protocols/antigravity.js"
import { Auth } from "../route/auth.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import { AntigravityAuth } from "./antigravity-auth.js"

export const id = ProviderID.make("_antigravity")

export type ProviderOptionsInput = Antigravity.ProviderOptionsInput
export type OptionsInput = ProviderOptionsInput

export type Config = Omit<RouteDefaultsInput, "providerOptions"> & {
  readonly baseURL?: string
  /** Explicit auth override (tests, embedding hosts). Wins over the keyring. */
  readonly auth?: Auth.Definition
  /** Static access token (tests/offline). Wins over the keyring. */
  readonly accessToken?: string
  readonly providerOptions?: ProviderOptionsInput
}

export type Settings = ProviderPackage.Settings &
  ProviderOptionsInput & {
    readonly baseURL?: string
    readonly accessToken?: string
    // The deployed catalog's variants carry the OpenAI spelling; the
    // protocol accepts both, this key is forwarded as a provider option.
    readonly reasoning_effort?: string
  }

const configuredRoute = (input: Config) => {
  const { baseURL, auth, accessToken, ...rest } = input
  return Antigravity.route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? Antigravity.DEFAULT_BASE_URL },
    auth: AntigravityAuth.keyringAuth({ auth, accessToken }),
  })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model<ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings, ProviderOptionsInput>["model"] = (
  modelID,
  { baseURL, accessToken, body, headers, reasoning_effort, ...providerOptions },
) =>
  configure({
    baseURL,
    accessToken,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions: {
      ...providerOptions,
      ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
    },
  }).model(modelID)

export * as Antigravity from "./antigravity.js"
