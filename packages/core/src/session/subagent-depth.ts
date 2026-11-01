export * as SubagentDepth from "./subagent-depth.js"

import { Effect, Schema } from "effect"
import { Config } from "../config.js"
import { ConfigAgentDocuments } from "../config/agent-documents.js"
import { FSUtil } from "@opencode/util/fs-util"
import type { Session } from "../session.js"
import { ModelGovernance } from "./model-governance.js"
import { SessionSchema } from "./schema.js"

export class LimitError extends Schema.TaggedError<LimitError>()("SubagentDepth.LimitError", {
  message: Schema.String,
}) {}

/**
 * Returns the depth of `parent` below its top-level session (0 for a top-level
 * session), failing when launching a subagent from it would exceed the
 * effective depth cap. Shared by the subagent tool and by commands that run as
 * subagents, so both enforce the same limit the same way.
 *
 * The cap is the smallest of the global `experimental.subagent_depth` (default
 * 5) and, for every ancestor including the launching session itself,
 * `depth(ancestor) + max_depth(ancestor's agent)` where the agent definition
 * sets one. With no `max_depth` anywhere this is exactly the global check.
 *
 * Parent links can form a cycle (corrupt or imported session data), so the
 * walk visits each session once, and the global limit is checked inside the
 * walk: either condition fails promptly instead of looping on the store forever.
 * A limit of 0 disables subagents entirely, so the check also runs for a
 * top-level session, whose depth is 0 and which has no parent to walk to.
 */
export const assertWithinLimit = Effect.fn("SubagentDepth.assertWithinLimit")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries">,
  parent: SessionSchema.Info,
  fs?: FSUtil.Interface,
) {
  const rawEntries = yield* config.entries()
  // With an FS, judge the directory-expanded entries so a Markdown-defined
  // ancestor agent's max_depth binds like a document-defined one (#1107).
  const entries = fs ? yield* ConfigAgentDocuments.expandEntries(fs, rawEntries) : rawEntries
  const limit = Config.latest(entries, "experimental")?.subagent_depth ?? 5
  const definitions = ModelGovernance.agentDefinitions(entries)
  const globalMessage = `Subagent depth limit reached (${limit}). Do this work in the current session; "experimental.subagent_depth" sets the limit.`
  const chain: SessionSchema.Info[] = [parent]
  let current = parent
  let depth = 0
  const seen = new Set([parent.id])
  if (depth >= limit) return yield* new LimitError({ message: globalMessage })
  // A fork counts as a child of its source (#505): follow the fork link when
  // there is no parent link, so depth caps above the source bind the fork.
  let governanceParentID = current.parentID ?? current.fork?.sessionID
  while (governanceParentID) {
    if (seen.has(governanceParentID))
      return yield* new LimitError({ message: `Session parent cycle: ${governanceParentID}` })
    seen.add(governanceParentID)
    depth++
    const parentID = governanceParentID
    current = yield* sessions
      .get(parentID)
      .pipe(Effect.mapError(() => new LimitError({ message: `Parent session not found: ${parentID}` })))
    chain.push(current)
    if (depth >= limit) return yield* new LimitError({ message: globalMessage })
    governanceParentID = current.parentID ?? current.fork?.sessionID
  }
  // chain[0] is the launching session at `depth`; each step up is one shallower.
  let binding: { agent: string; maxDepth: number; cap: number } | undefined
  for (const [index, ancestor] of chain.entries()) {
    if (ancestor.agent === undefined) continue
    const maxDepth = definitions.get(ancestor.agent)?.maxDepth
    if (maxDepth === undefined) continue
    const cap = depth - index + maxDepth
    if (binding === undefined || cap < binding.cap) binding = { agent: ancestor.agent, maxDepth, cap }
  }
  if (binding !== undefined && depth + 1 > binding.cap)
    return yield* new LimitError({
      message: `Subagent depth limit reached (${binding.cap}). Agent "${binding.agent}" sets "max_depth" to ${binding.maxDepth}, capping its subtree at depth ${binding.cap}. Do this work in the current session.`,
    })
  return depth
})
