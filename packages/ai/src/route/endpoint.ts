import type { LLMRequest } from "../schema/index.js"

export interface EndpointInput<Body, Request = LLMRequest> {
  readonly request: Request
  readonly body: Body
}

export type EndpointPart<Body, Request = LLMRequest> = string | ((input: EndpointInput<Body, Request>) => string)

/**
 * Declarative URL construction for one route.
 *
 * `Endpoint` carries URL construction for one route. Routes with a canonical
 * host put `baseURL` here; provider helpers can override it by configuring the
 * route before selecting a model.
 *
 * `path` may be a string or a function of `EndpointInput`, for routes whose
 * URL embeds the model id, region, or another body field (e.g. Bedrock,
 * Gemini). Media routes reuse the same shape with their own request type.
 */
export interface Definition<Body, Request = LLMRequest> {
  readonly baseURL?: string
  readonly path: EndpointPart<Body, Request>
  readonly query?: Record<string, string>
}

export type EndpointPatch<Body, Request = LLMRequest> = Partial<Definition<Body, Request>>

/** Construct an `Endpoint` from a path string or path function. */
export const path = <Body, Request = LLMRequest>(
  value: EndpointPart<Body, Request>,
  options: Omit<Definition<Body, Request>, "path"> = {},
): Definition<Body, Request> => ({
  ...options,
  path: value,
})

export const merge = <Body, Request = LLMRequest>(
  base: Definition<Body, Request>,
  patch: EndpointPatch<Body, Request>,
): Definition<Body, Request> => ({
  ...base,
  ...patch,
  baseURL: patch.baseURL ?? base.baseURL,
  path: patch.path ?? base.path,
  query: patch.query === undefined ? base.query : { ...base.query, ...patch.query },
})

export const trimBaseUrl = (value: string) => value.replace(/\/+$/, "")

// The path's leading API version segment ("/v1", "/v2", "/v2beta"), if any.
const versionPath = /^\/v\d+[a-zA-Z0-9._-]*(?=\/|$|\?)/

const renderPart = <Body, Request>(part: EndpointPart<Body, Request>, input: EndpointInput<Body, Request>) =>
  typeof part === "function" ? part(input) : part

/**
 * The version segment may live in the baseURL or in the route path, never both. The media protocols are split on this
 * (OpenAI and Google put it in the baseURL; Deepgram, ElevenLabs and AssemblyAI put it in the path), so a baseURL
 * ending in the path's leading version segment would otherwise render a doubled segment and 404 (#1956, #1959).
 */
const trimVersionPath = (baseURL: string, path: string) => {
  const version = versionPath.exec(path)?.[0]
  if (version === undefined || baseURL === "" || !baseURL.endsWith(version)) return path
  return path.slice(version.length) || "/"
}

/** Compose a baseURL and a route path with the version segment de-duplicated; the single URL builder for every route. */
export const renderURL = (baseURL: string, path: string) => {
  const base = trimBaseUrl(baseURL)
  return new URL(`${base}${trimVersionPath(base, path)}`)
}

export const render = <Body, Request = LLMRequest>(
  endpoint: Definition<Body, Request>,
  input: EndpointInput<Body, Request>,
) => {
  const url = renderURL(endpoint.baseURL ?? "", renderPart(endpoint.path, input))
  for (const [key, value] of Object.entries(endpoint.query ?? {})) url.searchParams.set(key, value)
  return url
}

export * as Endpoint from "./endpoint.js"
