import { Credential } from "@opencode/core/credential"
import { FileSystem } from "@opencode/core/filesystem"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { ConflictError, CredentialNotFoundError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { requireConnectable } from "./integration"

export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    // Credentials are global, so `integration.connect` is read from the global config Location, which carries managed
    // policy, the Console document, and user config.
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    return handlers
      .handle(
        "credential.list",
        Effect.fn(function* () {
          const credential = yield* Credential.Service
          return { data: entries(yield* credential.all()) }
        }),
      )
      .handle(
        "credential.create",
        Effect.fn(function* (ctx) {
          yield* requireConnectable(ctx.payload.integrationID).pipe(
            Effect.provide(services),
            // The global config directory always exists.
            Effect.catchIf((error) => error instanceof FileSystem.DirectoryNotFoundError, Effect.die),
          )
          const credential = yield* Credential.Service
          if (ctx.payload.id && (yield* credential.get(ctx.payload.id)))
            return yield* new ConflictError({
              resource: ctx.payload.id,
              message: `Credential already exists: ${ctx.payload.id}`,
            })
          const created = yield* credential.create(ctx.payload)
          const entry = entries(yield* credential.list(created.integrationID)).find((item) => item.id === created.id)
          return { data: entry ?? { ...created, active: false, value: Credential.redactedValue(created.value) } }
        }),
      )
      .handle(
        "credential.update",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          yield* requireCredential(credential, ctx.params.credentialID)
          yield* credential.update(ctx.params.credentialID, { label: ctx.payload.label })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.activate",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          yield* requireCredential(credential, ctx.params.credentialID)
          yield* credential.activate(ctx.params.credentialID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.remove",
        Effect.fn(function* (ctx) {
          // Removal goes through Integration so a sign-in method can revoke the credential remotely first.
          yield* requireCredential(yield* Credential.Service, ctx.params.credentialID)
          // The global config directory always exists.
          const integrations = yield* Integration.Service.pipe(Effect.provide(services), Effect.orDie)
          yield* integrations.connection.remove(ctx.params.credentialID)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

// The core service silently no-ops on a missing credential (internal
// callers rely on that), so the HTTP surface checks existence itself:
// a missing ID must answer 404, not a 204 that looks like a successful
// revoke/activate/update (#2527).
const requireCredential = Effect.fn("CredentialHandler.requireCredential")(function* (
  credential: Credential.Interface,
  credentialID: Credential.ID,
) {
  if (yield* credential.get(credentialID)) return
  return yield* new CredentialNotFoundError({
    credentialID,
    message: `Credential not found: ${credentialID}`,
  })
})

// Credential listings order each integration's selected credential last.
function entries(credentials: Credential.Info[]) {
  const selected = new Map(credentials.map((item) => [item.integrationID, item.id]))
  return credentials.map((item) => ({
    id: item.id,
    integrationID: item.integrationID,
    label: item.label,
    active: selected.get(item.integrationID) === item.id,
    value: Credential.redactedValue(item.value),
  }))
}
