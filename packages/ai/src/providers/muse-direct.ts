// Muse direct — the Muse plan's contributor seats served over
// Meta's native wire (#1825). This provider replaces the loopback
// bin/muse-proxy.mjs door: same provider id (`muse-direct`), same
// model ids, but the request now goes straight from this process to
// https://api.meta.ai/v1/responses, authenticated with the plan's
// minted inference key (see providers/muse-direct-auth.ts for the
// in-process exchange) and with the plan attestation's tool-name
// aliasing applied in the protocol (see
// protocols/muse-direct-responses.ts). No subprocess, no Muse CLI,
// no proxy hop.
//
// Id discipline: this is NOT the `meta` provider. `meta` is the one
// sanctioned door to the Meta pool for the pay-as-you-go API key;
// `muse-direct` is the plan-backed door for the contributor seats
// the fleet's routes pin deliberately. The two share Meta's Responses
// wire implementation and nothing else — different credentials,
// different routes, different provider ids.
import type { ProviderPackage } from "../provider-package.js"
import { MuseDirectResponses } from "../protocols/muse-direct-responses.js"
import { MuseDirectAuth, type CredentialSources } from "./muse-direct-auth.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Auth } from "../route/auth.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import type { OpenResponsesProviderOptionsInput } from "./open-responses-options.js"

export const id = ProviderID.make("muse-direct")
const baseURL = "https://api.meta.ai/v1"

export type ProviderOptionsInput = OpenResponsesProviderOptionsInput

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> & {
  readonly baseURL?: string
  /** An already-minted inference key, used directly (tests/offline). The live path exchanges the Muse account credential instead. */
  readonly apiKey?: string
  readonly auth?: Auth.Definition
  readonly sources?: CredentialSources
  readonly providerOptions?: ProviderOptionsInput
}

export type Settings = ProviderPackage.Settings &
  ProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

/**
 * The contributor models the fleet's Muse plan seats pin. No limits
 * or costs are invented for them; deployments declare those in
 * config.
 */
export interface ModelPreset {
  readonly id: string
  readonly name: string
}

export const DEFAULT_MODEL_ID = "muse-spark-1.3-contributor"

export const MODELS: ReadonlyArray<ModelPreset> = [
  { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
  { id: "muse-wonder-1.0-contributor", name: "Muse Wonder 1.0 Contributor" },
]

const responsesRoute = Route.make({
  id: "muse-direct-responses",
  provider: id,
  providerMetadataKey: "muse-direct",
  protocol: MuseDirectResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  // Meta Responses does not support WebSocket upgrades; always use HTTP/SSE.
  transport: MuseDirectResponses.transport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

export const routes = [responsesRoute]
export const route = responsesRoute

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey, auth, sources, baseURL: endpoint, ...defaults } = input
  const configuredResponses = responsesRoute.with({
    ...defaults,
    endpoint: { baseURL: endpoint ?? baseURL },
    auth: MuseDirectAuth.museDirectAuth({ auth, apiKey, sources }),
  })
  const responses = (modelID: string | ModelID) => configuredResponses.model<ProviderOptionsInput>({ id: modelID })
  return { id, model: responses, responses, configure }
}

export const provider = configure()
export const responses = provider.responses

export const model: ProviderPackage.Definition<Settings, ProviderOptionsInput>["model"] = (modelID, settings) =>
  fromSettings(settings).responses(modelID)

function fromSettings({ apiKey, baseURL, body, headers, ...providerOptions }: Settings) {
  return configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  })
}

export * as MuseDirect from "./muse-direct.js"
