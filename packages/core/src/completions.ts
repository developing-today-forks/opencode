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
