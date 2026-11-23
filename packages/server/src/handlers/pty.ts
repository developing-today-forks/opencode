import { Pty } from "@opencode/core/pty"
import { PtyProtocol } from "@opencode/core/pty/protocol"
import { PtyTicket } from "@opencode/core/pty/ticket"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Socket } from "effect/socket"
import { Api } from "../api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { ForbiddenError, PtyNotFoundError } from "@opencode/protocol/errors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@opencode/protocol/groups/pty"
import { locationErrors, requestRef, response } from "../location"
import { holdLocation, makePtyOutbox, runPtySocket, withPtySocketTracked } from "./pty-socket"

const notFound = (ptyID: Pty.ID) => new PtyNotFoundError({ ptyID, message: `PTY session not found: ${ptyID}` })

export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig

    return handlers
      .handle(
        "pty.list",
        Effect.fn(function* () {
          const pty = yield* Pty.Service
          return yield* response(pty.list())
        }),
      )
      .handle(
        "pty.create",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          const location = yield* Location.Service
          return yield* response(
            pty.create({
              ...ctx.payload,
              cwd: ctx.payload.cwd || location.directory,
            }),
          )
        }),
      )
      .handle(
        "pty.get",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty.get(ctx.params.ptyID).pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID))),
          )
        }),
      )
      .handle(
        "pty.update",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty
              .update(ctx.params.ptyID, ctx.payload)
              .pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID))),
          )
        }),
      )
      .handle(
        "pty.remove",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          yield* pty
            .remove(ctx.params.ptyID)
            .pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID)))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
          const pty = yield* Pty.Service
          const location = yield* Location.Service
          yield* pty.get(ctx.params.ptyID).pipe(Effect.catchTag("Pty.NotFoundError", () => notFound(ctx.params.ptyID)))
          return yield* response(
            tickets.issue({
              ptyID: ctx.params.ptyID,
              directory: location.directory,
              workspaceID: location.workspaceID,
            }),
          )
        }),
      )
      .handleRaw(
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
          if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })

          const ref = LocationServiceMap.canonical(requestRef(ctx.request))
          const url = new URL(ctx.request.url, "http://localhost")
          const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
          if (
            ticket &&
            !(yield* tickets.consume({
              ticket,
              ptyID: ctx.params.ptyID,
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }))
          )
            return HttpServerResponse.empty({ status: 403 })

          return yield* Effect.gen(function* () {
            const pty = yield* Pty.Service
            const exists = yield* pty.get(ctx.params.ptyID).pipe(
              Effect.as(true),
              Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
            )
            if (!exists) return HttpServerResponse.empty({ status: 404 })
            const parsedCursor = url.searchParams.get("cursor")
            const cursorNumber = parsedCursor === null ? undefined : Number(parsedCursor)
            const cursor =
              cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
                ? cursorNumber
                : undefined

            const socket = yield* Effect.orDie(ctx.request.upgrade)
            const outbox = yield* makePtyOutbox()
            yield* holdLocation(outbox)
            // Register with the shutdown lifecycle (#2284): a graceful drain closes this socket
            // deliberately (close code 1001) instead of dropping it at process exit. The
            // registration is scoped by withPtySocketTracked to the whole attach + run section
            // (#2454): it is untracked when that section exits on every path — a successful run,
            // an attach failure outside the caught tags below, or an interruption in between —
            // so a failed connect can never leak the handle into the shutdown drain.
            yield* withPtySocketTracked(
              {
                close: () => void outbox.offer(new Socket.CloseEvent(1001, "server shutting down")),
                terminate: outbox.shutdown,
              },
              Effect.gen(function* () {
                const attachment = yield* pty
                  .attach(ctx.params.ptyID, {
                    cursor,
                    onData: (chunk) => void outbox.offer(chunk),
                    onEnd: () => void outbox.offer(new Socket.CloseEvent(1000)),
                  })
                  .pipe(
                    Effect.catchTags({
                      "Pty.NotFoundError": () =>
                        Effect.sync(() => {
                          void outbox.offer(new Socket.CloseEvent(4404, "session not found"))
                        }),
                      "Pty.ExitedError": () =>
                        Effect.sync(() => {
                          void outbox.offer(new Socket.CloseEvent(4404, "session exited"))
                        }),
                    }),
                  )
                if (attachment) {
                  for (const chunk of PtyProtocol.chunks(attachment.replay)) void outbox.offer(chunk)
                  void outbox.offer(PtyProtocol.metaFrame(attachment.cursor))
                  attachment.activate()
                }

                yield* runPtySocket({
                  socket,
                  outbox: outbox.queue,
                  onDequeued: outbox.release,
                  onOverflow: outbox.whenOverflowed,
                  onMessage: (message) =>
                    Effect.sync(() => {
                      if (!attachment) return
                      const decoded = PtyProtocol.decodeInput(message)
                      if (decoded !== undefined) attachment.write(decoded)
                    }),
                  detach: () => attachment?.detach(),
                })
              }),
            )
            return HttpServerResponse.empty()
          }).pipe(Effect.scoped, Effect.provide(locations.get(ref)), locationErrors)
        }),
      )
  }),
)
