export * as Session from "./session.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { Project } from "./project.js"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema.js"
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
  tokens: TokenUsage.Info,
  /** Outcome of the last completed execution, recorded at `time.idle`. Absent until a run reaches a terminal transition. */
  outcome: Schema.Literals(["succeeded", "failed", "interrupted"]).pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
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
