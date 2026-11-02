export * as MuseAttestation from "./muse-attestation.js"

/**
 * Muse attestation aliasing for the façade (#1443, the Wave C gate for
 * #1155) — the in-fork reproduction of the muse door's direct-path
 * behaviour, scoped to the muse backend exactly as the door scopes it
 * to itself.
 *
 * The door (developing-today/code `bin/muse-proxy.mjs`, DIRECT_TOOL_ALIASES
 * and friends): Meta's subscription-key gate rejects requests whose
 * function tools carry the well-known agent-harness shell names (`shell`,
 * `bash`) with 403 `client_attestation_denied` — verified live 2026-10-30
 * by bisecting a real opencode request body; every other tool passes
 * unchanged, while `run_command` / `terminal` pass. The door therefore
 * presents those tools upstream under alias names (tool definitions,
 * history function_call items, tool_choice) and translates the model's
 * returned calls back, so the caller sees its own names and a normal 200.
 *
 * Scope (the §9.1 tension, resolved as Drew's sameness rule directs):
 * the façade's general rule stays verbatim preservation — tool names are
 * never renamed for any other provider. Aliasing engages ONLY when the
 * resolved target is the muse backend (provider `meta`, the native Meta
 * provider whose upstream is api.meta.ai — the one target subject to
 * the subscription-key attestation gate), and only on the chat and
 * responses door dialects (the door has no messages front; the messages
 * dialect is untouched). When the target is a door-backed provider
 * (`muse` / `muse-direct`, baseURL :18747) the door aliases on its own
 * side and the façade must NOT alias — double aliasing would corrupt
 * names. Sessions never pass through Generate, so session behaviour is
 * unchanged either way.
 *
 * Door semantics reproduced exactly:
 * - `shell` → `run_command`, `bash` → `terminal`, in tool definitions,
 *   history tool-call parts, and a named tool_choice.
 * - Collision guard (the door's `taken` check): if the alias target is
 *   already a genuine tool name in the same request, the name is left
 *   verbatim — aliasing it would make the two tools indistinguishable.
 * - Returned calls are translated back under the caller's names, on
 *   non-streaming responses and on streamed tool events alike, and on
 *   both the translated path and the native-shape pass-through path
 *   (whose raw body is aliased before forwarding, as the door's
 *   responses passthrough does).
 *
 * One deliberate deviation from the door, recorded on #1443: the door's
 * back-translation is an unconditional reverse map, so a GENUINE
 * `run_command` call in a request that never aliased is mislabelled
 * `shell` on the way out (the door's own alias probe demonstrates this).
 * The façade's reverse map contains only the names this request
 * actually aliased, so a genuine `run_command` / `terminal` call keeps
 * its name. Callers whose requests do alias see door-identical output.
 *
 * The residual gap, also recorded on #1443: if the upstream still
 * answers 403 `client_attestation_denied` despite aliasing (the
 * fingerprint moved to a name the alias table does not cover), the door
 * falls back to the CLI door and the caller still gets a 200. The
 * façade has no CLI door behind it — reproducing one would rebuild the
 * door inside the server, against design §3/§9.2 — so the failure is
 * classified as a distinct attestation provider failure
 * (Generate.AttestationError): never retried against the same target,
 * never quota-classified, ledgered like any other failed attempt so
 * route demotion/failover sees it. That is the one remaining
 * caller-visible diff from the door, and it is why #1443 stays open.
 */
import { LLMEvent, LLMResponse, Message, ToolChoice, ToolEntry, type AIError, type ToolEntryInput } from "@opencode/ai"
import type { CompletionInput } from "./generate.js"

/** The provider id of the muse backend: the native Meta provider. */
export const PROVIDER_ID = "meta"

/** The door's alias table (muse-proxy.mjs DIRECT_TOOL_ALIASES). */
export const ALIASES: Readonly<Record<string, string>> = { shell: "run_command", bash: "terminal" }

export interface Plan {
  /** Caller name → upstream alias, for the names this request aliases. */
  readonly forward: ReadonlyMap<string, string>
  /** Upstream alias → caller name, the exact reverse of `forward`. */
  readonly backward: ReadonlyMap<string, string>
}

/**
 * The aliasing plan for one request's tool names, or undefined when
 * nothing aliases: no shell/bash name present, or every alias target
 * already taken by a genuine tool in the same request (the door's
 * collision guard).
 */
export const plan = (toolNames: Iterable<string>): Plan | undefined => {
  const taken = new Set(toolNames)
  const forward = new Map<string, string>()
  for (const name of taken) {
    const alias = ALIASES[name]
    if (alias && !taken.has(alias)) forward.set(name, alias)
  }
  if (forward.size === 0) return undefined
  return { forward, backward: new Map([...forward].map(([name, alias]) => [alias, name])) }
}

/** Every tool-definition name in a request, descending into namespaces. */
export const toolNames = (tools: ReadonlyArray<ToolEntryInput> | undefined): string[] => {
  const names: string[] = []
  const walk = (entries: ReadonlyArray<ToolEntryInput>) => {
    for (const entry of entries) {
      if ("type" in entry && entry.type === "namespace") walk(entry.tools)
      else if ("name" in entry && typeof entry.name === "string") names.push(entry.name)
    }
  }
  if (tools) walk(tools)
  return names
}

const aliasEntry = (entry: ToolEntryInput, plan: Plan): ToolEntryInput => {
  if ("type" in entry && entry.type === "namespace") {
    const tools = entry.tools.map((child) => aliasEntry(child, plan))
    return tools.some((child, index) => child !== entry.tools[index]) ? { ...entry, tools } : entry
  }
  if ("name" in entry && typeof entry.name === "string" && plan.forward.has(entry.name))
    return ToolEntry.make({ ...entry, name: plan.forward.get(entry.name)! })
  return entry
}

const aliasToolChoice = (choice: CompletionInput["toolChoice"], plan: Plan): CompletionInput["toolChoice"] => {
  if (choice === undefined) return undefined
  const made = ToolChoice.make(choice)
  if (made.type === "tool" && made.name !== undefined && plan.forward.has(made.name))
    return new ToolChoice({
      type: "tool",
      name: plan.forward.get(made.name)!,
      ...(made.disableParallelToolUse !== undefined ? { disableParallelToolUse: made.disableParallelToolUse } : {}),
    })
  return choice
}

const aliasMessages = (messages: CompletionInput["messages"], plan: Plan): CompletionInput["messages"] =>
  messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if ((part.type === "tool-call" || part.type === "tool-result") && plan.forward.has(part.name)) {
        changed = true
        return { ...part, name: plan.forward.get(part.name)! }
      }
      return part
    })
    return changed ? Message.make({ ...message, content }) : message
  })

/** The request-side transform: a copy of the input with every caller
 * shell/bash name presented under its alias. Untouched when the plan
 * does not apply to a given field (references are preserved). */
export const aliasInput = (input: CompletionInput, plan: Plan): CompletionInput => ({
  ...input,
  messages: aliasMessages(input.messages, plan),
  ...(input.tools ? { tools: input.tools.map((entry) => aliasEntry(entry, plan)) } : {}),
  ...(input.toolChoice !== undefined ? { toolChoice: aliasToolChoice(input.toolChoice, plan) } : {}),
})

/** The response-side transform for one streamed event: a tool event
 * carrying an aliased name is rebuilt under the caller's name; every
 * other event passes through by reference. */
export const unaliasEvent = (event: LLMEvent, plan: Plan): LLMEvent => {
  switch (event.type) {
    case "tool-input-start":
      return plan.backward.has(event.name) ? LLMEvent.toolInputStart({ ...event, name: plan.backward.get(event.name)! }) : event
    case "tool-input-delta":
      return plan.backward.has(event.name) ? LLMEvent.toolInputDelta({ ...event, name: plan.backward.get(event.name)! }) : event
    case "tool-input-end":
      return plan.backward.has(event.name) ? LLMEvent.toolInputEnd({ ...event, name: plan.backward.get(event.name)! }) : event
    case "tool-input-error":
      return plan.backward.has(event.name) ? LLMEvent.toolInputError({ ...event, name: plan.backward.get(event.name)! }) : event
    case "tool-call":
      return plan.backward.has(event.name) ? LLMEvent.toolCall({ ...event, name: plan.backward.get(event.name)! }) : event
    case "tool-result":
      return plan.backward.has(event.name) ? LLMEvent.toolResult({ ...event, name: plan.backward.get(event.name)! }) : event
    case "tool-error":
      return plan.backward.has(event.name) ? LLMEvent.toolError({ ...event, name: plan.backward.get(event.name)! }) : event
    default:
      return event
  }
}

/** The response-side transform for a completed response: tool-call
 * events and the assembled message's tool-call parts are renamed back
 * under the caller's names. */
export const unaliasResponse = (response: LLMResponse, plan: Plan): LLMResponse => {
  const events = response.events.map((event) => unaliasEvent(event, plan))
  const content = response.message.content.map((part) =>
    part.type === "tool-call" && plan.backward.has(part.name) ? { ...part, name: plan.backward.get(part.name)! } : part,
  )
  if (events.every((event, index) => event === response.events[index]) && content.every((part, index) => part === response.message.content[index]))
    return response
  return new LLMResponse({
    message: Message.make({ ...response.message, content }),
    events,
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
    finishReason: response.finishReason,
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The pass-through side of the door's aliasing: rename shell/bash names
 * inside a raw door-dialect body before it is forwarded verbatim (the
 * door's `aliasResponsesRequestBody`, extended to the chat shape the
 * door's chat translation builds). Returns the re-serialized body, or
 * undefined when nothing aliased or the body cannot be parsed — the
 * caller then forwards the original body (and the translated path,
 * which is aliased separately, remains the fallback for unparseable
 * bodies via the shape-rejection retry).
 */
export const aliasRawBody = (raw: string, dialect: "chat" | "responses", plan: Plan): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  let changed = false
  const rename = (holder: unknown) => {
    if (isRecord(holder) && typeof holder.name === "string" && plan.forward.has(holder.name)) {
      holder.name = plan.forward.get(holder.name)!
      changed = true
    }
  }
  if (dialect === "responses") {
    if (Array.isArray(parsed.tools)) for (const tool of parsed.tools) rename(tool)
    if (Array.isArray(parsed.input))
      for (const item of parsed.input) if (isRecord(item) && item.type === "function_call") rename(item)
    if (isRecord(parsed.tool_choice) && parsed.tool_choice.type === "function") rename(parsed.tool_choice)
  } else {
    if (Array.isArray(parsed.tools)) for (const tool of parsed.tools) if (isRecord(tool)) rename(tool.function)
    if (Array.isArray(parsed.messages))
      for (const message of parsed.messages)
        if (isRecord(message) && Array.isArray(message.tool_calls))
          for (const call of message.tool_calls) if (isRecord(call)) rename(call.function)
    if (isRecord(parsed.tool_choice)) rename(parsed.tool_choice.function)
  }
  return changed ? JSON.stringify(parsed) : undefined
}

/**
 * Whether a provider failure is the attestation denial: an HTTP 403
 * whose body carries `client_attestation_denied` (the recorded door
 * body: `{error: {code: "client_attestation_denied", ...}}`). Quota and
 * auth failures never match — they keep their existing mappings.
 */
export const isAttestationDenial = (error: AIError): boolean =>
  error.reason.http?.status === 403 &&
  ((error.reason.body ?? "").includes("client_attestation_denied") || error.reason.message.includes("client_attestation_denied"))
