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
 * Shared walk behind both launch enforcement and the subagent tool's depth
 * line: visits each ancestor once (following the fork link when there is no
 * parent link, #505), failing on a parent cycle or a missing parent session,
 * and computes the session's depth plus the effective cap for its subtree.
 *
 * The effective cap is the smallest of the global
 * `experimental.subagent_depth` (default 5) and, for every ancestor including
 * the session itself, `depth(ancestor) + max_depth(ancestor's agent)` where
 * the agent definition sets one. With no `max_depth` anywhere the cap is
 * exactly the global limit.
 */
const resolve = Effect.fn("SubagentDepth.resolve")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries">,
  start: SessionSchema.Info,
  fs?: FSUtil.Interface,
) {
  const rawEntries = yield* config.entries()
  // With an FS, judge the directory-expanded entries so a Markdown-defined
  // ancestor agent's max_depth binds like a document-defined one (#1107).
  const entries = fs ? yield* ConfigAgentDocuments.expandEntries(fs, rawEntries) : rawEntries
  const limit = Config.latest(entries, "experimental")?.subagent_depth ?? 5
  const definitions = ModelGovernance.agentDefinitions(entries)
  const chain: SessionSchema.Info[] = [start]
  let current = start
  let depth = 0
  const seen = new Set([start.id])
  let parentID = current.parentID ?? current.fork?.sessionID
  while (parentID) {
    if (seen.has(parentID)) return yield* new LimitError({ message: `Session parent cycle: ${parentID}` })
    seen.add(parentID)
    depth++
    const id = parentID
    current = yield* sessions
      .get(id)
      .pipe(Effect.mapError(() => new LimitError({ message: `Parent session not found: ${id}` })))
    chain.push(current)
    parentID = current.parentID ?? current.fork?.sessionID
  }
  // chain[0] is the session itself at `depth`; each step up is one shallower.
  let binding: { agent: string; maxDepth: number; cap: number } | undefined
  for (const [index, ancestor] of chain.entries()) {
    if (ancestor.agent === undefined) continue
    const maxDepth = definitions.get(ancestor.agent)?.maxDepth
    if (maxDepth === undefined) continue
    const cap = depth - index + maxDepth
    if (binding === undefined || cap < binding.cap) binding = { agent: ancestor.agent, maxDepth, cap }
  }
  return { depth, limit, cap: binding === undefined ? limit : Math.min(limit, binding.cap), binding }
})

/**
 * Returns the depth of `parent` below its top-level session (0 for a top-level
 * session), failing when launching a subagent from it would exceed the
 * effective depth cap. Shared by the subagent tool and by commands that run as
 * subagents, so both enforce the same limit the same way.
 *
 * A limit of 0 disables subagents entirely, so the check also runs for a
 * top-level session, whose depth is 0 and which has no parent to walk to.
 */
export const assertWithinLimit = Effect.fn("SubagentDepth.assertWithinLimit")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries">,
  parent: SessionSchema.Info,
  fs?: FSUtil.Interface,
) {
  const { depth, limit, binding } = yield* resolve(sessions, config, parent, fs)
  if (depth >= limit)
    return yield* new LimitError({
      message: `Subagent depth limit reached (${limit}). Do this work in the current session; "experimental.subagent_depth" sets the limit.`,
    })
  if (binding !== undefined && depth + 1 > binding.cap)
    return yield* new LimitError({
      message: `Subagent depth limit reached (${binding.cap}). Agent "${binding.agent}" sets "max_depth" to ${binding.maxDepth}, capping its subtree at depth ${binding.cap}. Do this work in the current session.`,
    })
  return depth
})

/**
 * The depth readout behind the subagent tool description's depth line: the
 * session's depth and how many nesting levels remain under the SAME
 * effective cap `assertWithinLimit` enforces, so the line never promises
 * levels a launch would refuse. Fails with `LimitError` on a parent cycle or
 * a missing parent session; callers that render the line omit it on failure.
 */
export const readout = Effect.fn("SubagentDepth.readout")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries">,
  session: SessionSchema.Info,
  fs?: FSUtil.Interface,
) {
  const { depth, cap } = yield* resolve(sessions, config, session, fs)
  return { depth, cap, remaining: Math.max(0, cap - depth) }
})

export const formatDepthLine = (info: { depth: number; cap: number; remaining: number }) =>
  `Your session is at depth ${info.depth} of the subagent depth cap ${info.cap}: ${info.remaining} nesting level(s) remain from here.`
