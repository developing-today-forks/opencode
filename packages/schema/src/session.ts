export * as Session from "./session.js"

import { Effect, Result, Schema, SchemaGetter, SchemaParser } from "effect"
import { Base64Url } from "effect/encoding"
import { Agent } from "./agent.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { Provider } from "./provider.js"
import { Project } from "./project.js"
import { AbsolutePath, DateTimeUtcFromMillis, optional, RelativePath, statics } from "./schema.js"
import { SessionEvent } from "./session-event.js"
import { SessionID } from "./session-id.js"
import { SessionMetadata } from "./session-metadata.js"
import { SessionAgentOverride, SessionSubagentPolicy } from "./session-subagent-policy.js"
import { Money } from "./money.js"
import { Permission } from "./permission.js"
import { TokenUsage } from "./token-usage.js"
import { Revert } from "./session-revert.js"
import { SessionFork } from "./session-fork.js"

export const ID = SessionID
export type ID = SessionID

export const Metadata = SessionMetadata
export type Metadata = SessionMetadata

export const SubagentPolicy = SessionSubagentPolicy
export type SubagentPolicy = SessionSubagentPolicy

export const AgentOverride = SessionAgentOverride
export type AgentOverride = SessionAgentOverride

export const Event = SessionEvent

export { Revert }
export const ForkBoundary = SessionFork.Boundary
export type ForkBoundary = SessionFork.Boundary

export interface AuthoritativeCost extends Schema.Schema.Type<typeof AuthoritativeCost> {}
/**
 * Authoritative session cost: the success-only sum over the route_attempt ledger
 * (catalog prices recorded per attempt). Unlike `cost` — the projector's fold of
 * step usage, which also counts title/compaction usage that has no route_attempt
 * row — this counts only attempts that finished successfully.
 */
export const AuthoritativeCost = Schema.Struct({
  cost: Money.USD,
  cacheSavings: Money.USD,
  tokens: TokenUsage.Info,
}).annotate({ identifier: "Session.AuthoritativeCost" })

export interface RouteUsage extends Schema.Schema.Type<typeof RouteUsage> {}
/**
 * Serving-leaf readout: the route_attempt ledger's last serving leaf for this session, in the
 * same shape the route_usage tool produces (#1891). Surfaced on the session record itself so
 * consumers that read the record (the fleet-queue claim path) can name the leaf that actually
 * served, instead of the declared route alias. Present only when the session has a recorded
 * attempt; `Info.route_usage` stays absent — never null or partial — until then (#2696).
 */
export const RouteUsage = Schema.Struct({
  lastServing: Schema.Struct({
    leaf: Schema.String,
    providerID: Provider.ID,
    modelID: Model.ID,
    variant: Schema.NullOr(Model.VariantID),
    routeID: Schema.String,
    outcome: Schema.String,
    attemptedLeaf: Schema.String,
    failedOver: Schema.Boolean,
    failedOverTo: Schema.NullOr(Schema.String),
    hedged: Schema.Boolean,
    timeStarted: Schema.Finite,
  }),
}).annotate({ identifier: "Session.RouteUsage" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  fork: Schema.Struct({
    sessionID: ID,
    boundary: ForkBoundary,
  }).pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Money.USD,
  /** Success-only route_attempt totals (#7); absent until the session has a successful attempt. */
  costAuthoritative: AuthoritativeCost.pipe(optional),
  /** Serving-leaf readout (#2696); absent until the session has a recorded route attempt. */
  route_usage: RouteUsage.pipe(optional),
  tokens: TokenUsage.Info,
  /** Outcome of the last completed execution, recorded at `time.idle`. Absent until a run reaches a terminal transition. */
  outcome: Schema.Literals(["succeeded", "failed", "interrupted"]).pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    /** Start of the most recent execution. While it runs, `idle` still holds the previous execution's end. Resuming after a restart starts a new execution. */
    busy: DateTimeUtcFromMillis.pipe(optional),
    /** End of the most recent completed execution. */
    idle: DateTimeUtcFromMillis.pipe(optional),
    viewed: DateTimeUtcFromMillis.pipe(optional),
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String.pipe(optional),
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  metadata: Metadata.pipe(optional),
  /** Models this session's descendants may run; replaced wholesale by `session.subagent-policy.updated`. */
  subagentPolicy: SubagentPolicy.pipe(optional),
  /** Evaluated after the agent's rules; the last matching rule wins. */
  permissions: Permission.Ruleset.pipe(optional),
  /**
   * Detached (non-interactive) mode: nobody is attached to answer forms, so the `question` tool is
   * unavailable to this session and, by inheritance, to every session in its subtree. Absent means
   * interactive. Not clearable once set.
   */
  detached: Schema.Literal(true).pipe(optional),
  revert: Revert.pipe(optional),
}).annotate({ identifier: "Session.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}

// These fields are also the session.list HTTP query parameters. Raw Schema.optional keeps that
// endpoint's OpenAPI parameters unchanged.
const ListFilterFields = {
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.String.pipe(Schema.optional),
  parentID: Schema.Union([
    ID,
    Schema.Null.pipe(
      Schema.encodeTo(Schema.Literal("null"), {
        decode: SchemaGetter.transform(() => null),
        encode: SchemaGetter.transform(() => "null" as const),
      }),
    ),
  ])
    .annotate({ description: "Filter by parent session. Use null to return only root sessions." })
    .pipe(Schema.optional),
  archived: Schema.Literals(["true", "false"])
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transform((value) => value === "true"),
        encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
      }),
    )
    .annotate({
      description:
        "Filter by archive state. Use true to return only archived sessions or false to exclude them. Omit to include both.",
    })
    .pipe(Schema.optional),
}

export const ListFilter = Schema.Struct({
  ...ListFilterFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
}).annotate({ identifier: "Session.ListFilter" })
export interface ListFilter extends Schema.Schema.Type<typeof ListFilter> {}

const ListCursorInput = Schema.Union([
  Schema.Struct({ ...ListFilterFields, directory: AbsolutePath, anchor: ListAnchor }),
  Schema.Struct({
    ...ListFilterFields,
    project: Project.ID,
    subpath: RelativePath.pipe(Schema.optional),
    anchor: ListAnchor,
  }),
  Schema.Struct({ ...ListFilterFields, anchor: ListAnchor }),
])
const ListCursorJson = Schema.fromJsonString(ListCursorInput)
const encodeListCursor = Schema.encodeSync(ListCursorJson)
const decodeListCursor = Schema.decodeUnknownEffect(ListCursorJson)

export const ListCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  Schema.annotate({
    identifier: "SessionsCursor",
    description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
  }),
  statics((schema) => {
    // Read the default constructor without caching it on the schema, so `make` can be replaced.
    const make = SchemaParser.make(schema)
    return {
      make: (input: typeof ListCursorInput.Type) => make(Base64Url.encode(encodeListCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Base64Url.decodeString(input)
          return Result.isFailure(result)
            ? Effect.fail("Invalid cursor" as const)
            : decodeListCursor(result.success).pipe(Effect.mapError(() => "Invalid cursor" as const))
        }),
    }
  }),
)
export type ListCursor = typeof ListCursor.Type
