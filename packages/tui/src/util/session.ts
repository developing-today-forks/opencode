import type { JobInfo, ModelInfo, SessionMessageInfo } from "@opencode/client"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { Locale } from "./locale"

type SessionNode = {
  id: string
  parentID?: string | null
}

type FamilyNode<T> = { session: T; children: FamilyNode<T>[] }

// The family around `sessionID` below its root, in tree order with a connector prefix per row. Sessions that fail
// `include` stay only as ancestors of sessions that pass, so every row is drawn under its own parent.
export function sessionFamily<T extends SessionNode>(
  sessions: readonly T[],
  sessionID: string,
  include: (session: T) => boolean = () => true,
) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(sessionID)
  if (!current) return []

  const children = new Map<string, T[]>()
  sessions.forEach((session) => {
    if (!session.parentID) return
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  })

  // Parent links can form a cycle, so each walk visits a session once.
  function root(session: T, seen: Set<string>): T {
    seen.add(session.id)
    const parent = session.parentID ? byID.get(session.parentID) : undefined
    return parent && !seen.has(parent.id) ? root(parent, seen) : session
  }

  function tree(parentID: string, seen: Set<string>): FamilyNode<T>[] {
    return (children.get(parentID) ?? []).flatMap((session) => {
      if (seen.has(session.id)) return []
      seen.add(session.id)
      const nested = tree(session.id, seen)
      return include(session) || nested.length > 0 ? [{ session, children: nested }] : []
    })
  }

  function walk(nodes: FamilyNode<T>[], ancestors: boolean[]): Array<{ session: T; prefix: string }> {
    return nodes.flatMap((node, index) => {
      const last = index === nodes.length - 1
      const prefix =
        ancestors.length === 0
          ? ""
          : ancestors
              .slice(1)
              .map((ancestor) => (ancestor ? "   " : "│  "))
              .join("") + (last ? "└─ " : "├─ ")
      return [{ session: node.session, prefix }, ...walk(node.children, [...ancestors, last])]
    })
  }

  const top = root(current, new Set())
  return walk(tree(top.id, new Set([top.id])), [])
}

export function contextUsage(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  boundary?: string,
) {
  const last = lastAssistantWithUsage(messages, boundary)
  if (!last) return
  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return
  const model = models?.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)
  return {
    tokens,
    percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : undefined,
  }
}

export function formatContextUsage(tokens: number, percent?: number) {
  const value = Locale.number(tokens)
  return percent === undefined ? value : `${value} (${percent}%)`
}

// Running jobs in a session's tree. A subagent job belongs to the child it runs.
export function ownedJobs(jobs: readonly JobInfo[], sessionID: string, parentID: (id: string) => string | undefined) {
  return jobs.filter((job) => {
    const seen = new Set<string>()
    let current: string | undefined = job.kind === "subagent" ? job.childSessionID : job.sessionID
    while (current && !seen.has(current)) {
      if (current === sessionID) return true
      seen.add(current)
      // A subagent job runs in the direct child of the session that started it.
      current =
        parentID(current) ?? (job.kind === "subagent" && current === job.childSessionID ? job.sessionID : undefined)
    }
    return false
  })
}

// A script moved to the background ends its execute call with the job's id; its first line of code names it.
export function scriptLabel(messages: readonly SessionMessageInfo[], job: JobInfo) {
  const code = messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .flatMap((part) =>
      part.type === "tool" &&
      part.name === "execute" &&
      part.state.status === "completed" &&
      part.state.metadata?.jobID === job.id &&
      typeof part.state.input.code === "string"
        ? [part.state.input.code]
        : [],
    )
    .at(-1)
  const line = code
    ?.split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ?? job.title ?? "Script"
}
