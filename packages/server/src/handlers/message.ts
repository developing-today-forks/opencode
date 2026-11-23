import { SessionMessage } from "@opencode/core/session/message"
import { Session } from "@opencode/core/session"
import { Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { wantsMediaRefs } from "../media-uri"
import { InvalidCursorError } from "@opencode/protocol/errors"
import { SessionMediaMessagesResponse } from "@opencode/protocol/groups/message"
import { failedMessageDecode, missingSession } from "./session-error"

const DefaultMessagesLimit = 50

const MessageType = Schema.Literals([
  "agent-switched",
  "model-switched",
  "location-switched",
  "user",
  "synthetic",
  "system",
  "skill",
  "shell",
  "assistant",
  "compaction",
  "idle",
] satisfies ReadonlyArray<SessionMessage.Type>)

// The cursor binds the type filter it was minted under (#2501): a cursor
// followed with a different explicit type is rejected, and a cursor
// followed with no type continues the original filtered sequence, so an
// anchor minted in one filtered sequence can never page another. Cursors
// minted before the binding existed carry no type and decode with type
// undefined (an unfiltered sequence); they still cannot be retargeted to
// an explicit type.
const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
  type: Schema.optional(MessageType),
})

const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))

const cursor = {
  encode(
    message: { readonly id: SessionMessage.ID },
    order: "asc" | "desc",
    direction: "previous" | "next",
    type: SessionMessage.Type | undefined,
  ) {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction, type })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(Buffer.from(input, "base64url").toString("utf8"))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        const decoded = ctx.query.cursor
          ? (Option.getOrUndefined(cursor.decode(ctx.query.cursor)) ??
            (yield* new InvalidCursorError({ message: "Invalid cursor" })))
          : undefined
        if (decoded && ctx.query.type !== undefined && ctx.query.type !== decoded.type)
          return yield* new InvalidCursorError({
            message: "Cursor cannot be combined with a different type filter",
          })
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        const type = decoded ? decoded.type : ctx.query.type
        const input = {
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit ?? DefaultMessagesLimit,
          order,
          type,
          cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
        }
        const page = <Message extends { readonly id: SessionMessage.ID }>(messages: ReadonlyArray<Message>) => {
          const first = messages[0]
          const last = messages.at(-1)
          return {
            data: messages,
            cursor: {
              previous: first ? cursor.encode(first, order, "previous", type) : undefined,
              next: last ? cursor.encode(last, order, "next", type) : undefined,
            },
          }
        }
        if (wantsMediaRefs(ctx.request)) {
          const messages = yield* session
            .messagesWithRefs(input)
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
            )
          return yield* HttpServerResponse.schemaJson(SessionMediaMessagesResponse)(page(messages)).pipe(Effect.orDie)
        }
        const messages = yield* session
          .messages(input)
          .pipe(
            Effect.catchTag("Session.NotFoundError", missingSession),
            Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
          )
        return page(messages)
      }),
    )
  }),
)
