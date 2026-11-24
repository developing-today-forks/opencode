import { Credential } from "@opencode/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, CredentialNotFoundError, InvalidRequestError, ProviderNotFoundError } from "../errors.js"

const QuotaWindow = Schema.Struct({
  usedPercent: Schema.NullOr(Schema.Number),
  remainingPercent: Schema.NullOr(Schema.Number),
  windowSeconds: Schema.NullOr(Schema.Number),
  resetAfterSeconds: Schema.NullOr(Schema.Number),
  resetAt: Schema.NullOr(Schema.Number),
  resetAtFormatted: Schema.NullOr(Schema.String),
  resetAfterFormatted: Schema.NullOr(Schema.String),
  valueLabel: Schema.optional(Schema.String),
})

/** A provider's quota answer. Only these fields are published; the credential that produced it never is. */
const ProviderQuota = Schema.Struct({
  providerId: Schema.String,
  providerName: Schema.String,
  ok: Schema.Boolean,
  configured: Schema.Boolean,
  usage: Schema.NullOr(Schema.Struct({ windows: Schema.Record(Schema.String, QuotaWindow) })),
  fetchedAt: Schema.Number,
  error: Schema.optional(Schema.String),
})

export const CredentialGroup = HttpApiGroup.make("server.credential")
  .add(
    HttpApiEndpoint.get("credential.list", "/api/credential", {
      success: Schema.Struct({ data: Schema.Array(Credential.Entry) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.list",
        summary: "List credentials",
        description:
          "List every stored integration credential, including its secret value. Session-cookie credentials are provider-only: listings return their metadata with the cookie redacted.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("credential.create", "/api/credential", {
      payload: Credential.CreateInput,
      success: Schema.Struct({ data: Credential.Entry }),
      error: [ConflictError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.create",
        summary: "Create credential",
        description:
          "Store an integration credential. It becomes the integration's active credential unless activate is false and the integration already has one. Fails with a conflict when the requested ID already exists, and with an invalid request when an `integration.connect` policy denies the integration.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("credential.update", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: CredentialNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.update",
        summary: "Update credential",
        description: "Update a stored credential label.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("credential.providerQuota", "/api/experimental/credential/provider/:providerID/quota", {
      params: { providerID: Schema.String },
      success: Schema.Struct({ data: ProviderQuota }),
      error: ProviderNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.credential.providerQuota",
        summary: "Get provider quota from its session cookie",
        description:
          "Experimental: may change without compatibility guarantees. Answer a provider's quota with the session-cookie credential the server holds for it. The cookie is used by the server and never returned; the response carries only the quota result.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "credential" }))
  .add(
    HttpApiEndpoint.post("credential.activate", "/api/credential/:credentialID/activate", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
      error: CredentialNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.activate",
        summary: "Activate credential",
        description: "Activate a stored integration credential.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("credential.remove", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
      error: CredentialNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.remove",
        summary: "Remove credential",
        description: "Remove a stored integration credential.",
      }),
    ),
  )
