export * as PluginSessionList from "./session-list.js"

import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/schema/project"
import { AbsolutePath, RelativePath } from "@opencode/schema/schema"
import type { Plugin } from "@opencode/plugin/effect"
import { Base64Url } from "effect/encoding"
import { Effect, Result, Schema } from "effect"
import { pageLimit } from "../util/number.js"

/** Filter fields shared by the HTTP session list query and its pagination cursor. */
export interface SessionListFilter {
  readonly search?: string | undefined
  readonly order?: "asc" | "desc" | undefined
  readonly parentID?: Session.ID | null | undefined
  readonly directory?: AbsolutePath | undefined
  readonly project?: Project.ID | undefined
  readonly subpath?: RelativePath | undefined
}

export interface DecodedSessionListCursor extends SessionListFilter {
  readonly anchor: Session.ListAnchor
}

/**
 * Page the plugin `session.list` surface returns when the plugin supplies no
 * usable limit. Mirrors the HTTP `session.list` handler
 * (`packages/server/src/handlers/session.ts`), which applies
 * `limit ?? DefaultSessionsLimit`.
 */
export const DEFAULT_SESSION_LIMIT = 50

/**
 * `Session.list` reaches the store's `limit` through `PositiveInt`, so a plugin
 * supplied limit is normalised before it gets there: a missing or non-finite
 * value becomes the default page, and zero, negative or fractional values are
 * clamped to a positive integer instead of widening the query to every session
 * (SQLite treats a negative LIMIT as unlimited) or failing it as an opaque
 * store defect. Unlike `branchListLimit` there is no upper bound — the HTTP
 * surface applies none, so a positive integer passes through unchanged.
 */
export function sessionListLimit(limit?: number): number {
  return pageLimit(limit, { default: DEFAULT_SESSION_LIMIT })
}

export type SessionListOutput = Effect.Success<ReturnType<Plugin.Context["session"]["list"]>>
export type SessionListInput = NonNullable<Parameters<Plugin.Context["session"]["list"]>[0]>
export type SessionListCursor = NonNullable<SessionListOutput["cursor"]["previous"]>

/**
 * Cursor body mirroring the HTTP `SessionsCursor` format
 * (`packages/protocol/src/groups/session.ts`): the active filter fields plus
 * the page anchor, JSON-encoded and base64url-wrapped. `null` parentIDs encode
 * as `"null"` to stay byte-compatible. Core keeps its own codec so the
 * runtime dependency direction (Schema -> Core/Protocol -> Server) stays
 * intact; `session-list.test.ts` asserts compatibility against the protocol
 * codec.
 */
const CursorBody = Schema.Struct({
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  parentID: Schema.Union([Session.ID, Schema.Literal("null"), Schema.Null]).pipe(Schema.optional),
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  anchor: Session.ListAnchor,
})

const CursorJson = Schema.fromJsonString(CursorBody)

export const decodeSessionListCursor = Effect.fn("PluginSessionList.decode")(function* (cursor: string) {
  const raw = Base64Url.decodeString(cursor)
  if (Result.isFailure(raw)) return yield* Effect.fail(new Error("Invalid session list cursor"))
  const body = yield* Schema.decodeUnknownEffect(CursorJson)(raw.success).pipe(
    Effect.mapError(() => new Error("Invalid session list cursor")),
  )
  const parentID = body.parentID === "null" ? null : body.parentID
  return {
    ...(body.order === undefined ? {} : { order: body.order }),
    ...(body.search === undefined ? {} : { search: body.search }),
    ...(parentID === undefined ? {} : { parentID }),
    ...(body.directory === undefined ? {} : { directory: body.directory }),
    ...(body.project === undefined ? {} : { project: body.project }),
    ...(body.subpath === undefined ? {} : { subpath: body.subpath }),
    anchor: body.anchor,
  } satisfies DecodedSessionListCursor
})

export function encodeSessionListCursor(filter: SessionListFilter, anchor: Session.ListAnchor): SessionListCursor {
  return Base64Url.encode(
    JSON.stringify({
      ...(filter.order === undefined ? {} : { order: filter.order }),
      ...(filter.search === undefined ? {} : { search: filter.search }),
      ...(filter.parentID === undefined ? {} : { parentID: filter.parentID ?? "null" }),
      ...(filter.directory === undefined ? {} : { directory: filter.directory }),
      ...(filter.project === undefined ? {} : { project: filter.project }),
      ...(filter.subpath === undefined ? {} : { subpath: filter.subpath }),
      anchor: { id: anchor.id, time: anchor.time, direction: anchor.direction },
    }),
  ) as SessionListCursor
}
