import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ProviderNotFoundError, ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

/**
 * Provider info as served over HTTP: the provider metadata plus its resolved
 * model catalog. Model definitions stay out of the core Provider.Info schema
 * (model.ts already depends on provider.ts), so the HTTP shape is composed
 * here where both schemas are available. API consumers doing model discovery
 * through /api/provider need the models embedded per provider (#560).
 */
export const InfoWithModels = Schema.Struct({
  ...Provider.Info.fields,
  models: Schema.Array(Model.Info),
}).annotate({ identifier: "Provider.InfoWithModels" })
export type InfoWithModels = typeof InfoWithModels.Type

export const ProviderGroup = HttpApiGroup.make("server.provider")
  .add(
    HttpApiEndpoint.get("provider.list", "/api/provider", {
      query: LocationQuery,
      success: Location.response(Schema.Array(InfoWithModels)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.list",
          summary: "List providers",
          description:
            "Retrieve active AI providers, each with its resolved models, so clients can show provider availability and configuration and discover models per provider.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.get", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(InfoWithModels),
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.get",
          summary: "Get provider",
          description:
            "Retrieve a single AI provider with its resolved models so clients can inspect its availability, endpoint settings, and model catalog.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "provider",
      description: "Experimental provider routes.",
    }),
  )
