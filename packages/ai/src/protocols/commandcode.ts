// The Command Code /alpha/generate protocol — the Command Code CLI's own
// wire format, folded into the fork as a native provider protocol
// (#6117). Extracted from the installed CLI itself (command-code 1.74.1,
// dist/cli.mjs: createModelClient / consumeStream / toWireMessages /
// toWireTools / toWireSystem / buildCommandApiHeaders), not from the
// vendor's Provider API docs:
//
//   POST https://api.commandcode.ai/alpha/generate
//   Headers: Authorization: Bearer + the API key (the `cmd login` key from
//     ~/.commandcode/auth.json — see providers/commandcode-auth.ts),
//     Content-Type: application/json, User-Agent: cli,
//     x-command-code-version: <CLI version>, x-cli-environment: production
//   Body: { config: <server config>, memory: null, taste: null,
//     skills: null,
//     permissionMode: "standard", threadId?: "<uuid>",
//     params: { model: "<catalog id, e.g. deepseek/deepseek-v4-flash>",
//       messages: <wire messages>, tools?: [{ name, description,
//       input_schema }], system?: [{ type: "text", text }],
//       max_tokens: 64000, stream: true, temperature?,
//       reasoning_effort? } }
//
// The `config` object is the CLI's buildServerConfig: the environment
// block of ITS working directory ({ workingDir, date (YYYY-MM-DD),
// environment (platform), structure (sorted non-hidden top-level
// entries), isGitRepo, currentBranch, mainBranch, gitStatus,
// recentCommits }) — the gateway validates all nine fields (a bare {}
// is a 400, probed live 2026-11-05). The lowering below builds the same
// shape from the server process (its cwd/date/platform/directory
// listing, with the CLI's own non-git fallback for the git fields —
// this protocol does not shell out to git); a deployment can supply
// the whole object via the `serverConfig` provider option.
//
// The hosted Provider API (api.commandcode.ai/provider/v1, OpenAI /
// Anthropic shaped) is a different surface: it rejects the fleet's Go
// plan outright ("Your Go plan doesn't include API access", 403
// upgrade_required — bin/commandcode-proxy.mjs in developing-today/code
// and opencode#1411). /alpha/generate is the endpoint the CLI itself
// uses on every turn and is not plan-gated, which is why the emulation
// targets it: same credential, same metering windows (the fork's
// command-code quota provider reads /alpha/whoami + /alpha/billing).
//
// Wire messages are the Vercel-AI-SDK-shaped ModelMessage forms the
// CLI's toWire* converters produce:
//   user:      content [{ type: "text", text } |
//                       { type: "image", image: "data:<mime>;base64,..", mimeType }]
//   assistant: content [{ type: "text", text } |
//                       { type: "reasoning", text } |
//                       { type: "tool-call", toolCallId, toolName, input }]
//   tool:      content [{ type: "tool-result", toolCallId, toolName,
//                         output: { type: "text", value } }]
// The response is an NDJSON stream (one JSON object per line):
//   { type: "text-delta", text } / { type: "reasoning-start" } /
//   { type: "reasoning-delta", text } / { type: "reasoning-end" } /
//   { type: "tool-call", toolCallId, toolName, input, providerExecuted? } /
//   { type: "tool-result", toolCallId, toolName, output|result, isError? }
//     (server-executed calls only) /
//   { type: "finish", finishReason, rawFinishReason?,
//     totalUsage: { inputTokens, outputTokens,
//       inputTokenDetails: { cacheReadTokens, cacheWriteTokens } } } /
//   { type: "error", error: string | { message, statusCode?, isRetryable? } } /
//   { type: "abort" }
//
// Doctrine notes (code#6117):
//   * Client tools are declared in params.tools and stream back as real
//     client tool calls — the property the retired CLI bridge
//     (bin/commandcode-proxy.mjs) could not provide: it reduced the
//     client's tools to a prose manifest and ran the CLI's own tools
//     instead, returning only a text summary.
//   * The CLI's params carry NO tool_choice field (createModelClient
//     never sends one), so a forced choice (required / a named tool)
//     cannot be honored on this wire. Lowering fails closed with an
//     invalid-request error rather than silently downgrading to auto.
//     `none` is honored faithfully by omitting params.tools.
//   * A stream that ends without a finish (or abort) event is a hard
//     error, exactly the CLI's own guard in consumeStream.
import { readdirSync } from "node:fs"
import { Effect, Schema } from "effect"
import { Route } from "../route/client.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport } from "../route/transport/index.js"
import {
  AIError,
  LLMEvent,
  Usage,
  type FinishReason,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type ProviderOptions,
  type ToolDefinition,
} from "../schema/index.js"
import { classifyProviderFailure } from "../provider-error.js"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared.js"
import { Lifecycle } from "./utils/lifecycle.js"

const ADAPTER = "commandcode"
export const DEFAULT_BASE_URL = "https://api.commandcode.ai"
export const PATH = "/alpha/generate"
/** The CLI's own default output cap when a turn sets none (bundle: hC = 64e3). */
export const DEFAULT_MAX_TOKENS = 64_000

export type OptionsInput = ProviderOptions & typeof Options.Encoded
export type ProviderOptionsInput = OptionsInput

const Options = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.String),
  reasoning_effort: Schema.optional(Schema.String),
  /** Wire permissionMode (bundle: "standard" | "auto-accept" | "plan"); defaults to "standard". */
  permissionMode: Schema.optional(Schema.String),
  /** Resume a gateway thread: only uuid thread ids are sent (bundle: toWireThreadId). */
  threadId: Schema.optional(Schema.String),
  /** Full replacement for the built server config (the bundle's buildServerConfig shape). */
  serverConfig: Schema.optional(
    Schema.Struct({
      workingDir: Schema.String,
      date: Schema.String,
      environment: Schema.String,
      structure: Schema.Array(Schema.String),
      isGitRepo: Schema.Boolean,
      currentBranch: Schema.String,
      mainBranch: Schema.String,
      gitStatus: Schema.String,
      recentCommits: Schema.Array(Schema.String),
    }),
  ),
})
const decodeOptions = ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))

// =============================================================================
// Request body schema (the bundle's postStream body, field for field)
// =============================================================================
const WireTextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const WireImagePart = Schema.Struct({ type: Schema.Literal("image"), image: Schema.String, mimeType: Schema.String })
const WireReasoningPart = Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String })
const WireToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
})
const WireToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  output: Schema.Struct({ type: Schema.Literal("text"), value: Schema.String }),
})
const WireContentPart = Schema.Union([
  WireTextPart,
  WireImagePart,
  WireReasoningPart,
  WireToolCallPart,
  WireToolResultPart,
])
const WireMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  content: Schema.Array(WireContentPart),
})
const WireTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: JsonObject,
})
const WireSystemPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const Params = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(WireMessage),
  tools: optionalArray(WireTool),
  system: optionalArray(WireSystemPart),
  max_tokens: Schema.Number,
  stream: Schema.Literal(true),
  temperature: Schema.optional(Schema.Number),
  reasoning_effort: Schema.optional(Schema.String),
})
const ServerConfig = Schema.Struct({
  workingDir: Schema.String,
  date: Schema.String,
  environment: Schema.String,
  structure: Schema.Array(Schema.String),
  isGitRepo: Schema.Boolean,
  currentBranch: Schema.String,
  mainBranch: Schema.String,
  gitStatus: Schema.String,
  recentCommits: Schema.Array(Schema.String),
})
const Body = Schema.Struct({
  config: ServerConfig,
  memory: Schema.Null,
  taste: Schema.Null,
  skills: Schema.Null,
  permissionMode: Schema.String,
  threadId: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  promptCache: Schema.optional(Schema.Boolean),
  params: Params,
})
export type CommandCodeBody = typeof Body.Type

// =============================================================================
// Stream event schema (the bundle's consumeStream event vocabulary)
// =============================================================================
// Both stream structs carry a Record rest: the gateway's event
// vocabulary is the CLI's private protocol and grows fields the client
// ignores (live-captured 2026-11-05: totalUsage.noCacheTokens /
// totalTokens / reasoningTokens, tool-input-* ids and deltas). Unknown
// fields must decode through, never fail the stream.
const WireUsageDetails = Schema.StructWithRest(
  Schema.Struct({
    cacheReadTokens: optionalNull(Schema.Number),
    cacheWriteTokens: optionalNull(Schema.Number),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const WireUsage = Schema.StructWithRest(
  Schema.Struct({
    inputTokens: optionalNull(Schema.Number),
    outputTokens: optionalNull(Schema.Number),
    totalTokens: optionalNull(Schema.Number),
    reasoningTokens: optionalNull(Schema.Number),
    inputTokenDetails: Schema.optional(WireUsageDetails),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const Event = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    text: optionalNull(Schema.String),
    toolCallId: optionalNull(Schema.String),
    toolName: optionalNull(Schema.String),
    input: Schema.optional(Schema.Unknown),
    args: Schema.optional(Schema.Unknown),
    output: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    isError: Schema.optional(Schema.Boolean),
    providerExecuted: Schema.optional(Schema.Boolean),
    finishReason: optionalNull(Schema.String),
    rawFinishReason: optionalNull(Schema.String),
    totalUsage: Schema.optional(WireUsage),
    error: Schema.optional(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type Event = typeof Event.Type

interface ParserState {
  readonly route: string
  readonly providerMetadataKey: string
  readonly lifecycle: Lifecycle.State
  readonly textId?: string
  readonly reasoningId?: string
  readonly nextTextId: number
  readonly nextReasoningId: number
  readonly hasToolCalls: boolean
  readonly finishReason?: string
  readonly rawFinishReason?: string
  readonly usage?: typeof WireUsage.Type
  readonly sawFinish: boolean
  readonly emittedFinish: boolean
  readonly aborted: boolean
}

// =============================================================================
// Request lowering (the bundle's createModelClient body, over LLMRequest)
// =============================================================================
const lowerTool = (tool: ToolDefinition): typeof WireTool.Type => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: tool.inputSchema ?? { type: "object", properties: {} },
})

const lowerMediaPart = Effect.fnUntraced(function* (part: MediaPart) {
  const inline = yield* ProviderShared.requireInlineMedia("Command Code", part.media)
  return { type: "image" as const, image: inline.dataUrl, mimeType: inline.mime }
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The CLI's buildServerConfig, from the server process: its cwd, today's
 * date, its platform, and the sorted non-hidden top-level entries of the
 * cwd (the bundle's readStructure also appends scope labels and excludes
 * a small ignore set). Git fields take the bundle's own non-git fallback
 * shape — a protocol lowering does not shell out to git.
 */
export const buildServerConfig = (): typeof ServerConfig.Type => {
  const workingDir = process.cwd()
  let structure: Array<string> = []
  try {
    structure = readdirSync(workingDir, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules")
      .sort()
  } catch {
    structure = []
  }
  return {
    workingDir,
    date: new Date().toISOString().slice(0, 10),
    environment: process.platform,
    structure,
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  }
}

const fromRequest = Effect.fn("CommandCode.fromRequest")(function* (request: LLMRequest) {
  const flattened = ProviderShared.flattenToolRequest(request)
  const lowered = flattened.request
  const options = yield* decodeOptions(request.providerOptions ?? {})

  // Fail closed on a forced tool choice: the wire has no tool_choice
  // field, so honoring one is impossible and downgrading it to auto
  // would be the silent substitution #6117 exists to kill.
  if (request.toolChoice !== undefined && request.toolChoice.type !== "auto" && request.toolChoice.type !== "none")
    return yield* ProviderShared.invalidRequest(
      `Command Code's /alpha/generate wire carries no tool_choice field, so a forced tool choice ` +
        `(${request.toolChoice.type}) cannot be honored; failing closed instead of silently downgrading it to auto`,
    )
  const toolsSuppressed = request.toolChoice?.type === "none"

  const systemParts: Array<{ type: "text"; text: string }> = request.system
    .filter((part) => part.text.length > 0)
    .map((part) => ({ type: "text" as const, text: part.text }))

  const messages: Array<typeof WireMessage.Type> = []
  for (const message of lowered.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Command Code", message)
      systemParts.push({ type: "text", text: part.text })
      continue
    }
    if (message.role === "user") {
      const content: Array<typeof WireContentPart.Type> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "media"]))
          return yield* ProviderShared.unsupportedContent("Command Code", "user", ["text", "media"])
        if (part.type === "text") {
          if (part.text) content.push({ type: "text", text: part.text })
          continue
        }
        content.push(yield* lowerMediaPart(part))
      }
      if (content.length) messages.push({ role: "user", content })
      continue
    }
    if (message.role === "assistant") {
      const content: Array<typeof WireContentPart.Type> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
          return yield* ProviderShared.unsupportedContent("Command Code", "assistant", [
            "text",
            "reasoning",
            "tool-call",
          ])
        if (part.type === "text") {
          if (part.text) content.push({ type: "text", text: part.text })
          continue
        }
        if (part.type === "reasoning") {
          if (part.text) content.push({ type: "reasoning", text: part.text })
          continue
        }
        // The bundle's toWireMessages skips provider-executed calls in
        // history: the gateway already ran them and their results ride
        // as tool messages.
        if (part.providerExecuted) continue
        content.push({ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input ?? {} })
      }
      if (content.length) messages.push({ role: "assistant", content })
      continue
    }
    // Tool results: one wire tool message per core tool message, each
    // part carrying the bundle's { type: "text", value } output shape.
    const content: Array<typeof WireContentPart.Type> = []
    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Command Code", "tool", ["tool-result"])
      content.push({
        type: "tool-result",
        toolCallId: part.id,
        toolName: part.name,
        output: { type: "text", value: ProviderShared.toolResultText(part) },
      })
    }
    if (content.length) messages.push({ role: "tool", content })
  }

  const generation = request.generation
  const effort = options.reasoningEffort ?? options.reasoning_effort
  return {
    config: options.serverConfig ?? buildServerConfig(),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: options.permissionMode ?? "standard",
    threadId: options.threadId !== undefined && UUID_PATTERN.test(options.threadId) ? options.threadId : undefined,
    mode: undefined,
    promptCache: undefined,
    params: {
      model: String(request.model.id),
      messages,
      tools: toolsSuppressed || flattened.tools.length === 0 ? undefined : flattened.tools.map(lowerTool),
      // The bundle's toWireSystem: every system section but the last
      // carries a trailing newline.
      system:
        systemParts.length === 0
          ? undefined
          : systemParts.map((part, index) => ({
              type: "text" as const,
              text: index < systemParts.length - 1 ? `${part.text}\n` : part.text,
            })),
      max_tokens: generation?.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true as const,
      temperature: generation?.temperature,
      reasoning_effort: effort,
    },
  }
})

// =============================================================================
// Stream parsing (the bundle's consumeStream, as LLMEvents)
// =============================================================================
const mapUsage = (usage: typeof WireUsage.Type | undefined, metadataKey: string) => {
  if (!usage) return undefined
  const inputTokens = usage.inputTokens ?? undefined
  const outputTokens = usage.outputTokens ?? undefined
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? undefined
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? undefined
  return new Usage({
    inputTokens,
    outputTokens,
    nonCachedInputTokens: ProviderShared.subtractTokens(inputTokens, cacheRead),
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: usage.reasoningTokens ?? undefined,
    totalTokens: ProviderShared.totalTokens(inputTokens, outputTokens, usage.totalTokens ?? undefined),
    providerMetadata: { [metadataKey]: { ...usage } } as ProviderMetadata,
  })
}

// Finish mapping (#1755): tool spellings win, then length; the honest
// outcomes come next — a content-filter finish is not a stop, an error
// or abort finish is not a stop either (an abort still emits the finish
// event so partial text stays usable; the raw reason is preserved on
// the event). Recognized stop spellings (and no reason) map to stop;
// anything else unrecognized maps to unknown rather than being
// silently reported as a clean stop.
const mapFinishReason = (raw: string | undefined, hasToolCalls: boolean): FinishReason => {
  if (hasToolCalls) return "tool-calls"
  switch ((raw ?? "").toLowerCase()) {
    case "tool_use":
    case "tool-calls":
    case "tool_calls":
      return "tool-calls"
    case "length":
    case "max_tokens":
      return "length"
    case "content-filter":
    case "content_filter":
    case "content_filtering":
      return "content-filter"
    case "error":
    case "failed":
    case "failure":
    case "abort":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "error"
    case "":
    case "stop":
    case "end_turn":
    case "end-turn":
    case "stop_sequence":
      return "stop"
    default:
      return "unknown"
  }
}

const finishEvents = (state: ParserState, raw: string | undefined): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  Lifecycle.finish(state.lifecycle, events, {
    reason: { normalized: mapFinishReason(raw, state.hasToolCalls), raw },
    usage: mapUsage(state.usage, state.providerMetadataKey),
  })
  return events
}

const serverToolOutputText = (event: Event): { text: string; isError: boolean } => {
  // The bundle's formatServerToolOutput: an object output passes through
  // as JSON; a string result/output is used verbatim; isError flips the
  // output kind to error-text.
  const value = event.output ?? event.result ?? ""
  const text = typeof value === "string" ? value : ProviderShared.encodeJson(value)
  return { text, isError: event.isError === true }
}

const step: (
  state: ParserState,
  event: Event,
) => Effect.Effect<readonly [ParserState, ReadonlyArray<LLMEvent>], AIError> = (state, event) => {
  // Tool-call inputs arrive as JSON values on this wire; a string form
  // is parsed through the shared tool-input parser (invalid JSON at
  // finish is a hard error there, never a silent repair).
  // The gateway can trail bookkeeping events (provider-metadata) after
  // finish; once the finish events are emitted the stream is terminal
  // and anything further is a no-op (the bundle's consumeStream keeps
  // reading to end-of-stream the same way).
  if (state.emittedFinish) return Effect.succeed([state, []] as const)
  // A tool-call or tool-result event without a name or an id is malformed gateway
  // output (#1756): it used to vanish silently (nameless) or be
  // emitted with a colliding empty id. Fail the stream loudly, the
  // same contract as the truncated-stream and invalid-tool-input
  // failures — there is no safe fallback identity to invent.
  if (event.type === "tool-call" || event.type === "tool-result") {
    const missing = !event.toolName ? "toolName" : !event.toolCallId ? "toolCallId" : null
    if (missing !== null) {
      return Effect.fail(
        ProviderShared.eventError(
          state.route,
          `Command Code ${event.type} event is missing its ${missing}; malformed ${event.type} events fail the stream`,
          ProviderShared.encodeJson(event),
        ),
      )
    }
  }
  if (event.type === "tool-call" && typeof (event.input ?? event.args) === "string") {
    const raw = (event.input ?? event.args) as string
    return ProviderShared.parseToolInput(state.route, event.toolName ?? "", raw).pipe(
      Effect.flatMap((input) => step(state, { ...event, input, args: undefined })),
    )
  }
  if (event.type === "error") {
    const raw = event.error
    const message =
      typeof raw === "string" && raw.length > 0
        ? raw
        : ProviderShared.isRecord(raw) && typeof raw.message === "string" && raw.message.length > 0
          ? raw.message
          : "Command Code provider error"
    const status = ProviderShared.isRecord(raw) && typeof raw.statusCode === "number" ? raw.statusCode : undefined
    return Effect.fail(
      new AIError({
        reason: classifyProviderFailure({ message, status, rawBody: ProviderShared.encodeJson(event) }),
      }),
    )
  }

  const events: LLMEvent[] = []
  let lifecycle = state.lifecycle
  let textId = state.textId
  let reasoningId = state.reasoningId
  let nextTextId = state.nextTextId
  let nextReasoningId = state.nextReasoningId
  let hasToolCalls = state.hasToolCalls
  let usage = state.usage
  let finishReason = state.finishReason
  let rawFinishReason = state.rawFinishReason
  let sawFinish = state.sawFinish
  let aborted = state.aborted

  const endReasoning = () => {
    if (reasoningId !== undefined) {
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, reasoningId)
      reasoningId = undefined
    }
  }
  const endText = () => {
    if (textId !== undefined) {
      lifecycle = Lifecycle.textEnd(lifecycle, events, textId)
      textId = undefined
    }
  }

  switch (event.type) {
    case "text-delta": {
      if (event.text) {
        endReasoning()
        if (textId === undefined) {
          textId = `text-${nextTextId}`
          nextTextId += 1
        }
        lifecycle = Lifecycle.textDelta(lifecycle, events, textId, event.text)
      }
      break
    }
    case "reasoning-start": {
      endText()
      if (reasoningId === undefined) {
        reasoningId = `reasoning-${nextReasoningId}`
        nextReasoningId += 1
        lifecycle = Lifecycle.reasoningStart(lifecycle, events, reasoningId)
      }
      break
    }
    case "reasoning-delta": {
      if (event.text) {
        endText()
        if (reasoningId === undefined) {
          reasoningId = `reasoning-${nextReasoningId}`
          nextReasoningId += 1
        }
        lifecycle = Lifecycle.reasoningDelta(lifecycle, events, reasoningId, event.text)
      }
      break
    }
    case "reasoning-end": {
      endReasoning()
      break
    }
    case "tool-call": {
      endReasoning()
      endText()
      const name = event.toolName ?? ""
      const id = event.toolCallId ?? ""
      if (name) {
        lifecycle = Lifecycle.stepStart(lifecycle, events)
        const input = event.input ?? event.args ?? {}
        events.push(
          LLMEvent.toolCall({
            id,
            name,
            input,
            ...(event.providerExecuted ? { providerExecuted: true } : {}),
          }),
        )
        if (!event.providerExecuted) hasToolCalls = true
      }
      break
    }
    case "tool-result": {
      // Stream tool-results are the gateway's own executions (the
      // bundle's server_tool_result): surface them as provider-executed
      // results, never as client executions.
      const { text, isError } = serverToolOutputText(event)
      events.push(
        LLMEvent.toolResult({
          id: event.toolCallId ?? "",
          name: event.toolName ?? "",
          result: isError ? { type: "error", value: text } : { type: "text", value: text },
          providerExecuted: true,
        }),
      )
      break
    }
    case "finish": {
      sawFinish = true
      finishReason = event.finishReason ?? finishReason
      rawFinishReason = event.rawFinishReason ?? rawFinishReason
      usage = event.totalUsage ?? usage
      break
    }
    case "abort": {
      aborted = true
      break
    }
    default:
      // provider-metadata / cache-write-tokens and any future bookkeeping
      // events carry no client-visible content; the bundle consumes and
      // drops them the same way.
      break
  }

  const next: ParserState = {
    ...state,
    lifecycle,
    textId,
    reasoningId,
    nextTextId,
    nextReasoningId,
    hasToolCalls,
    usage,
    finishReason,
    rawFinishReason,
    sawFinish,
    aborted,
  }
  if (sawFinish) {
    return Effect.succeed([
      { ...next, lifecycle: Lifecycle.initial(), emittedFinish: true },
      [...events, ...finishEvents(next, rawFinishReason ?? finishReason)],
    ] as const)
  }
  return Effect.succeed([next, events] as const)
}

const onHalt = (state: ParserState) => {
  if (state.emittedFinish || state.sawFinish) return Effect.succeed([] as ReadonlyArray<LLMEvent>)
  if (state.aborted) return Effect.succeed(finishEvents(state, "abort"))
  // The bundle's consumeStream guard: a stream that ends before its
  // finish event was truncated — fail loudly instead of presenting a
  // partial answer as complete.
  return Effect.fail(
    ProviderShared.eventError(
      state.route,
      "Command Code stream ended unexpectedly before completion (no finish event) — response was truncated",
    ),
  )
}

export const protocol = Protocol.make({
  id: ADAPTER,
  body: { schema: Body, from: fromRequest },
  stream: {
    event: Protocol.jsonEvent(Event),
    initial: (request): ParserState => ({
      route: `${request.model.provider}/${request.model.route.id}`,
      providerMetadataKey: request.model.route.providerMetadataKey ?? String(request.model.provider),
      lifecycle: Lifecycle.initial(),
      nextTextId: 0,
      nextReasoningId: 0,
      hasToolCalls: false,
      sawFinish: false,
      emittedFinish: false,
      aborted: false,
    }),
    step,
    onHalt,
  },
})

export const framing = Framing.lines
export const httpTransport = HttpTransport.sseJson.with<CommandCodeBody>().with({ framing })

export const route = Route.make({
  id: ADAPTER,
  provider: "commandcode",
  providerMetadataKey: "commandcode",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as CommandCode from "./commandcode.js"
