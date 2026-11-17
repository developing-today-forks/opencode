import { Credential } from "@opencode/core/credential"
import { ConflictError, CredentialNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"

export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  handlers
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
        const credential = yield* Credential.Service
        if (ctx.payload.id && (yield* credential.get(ctx.payload.id)))
          return yield* new ConflictError({
            resource: ctx.payload.id,
            message: `Credential already exists: ${ctx.payload.id}`,
          })
        const created = yield* credential.create(ctx.payload)
        const entry = entries(yield* credential.list(created.integrationID)).find((item) => item.id === created.id)
        return { data: entry ?? { ...created, active: false } }
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
        const credential = yield* Credential.Service
        yield* requireCredential(credential, ctx.params.credentialID)
        yield* credential.remove(ctx.params.credentialID)
        return HttpApiSchema.NoContent.make()
      }),
    ),
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
    value: item.value,
  }))
}
