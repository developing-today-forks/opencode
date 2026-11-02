export * as Completions from "./completions.js"

/**
 * OpenAI chat-completions wire translation for the completions door
 * (#1405). Pure functions between the caller's wire format and the
 * internal LLM shapes; the server handler (packages/server/src/handlers/completions.ts)
 * owns effects and HTTP. Lives in core, next to the Generate service it
 * feeds, because the LLM shapes are core-layer types. Unsupported wire features fail loudly at parse time
 * (a 400 the caller can see) instead of being silently dropped.
 */
import {
  Media,
  Message,
  ToolCallPart,
  ToolResultPart,
  type ContentPart,
  type GenerationOptions,
  type LLMEvent,
  type LLMResponse,
  type ToolChoice,
  type ToolDefinition,
  type ToolEntryInput,
  type Usage,
} from "@opencode/ai"
import type { CompletionInput } from "./generate.js"
import { Model } from "./model.js"
import { randomBytes } from "node:crypto"

export const ADVERTISED_MODELS = ["workhorse", "speed", "specialist", "summit", "scout", "workhorse-weighted"]

export const completionId = () => `chatcmpl-${randomBytes(12).toString("hex")}`

export const DONE_FRAME = "data: [DONE]\n\n"

export interface ParsedChatRequest {
  readonly modelLabel: string
  readonly stream: boolean
  readonly input: CompletionInput
}

export type ParseResult = { readonly ok: true; readonly value: ParsedChatRequest } | { readonly ok: false; readonly error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textOf = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null
    parts.push(part.text)
  }
  return parts.join("")
}

const parseModel = (raw: unknown): { ref: Model.Ref; label: string } | string => {
  const label = typeof raw === "string" && raw ? raw : "workhorse"
  try {
    return { ref: Model.Ref.parse(label.includes("/") ? label : `opencode-route/${label}`), label }
  } catch {
    return `invalid model reference: ${label}`
  }
}

const parseTools = (raw: unknown): ReadonlyArray<ToolEntryInput> | string => {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return "tools must be an array"
  const tools: ToolDefinition.Input[] = []
  for (const tool of raw) {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function) || typeof tool.function.name !== "string")
      return "only function tools are supported by this door"
    const parameters = tool.function.parameters
    tools.push({
      name: tool.function.name,
      description: typeof tool.function.description === "string" ? tool.function.description : "",
      inputSchema: isRecord(parameters) ? parameters : { type: "object", properties: {} },
    })
  }
  return tools
}

const parseToolChoice = (
  raw: unknown,
): { readonly choice: ToolChoice.Input | undefined } | { readonly error: string } => {
  if (raw === undefined) return { choice: undefined }
  if (typeof raw === "string") return { choice: raw }
  if (isRecord(raw) && raw.type === "function" && isRecord(raw.function) && typeof raw.function.name === "string")
    return { choice: raw.function.name }
  return { error: "unsupported tool_choice" }
}

const parseGeneration = (body: Record<string, unknown>): GenerationOptions.Input => {
  const max = typeof body.max_tokens === "number" ? body.max_tokens : body.max_completion_tokens
  const stop =
    typeof body.stop === "string"
      ? [body.stop]
      : Array.isArray(body.stop) && body.stop.every((s) => typeof s === "string")
        ? body.stop
        : undefined
  return {
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
    ...(typeof body.top_k === "number" ? { topK: body.top_k } : {}),
    ...(typeof body.frequency_penalty === "number" ? { frequencyPenalty: body.frequency_penalty } : {}),
    ...(typeof body.presence_penalty === "number" ? { presencePenalty: body.presence_penalty } : {}),
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    ...(typeof max === "number" ? { maxTokens: max } : {}),
    ...(stop ? { stop } : {}),
  }
}

export const parseChatRequest = (body: unknown): ParseResult => {
  if (!isRecord(body)) return { ok: false, error: "request body must be a JSON object" }
  if (!Array.isArray(body.messages)) return { ok: false, error: "messages must be an array" }
  const model = parseModel(body.model)
  if (typeof model === "string") return { ok: false, error: model }
  const tools = parseTools(body.tools)
  if (typeof tools === "string") return { ok: false, error: tools }
  const toolChoice = parseToolChoice(body.tool_choice)
  if ("error" in toolChoice) return { ok: false, error: toolChoice.error }

  const system: string[] = []
  const messages: Array<Message | Message.Input> = []
  const toolNames = new Map<string, string>()
  for (const entry of body.messages) {
    if (!isRecord(entry) || typeof entry.role !== "string") return { ok: false, error: "each message must be an object with a role" }
    if (entry.role === "system") {
      const text = textOf(entry.content)
      if (text === null) return { ok: false, error: "system messages must carry text content" }
      system.push(text)
      continue
    }
    if (entry.role === "user") {
      const text = textOf(entry.content)
      if (text === null) return { ok: false, error: "only text user content is supported by this door" }
      messages.push(Message.user(text))
      continue
    }
    if (entry.role === "assistant") {
      const parts: ContentPart[] = []
      const text = entry.content === null || entry.content === undefined ? "" : textOf(entry.content)
      if (text === null) return { ok: false, error: "only text assistant content is supported by this door" }
      if (text) parts.push(Message.text(text))
      if (entry.tool_calls !== undefined) {
        if (!Array.isArray(entry.tool_calls)) return { ok: false, error: "tool_calls must be an array" }
        for (const call of entry.tool_calls) {
          if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function) || typeof call.function.name !== "string")
            return { ok: false, error: "assistant tool_calls must be function calls with an id and a name" }
          let input: unknown = {}
          if (typeof call.function.arguments === "string" && call.function.arguments) {
            try {
              input = JSON.parse(call.function.arguments)
            } catch {
              return { ok: false, error: `tool call ${call.id} arguments are not valid JSON` }
            }
          } else if (call.function.arguments !== undefined && typeof call.function.arguments !== "string") {
            input = call.function.arguments
          }
          toolNames.set(call.id, call.function.name)
          parts.push(ToolCallPart.make({ id: call.id, name: call.function.name, input }))
        }
      }
      messages.push(Message.assistant(parts))
      continue
    }
    if (entry.role === "tool") {
      if (typeof entry.tool_call_id !== "string") return { ok: false, error: "tool messages must carry tool_call_id" }
      const text = textOf(entry.content)
      if (text === null) return { ok: false, error: "tool messages must carry text content" }
      messages.push(
        Message.tool(
          ToolResultPart.make({
            id: entry.tool_call_id,
            name: toolNames.get(entry.tool_call_id) ?? "tool",
            result: text,
            resultType: "text",
          }),
        ),
      )
      continue
    }
    return { ok: false, error: `unsupported message role: ${entry.role}` }
  }

  return {
    ok: true,
    value: {
      modelLabel: model.label,
      stream: body.stream === true,
      input: {
        model: model.ref,
        system: system.length ? system.join("\n") : undefined,
        messages,
        tools: tools.length ? tools : undefined,
        toolChoice: toolChoice.choice,
        generation: parseGeneration(body),
      },
    },
  }
}

// ------------------------------------------------------------ responses

export const usageBody = (usage: Usage | undefined) => {
  if (!usage) return undefined
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage.totalTokens ?? input + output,
    ...(usage.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }
      : {}),
  }
}

const finishReason = (normalized: string, hasToolCalls: boolean): string => {
  if (hasToolCalls && normalized !== "length" && normalized !== "content-filter") return "tool_calls"
  switch (normalized) {
    case "length":
      return "length"
    case "content-filter":
      return "content_filter"
    case "tool-calls":
      return "tool_calls"
    default:
      return "stop"
  }
}

export const completionBody = (args: {
  readonly id: string
  readonly created: number
  readonly model: string
  readonly response: LLMResponse
}) => {
  const toolCalls = args.response.toolCalls
  const text = args.response.text
  return {
    id: args.id,
    object: "chat.completion",
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length && !text ? null : text,
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: String(call.id),
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                })),
              }
            : {}),
        },
        finish_reason: finishReason(args.response.finishReason.normalized, toolCalls.length > 0),
      },
    ],
    ...(args.response.usage ? { usage: usageBody(args.response.usage) } : {}),
  }
}

export const modelsBody = () => ({
  object: "list",
  data: ADVERTISED_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "opencode-route" })),
})

/**
 * One model by the id a caller names, in the same shape as a modelsBody
 * entry, or undefined when the door does not serve that id. Route models
 * are the finite advertised set: they answer to both the bare id the list
 * carries (`workhorse`) and the prefixed ref callers use as a completion
 * model (`opencode-route/workhorse`, answered with that id). Any other
 * `provider/model` ref is a concrete catalog model: the door serves those
 * by pass-through (parseChatRequest accepts any such ref and resolution
 * happens at completion time), so the entry is echoed with the provider
 * as owner. Bare names that are not advertised routes and malformed refs
 * are unknown.
 */
export const modelBody = (id: string) => {
  const listed = modelsBody().data.find((model) => model.id === id)
  if (listed) return listed
  if (id.startsWith("opencode-route/")) {
    const route = id.slice("opencode-route/".length)
    const entry = modelsBody().data.find((model) => model.id === route)
    return entry ? { ...entry, id } : undefined
  }
  const slash = id.indexOf("/")
  if (slash > 0 && slash < id.length - 1) return { id, object: "model", created: 0, owned_by: id.slice(0, slash) }
  return undefined
}

export const errorBody = (message: string, type: string) => ({ error: { message, type } })

export const errorFrame = (message: string) => `data: ${JSON.stringify(errorBody(message, "server_error"))}\n\n`

/**
 * Stateful OpenAI SSE translator: internal LLM events in, `data:` frames
 * out. The finish event produces the terminal chunk (finish_reason plus
 * usage when the provider reported it); the handler appends [DONE].
 */
export class ChatStreamTranslator {
  failed = false
  private started = false
  private hasToolCalls = false
  private readonly toolIndex = new Map<string, number>()

  constructor(
    private readonly meta: { readonly id: string; readonly created: number; readonly model: string },
  ) {}

  private chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: Usage): string {
    const first = !this.started
    this.started = true
    return `data: ${JSON.stringify({
      id: this.meta.id,
      object: "chat.completion.chunk",
      created: this.meta.created,
      model: this.meta.model,
      choices: [
        {
          index: 0,
          delta: first ? { role: "assistant", ...delta } : delta,
          finish_reason: finish,
        },
      ],
      ...(usage ? { usage: usageBody(usage) } : {}),
    })}\n\n`
  }

  private toolSlot(id: string): number {
    const existing = this.toolIndex.get(id)
    if (existing !== undefined) return existing
    const next = this.toolIndex.size
    this.toolIndex.set(id, next)
    return next
  }

  push(event: LLMEvent): string[] {
    switch (event.type) {
      case "text-delta":
        return [this.chunk({ content: event.text })]
      case "reasoning-delta":
        return [this.chunk({ reasoning_content: event.text })]
      case "tool-input-start": {
        this.hasToolCalls = true
        const index = this.toolSlot(String(event.id))
        return [
          this.chunk({
            tool_calls: [
              { index, id: String(event.id), type: "function", function: { name: event.name, arguments: "" } },
            ],
          }),
        ]
      }
      case "tool-input-delta": {
        const index = this.toolSlot(String(event.id))
        return [this.chunk({ tool_calls: [{ index, function: { arguments: event.text } }] })]
      }
      case "tool-call": {
        this.hasToolCalls = true
        if (this.toolIndex.has(String(event.id))) return []
        const index = this.toolSlot(String(event.id))
        return [
          this.chunk({
            tool_calls: [
              {
                index,
                id: String(event.id),
                type: "function",
                function: { name: event.name, arguments: JSON.stringify(event.input ?? {}) },
              },
            ],
          }),
        ]
      }
      case "finish":
        return [this.chunk({}, finishReason(event.reason.normalized, this.hasToolCalls), event.usage)]
      case "provider-error":
        this.failed = true
        return [errorFrame(event.message)]
      default:
        return []
    }
  }
}

// ------------------------------------------------------------ responses door
//
// The same universal door in the Responses dialect (#1146): every model
// the completions endpoint serves — route names and direct catalog
// provider/model refs alike — is addressable here too. The dialect is
// translated to and from the same internal shapes; nothing is excluded
// because conversion is needed. Stateless like the completions door:
// `previous_response_id` is rejected loudly instead of silently
// dropping the caller's context, and reasoning items in the input
// (provider-internal echoes) are accepted and skipped.

export const responseId = () => `resp_${randomBytes(12).toString("hex")}`

export interface ParsedResponsesRequest {
  readonly modelLabel: string
  readonly stream: boolean
  readonly input: CompletionInput
}

export type ParseResponsesResult =
  | { readonly ok: true; readonly value: ParsedResponsesRequest }
  | { readonly ok: false; readonly error: string }

const responsesTextOf = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) return null
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string")
      parts.push(part.text)
    else return null
  }
  return parts.join("")
}

export const parseResponsesRequest = (body: unknown): ParseResponsesResult => {
  if (!isRecord(body)) return { ok: false, error: "request body must be a JSON object" }
  if (body.previous_response_id !== undefined)
    return { ok: false, error: "previous_response_id is not supported by this stateless door" }
  const model = parseModel(body.model)
  if (typeof model === "string") return { ok: false, error: model }

  const tools: ToolDefinition.Input[] = []
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { ok: false, error: "tools must be an array" }
    for (const tool of body.tools) {
      if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string")
        return { ok: false, error: "only function tools are supported by this door" }
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      })
    }
  }
  let toolChoice: ToolChoice.Input | undefined
  if (typeof body.tool_choice === "string") toolChoice = body.tool_choice
  else if (isRecord(body.tool_choice) && body.tool_choice.type === "function" && typeof body.tool_choice.name === "string")
    toolChoice = body.tool_choice.name
  else if (body.tool_choice !== undefined) return { ok: false, error: "unsupported tool_choice" }
  if (isRecord(body.text) && isRecord(body.text.format) && body.text.format.type === "json_schema")
    return { ok: false, error: "structured output formats are not supported by this door" }

  const system: string[] = []
  if (typeof body.instructions === "string" && body.instructions) system.push(body.instructions)
  const messages: Array<Message | Message.Input> = []
  const toolNames = new Map<string, string>()
  const pushMessage = (role: unknown, content: unknown): string | null => {
    if (role === "system" || role === "developer") {
      const text = responsesTextOf(content)
      if (text === null) return "system messages must carry text content"
      system.push(text)
      return null
    }
    if (role === "user") {
      const text = responsesTextOf(content)
      if (text === null) return "only text user content is supported by this door"
      messages.push(Message.user(text))
      return null
    }
    if (role === "assistant") {
      const text = responsesTextOf(content)
      if (text === null) return "only text assistant content is supported by this door"
      if (text) messages.push(Message.assistant(text))
      return null
    }
    return `unsupported message role: ${String(role)}`
  }

  if (typeof body.input === "string") {
    messages.push(Message.user(body.input))
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item)) return { ok: false, error: "each input item must be an object" }
      if (item.type === "reasoning") continue
      if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || typeof item.name !== "string")
          return { ok: false, error: "function_call items must carry call_id and name" }
        let input: unknown = {}
        if (typeof item.arguments === "string" && item.arguments) {
          try {
            input = JSON.parse(item.arguments)
          } catch {
            return { ok: false, error: `function_call ${item.call_id} arguments are not valid JSON` }
          }
        }
        toolNames.set(item.call_id, item.name)
        messages.push(Message.assistant([ToolCallPart.make({ id: item.call_id, name: item.name, input })]))
        continue
      }
      if (item.type === "function_call_output") {
        if (typeof item.call_id !== "string") return { ok: false, error: "function_call_output items must carry call_id" }
        const text = typeof item.output === "string" ? item.output : responsesTextOf(item.output)
        if (text === null) return { ok: false, error: "function_call_output must carry text output" }
        messages.push(
          Message.tool(
            ToolResultPart.make({
              id: item.call_id,
              name: toolNames.get(item.call_id) ?? "tool",
              result: text,
              resultType: "text",
            }),
          ),
        )
        continue
      }
      if (item.type === "message" || item.type === undefined || typeof item.role === "string") {
        const error = pushMessage(item.role, item.content)
        if (error) return { ok: false, error }
        continue
      }
      return { ok: false, error: `unsupported input item type: ${String(item.type)}` }
    }
  } else if (body.input !== undefined) {
    return { ok: false, error: "input must be a string or an array of items" }
  }

  // Responses carries reasoning effort on the request; the fork carries
  // it as the model variant. Apply it when the ref has no variant yet.
  let ref = model.ref
  if (isRecord(body.reasoning) && typeof body.reasoning.effort === "string" && body.reasoning.effort && !ref.variant)
    ref = { ...ref, variant: body.reasoning.effort as typeof ref.variant }

  const max = typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined
  return {
    ok: true,
    value: {
      modelLabel: model.label,
      stream: body.stream === true,
      input: {
        model: ref,
        system: system.length ? system.join("\n") : undefined,
        messages,
        tools: tools.length ? tools : undefined,
        toolChoice,
        generation: {
          ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
          ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
          ...(max !== undefined ? { maxTokens: max } : {}),
        },
      },
    },
  }
}

export const responsesUsageBody = (usage: Usage | undefined) => {
  if (!usage) return undefined
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.totalTokens ?? input + output,
    ...(usage.reasoningTokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { input_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }
      : {}),
  }
}

export const responsesBody = (args: {
  readonly id: string
  readonly created: number
  readonly model: string
  readonly response: LLMResponse
}) => {
  const output: Array<Record<string, unknown>> = []
  const text = args.response.text
  if (text)
    output.push({
      type: "message",
      id: `msg_${args.id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  for (const call of args.response.toolCalls)
    output.push({
      type: "function_call",
      id: `fc_${String(call.id)}`,
      call_id: String(call.id),
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}),
      status: "completed",
    })
  return {
    id: args.id,
    object: "response",
    created_at: args.created,
    model: args.model,
    status: "completed",
    output,
    ...(args.response.usage ? { usage: responsesUsageBody(args.response.usage) } : {}),
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  }
}

const responsesFrame = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

/**
 * Stateful Responses SSE translator: internal LLM events in, typed
 * Responses frames out (`response.output_text.delta`,
 * `response.function_call_arguments.delta`, …). `start()` emits
 * `response.created`; the finish event emits `response.completed`
 * carrying the full response object. The Responses dialect has no
 * [DONE] sentinel — the stream simply ends after `response.completed`.
 */
export class ResponsesStreamTranslator {
  failed = false
  private textStarted = false
  private textIndex = 0
  private nextIndex = 0
  private readonly toolSlots = new Map<string, { index: number; name: string; args: string }>()

  constructor(
    private readonly meta: { readonly id: string; readonly created: number; readonly model: string },
  ) {}

  private base(status: string) {
    return { id: this.meta.id, object: "response", created_at: this.meta.created, model: this.meta.model, status, output: [] }
  }

  start(): string {
    return responsesFrame("response.created", { response: this.base("in_progress") })
  }

  push(event: LLMEvent): string[] {
    switch (event.type) {
      case "text-delta": {
        if (!this.textStarted) {
          this.textStarted = true
          this.textIndex = this.nextIndex++
        }
        return [
          responsesFrame("response.output_text.delta", {
            item_id: `msg_${this.meta.id}`,
            output_index: this.textIndex,
            content_index: 0,
            delta: event.text,
          }),
        ]
      }
      case "reasoning-delta":
        return [
          responsesFrame("response.reasoning_text.delta", {
            item_id: `rs_${this.meta.id}`,
            output_index: this.textIndex,
            content_index: 0,
            delta: event.text,
          }),
        ]
      case "tool-input-start": {
        const slot = { index: this.nextIndex++, name: event.name, args: "" }
        this.toolSlots.set(String(event.id), slot)
        return [
          responsesFrame("response.output_item.added", {
            output_index: slot.index,
            item: {
              type: "function_call",
              id: `fc_${String(event.id)}`,
              call_id: String(event.id),
              name: event.name,
              arguments: "",
              status: "in_progress",
            },
          }),
        ]
      }
      case "tool-input-delta": {
        const slot = this.toolSlots.get(String(event.id))
        if (!slot) return []
        slot.args += event.text
        return [
          responsesFrame("response.function_call_arguments.delta", {
            item_id: `fc_${String(event.id)}`,
            output_index: slot.index,
            delta: event.text,
          }),
        ]
      }
      case "tool-call": {
        if (this.toolSlots.has(String(event.id))) return []
        const slot = { index: this.nextIndex++, name: event.name, args: JSON.stringify(event.input ?? {}) }
        this.toolSlots.set(String(event.id), slot)
        return [
          responsesFrame("response.output_item.added", {
            output_index: slot.index,
            item: {
              type: "function_call",
              id: `fc_${String(event.id)}`,
              call_id: String(event.id),
              name: event.name,
              arguments: slot.args,
              status: "in_progress",
            },
          }),
        ]
      }
      case "finish":
        return [
          responsesFrame("response.completed", {
            response: {
              ...this.base("completed"),
              ...(event.usage ? { usage: responsesUsageBody(event.usage) } : {}),
            },
          }),
        ]
      case "provider-error":
        this.failed = true
        return [responsesFrame("response.failed", { response: { ...this.base("failed"), error: { message: event.message } } })]
      default:
        return []
    }
  }
}

// ------------------------------------------------------------ messages door
//
// The same universal door in the Anthropic Messages dialect (#1146;
// Drew, 2026-11-02: "allow v1 messages for any model"). Every model the
// other doors serve — route names and direct catalog provider/model
// refs alike — is addressable here too, whether the caller's dialect
// matches the resolved provider's native dialect or not: the request
// is translated to and from the same canonical internal shapes, and
// the provider layer speaks its native dialect from there. Stateless
// like the other doors: no session is created or stored. Anthropic
// request features this wave does not carry (thinking blocks and
// thinking configuration, document blocks, server tools, MCP servers)
// fail loudly at parse time, naming the shape, instead of being
// silently dropped or forwarded blindly.

export const messageId = () => `msg_${randomBytes(12).toString("hex")}`

export interface ParsedMessagesRequest {
  readonly modelLabel: string
  readonly stream: boolean
  readonly input: CompletionInput
}

export type ParseMessagesResult =
  | { readonly ok: true; readonly value: ParsedMessagesRequest }
  | { readonly ok: false; readonly error: string }

/**
 * Anthropic reports `input_tokens` as the non-cached portion only, with
 * cache reads/writes as separate fields; the canonical Usage carries
 * the inclusive total plus the breakdown, so the non-cached portion is
 * recovered here (preferring the breakdown the protocol mapper stored).
 */
export const messagesUsageBody = (usage: Usage | undefined) => {
  if (!usage) return { input_tokens: 0, output_tokens: 0 }
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  const nonCached = usage.nonCachedInputTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite)
  return {
    input_tokens: nonCached,
    output_tokens: usage.outputTokens ?? 0,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
  }
}

const stopSequenceOf = (metadata: unknown): string | null => {
  if (!isRecord(metadata)) return null
  for (const value of Object.values(metadata)) {
    if (isRecord(value) && typeof value.stopSequence === "string") return value.stopSequence
  }
  return null
}

const messagesStop = (normalized: string, raw: string | undefined, hasToolCalls: boolean, stopSequence: string | null) => {
  if (raw === "stop_sequence") return { stop_reason: "stop_sequence", stop_sequence: stopSequence }
  if (hasToolCalls && normalized !== "length") return { stop_reason: "tool_use", stop_sequence: null }
  switch (normalized) {
    case "length":
      return { stop_reason: "max_tokens", stop_sequence: null }
    case "tool-calls":
      return { stop_reason: "tool_use", stop_sequence: null }
    case "content-filter":
      return { stop_reason: "refusal", stop_sequence: null }
    default:
      return { stop_reason: "end_turn", stop_sequence: null }
  }
}

export const messagesBody = (args: { readonly id: string; readonly model: string; readonly response: LLMResponse }) => {
  const content: Array<Record<string, unknown>> = []
  const reasoning = args.response.reasoning
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" })
  const text = args.response.text
  if (text) content.push({ type: "text", text })
  for (const call of args.response.toolCalls)
    content.push({ type: "tool_use", id: String(call.id), name: call.name, input: call.input ?? {} })
  const finish = args.response.events.find((event) => event.type === "finish")
  const stop = messagesStop(
    args.response.finishReason.normalized,
    args.response.finishReason.raw,
    args.response.toolCalls.length > 0,
    finish ? stopSequenceOf(finish.providerMetadata) : null,
  )
  return {
    id: args.id,
    type: "message",
    role: "assistant",
    model: args.model,
    content,
    stop_reason: stop.stop_reason,
    stop_sequence: stop.stop_sequence,
    usage: messagesUsageBody(args.response.usage),
  }
}

const parseMessagesImage = (block: Record<string, unknown>): ContentPart | string => {
  if (!isRecord(block.source)) return "image blocks must carry a source object"
  if (block.source.type === "base64") {
    if (typeof block.source.media_type !== "string" || typeof block.source.data !== "string")
      return "image base64 sources must carry media_type and data"
    if (!block.source.media_type.startsWith("image/"))
      return `unsupported image media_type: ${block.source.media_type}`
    return Message.media(Media.base64(block.source.data, block.source.media_type))
  }
  if (block.source.type === "url") {
    if (typeof block.source.url !== "string") return "image url sources must carry a url"
    return Message.media(Media.url(block.source.url))
  }
  return `unsupported image source type: ${String(block.source.type)} (supported: base64, url)`
}

const parseMessagesToolResult = (
  block: Record<string, unknown>,
  toolNames: Map<string, string>,
): ContentPart | string => {
  if (typeof block.tool_use_id !== "string") return "tool_result blocks must carry tool_use_id"
  let result: unknown = ""
  let resultType: "text" | "json" | "error" = "text"
  if (typeof block.content === "string") {
    result = block.content
  } else if (Array.isArray(block.content)) {
    const texts: string[] = []
    let structured: unknown
    let hasStructured = false
    for (const item of block.content) {
      if (!isRecord(item)) return "tool_result content blocks must be objects"
      if (item.type === "text") {
        if (typeof item.text !== "string") return "tool_result text blocks must carry text"
        texts.push(item.text)
        continue
      }
      if (item.type === "json") {
        structured = item.json
        hasStructured = true
        continue
      }
      return `unsupported tool_result content block type: ${String(item.type)}`
    }
    if (hasStructured && texts.length) return "tool_result content must not mix text and json blocks in this door"
    if (hasStructured) {
      result = structured
      resultType = "json"
    } else {
      result = texts.join("")
    }
  } else if (block.content !== undefined) {
    return "tool_result content must be a string or an array of blocks"
  }
  if (block.is_error === true) resultType = "error"
  return ToolResultPart.make({
    id: block.tool_use_id,
    name: toolNames.get(block.tool_use_id) ?? "tool",
    result,
    resultType,
  })
}

const parseMessagesBlocks = (
  entry: Record<string, unknown>,
  toolNames: Map<string, string>,
): { readonly parts: ContentPart[]; readonly toolResults: ContentPart[] } | string => {
  const parts: ContentPart[] = []
  const toolResults: ContentPart[] = []
  if (typeof entry.content === "string") {
    if (entry.content) parts.push(Message.text(entry.content))
    return { parts, toolResults }
  }
  if (!Array.isArray(entry.content)) return "message content must be a string or an array of blocks"
  if (entry.content.length === 0) return "messages must carry at least one content block"
  for (const block of entry.content) {
    if (!isRecord(block) || typeof block.type !== "string")
      return "content blocks must be objects with a type"
    if (block.type === "text") {
      if (typeof block.text !== "string") return "text blocks must carry text"
      parts.push(Message.text(block.text))
      continue
    }
    if (block.type === "image") {
      if (entry.role !== "user") return "image blocks are only supported in user messages"
      const image = parseMessagesImage(block)
      if (typeof image === "string") return image
      parts.push(image)
      continue
    }
    if (block.type === "tool_use") {
      if (entry.role !== "assistant") return "tool_use blocks are only supported in assistant messages"
      if (typeof block.id !== "string" || typeof block.name !== "string")
        return "tool_use blocks must carry an id and a name"
      toolNames.set(block.id, block.name)
      parts.push(ToolCallPart.make({ id: block.id, name: block.name, input: block.input ?? {} }))
      continue
    }
    if (block.type === "tool_result") {
      if (entry.role !== "user") return "tool_result blocks are only supported in user messages"
      const result = parseMessagesToolResult(block, toolNames)
      if (typeof result === "string") return result
      toolResults.push(result)
      continue
    }
    if (block.type === "thinking" || block.type === "redacted_thinking")
      return `${block.type} blocks in input are not supported by this door (they are provider-internal and cannot round-trip)`
    return `unsupported content block type: ${block.type}`
  }
  if (toolResults.length && parts.length)
    return "tool_result blocks must not be mixed with other content blocks in one message in this door; send them in their own user message"
  return { parts, toolResults }
}

export const parseMessagesRequest = (body: unknown): ParseMessagesResult => {
  if (!isRecord(body)) return { ok: false, error: "request body must be a JSON object" }
  for (const field of ["thinking", "context_management", "mcp_servers", "container", "service_tier"] as const) {
    if (body[field] !== undefined) return { ok: false, error: `${field} is not supported by this door` }
  }
  if (isRecord(body.metadata) && body.metadata.user_id !== undefined)
    return { ok: false, error: "metadata.user_id is not supported by this door" }
  if (!Array.isArray(body.messages)) return { ok: false, error: "messages must be an array" }
  if (typeof body.max_tokens !== "number") return { ok: false, error: "max_tokens is required and must be a number" }
  const model = parseModel(body.model)
  if (typeof model === "string") return { ok: false, error: model }

  const tools: ToolDefinition.Input[] = []
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { ok: false, error: "tools must be an array" }
    for (const tool of body.tools) {
      if (!isRecord(tool)) return { ok: false, error: "each tool must be an object" }
      if (typeof tool.type === "string" && tool.type !== "custom")
        return { ok: false, error: `server tools are not supported by this door: ${tool.type}` }
      if (typeof tool.name !== "string") return { ok: false, error: "tools must carry a name" }
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      })
    }
  }

  let toolChoice: ToolChoice.Input | undefined
  if (body.tool_choice !== undefined) {
    if (!isRecord(body.tool_choice)) return { ok: false, error: "unsupported tool_choice" }
    const disable = body.tool_choice.disable_parallel_tool_use === true ? { disableParallelToolUse: true } : {}
    if (body.tool_choice.type === "auto") toolChoice = { type: "auto", ...disable }
    else if (body.tool_choice.type === "any") toolChoice = { type: "required", ...disable }
    else if (body.tool_choice.type === "none") toolChoice = { type: "none" }
    else if (body.tool_choice.type === "tool") {
      if (typeof body.tool_choice.name !== "string") return { ok: false, error: "tool_choice of type tool must carry a name" }
      toolChoice = { type: "tool", name: body.tool_choice.name, ...disable }
    } else return { ok: false, error: `unsupported tool_choice type: ${String(body.tool_choice.type)}` }
  }

  let system: string | undefined
  if (typeof body.system === "string") {
    system = body.system
  } else if (Array.isArray(body.system)) {
    const texts: string[] = []
    for (const block of body.system) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string")
        return { ok: false, error: "only text blocks are supported in the system field by this door" }
      texts.push(block.text)
    }
    system = texts.join("")
  } else if (body.system !== undefined) {
    return { ok: false, error: "system must be a string or an array of text blocks" }
  }

  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every((s) => typeof s === "string")))
    return { ok: false, error: "stop_sequences must be an array of strings" }

  const messages: Array<Message | Message.Input> = []
  const toolNames = new Map<string, string>()
  for (const entry of body.messages) {
    if (!isRecord(entry) || typeof entry.role !== "string")
      return { ok: false, error: "each message must be an object with a role" }
    if (entry.role === "system")
      return { ok: false, error: "system content belongs in the top-level system field, not in messages" }
    if (entry.role !== "user" && entry.role !== "assistant")
      return { ok: false, error: `unsupported message role: ${entry.role}` }
    if (entry.content === undefined) return { ok: false, error: "each message must carry content" }
    const parsedBlocks = parseMessagesBlocks(entry, toolNames)
    if (typeof parsedBlocks === "string") return { ok: false, error: parsedBlocks }
    if (parsedBlocks.toolResults.length) {
      messages.push(Message.tool(parsedBlocks.toolResults[0] as ToolResultPart))
      for (const extra of parsedBlocks.toolResults.slice(1))
        messages.push(Message.tool(extra as ToolResultPart))
      continue
    }
    messages.push(entry.role === "user" ? Message.user(parsedBlocks.parts) : Message.assistant(parsedBlocks.parts))
  }

  return {
    ok: true,
    value: {
      modelLabel: model.label,
      stream: body.stream === true,
      input: {
        model: model.ref,
        system: system || undefined,
        messages,
        tools: tools.length ? tools : undefined,
        toolChoice,
        generation: {
          ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
          ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
          ...(typeof body.top_k === "number" ? { topK: body.top_k } : {}),
          maxTokens: body.max_tokens,
          ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences as string[] } : {}),
        },
      },
    },
  }
}

const messagesFrame = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

export const PING_FRAME = messagesFrame("ping", {})

/**
 * Anthropic error envelope for this door: `{type: "error", error:
 * {type, message}}` — deliberately NOT the OpenAI-shaped `errorBody`
 * the chat/responses doors use.
 */
export const messagesErrorBody = (message: string, type: string) => ({ type: "error", error: { type, message } })

export const messagesErrorFrame = (message: string) =>
  `event: error\ndata: ${JSON.stringify(messagesErrorBody(message, "api_error"))}\n\n`

interface MessagesBlockSlot {
  readonly index: number
  closed: boolean
}

/**
 * Stateful Anthropic SSE translator: internal LLM events in, typed
 * Messages frames out. `start()` emits `message_start` plus a `ping`
 * (the dialect's keep-alive event); text, thinking, and tool_use
 * content blocks follow the content_block_start/delta/stop grammar
 * with per-block indices; the finish event closes any open block, then
 * emits `message_delta` (stop_reason plus cumulative usage) and
 * `message_stop`. A provider failure terminates the stream with an
 * `error` event — never a clean `message_stop` over partial output.
 */
export class MessagesStreamTranslator {
  failed = false
  private nextIndex = 0
  private readonly textBlocks = new Map<string, MessagesBlockSlot>()
  private readonly reasoningBlocks = new Map<string, MessagesBlockSlot>()
  private readonly toolBlocks = new Map<string, MessagesBlockSlot & { name: string }>()
  private usage: Usage | undefined

  constructor(private readonly meta: { readonly id: string; readonly model: string }) {}

  start(): string {
    return (
      messagesFrame("message_start", {
        message: {
          id: this.meta.id,
          type: "message",
          role: "assistant",
          model: this.meta.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: messagesUsageBody(undefined),
        },
      }) + PING_FRAME
    )
  }

  private open(map: Map<string, MessagesBlockSlot>, id: string, block: Record<string, unknown>): string {
    const slot = { index: this.nextIndex++, closed: false }
    map.set(id, slot)
    return messagesFrame("content_block_start", { index: slot.index, content_block: block })
  }

  private close(slot: MessagesBlockSlot): string {
    slot.closed = true
    return messagesFrame("content_block_stop", { index: slot.index })
  }

  push(event: LLMEvent): string[] {
    switch (event.type) {
      case "text-start": {
        if (this.textBlocks.has(String(event.id))) return []
        return [this.open(this.textBlocks, String(event.id), { type: "text", text: "" })]
      }
      case "text-delta": {
        const frames: string[] = []
        if (!this.textBlocks.has(String(event.id)))
          frames.push(this.open(this.textBlocks, String(event.id), { type: "text", text: "" }))
        const slot = this.textBlocks.get(String(event.id))!
        frames.push(
          messagesFrame("content_block_delta", { index: slot.index, delta: { type: "text_delta", text: event.text } }),
        )
        return frames
      }
      case "text-end": {
        const slot = this.textBlocks.get(String(event.id))
        return slot && !slot.closed ? [this.close(slot)] : []
      }
      case "reasoning-start": {
        if (this.reasoningBlocks.has(String(event.id))) return []
        return [this.open(this.reasoningBlocks, String(event.id), { type: "thinking", thinking: "" })]
      }
      case "reasoning-delta": {
        const frames: string[] = []
        if (!this.reasoningBlocks.has(String(event.id)))
          frames.push(this.open(this.reasoningBlocks, String(event.id), { type: "thinking", thinking: "" }))
        const slot = this.reasoningBlocks.get(String(event.id))!
        frames.push(
          messagesFrame("content_block_delta", {
            index: slot.index,
            delta: { type: "thinking_delta", thinking: event.text },
          }),
        )
        return frames
      }
      case "reasoning-end": {
        const slot = this.reasoningBlocks.get(String(event.id))
        return slot && !slot.closed ? [this.close(slot)] : []
      }
      case "tool-input-start": {
        if (this.toolBlocks.has(String(event.id))) return []
        const slot = { index: this.nextIndex++, closed: false, name: event.name }
        this.toolBlocks.set(String(event.id), slot)
        return [
          messagesFrame("content_block_start", {
            index: slot.index,
            content_block: { type: "tool_use", id: String(event.id), name: event.name, input: {} },
          }),
        ]
      }
      case "tool-input-delta": {
        const slot = this.toolBlocks.get(String(event.id))
        if (!slot) return []
        return [
          messagesFrame("content_block_delta", {
            index: slot.index,
            delta: { type: "input_json_delta", partial_json: event.text },
          }),
        ]
      }
      case "tool-input-end": {
        const slot = this.toolBlocks.get(String(event.id))
        return slot && !slot.closed ? [this.close(slot)] : []
      }
      case "tool-call": {
        const existing = this.toolBlocks.get(String(event.id))
        if (existing) return existing.closed ? [] : [this.close(existing)]
        const slot = { index: this.nextIndex++, closed: false, name: event.name }
        this.toolBlocks.set(String(event.id), slot)
        return [
          messagesFrame("content_block_start", {
            index: slot.index,
            content_block: { type: "tool_use", id: String(event.id), name: event.name, input: {} },
          }),
          messagesFrame("content_block_delta", {
            index: slot.index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input ?? {}) },
          }),
          this.close(slot),
        ]
      }
      case "step-finish": {
        if (event.usage) this.usage = event.usage
        return []
      }
      case "finish": {
        const usage = event.usage ?? this.usage
        const frames: string[] = []
        for (const slot of [...this.textBlocks.values(), ...this.reasoningBlocks.values(), ...this.toolBlocks.values()])
          if (!slot.closed) frames.push(this.close(slot))
        const stop = messagesStop(
          event.reason.normalized,
          event.reason.raw,
          this.toolBlocks.size > 0,
          stopSequenceOf(event.providerMetadata),
        )
        frames.push(
          messagesFrame("message_delta", {
            delta: { stop_reason: stop.stop_reason, stop_sequence: stop.stop_sequence },
            usage: messagesUsageBody(usage),
          }),
        )
        frames.push(messagesFrame("message_stop", {}))
        return frames
      }
      case "provider-error":
        this.failed = true
        return [messagesErrorFrame(event.message)]
      default:
        return []
    }
  }
}
