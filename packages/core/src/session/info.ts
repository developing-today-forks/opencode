import { DateTime, Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath, RelativePath } from "../schema.js"
import { SessionSchema } from "./schema.js"
import type { SessionTable } from "./sql.js"
import { PersistedRevert } from "@opencode/schema/session-revert"
import { Money } from "@opencode/schema/money"
import type { ModelUsage } from "../model-usage.js"

const decodeRevert = Schema.decodeUnknownOption(PersistedRevert)

/**
 * A stored revert value decoded to Revert, or undefined when it matches neither persisted shape. A
 * truncated write, a hand-edited DB, or a future shape makes the strict decoder throw ParseError, and
 * fromRow runs synchronously inside SessionStore.get/list, so one non-conforming row would brick every
 * read of the session (opencode#2893). An undecodable revert reads as absent instead, mirroring the
 * timestamp `representable` fallback below.
 */
const representableRevert = (value: unknown) => Option.getOrUndefined(decodeRevert(value))

export type AuthoritativeUsage = {
  readonly costUsd: number
  readonly cacheSavedUsd: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** The largest epoch-millisecond magnitude a JavaScript Date can hold (ECMA-262 time value range). */
const maxEpochMillis = 8_640_000_000_000_000

/**
 * A stored epoch-millisecond column as a DateTime, or undefined when the value can't be one. Legacy or
 * corrupt rows can hold a non-integer or out-of-range number (written before boundary validation), and
 * DateTime.makeUnsafe throws on those, which would brick every read of the session (opencode#2820, #2870).
 */
const representable = (millis: number | null) =>
  millis === null || !Number.isInteger(millis) || Math.abs(millis) > maxEpochMillis
    ? undefined
    : DateTime.makeUnsafe(millis)

/**
 * A required timestamp: its own value when representable, else its sibling's (created and updated stand in
 * for each other), else the epoch, so a session with a corrupt row still reads and sorts as oldest.
 */
const required = (own: DateTime.Utc | undefined, sibling: DateTime.Utc | undefined) =>
  own ?? sibling ?? DateTime.makeUnsafe(0)

export function fromRow(
  row: typeof SessionTable.$inferSelect,
  authoritative?: AuthoritativeUsage,
  serving?: ModelUsage.LastServing | null,
): SessionSchema.Info {
  const created = representable(row.time_created)
  const updated = representable(row.time_updated)
  return SessionSchema.Info.make({
    id: row.id,
    projectID: row.project_id,
    title: row.title ?? undefined,
    parentID: row.parent_id ?? undefined,
    fork:
      row.fork_session_id && row.fork_boundary
        ? {
            sessionID: row.fork_session_id,
            boundary: row.fork_boundary,
          }
        : undefined,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: Model.ID.make(row.model.id),
          providerID: Provider.ID.make(row.model.providerID),
          variant: Model.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    cost: Money.USD.make(row.cost),
    costAuthoritative: authoritative
      ? {
          cost: Money.USD.make(authoritative.costUsd),
          cacheSavings: Money.USD.make(authoritative.cacheSavedUsd),
          tokens: {
            input: authoritative.input,
            output: authoritative.output,
            reasoning: authoritative.reasoning,
            cache: { read: authoritative.cacheRead, write: authoritative.cacheWrite },
          },
        }
      : undefined,
    route_usage: serving
      ? {
          lastServing: {
            leaf: serving.leaf,
            providerID: Provider.ID.make(serving.providerID),
            modelID: Model.ID.make(serving.modelID),
            variant: serving.variant === null ? null : Model.VariantID.make(serving.variant),
            routeID: serving.routeID,
            outcome: serving.outcome,
            attemptedLeaf: serving.attemptedLeaf,
            failedOver: serving.failedOver,
            failedOverTo: serving.failedOverTo,
            hedged: serving.hedged,
            timeStarted: serving.timeStarted,
          },
        }
      : undefined,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: {
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ?? undefined,
    },
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    metadata: row.metadata ?? undefined,
    subagentPolicy: row.subagent_policy ?? undefined,
    permissions: row.permission ?? undefined,
    detached: row.detached ? true : undefined,
    revert: row.revert ? representableRevert(row.revert) : undefined,
    outcome: row.idle_outcome ?? undefined,
    time: {
      created: required(created, updated),
      updated: required(updated, created),
      busy: representable(row.time_busy),
      idle: representable(row.time_idle),
      viewed: representable(row.time_viewed),
      archived: representable(row.time_archived),
    },
  })
}
