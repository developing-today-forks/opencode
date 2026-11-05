// The Antigravity v1internal protocol — the agy CLI's own wire format,
// folded into the fork as a native provider protocol (#1414; the
// standalone door bin/antigravity-direct.mjs in developing-today/code
// is the reference implementation this ports, behaviour for behaviour).
//
//   POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
//   Headers: Authorization: Bearer <keyring OAuth access token>,
//     Content-Type: application/json, Accept-Encoding: gzip, and the
//     CLI's own User-Agent (supplied per request by the provider's auth
//     layer — see providers/antigravity.ts).
//   Body: { project: "aicode-consumers",
//     requestId: "agent/<uuid>/<ms>/<uuid>/1",
//     model: "<cli model id, e.g. gemini-3.8-flash-high>",
//     userAgent: "antigravity", requestType: "agent",
//     request: { contents, systemInstruction?, tools?, toolConfig?,
//       generationConfig: { maxOutputTokens,
//         thinkingConfig: { includeThoughts: true, thinkingLevel } },
//       sessionId: "<negative int64 as string>" } }
//
// Responses are the GenerateContent SSE stream wrapped per event in
// { response: { candidates, usageMetadata } }.
import { Effect, Schema } from "effect"
import { Route } from "../route/client.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport, type Transport, type TransportPrepareInput } from "../route/transport/index.js"
import {
  AIError,
  LLMEvent,
  Usage,
  type FinishReason,
  type LLMRequest,
  type ProviderMetadata,
  type ProviderOptions,
  type MediaPart,
  type ToolDefinition,
} from "../schema/index.js"
import { classifyProviderFailure } from "../provider-error.js"
import { Media } from "../media.js"
import { JsonObject, lenient, optionalArray, optionalNull, ProviderShared } from "./shared.js"
import { GeminiGenerateContent } from "./utils/gemini-generate-content.js"
import { Lifecycle } from "./utils/lifecycle.js"
import { AntigravityAuth } from "../providers/antigravity-auth.js"

const ADAPTER = "antigravity"
export const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"
const PROJECT = "aicode-consumers"
// Google documents this sentinel for replaying Gemini 3 function calls after their
// original signature was lost; the fork's Gemini protocol uses the same fallback.
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator"

export type OptionsInput = ProviderOptions & typeof Options.Encoded
export type ProviderOptionsInput = OptionsInput

// =============================================================================
// Model id + effort resolution (the door's resolveModelAndEffort)
// =============================================================================
const EFFORTS = ["low", "medium", "high"] as const
type Effort = (typeof EFFORTS)[number]

// The upstream catalog (v1internal:fetchAvailableModels, probed live
// 2026-11-05 on both daily-cloudcode-pa and cloudcode-pa — identical
// 26-key catalogs) carries TWO model-id shapes:
//   - effort families, keyed only as "<base>-<low|medium|high>"
//     (gemini-4-argon, gemini-3.8-flash, claude-sonnet-5-5,
//     claude-opus-5-5, gpt-oss-120b-medium): the suffix is part of the
//     wire id and must be appended, as the door always did.
//   - wire-complete ids, keyed bare (below): the id IS the whole wire
//     id. Appending an effort suffix mints an entity that does not
//     exist upstream — streamGenerateContent answers 404 NOT_FOUND
//     ("Requested entity was not found.") for e.g.
//     "gemini-2.5-flash-medium" / "gemini-3-flash-medium", while the
//     bare ids answer 200 (probed live 2026-11-05). For these models
//     the effort still drives generationConfig.thinkingLevel; it is
//     just not part of the model id.
// The list is the non-internal subset of the probed catalog (the
// chat_*/tab_* completion keys are not chat models and stay unlisted).
const WIRE_COMPLETE_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash-tiered",
])

export const resolveModelAndEffort = (requestedModel: string, requestedEffort?: string) => {
  let model = String(requestedModel ?? "").trim()
  let effort = requestedEffort ? String(requestedEffort).toLowerCase() : undefined
  const suffix = model.match(/^(.*)-(low|medium|high|xhigh|max)$/)
  if (suffix) {
    model = suffix[1]
    if (!effort) effort = suffix[2]
  }
  if (effort === "xhigh" || effort === "max") effort = "high"
  const resolved: Effort = effort !== undefined && (EFFORTS as ReadonlyArray<string>).includes(effort) ? (effort as Effort) : "medium"
  return { base: model, effort: resolved, fullName: WIRE_COMPLETE_MODELS.has(model) ? model : `${model}-${resolved}` }
}

// =============================================================================
// Tool schema conversion: client JSON Schema -> the v1internal proto Schema.
// Ported from the door (which follows the fork's Gemini schema normalizer,
// tightened to the field allowlist probed against this endpoint 2026-10-30,
// code#2825): the proto parser rejects any field name it does not know with
// a hard 400, so schemas are reduced to the proto vocabulary.
// One family split (opencode#1550, probed against the door 2026-11-03): for
// Claude models the upstream re-serializes the proto Schema into an
// Anthropic input_schema, and Anthropic's validator rejects `anyOf`
// outright (any branch count, any position) while accepting oneOf/allOf;
// Gemini models accept anyOf verbatim. So when the target is a Claude
// model (the `anthropic` flag threaded from fromRequest), anyOf is emitted
// as oneOf — tool unions are disjoint alternatives in practice, where
// exactly-one is the faithful reading.
// =============================================================================
const SCHEMA_FIELDS = new Set([
  "type", "format", "title", "description", "nullable", "default", "enum",
  "example", "items", "prefixItems", "minItems", "maxItems", "minProperties",
  "maxProperties", "properties", "propertyOrdering", "required", "minLength",
  "maxLength", "pattern", "minimum", "maximum", "anyOf", "oneOf", "allOf", "not",
])
const SCHEMA_VALUE_KEYS = new Set(["enum", "default", "example"])
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const resolveSchemaRefs = (root: Record<string, unknown>): unknown => {
  const lookup = (ref: string): unknown => {
    if (ref === "#") return root
    if (!ref.startsWith("#/")) return undefined
    let current: unknown = root
    for (const raw of ref.slice(2).split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~")
      if ((!isRecord(current) && !Array.isArray(current)) || (current as Record<string, unknown>)[segment] === undefined)
        return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    return current
  }
  const walk = (node: unknown, chain: ReadonlyArray<string>): unknown => {
    if (Array.isArray(node)) return node.map((value) => walk(value, chain))
    if (!isRecord(node)) return node
    if (typeof node.$ref === "string") {
      const { $ref, ...siblings } = node
      const target = $ref.startsWith("#") ? lookup($ref) : undefined
      const merged: Record<string, unknown> =
        target === undefined || chain.includes($ref) || chain.length >= 10 ? {} : { ...(walk(target, [...chain, $ref]) as Record<string, unknown>) }
      for (const [key, value] of Object.entries(siblings)) merged[key] = walk(value, chain)
      return merged
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (SCHEMA_VALUE_KEYS.has(key)) {
        out[key] = value
        continue
      }
      if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
        const sub: Record<string, unknown> = {}
        for (const [name, schema] of Object.entries(value)) sub[name] = walk(schema, chain)
        out[key] = sub
        continue
      }
      out[key] = walk(value, chain)
    }
    return out
  }
  return walk(root, [])
}

const convertSchemaNode = (node: unknown, anthropic = false): Record<string, unknown> => {
  // Boolean schemas (#1573): false is the never schema and the proto has no
  // boolean form, so encode it as { not: {} } (the negation of the
  // unconstrained schema). Returning {} for it — the old non-record
  // fallthrough — inverted it to "anything allowed" on the wire. True is
  // unconstrained and keeps converting to {}.
  if (node === false) return { not: {} }
  if (!isRecord(node)) return {}
  const out: Record<string, unknown> = {}
  let minimum = node.minimum
  let maximum = node.maximum
  if (typeof node.exclusiveMinimum === "number" && minimum === undefined) minimum = node.exclusiveMinimum
  if (typeof node.exclusiveMaximum === "number" && maximum === undefined) maximum = node.exclusiveMaximum
  let items = node.items
  let prefixItems = node.prefixItems
  if (Array.isArray(items)) {
    if (items.length && prefixItems === undefined) prefixItems = items
    items = undefined
  }
  if (prefixItems !== undefined && items === undefined) items = {}
  for (const [key, value] of Object.entries(node)) {
    if (!SCHEMA_FIELDS.has(key)) continue
    if (SCHEMA_VALUE_KEYS.has(key)) {
      out[key] = value
      continue
    }
    if (key === "properties") {
      if (isRecord(value)) {
        const props: Record<string, unknown> = {}
        for (const [name, sub] of Object.entries(value)) props[name] = convertSchemaNode(sub, anthropic)
        out.properties = props
      }
      continue
    }
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      if (Array.isArray(value)) {
        const branches = value.map((sub) => convertSchemaNode(sub, anthropic))
        if (key === "allOf") out.allOf = branches
        // anyOf folds into oneOf for Anthropic targets (#1550); a node
        // carrying both keywords merges both branch sets into the single
        // oneOf the Anthropic side accepts.
        else if (key === "oneOf" || anthropic)
          out.oneOf = Array.isArray(out.oneOf) ? [...out.oneOf, ...branches] : branches
        else out.anyOf = branches
      }
      continue
    }
    if (key === "not") {
      // not:false is "not never" — unconstrained — so the key is omitted
      // rather than emitting { not: { not: {} } } (#1573). not:true flows
      // through the normal path and lands as { not: {} } (never).
      if (value !== false) out.not = convertSchemaNode(value, anthropic)
      continue
    }
    if (key === "type" || key === "required" || key === "minimum" || key === "maximum" || key === "items" || key === "prefixItems") continue
    out[key] = value
  }
  if (minimum !== undefined) out.minimum = minimum
  if (maximum !== undefined) out.maximum = maximum
  if (items !== undefined) out.items = convertSchemaNode(items, anthropic)
  if (prefixItems !== undefined)
    out.prefixItems = (Array.isArray(prefixItems) ? prefixItems : [prefixItems]).map((sub) => convertSchemaNode(sub, anthropic))
  let nullable = node.nullable === true
  if (Array.isArray(node.type)) {
    const types = node.type.filter((entry): entry is string => typeof entry === "string")
    if (types.includes("null")) nullable = true
    const concrete = types.filter((entry) => entry !== "null")
    if (concrete.length === 1) out.type = concrete[0].toUpperCase()
    else if (concrete.length > 1) {
      // A multi-valued type union cannot ride the proto's single `type`
      // enum, so emit one branch per concrete member (#1556) through the
      // same branch machinery #1550 uses for anyOf: anyOf for Gemini
      // targets, oneOf for Anthropic, merged with any branches the node's
      // own anyOf handling already emitted on that side. The node's other
      // keywords stay on this node and keep applying to every branch; an
      // ARRAY branch carries the node's items/prefixItems (or an
      // unconstrained items, per #1548) because the proto requires items
      // on every ARRAY schema.
      const branches = concrete.map((entry) => {
        const branch: Record<string, unknown> = { type: entry.toUpperCase() }
        if (entry === "array") {
          if (out.items !== undefined) branch.items = out.items
          else if (out.prefixItems !== undefined) branch.prefixItems = out.prefixItems
          else branch.items = {}
        }
        return branch
      })
      if (anthropic) out.oneOf = [...(Array.isArray(out.oneOf) ? out.oneOf : []), ...branches]
      else out.anyOf = [...(Array.isArray(out.anyOf) ? out.anyOf : []), ...branches]
    }
  } else if (typeof node.type === "string") {
    out.type = node.type.toUpperCase()
  }
  if (nullable) out.nullable = true
  if (out.type === undefined && out.properties) out.type = "OBJECT"
  // The proto requires `items` on an ARRAY schema even when the client
  // leaves the element type unconstrained ("properties[paths].items:
  // missing field", #1548, probed live against the door 2026-11-03):
  // synthesize an unconstrained items — omitted items in JSON Schema
  // means any element.
  if (out.type === "ARRAY" && out.items === undefined && out.prefixItems === undefined) out.items = {}
  if (Array.isArray(node.required)) {
    const declared = out.properties && isRecord(out.properties) ? new Set(Object.keys(out.properties)) : new Set<string>()
    const required = node.required.filter((name): name is string => typeof name === "string" && declared.has(name))
    if (required.length) out.required = required
  }
  return out
}

/** Convert a client JSON Schema tool definition to the proto Schema the wire accepts. */
export const convertSchema = (schema: unknown, anthropic = false) => {
  // A false root is the never schema (#1573): return its encoding directly —
  // it never reaches convertSchemaNode through the record path, and the
  // OBJECT default below must not land on it.
  if (schema === false) return { not: {} }
  const converted = convertSchemaNode(resolveSchemaRefs(isRecord(schema) ? schema : {}), anthropic)
  // A branch-only root (a multi-valued type union, #1556, or the node's own
  // anyOf/oneOf composition) describes itself; forcing OBJECT onto it would
  // narrow the union back to objects only. The same holds for an
  // allOf/not-only root (#1667): allOf composes its branches (a string
  // branch plus a forced OBJECT is unsatisfiable), and `not` negates its
  // subschema against every type, so OBJECT would narrow "not a string"
  // to objects only.
  if (
    converted.type === undefined &&
    converted.anyOf === undefined &&
    converted.oneOf === undefined &&
    converted.allOf === undefined &&
    converted.not === undefined
  )
    converted.type = "OBJECT"
  return converted
}

// =============================================================================
// Schemas
// =============================================================================
const PartText = Schema.Struct({
  text: Schema.String,
  thought: optionalNull(Schema.Boolean),
  thoughtSignature: optionalNull(Schema.String),
})
const PartInlineData = Schema.Struct({
  inlineData: Schema.Struct({ mimeType: Schema.String, data: Schema.String }),
  thoughtSignature: optionalNull(Schema.String),
})
const PartFileData = Schema.Struct({
  fileData: Schema.Struct({ mimeType: Schema.String, fileUri: Schema.String }),
})
const PartFunctionCall = Schema.Struct({
  functionCall: Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown), id: Schema.optional(Schema.String) }),
  thoughtSignature: optionalNull(Schema.String),
})
const PartFunctionResponse = Schema.Struct({
  functionResponse: Schema.Struct({ name: Schema.String, response: Schema.Unknown, id: Schema.optional(Schema.String) }),
})
const ContentPart = Schema.Union([PartText, PartInlineData, PartFileData, PartFunctionCall, PartFunctionResponse])
const Content = Schema.Struct({
  role: optionalNull(Schema.Literals(["user", "model"])),
  parts: optionalNull(Schema.Array(ContentPart)),
})
const SystemInstruction = Schema.Struct({
  role: Schema.optional(Schema.String),
  parts: Schema.Array(Schema.Struct({ text: Schema.String })),
})
const FunctionDeclaration = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
})
const ToolConfig = Schema.Struct({
  functionCallingConfig: Schema.Struct({
    mode: Schema.Literals(["AUTO", "NONE", "ANY"]),
    allowedFunctionNames: optionalArray(Schema.String),
  }),
})
const GenerationConfig = Schema.Struct({
  maxOutputTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  thinkingConfig: Schema.optional(
    Schema.Struct({ includeThoughts: Schema.optional(Schema.Boolean), thinkingLevel: Schema.optional(Schema.String) }),
  ),
})
const InnerRequest = Schema.Struct({
  contents: Schema.Array(Content),
  systemInstruction: Schema.optional(SystemInstruction),
  tools: optionalArray(Schema.Struct({ functionDeclarations: Schema.Array(FunctionDeclaration) })),
  toolConfig: Schema.optional(ToolConfig),
  generationConfig: Schema.optional(GenerationConfig),
  sessionId: Schema.optional(Schema.String),
})
const Body = Schema.Struct({
  project: Schema.String,
  requestId: Schema.String,
  model: Schema.String,
  userAgent: Schema.String,
  requestType: Schema.String,
  request: InnerRequest,
})
export type AntigravityBody = typeof Body.Type

const ThinkingConfigInput = Schema.Struct({
  thinkingLevel: lenient(Schema.String),
  thinkingBudget: lenient(Schema.Number),
  includeThoughts: lenient(Schema.Boolean),
})
const Options = Schema.Struct({
  reasoningEffort: lenient(Schema.String),
  reasoning_effort: lenient(Schema.String),
  thinkingConfig: lenient(ThinkingConfigInput),
})
const decodeOptions = ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))

const UsageMetadata = Schema.Struct({
  cachedContentTokenCount: optionalNull(Schema.Number),
  thoughtsTokenCount: optionalNull(Schema.Number),
  promptTokenCount: optionalNull(Schema.Number),
  candidatesTokenCount: optionalNull(Schema.Number),
  totalTokenCount: optionalNull(Schema.Number),
})
type UsageMetadata = typeof UsageMetadata.Type
const Candidate = Schema.Struct({
  content: optionalNull(
    Schema.Struct({ role: optionalNull(Schema.String), parts: optionalNull(Schema.Array(Schema.Unknown)) }),
  ),
  finishReason: optionalNull(Schema.String),
})
const InnerResponse = Schema.Struct({
  candidates: optionalNull(Schema.Array(Candidate)),
  usageMetadata: optionalNull(UsageMetadata),
  promptFeedback: optionalNull(Schema.Unknown),
})
const Event = Schema.Struct({
  response: optionalNull(InnerResponse),
  candidates: optionalNull(Schema.Array(Candidate)),
  usageMetadata: optionalNull(UsageMetadata),
  error: Schema.optional(Schema.Unknown),
})
type Event = typeof Event.Type

interface ParserState {
  readonly route: string
  readonly providerMetadataKey: string
  readonly finishReason?: string
  readonly hasToolCalls: boolean
  readonly usage?: UsageMetadata
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignature?: string
  readonly textSignature?: string
  readonly pendingSignature?: string
  readonly reasoningId?: string
  readonly textId?: string
  readonly nextReasoningId: number
  readonly nextTextId: number
}

// =============================================================================
// Request lowering (the door's buildV1Request, over the fork's LLMRequest)
// =============================================================================
const providerMetadata = (key: string, metadata: Record<string, unknown>): ProviderMetadata => ({ [key]: metadata })

const thoughtSignature = (metadata: ProviderMetadata | undefined, key: string) => {
  const ownValue = metadata?.[key]
  if (ProviderShared.isRecord(ownValue) && typeof ownValue.thoughtSignature === "string") return ownValue.thoughtSignature

  const values = Object.values(metadata ?? {})
  for (const value of values) {
    if (ProviderShared.isRecord(value) && typeof value.thoughtSignature === "string") return value.thoughtSignature
  }
  for (const value of values) {
    if (!ProviderShared.isRecord(value) || !ProviderShared.isRecord(value.extraContent)) continue
    const google = value.extraContent.google
    if (ProviderShared.isRecord(google) && typeof google.thought_signature === "string") return google.thought_signature
  }
}

const lowerTool = (tool: ToolDefinition, anthropic: boolean) => ({
  name: tool.name,
  description: tool.description ?? "",
  parameters: convertSchema(tool.inputSchema ?? { type: "object", properties: {} }, anthropic),
})

const lowerToolConfig = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Antigravity", toolChoice, {
    auto: () => ({ functionCallingConfig: { mode: "AUTO" as const } }),
    none: () => ({ functionCallingConfig: { mode: "NONE" as const } }),
    required: () => ({ functionCallingConfig: { mode: "ANY" as const } }),
    tool: (name) => ({ functionCallingConfig: { mode: "ANY" as const, allowedFunctionNames: [name] } }),
  })

const lowerMediaPart = Effect.fnUntraced(function* (part: MediaPart) {
  // Same media lowering as the fork's Gemini protocol: Files references
  // become fileData, everything else must arrive as inline base64.
  return yield* GeminiGenerateContent.mediaPart("Antigravity", part.media)
})

const sessionId = () => {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `-${(BigInt(`0x${hex}`) & ((1n << 62n) - 1n)).toString()}`
}

const fromRequest = Effect.fn("Antigravity.fromRequest")(function* (request: LLMRequest) {
    const flattened = ProviderShared.flattenToolRequest(request)
    const lowered = flattened.request
    const options = yield* decodeOptions(request.providerOptions ?? {})
    const { base, fullName } = resolveModelAndEffort(
      String(request.model.id),
      options.reasoningEffort ?? options.reasoning_effort ?? options.thinkingConfig?.thinkingLevel,
    )
    const anthropic = base.startsWith("claude")
    const providerMetadataKey = request.model.route.providerMetadataKey ?? String(request.model.provider)
    const systemParts: Array<{ text: string }> = request.system.map((part) => ({ text: part.text }))
    const contents: Array<typeof Content.Type> = []

    for (const message of lowered.messages) {
      if (message.role === "system") {
        const part = yield* ProviderShared.wrappedSystemUpdate("Antigravity", message)
        systemParts.push({ text: part.text })
        continue
      }
      if (message.role === "user") {
        const parts: Array<typeof ContentPart.Type> = []
        for (const part of message.content) {
          if (!ProviderShared.supportsContent(part, ["text", "media"]))
            return yield* ProviderShared.unsupportedContent("Antigravity", "user", ["text", "media"])
          if (part.type === "text") {
            if (part.text) parts.push({ text: part.text })
            continue
          }
          parts.push(yield* lowerMediaPart(part))
        }
        if (parts.length) contents.push({ role: "user", parts })
        continue
      }
      if (message.role === "assistant") {
        const parts: Array<typeof ContentPart.Type> = []
        for (const part of message.content) {
          if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call", "media"]))
            return yield* ProviderShared.unsupportedContent("Antigravity", "assistant", [
              "text",
              "reasoning",
              "tool-call",
              "media",
            ])
          if (part.type === "text") {
            if (part.text)
              parts.push({ text: part.text, thoughtSignature: thoughtSignature(part.providerMetadata, providerMetadataKey) })
            continue
          }
          if (part.type === "reasoning") {
            if (part.text)
              parts.push({
                text: part.text,
                thought: true,
                thoughtSignature: thoughtSignature(part.providerMetadata, providerMetadataKey),
              })
            continue
          }
          if (part.type === "media") {
            parts.push({
              ...(yield* lowerMediaPart(part)),
              thoughtSignature: thoughtSignature(part.providerMetadata, providerMetadataKey),
            })
            continue
          }
          const signature = thoughtSignature(part.providerMetadata, providerMetadataKey)
          const args =
            ProviderShared.isRecord(part.input) && !Array.isArray(part.input) ? part.input : {}
          parts.push({
            functionCall: { name: part.name, args, ...(anthropic && part.id ? { id: part.id } : {}) },
            // The door stashes signatures server-side keyed by tool_call id;
            // fork sessions carry them in providerMetadata instead. When no
            // signature survives (stateless façade history), fall back to
            // Google's documented skip validator rather than the door's 400.
            thoughtSignature: signature ?? SKIP_THOUGHT_SIGNATURE_VALIDATOR,
          })
        }
        if (parts.length) contents.push({ role: "model", parts })
        continue
      }
      // Tool results: one user content per tool message, exactly the door's
      // shape. functionResponse.response is a proto Struct — it must be a
      // JSON object; array/scalar results are wrapped as { result }.
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["tool-result"]))
          return yield* ProviderShared.unsupportedContent("Antigravity", "tool", ["tool-result"])
        let response: unknown
        if (part.result.type === "json" && ProviderShared.isRecord(part.result.value)) {
          response = part.result.value
        } else {
          const text = ProviderShared.toolResultText(part)
          try {
            const parsed: unknown = JSON.parse(text)
            response = ProviderShared.isRecord(parsed) ? parsed : { result: parsed }
          } catch {
            response = { result: text }
          }
        }
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: part.name, response, ...(anthropic && part.id ? { id: part.id } : {}) } }],
        })
      }
    }

    // The door fails closed on a specific-function tool_choice naming an
    // undeclared function (400, never widened to bare ANY — code#2822).
    // The fork's toolChoice arrives already parsed, so the same check is:
    // a named choice whose name is not among the declared tools is an
    // invalid request, validated even when no tools were declared.
    if (request.toolChoice?.name !== undefined && !flattened.tools.some((tool) => tool.name === request.toolChoice?.name))
      return yield* ProviderShared.invalidRequest(
        `tool_choice names function "${request.toolChoice.name}" which is not among the declared tools`,
      )
    const generation = request.generation
    const inner: typeof InnerRequest.Type = {
      contents,
      systemInstruction: systemParts.length ? { role: "user", parts: systemParts } : undefined,
      tools: flattened.tools.length
        ? [{ functionDeclarations: flattened.tools.map((tool) => lowerTool(tool, base.startsWith("claude"))) }]
        : undefined,
      toolConfig:
        flattened.tools.length && request.toolChoice ? yield* lowerToolConfig(request.toolChoice) : undefined,
      generationConfig: {
        maxOutputTokens: generation?.maxTokens ?? 65536,
        temperature: generation?.temperature,
        topP: generation?.topP,
        thinkingConfig: {
          includeThoughts: options.thinkingConfig?.includeThoughts ?? true,
          thinkingLevel: resolveModelAndEffort(
            String(request.model.id),
            options.reasoningEffort ?? options.reasoning_effort ?? options.thinkingConfig?.thinkingLevel,
          ).effort.toUpperCase(),
        },
      },
      sessionId: sessionId(),
    }
    return {
      project: PROJECT,
      requestId: `agent/${globalThis.crypto.randomUUID()}/${Date.now()}/${globalThis.crypto.randomUUID()}/1`,
      model: fullName,
      userAgent: "antigravity",
      requestType: "agent",
      request: inner,
    }
})

// =============================================================================
// Stream parsing (the door's consumeSse, as LLMEvents)
// =============================================================================
const mapUsage = (usage: UsageMetadata | undefined, metadataKey: string) => {
  if (!usage) return undefined
  const promptTokens = usage.promptTokenCount ?? undefined
  const cached = usage.cachedContentTokenCount ?? undefined
  const thoughts = usage.thoughtsTokenCount ?? undefined
  const visible = usage.candidatesTokenCount ?? undefined
  const outputTokens = visible !== undefined ? visible + (thoughts ?? 0) : undefined
  return new Usage({
    inputTokens: promptTokens,
    outputTokens,
    nonCachedInputTokens: ProviderShared.subtractTokens(promptTokens, cached),
    cacheReadInputTokens: cached,
    reasoningTokens: thoughts,
    totalTokens: ProviderShared.totalTokens(promptTokens, outputTokens, usage.totalTokenCount ?? undefined),
    providerMetadata: providerMetadata(metadataKey, { ...usage }),
  })
}

// The door's finishReasonMap: tool calls win; then the upstream reason.
const mapFinishReason = (finishReason: string | undefined, hasToolCalls: boolean): FinishReason => {
  if (hasToolCalls) return "tool-calls"
  switch (finishReason) {
    case "MAX_TOKENS":
      return "length"
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "content-filter"
    default:
      return "stop"
  }
}

const finish = (state: ParserState): ReadonlyArray<LLMEvent> => {
  if (state.finishReason === undefined && state.usage === undefined) return []
  const events: LLMEvent[] = []
  let lifecycle = state.lifecycle
  if (state.reasoningId !== undefined)
    lifecycle = Lifecycle.reasoningEnd(
      lifecycle,
      events,
      state.reasoningId,
      state.reasoningSignature === undefined
        ? undefined
        : providerMetadata(state.providerMetadataKey, { thoughtSignature: state.reasoningSignature }),
    )
  if (state.textId !== undefined)
    lifecycle = Lifecycle.textEnd(
      lifecycle,
      events,
      state.textId,
      state.textSignature === undefined
        ? undefined
        : providerMetadata(state.providerMetadataKey, { thoughtSignature: state.textSignature }),
    )
  Lifecycle.finish(lifecycle, events, {
    reason: { normalized: mapFinishReason(state.finishReason, state.hasToolCalls), raw: state.finishReason },
    usage: mapUsage(state.usage, state.providerMetadataKey),
  })
  return events
}

const step = (state: ParserState, event: Event) => {
  if (ProviderShared.isRecord(event.error)) {
    const body = ProviderShared.encodeJson(event)
    const error = event.error as Record<string, unknown>
    return Effect.fail(
      new AIError({
        reason: classifyProviderFailure({
          message:
            typeof error.message === "string" && error.message.length > 0
              ? error.message
              : typeof error.status === "string" && error.status.length > 0
                ? error.status
                : "Antigravity provider error",
          status: typeof error.code === "number" ? error.code : undefined,
          rawBody: body,
        }),
      }),
    )
  }
  if ("error" in event && event.error !== undefined)
    return Effect.fail(
      ProviderShared.eventError(state.route, `Invalid ${state.route} stream event`, ProviderShared.encodeJson(event)),
    )
  const resp = event.response ?? event
  const candidate = resp.candidates?.[0]
  const next: ParserState = {
    ...state,
    usage: resp.usageMetadata ?? state.usage,
    finishReason: candidate?.finishReason ?? state.finishReason,
  }
  if (!candidate?.content) return Effect.succeed([next, []] as const)

  const events: LLMEvent[] = []
  let lifecycle = next.lifecycle
  let reasoningSignature = next.reasoningSignature
  let textSignature = next.textSignature
  let pendingSignature = next.pendingSignature
  let reasoningId = next.reasoningId
  let textId = next.textId
  let nextReasoningId = next.nextReasoningId
  let nextTextId = next.nextTextId
  let hasToolCalls = next.hasToolCalls

  for (const rawPart of candidate.content.parts ?? []) {
    if (!ProviderShared.isRecord(rawPart)) continue
    const signature = typeof rawPart.thoughtSignature === "string" && rawPart.thoughtSignature ? rawPart.thoughtSignature : undefined
    if (signature !== undefined) pendingSignature = signature
    if ("inlineData" in rawPart) {
      const inline = rawPart.inlineData
      if (ProviderShared.isRecord(inline) && typeof inline.data === "string" && typeof inline.mimeType === "string") {
        lifecycle = Lifecycle.stepStart(lifecycle, events)
        events.push(
          LLMEvent.media({
            media: Media.base64(inline.data, inline.mimeType),
            providerMetadata: signature
              ? providerMetadata(state.providerMetadataKey, { thoughtSignature: signature })
              : undefined,
          }),
        )
      }
      continue
    }
    if (typeof rawPart.text === "string" && rawPart.text) {
      if (rawPart.thought) {
        if (signature !== undefined) reasoningSignature = signature
        if (textId !== undefined) {
          lifecycle = Lifecycle.textEnd(
            lifecycle,
            events,
            textId,
            textSignature ? providerMetadata(state.providerMetadataKey, { thoughtSignature: textSignature }) : undefined,
          )
          textId = undefined
          textSignature = undefined
        }
        if (reasoningId === undefined) {
          reasoningId = `reasoning-${nextReasoningId}`
          nextReasoningId += 1
        }
        lifecycle = Lifecycle.reasoningDelta(
          lifecycle,
          events,
          reasoningId,
          rawPart.text,
          signature ? providerMetadata(state.providerMetadataKey, { thoughtSignature: signature }) : undefined,
        )
        continue
      }
      if (signature !== undefined) textSignature = signature
      if (reasoningId !== undefined) {
        lifecycle = Lifecycle.reasoningEnd(
          lifecycle,
          events,
          reasoningId,
          reasoningSignature
            ? providerMetadata(state.providerMetadataKey, { thoughtSignature: reasoningSignature })
            : undefined,
        )
        reasoningId = undefined
        reasoningSignature = undefined
      }
      if (textId === undefined) {
        textId = `text-${nextTextId}`
        nextTextId += 1
      }
      lifecycle = Lifecycle.textDelta(
        lifecycle,
        events,
        textId,
        rawPart.text,
        textSignature ? providerMetadata(state.providerMetadataKey, { thoughtSignature: textSignature }) : undefined,
      )
      textSignature = undefined
      continue
    }
    if ("functionCall" in rawPart && ProviderShared.isRecord(rawPart.functionCall)) {
      const call = rawPart.functionCall
      if (typeof call.name !== "string") continue
      // The wire carries a call id for Claude tool_use interop (#1550);
      // keep it when present so history replays the id Anthropic issued.
      // Otherwise mint the door's shape so façade callers see the same id
      // grammar the door produced.
      const id =
        typeof call.id === "string" && call.id ? call.id : `call_${globalThis.crypto.randomUUID().replaceAll("-", "")}`
      if (reasoningId !== undefined) {
        lifecycle = Lifecycle.reasoningEnd(
          lifecycle,
          events,
          reasoningId,
          reasoningSignature
            ? providerMetadata(state.providerMetadataKey, { thoughtSignature: reasoningSignature })
            : undefined,
        )
        reasoningId = undefined
        reasoningSignature = undefined
      }
      if (textId !== undefined) {
        lifecycle = Lifecycle.textEnd(
          lifecycle,
          events,
          textId,
          textSignature ? providerMetadata(state.providerMetadataKey, { thoughtSignature: textSignature }) : undefined,
        )
        textId = undefined
        textSignature = undefined
      }
      lifecycle = Lifecycle.stepStart(lifecycle, events)
      const callSignature = signature ?? pendingSignature
      events.push(
        LLMEvent.toolCall({
          id,
          name: call.name,
          input: ProviderShared.isRecord(call.args) ? call.args : {},
          providerMetadata: callSignature
            ? providerMetadata(state.providerMetadataKey, { thoughtSignature: callSignature })
            : undefined,
        }),
      )
      hasToolCalls = true
    }
  }

  return Effect.succeed([
    {
      ...next,
      hasToolCalls,
      lifecycle,
      reasoningSignature,
      textSignature,
      pendingSignature,
      reasoningId,
      textId,
      nextReasoningId,
      nextTextId,
    },
    events,
  ] as const)
}

// =============================================================================
// Transport: SSE with the door's single auth retry (401 -> fresh keyring
// read + refresh, retry exactly once). The retry re-prepares the request,
// so auth runs again against the invalidated in-memory token cache.
// =============================================================================
export interface Prepared {
  readonly http: HttpTransport.HttpPrepared<string>
  readonly input: TransportPrepareInput<AntigravityBody>
}

const sse = HttpTransport.sseJson.with<AntigravityBody>()

const isUnauthorized = (error: AIError) =>
  error.reason._tag === "Authentication" &&
  (error.reason as { http?: { status?: number } }).http?.status === 401

export const transport: Transport<AntigravityBody, Prepared, string> = {
  id: sse.id,
  prepare: (input) => sse.prepare(input).pipe(Effect.map((http) => ({ http, input }))),
  execute: (prepared, request, runtime, options) =>
    Effect.gen(function* () {
      const first = yield* Effect.result(sse.execute(prepared.http, request, runtime, options))
      if (first._tag === "Success") return first.success
      if (!isUnauthorized(first.failure)) return yield* first.failure
      AntigravityAuth.invalidate()
      const retried = yield* sse
        .prepare(prepared.input)
        .pipe(Effect.flatMap((http) => sse.execute(http, request, runtime, options)))
      return retried
    }),
}

// =============================================================================
// Protocol + route
// =============================================================================
export const protocol = Protocol.make({
  id: ADAPTER,
  body: { schema: Body, from: fromRequest },
  sanitizer: "gemini",
  stream: {
    event: Protocol.jsonEvent(Event),
    initial: (request): ParserState => ({
      route: `${request.model.provider}/${request.model.route.id}`,
      providerMetadataKey: request.model.route.providerMetadataKey ?? String(request.model.provider),
      hasToolCalls: false,
      lifecycle: Lifecycle.initial(),
      nextReasoningId: 0,
      nextTextId: 0,
    }),
    step,
    onHalt: (state) => Effect.succeed(finish(state)),
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "antigravity",
  providerMetadataKey: "antigravity",
  protocol,
  endpoint: Endpoint.path("/v1internal:streamGenerateContent?alt=sse", { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport,
})

export * as Antigravity from "./antigravity.js"
