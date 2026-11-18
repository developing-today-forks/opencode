import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk"
import type { OpenCodeEvent } from "@opencode/client/effect"
import type { Form } from "@opencode/schema/form"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import type { SessionError } from "@opencode/schema/session-error"
import type { SessionMessage } from "@opencode/schema/session-message"
import { TokenUsage } from "@opencode/schema/token-usage"
import { ACPChild } from "./child"
import { ACPCompaction } from "./compaction"
import { ACPError } from "./error"
import {
  completedToolUpdate,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  type DiffSource,
  type ToolInput,
} from "./tool"

const RetryMeta = "opencode/retry"

export type TurnStart = { readonly type: "input" | "compaction"; readonly id: SessionMessage.ID }

export type Terminal = "succeeded" | "failed" | "interrupted"

export type TurnContext = {
  readonly sessionID: Session.ID
  readonly cwd: string
<<<<<<< HEAD
  /** Absent for a follower that starts without a prompt, such as after `session/load`. */
=======
>>>>>>> upstream-anomalyco/dev
  readonly start?: TurnStart
  readonly childUpdates: boolean
  readonly compaction: boolean
}

type Tool = {
  readonly sessionID: string
  readonly id: string
  readonly name: string
  readonly input: ToolInput
  readonly metadata: Record<string, unknown>
}

type RetryStatus = {
  readonly attempt: number
  readonly nextRetryAt: string
  readonly error: SessionError.Error
}

type Child = ACPChild.Session & { readonly turnID?: string }

export type TurnState = {
  readonly started: boolean
  readonly tools: ReadonlyMap<string, Tool>
  readonly retries: ReadonlyMap<string, RetryStatus>
  readonly compactions: ACPCompaction.Tracked
<<<<<<< HEAD
  readonly children: ReadonlyMap<string, ACPChild.Session>
=======
  readonly children: ReadonlyMap<string, Child>
  readonly openChildren: ReadonlySet<string>
>>>>>>> upstream-anomalyco/dev
  readonly asks: ReadonlySet<string>
  /** Every ask this subscription saw settled, so a list read before the settlement cannot ask it again. */
  readonly settled: ReadonlySet<string>
  readonly finish?: SessionMessage.Assistant["finish"]
  readonly usage?: { readonly turn: TokenUsage.Info; readonly last: TokenUsage.Info }
  readonly stepError?: SessionError.Error
  readonly executionError?: { readonly type: string; readonly message: string }
}

type CreatedEvent = Extract<OpenCodeEvent, { type: "session.created" }>

export type Output =
  | { readonly _tag: "SessionUpdate"; readonly update: SessionUpdate; readonly diff?: DiffSource }
  | { readonly _tag: "ChildUpdate"; readonly update: ACPChild.Update; readonly diff?: DiffSource }
  | {
      readonly _tag: "PermissionAsk"
      readonly request: Permission.Request
      readonly tool?: Tool
      readonly child?: Child
    }
<<<<<<< HEAD
  | { readonly _tag: "FormAsk"; readonly form: Form.Info; readonly child?: ACPChild.Session }
=======
  | { readonly _tag: "FormAsk"; readonly form: FormEvent["data"]["form"]; readonly child?: Child }
>>>>>>> upstream-anomalyco/dev
  | { readonly _tag: "AskSettled"; readonly id: string }

export type Folded = {
  readonly state: TurnState
  readonly outputs: ReadonlyArray<Output>
  readonly terminal?: Terminal
}

export const initial: TurnState = {
  started: false,
  tools: new Map(),
  retries: new Map(),
  compactions: new Map(),
  children: new Map(),
  asks: new Set(),
  settled: new Set(),
}

export function fold(state: TurnState, event: OpenCodeEvent, ctx: TurnContext): Folded {
  if (event.type === "session.created") return childCreated(state, event, ctx)
  if (event.type === "permission.asked") return permissionAsk(state, ctx, event.data)
  if (event.type === "form.created") return formAsk(state, ctx, event.data.form)

  const sessionID = sessionIDFromEvent(event)
  const child = sessionID ? state.children.get(sessionID) : undefined
<<<<<<< HEAD
=======
  const openChild = child && state.openChildren.has(child.id) ? child : undefined

  if (event.type === "permission.asked" && (event.data.sessionID === ctx.sessionID || openChild)) {
    const tool = event.data.source?.id
      ? state.tools.get(toolKey(event.data.sessionID, event.data.source.id))
      : undefined
    return {
      state: { ...state, asks: new Set(state.asks).add(event.data.id) },
      outputs: [{ _tag: "PermissionAsk", event, tool, child: openChild }],
    }
  }
  if (event.type === "form.created" && (event.data.form.sessionID === ctx.sessionID || openChild)) {
    return {
      state: { ...state, asks: new Set(state.asks).add(event.data.form.id) },
      outputs: [{ _tag: "FormAsk", form: event.data.form, child: openChild }],
    }
  }
>>>>>>> upstream-anomalyco/dev
  const settledID =
    event.type === "permission.replied"
      ? event.data.requestID
      : event.type === "form.replied" || event.type === "form.cancelled"
        ? event.data.id
        : undefined
  if (settledID) {
    const settled = new Set(state.settled).add(settledID)
    if (!state.asks.has(settledID)) return { state: { ...state, settled }, outputs: [] }
    const asks = new Set(state.asks)
    asks.delete(settledID)
    return { state: { ...state, asks, settled }, outputs: [{ _tag: "AskSettled", id: settledID }] }
  }
  if (!sessionID || (sessionID !== ctx.sessionID && !child)) return { state, outputs: [] }
<<<<<<< HEAD
  if (event.type === "session.inbox.delivered" && event.data.inboxID === ctx.start?.id)
=======
  if (
    sessionID === ctx.sessionID &&
    event.type === "session.inbox.delivered" &&
    (!ctx.start || event.data.inboxID === ctx.start.id)
  )
>>>>>>> upstream-anomalyco/dev
    return { state: { ...state, started: true }, outputs: [] }
  if (!child && !state.started) return { state, outputs: [] }
  return child ? childEvent(state, event, ctx, child) : rootEvent(state, event, ctx)
}

<<<<<<< HEAD
/** Asks already pending when the subscription started, asked as if their events had just arrived. */
export function pending(
  state: TurnState,
  ctx: TurnContext,
  input: { readonly permissions: ReadonlyArray<Permission.Request>; readonly forms: ReadonlyArray<Form.Info> },
): Folded {
  return [
    ...input.permissions.map((request) => ({ request })),
    ...input.forms.map((form) => ({ form })),
  ].reduce<Folded>(
    (folded, item) => {
      const next =
        "request" in item ? permissionAsk(folded.state, ctx, item.request) : formAsk(folded.state, ctx, item.form)
      return { state: next.state, outputs: [...folded.outputs, ...next.outputs] }
    },
    { state, outputs: [] },
  )
}

/** The session that places an event in the tree: a new session's parent, otherwise the event's own session. */
export function placedBy(event: OpenCodeEvent) {
  return event.type === "session.created" ? event.data.parentID : sessionIDFromEvent(event)
}

/** Whether the event comes from the prompt's session or a session tracked below it. */
export function inTree(state: TurnState, event: OpenCodeEvent, ctx: TurnContext) {
  const sessionID = placedBy(event)
  return sessionID !== undefined && (sessionID === ctx.sessionID || state.children.has(sessionID))
}

/** Tracks descendants found by walking up from a session this subscription never saw created. */
export function adopt(state: TurnState, sessions: ReadonlyArray<ACPChild.Session>): TurnState {
  const added = sessions.filter((session) => !state.children.has(session.id))
  if (added.length === 0) return state
  return { ...state, children: new Map([...state.children, ...added.map((session) => [session.id, session] as const)]) }
=======
export function projectChild(ctx: TurnContext, child: Child) {
  return !ctx.childUpdates && ctx.start !== undefined && child.turnID === ctx.start.id
>>>>>>> upstream-anomalyco/dev
}

export function failure(state: TurnState) {
  const error = state.stepError ?? state.executionError
  if (error?.type === "provider.auth") return new ACPError.AuthRequiredError()
  if (error && error.type !== "aborted" && error.type !== "provider.content-filter") {
    return new ACPError.ServiceFailureError({
      safeMessage: error.message || "OpenCode prompt failed",
      service: "session",
      errorName: error.type,
    })
  }
  return undefined
}

export function response(state: TurnState, sessionID: string, terminal: Terminal): PromptResponse {
  const tokens = state.usage?.turn
  const usage = tokens
    ? {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        totalTokens: TokenUsage.total(tokens),
        ...(tokens.reasoning > 0 ? { thoughtTokens: tokens.reasoning } : {}),
        ...(tokens.cache.read > 0 ? { cachedReadTokens: tokens.cache.read } : {}),
        ...(tokens.cache.write > 0 ? { cachedWriteTokens: tokens.cache.write } : {}),
      }
    : undefined
  const error = (state.stepError ?? state.executionError)?.type
  const stopReason = resolveStopReason({ terminal, finish: state.finish, error })
  // Interruption clears the projected retry, so a retry pending at interrupt is reported here.
  const retry = state.retries.get(sessionID)
  return { stopReason, ...(usage ? { usage } : {}), _meta: retry ? { [RetryMeta]: retry } : {} }
}

// Child compactions are left to the background consumer.
export function abandon(state: TurnState, ctx: TurnContext): Folded {
  const compaction = state.compactions.get(ctx.sessionID)
  return {
    state: { ...state, tools: new Map(), compactions: without(state.compactions, ctx.sessionID) },
    outputs: [
      ...[...state.tools.values()].flatMap((tool) =>
        route(ctx, state.children.get(tool.sessionID), {
          sessionUpdate: "tool_call_update",
          ...errorToolUpdate({
            toolCallId: tool.id,
            toolName: tool.name,
            input: tool.input,
            metadata: tool.metadata,
            content: [],
            error: "Cancelled",
            cwd: ctx.cwd,
          }),
        }),
      ),
      ...(compaction
        ? route(ctx, undefined, ACPCompaction.abandon(compaction, ACPCompaction.usesStandardUpdates(ctx, false)))
        : []),
    ],
  }
}

export function reasoningMessageID(messageID: string, ordinal: number) {
  return `${messageID}:reasoning:${ordinal}`
}

function childCreated(state: TurnState, event: CreatedEvent, ctx: TurnContext): Folded {
  const parentID = event.data.parentID
  if (!parentID) return { state, outputs: [] }
  const parent = parentID === ctx.sessionID ? undefined : state.children.get(parentID)
  if (!parent && parentID !== ctx.sessionID) return { state, outputs: [] }
  const child: Child = {
    id: event.data.sessionID,
    parentID,
    depth: parent ? parent.depth + 1 : 1,
    title: event.data.title,
    turnID: parent ? parent.turnID : ctx.start?.id,
  }
  return {
    state: { ...state, children: new Map(state.children).set(child.id, child) },
    outputs: childStatus(ctx, child, { type: "status", status: "created" }),
  }
}

// An ask can arrive twice, once listed as pending and once as its event, so each is asked once.
function permissionAsk(state: TurnState, ctx: TurnContext, request: Permission.Request): Folded {
  const child = state.children.get(request.sessionID)
  if (state.asks.has(request.id) || state.settled.has(request.id) || (request.sessionID !== ctx.sessionID && !child))
    return { state, outputs: [] }
  const tool = request.source ? state.tools.get(toolKey(request.sessionID, request.source.id)) : undefined
  return {
    state: { ...state, asks: new Set(state.asks).add(request.id) },
    outputs: [{ _tag: "PermissionAsk", request, tool, child }],
  }
}

function formAsk(state: TurnState, ctx: TurnContext, form: Form.Info): Folded {
  const child = state.children.get(form.sessionID)
  if (state.asks.has(form.id) || state.settled.has(form.id) || (form.sessionID !== ctx.sessionID && !child))
    return { state, outputs: [] }
  return {
    state: { ...state, asks: new Set(state.asks).add(form.id) },
    outputs: [{ _tag: "FormAsk", form, child }],
  }
}

function rootEvent(state: TurnState, event: OpenCodeEvent, ctx: TurnContext): Folded {
  switch (event.type) {
    case "session.step.started":
      return sessionEvent({ ...state, stepError: undefined }, event, ctx, undefined)
    case "session.step.ended":
      return { state: { ...recordStep(state, event.data.tokens), finish: event.data.finish }, outputs: [] }
    case "session.step.failed": {
      const recorded = event.data.tokens ? recordStep(state, event.data.tokens) : state
      return { state: { ...recorded, stepError: event.data.error }, outputs: [] }
    }
    case "session.execution.succeeded":
      return { state: { ...state, started: Boolean(ctx.start) }, outputs: [], terminal: "succeeded" }
    case "session.execution.interrupted":
      return { state: { ...state, started: Boolean(ctx.start) }, outputs: [], terminal: "interrupted" }
    case "session.execution.failed":
      return {
        state: { ...state, started: Boolean(ctx.start), executionError: event.data.error },
        outputs: [],
        terminal: "failed",
      }
    default:
      return sessionEvent(state, event, ctx, undefined)
  }
}

function childEvent(state: TurnState, event: OpenCodeEvent, ctx: TurnContext, child: Child): Folded {
  switch (event.type) {
    case "session.execution.started":
      return {
        state: { ...state, openChildren: new Set(state.openChildren).add(child.id) },
        outputs: childStatus(ctx, child, { type: "status", status: "running" }),
      }
    case "session.execution.succeeded":
      return { state, outputs: childStatus(ctx, child, { type: "status", status: "completed" }) }
    case "session.execution.interrupted":
      return { state, outputs: childStatus(ctx, child, { type: "status", status: "interrupted" }) }
    case "session.execution.failed":
      return {
        state,
        outputs: childStatus(ctx, child, { type: "status", status: "failed", error: event.data.error }),
      }
    default:
      return sessionEvent(state, event, ctx, child)
  }
}

function sessionEvent(state: TurnState, event: OpenCodeEvent, ctx: TurnContext, child: Child | undefined): Folded {
  const sessionID = child?.id ?? ctx.sessionID
  const send = (update: SessionUpdate) => route(ctx, child, update)
  switch (event.type) {
    case "session.step.started":
      if (!state.retries.has(sessionID)) return { state, outputs: [] }
      return {
        state: { ...state, retries: without(state.retries, sessionID) },
        outputs: send({ sessionUpdate: "session_info_update", _meta: { [RetryMeta]: null } }),
      }
    case "session.retry.scheduled": {
      const retry = {
        attempt: event.data.attempt,
        nextRetryAt: new Date(event.data.at).toISOString(),
        error: event.data.error,
      }
      return {
        state: { ...state, retries: new Map(state.retries).set(sessionID, retry) },
        outputs: send({ sessionUpdate: "session_info_update", _meta: { [RetryMeta]: retry } }),
      }
    }
    case "session.compaction.started":
    case "session.compaction.ended":
    case "session.compaction.failed": {
      const applied = ACPCompaction.apply(
        event,
        state.compactions,
        ACPCompaction.usesStandardUpdates(ctx, child !== undefined),
      )
      return { state: { ...state, compactions: applied.tracked }, outputs: applied.updates.flatMap(send) }
    }
    case "session.compaction.delta": {
      const update = ACPCompaction.chunk(
        state.compactions.get(sessionID),
        event.data.text,
        ACPCompaction.usesStandardUpdates(ctx, child !== undefined),
      )
      return { state, outputs: update ? send(update) : [] }
    }
    case "session.text.delta":
      return {
        state,
        outputs: send({
          sessionUpdate: "agent_message_chunk",
          messageId: event.data.assistantMessageID,
          content: { type: "text", text: event.data.delta },
        }),
      }
    case "session.reasoning.delta":
      return {
        state,
        outputs: send({
          sessionUpdate: "agent_thought_chunk",
          messageId: reasoningMessageID(event.data.assistantMessageID, event.data.ordinal),
          content: { type: "text", text: event.data.delta },
        }),
      }
    case "session.tool.input.started":
      return {
        state: {
          ...state,
          tools: new Map(state.tools).set(
            toolKey(event.data.sessionID, event.data.id),
            newTool(event.data.sessionID, event.data.id, event.data.name),
          ),
        },
        outputs: send({
          sessionUpdate: "tool_call",
          ...pendingToolCall({
            toolCallId: event.data.id,
            toolName: event.data.name,
            state: { input: {} },
            cwd: ctx.cwd,
          }),
        }),
      }
    case "session.tool.called": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const tool = {
        ...(state.tools.get(key) ?? newTool(event.data.sessionID, event.data.id)),
        input: event.data.input,
      }
      return {
        state: { ...state, tools: new Map(state.tools).set(key, tool) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...runningToolUpdate({
            toolCallId: event.data.id,
            toolName: tool.name,
            state: { input: tool.input },
            cwd: ctx.cwd,
          }),
        }),
      }
    }
    case "session.tool.progress": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const current = state.tools.get(key)
      if (!current) return { state, outputs: [] }
      return {
        state: { ...state, tools: new Map(state.tools).set(key, { ...current, metadata: event.data.metadata }) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...runningToolUpdate({
            toolCallId: event.data.id,
            toolName: current.name,
            state: { input: current.input },
            cwd: ctx.cwd,
          }),
        }),
      }
    }
    case "session.tool.success": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const tool = state.tools.get(key) ?? newTool(event.data.sessionID, event.data.id)
      return {
        state: { ...state, tools: without(state.tools, key) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...completedToolUpdate({
            toolCallId: event.data.id,
            toolName: tool.name,
            input: tool.input,
            metadata: event.data.metadata,
            content: event.data.content,
            cwd: ctx.cwd,
          }),
        }).map((output) => ({
          ...output,
          diff: { toolName: tool.name, input: tool.input, metadata: event.data.metadata },
        })),
      }
    }
    case "session.tool.failed": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const tool = state.tools.get(key) ?? newTool(event.data.sessionID, event.data.id)
      return {
        state: { ...state, tools: without(state.tools, key) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...errorToolUpdate({
            toolCallId: event.data.id,
            toolName: tool.name,
            input: tool.input,
            metadata: event.data.metadata ?? tool.metadata,
            content: event.data.content ?? [],
            error: event.data.error.message,
            cwd: ctx.cwd,
          }),
        }),
      }
    }
    default:
      return { state, outputs: [] }
  }
}

function newTool(sessionID: string, id: string, name = "tool"): Tool {
  return { sessionID, id, name, input: {}, metadata: {} }
}

function route(ctx: TurnContext, child: Child | undefined, update: SessionUpdate): Output[] {
  if (!child) return [{ _tag: "SessionUpdate", update }]
  const projected = ACPChild.project(update, child)
  if (ctx.childUpdates) return childStatus(ctx, child, { type: "update", update: projected })
  return projectChild(ctx, child) ? [{ _tag: "SessionUpdate", update: projected }] : []
}

function childStatus(ctx: TurnContext, child: ACPChild.Session, event: ACPChild.Event): Output[] {
  if (!ctx.childUpdates) return []
  return [{ _tag: "ChildUpdate", update: ACPChild.update(ctx.sessionID, child, event) }]
}

function recordStep(state: TurnState, tokens: TokenUsage.Info): TurnState {
  const turn = state.usage?.turn
  return {
    ...state,
    usage: {
      turn: turn
        ? {
            input: turn.input + tokens.input,
            output: turn.output + tokens.output,
            reasoning: turn.reasoning + tokens.reasoning,
            cache: { read: turn.cache.read + tokens.cache.read, write: turn.cache.write + tokens.cache.write },
          }
        : tokens,
      last: tokens,
    },
  }
}

function without<K, V>(map: ReadonlyMap<K, V>, key: K) {
  const next = new Map(map)
  next.delete(key)
  return next
}

function sessionIDFromEvent(event: OpenCodeEvent) {
  if ("sessionID" in event.data && typeof event.data.sessionID === "string") return event.data.sessionID
  if (event.type === "form.created") return event.data.form.sessionID
  return undefined
}

function toolKey(sessionID: string, id: string) {
  return `${sessionID}:${id}`
}

function resolveStopReason(input: {
  readonly terminal: Terminal
  readonly finish: SessionMessage.Assistant["finish"]
  readonly error?: string
}): PromptResponse["stopReason"] {
  if (input.terminal === "interrupted" || input.error === "aborted") return "cancelled"
  if (input.finish === "length") return "max_tokens"
  if (input.finish === "content-filter" || input.error === "provider.content-filter") return "refusal"
  return "end_turn"
}

export * as ACPTranslate from "./translate"
