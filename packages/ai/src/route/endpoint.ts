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

const renderPart = <Body, Request>(part: EndpointPart<Body, Request>, input: EndpointInput<Body, Request>) =>
  typeof part === "function" ? part(input) : part

export const render = <Body, Request = LLMRequest>(
  endpoint: Definition<Body, Request>,
  input: EndpointInput<Body, Request>,
) => {
  const baseURL = trimBaseUrl(endpoint.baseURL ?? "")
  let path = renderPart(endpoint.path, input)
  // A baseURL that already ends in the path's leading version segment must
  // not render that segment twice: a provider baseURL ending in "/v1"
  // (Cloudflare's ".../anthropic/v1" passthrough, Bedrock Mantle's
  // ".../anthropic/v1", a user's ".../v1" Anthropic-compatible baseURL)
  // combined with the Anthropic Messages path "/v1/messages" posted to
  // "/v1/v1/messages" and 404'd (#1956). The version segment lives in
  // exactly one place after this de-duplication.
  if (baseURL.endsWith("/v1") && (path === "/v1" || path.startsWith("/v1/") || path.startsWith("/v1?")))
    path = path.slice("/v1".length) || "/"
  const url = new URL(`${baseURL}${path}`)
  for (const [key, value] of Object.entries(endpoint.query ?? {})) url.searchParams.set(key, value)
  return url
}

export * as Endpoint from "./endpoint.js"
