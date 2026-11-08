// The muse-direct Responses protocol: Meta's Responses wire
// (protocols/meta-responses.ts) plus the one behaviour the plan's
// attestation demands and the loopback door used to perform — tool
// name aliasing — done here, at the protocol layer, so EVERY caller
// is covered.
//
// Why: with the plan's minted inference key, Meta's attestation
// rejects function tools named `shell` or `bash` (403
// client_attestation_denied). The door (bin/muse-proxy.mjs in
// developing-today/code, direct mode) presented them as `run_command`
// / `terminal` outbound and renamed them back inbound. The fork's
// canonical-level implementation of the same transforms lives in
// packages/core/src/muse-attestation.ts, but core applies it only on
// the Generate façade path (provider `meta` there) — session traffic
// never passes through Generate, it runs LLMClient directly. Aliasing
// in the protocol is the one placement that covers sessions, the
// façade, and every future caller identically, because the protocol
// owns both directions of the wire: request lowering (body.from) and
// response decoding (stream.step). Composition is safe: a request
// already aliased upstream presents no shell/bash names here, so the
// plan computes to undefined and this layer is a no-op.
//
// The transforms below port core's MuseAttestation semantics
// one-for-one (same alias map, same collision guard, same
// prototype-name guard): alias tool definitions (descending into
// namespaces), history tool-call / tool-result parts, and a named
// tool choice outbound; unalias tool event names inbound.
//
// The transport adds the door's second direct-mode behaviour: on an
// upstream 401 the minted-key cache is invalidated and the request is
// re-prepared (so auth re-exchanges) and retried exactly once — the
// same shape as the antigravity protocol's transport.
import { Effect } from "effect"
import { LLMEvent, LLMRequest, Message, ToolChoice, ToolEntry, type ToolDefinition } from "../schema/index.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport, type Transport, type TransportPrepareInput } from "../route/transport/index.js"
import { MetaResponses } from "./meta-responses.js"
import { OpenResponses } from "./open-responses.js"
import { MuseDirectAuth } from "../providers/muse-direct-auth.js"

/** Caller tool name -> the name Meta's attestation accepts for it. */
export const ALIASES: Readonly<Record<string, string>> = {
  shell: "run_command",
  bash: "terminal",
}

export interface Plan {
  readonly forward: ReadonlyMap<string, string>
  readonly backward: ReadonlyMap<string, string>
}

const ownValue = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

/**
 * The aliasing plan for one request's tool names, or undefined when
 * nothing aliases: no shell/bash name present, or every alias target
 * already taken by a genuine tool in the same request (the collision
 * guard — renaming onto a live tool would corrupt both).
 */
export const plan = (toolNames: Iterable<string>): Plan | undefined => {
  const taken = new Set(toolNames)
  const forward = new Map<string, string>()
  for (const name of taken) {
    const alias = ownValue(ALIASES, name)
    if (alias && !taken.has(alias)) forward.set(name, alias)
  }
  if (forward.size === 0) return undefined
  return { forward, backward: new Map([...forward].map(([name, alias]) => [alias, name])) }
}

/** Every tool-definition name in a request, descending into namespaces. */
export const toolNames = (tools: ReadonlyArray<ToolEntry> | undefined): string[] => {
  const names: string[] = []
  const walk = (entries: ReadonlyArray<ToolEntry>) => {
    for (const entry of entries) {
      if (entry.type === "namespace") walk(entry.tools)
      else names.push(entry.name)
    }
  }
  if (tools) walk(tools)
  return names
}

const aliasEntry = (entry: ToolEntry, active: Plan): ToolEntry => {
  if (entry.type === "namespace") {
    const tools = entry.tools.map((child) => aliasEntry(child, active))
    return tools.some((child, index) => child !== entry.tools[index]) ? { ...entry, tools } : entry
  }
  const alias = active.forward.get(entry.name)
  return alias ? ToolEntry.make({ ...(entry as ToolDefinition), name: alias }) : entry
}

const aliasToolChoice = (choice: LLMRequest["toolChoice"], active: Plan): LLMRequest["toolChoice"] => {
  if (choice === undefined) return undefined
  const made = ToolChoice.make(choice)
  if (made.type === "tool" && made.name !== undefined && active.forward.has(made.name))
    return new ToolChoice({
      type: "tool",
      name: active.forward.get(made.name)!,
      ...(made.disableParallelToolUse !== undefined ? { disableParallelToolUse: made.disableParallelToolUse } : {}),
    })
  return choice
}

const aliasMessages = (messages: LLMRequest["messages"], active: Plan): LLMRequest["messages"] =>
  messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if ((part.type === "tool-call" || part.type === "tool-result") && active.forward.has(part.name)) {
        changed = true
        return { ...part, name: active.forward.get(part.name)! }
      }
      return part
    })
    return changed ? Message.make({ ...message, content }) : message
  })

/** The request-side transform: the same request with every caller
 * shell/bash name presented under its alias. Returned by reference
 * when the plan does not apply. */
export const aliasRequest = (request: LLMRequest): LLMRequest => {
  const active = plan(toolNames(request.tools))
  if (!active) return request
  return LLMRequest.update(request, {
    messages: aliasMessages(request.messages, active),
    tools: request.tools.map((entry) => aliasEntry(entry, active)),
    ...(request.toolChoice !== undefined ? { toolChoice: aliasToolChoice(request.toolChoice, active) } : {}),
  })
}

/** The response-side transform for one streamed event: a tool event
 * carrying an aliased name is rebuilt under the caller's name; every
 * other event passes through by reference. */
export const unaliasEvent = (event: LLMEvent, active: Plan): LLMEvent => {
  switch (event.type) {
    case "tool-input-start":
      return active.backward.has(event.name) ? LLMEvent.toolInputStart({ ...event, name: active.backward.get(event.name)! }) : event
    case "tool-input-delta":
      return active.backward.has(event.name) ? LLMEvent.toolInputDelta({ ...event, name: active.backward.get(event.name)! }) : event
    case "tool-input-end":
      return active.backward.has(event.name) ? LLMEvent.toolInputEnd({ ...event, name: active.backward.get(event.name)! }) : event
    case "tool-input-error":
      return active.backward.has(event.name) ? LLMEvent.toolInputError({ ...event, name: active.backward.get(event.name)! }) : event
    case "tool-call":
      return active.backward.has(event.name) ? LLMEvent.toolCall({ ...event, name: active.backward.get(event.name)! }) : event
    case "tool-result":
      return active.backward.has(event.name) ? LLMEvent.toolResult({ ...event, name: active.backward.get(event.name)! }) : event
    case "tool-error":
      return active.backward.has(event.name) ? LLMEvent.toolError({ ...event, name: active.backward.get(event.name)! }) : event
    default:
      return event
  }
}

type InnerProtocol = typeof MetaResponses.protocol
type InnerState = Parameters<InnerProtocol["stream"]["step"]>[0]

interface ParserState {
  // MetaResponses' parser state extends OpenResponses.ParserState but
  // is not itself exported; the wrapper stores the exported base type
  // and casts back at the delegation points below.
  readonly inner: OpenResponses.ParserState
  readonly plan: Plan | undefined
}

const inner = MetaResponses.protocol

export const protocol = Protocol.make({
  id: "muse-direct-responses",
  body: {
    schema: OpenResponses.OpenResponsesBody,
    from: (request) => inner.body.from(aliasRequest(request)),
  },
  stream: {
    event: inner.stream.event,
    initial: (request): ParserState => ({
      inner: inner.stream.initial(request),
      plan: plan(toolNames(request.tools)),
    }),
    step: (state: ParserState, event) =>
      inner.stream.step(state.inner as InnerState, event).pipe(
        Effect.map(
          ([next, events]) =>
            [
              { inner: next, plan: state.plan },
              state.plan ? events.map((item) => unaliasEvent(item, state.plan!)) : events,
            ] as const,
        ),
      ),
    terminal: inner.stream.terminal,
    onHalt: (state: ParserState) =>
      inner.stream.onHalt
        ? inner.stream
            .onHalt(state.inner as InnerState)
            .pipe(Effect.map((events) => (state.plan ? events.map((item) => unaliasEvent(item, state.plan!)) : events)))
        : Effect.succeed([]),
  },
  supportsEffortUpdates: inner.supportsEffortUpdates,
  sanitizer: inner.sanitizer,
})

// =============================================================================
// Transport: SSE with the door's single auth retry (401 -> minted-key
// cache invalidated, re-prepare so auth re-exchanges, retry exactly
// once). Mirrors the antigravity protocol's transport.
// =============================================================================
export interface Prepared {
  readonly http: HttpTransport.HttpPrepared<string>
  readonly input: TransportPrepareInput<OpenResponses.OpenResponsesBody>
}

const sse = OpenResponses.httpTransport

const isUnauthorized = (error: { readonly reason: { readonly _tag: string } }) =>
  error.reason._tag === "Authentication" &&
  (error.reason as { http?: { status?: number } }).http?.status === 401

export const transport: Transport<OpenResponses.OpenResponsesBody, Prepared, string> = {
  id: sse.id,
  prepare: (input) => sse.prepare(input).pipe(Effect.map((http) => ({ http, input }))),
  execute: (prepared, request, runtime, options) =>
    Effect.gen(function* () {
      const first = yield* Effect.result(sse.execute(prepared.http, request, runtime, options))
      if (first._tag === "Success") return first.success
      if (!isUnauthorized(first.failure)) return yield* first.failure
      MuseDirectAuth.invalidate()
      const retried = yield* sse
        .prepare(prepared.input)
        .pipe(Effect.flatMap((http) => sse.execute(http, request, runtime, options)))
      return retried
    }),
}

export * as MuseDirectResponses from "./muse-direct-responses.js"
