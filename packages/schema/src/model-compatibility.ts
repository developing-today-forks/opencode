import { Schema, Struct } from "effect"
import { optional } from "./schema.js"

// Shared by model and provider schemas; kept separate because model.ts imports provider.ts.
export type ReasoningField = "reasoning" | "reasoning_content" | "reasoning_text" | (string & {})
export const ReasoningField: Schema.Codec<ReasoningField> = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
]).annotate({ identifier: "Model.ReasoningField" })

export const MaxTokensField = Schema.Literals(["max_completion_tokens", "max_tokens"]).annotate({
  identifier: "Model.MaxTokensField",
})
export type MaxTokensField = typeof MaxTokensField.Type

export const CacheFormat = Schema.Literals(["anthropic", "alibaba"]).annotate({
  identifier: "Model.CacheFormat",
  description:
    "Prompt-cache marker syntax the endpoint accepts. Overrides the route default; both send `cache_control`, and `alibaba` skips tool definitions. A model route may set it per route or per target; a target's own value overrides the route's and nested routes inherit it.",
})
export type CacheFormat = typeof CacheFormat.Type

export interface Compatibility extends Schema.Schema.Type<typeof Compatibility> {}
export const Compatibility = Schema.Struct({
  reasoningField: ReasoningField.pipe(optional),
  /** Require every assistant message to include its reasoning field, even when empty. */
  requireReasoning: Schema.Boolean.pipe(optional),
  maxTokensField: MaxTokensField.pipe(optional),
  /** Supports the OpenAI `store` request field. Gateway-door family defaults (e.g. GLM/Kimi/Gemini/DeepSeek models behind cline-pass, opendesign, opencode-go) are carried as per-model entries here, not detected in the shared protocol (#1824). */
  supportsStore: Schema.Boolean.pipe(optional),
  /** Supports the strict field on tool definitions. */
  supportsStrictMode: Schema.Boolean.pipe(optional),
  /** Sends `tool_stream` for GLM models on ZAI-shaped endpoints. */
  zaiToolStream: Schema.Boolean.pipe(optional),
  requireFinishReason: Schema.Boolean.pipe(optional),
  requireAssistantAfterTool: Schema.Boolean.pipe(optional),
  supportsPromptCacheKey: Schema.Boolean.pipe(optional),
  /** Prompt-cache marker syntax the endpoint accepts. Overrides the route default; both send `cache_control`, and `alibaba` skips tool definitions. */
  cacheFormat: CacheFormat.pipe(optional),
  /** Supports Anthropic's thinking-prefix mismatch controls. Overrides model-ID detection. */
  supportsThinkingBlockBinding: Schema.Boolean.pipe(optional),
  /** Supports per-message effort updates. Overrides model-ID detection. */
  supportsEffortUpdates: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Model.Compatibility" })

// Provider defaults inherited by its models. Model-version features stay model-only.
export interface ProviderCompatibility extends Schema.Schema.Type<typeof ProviderCompatibility> {}
export const ProviderCompatibility = Schema.Struct(
  Struct.omit(Compatibility.fields, ["supportsThinkingBlockBinding", "supportsEffortUpdates"]),
).annotate({ identifier: "Provider.Compatibility" })
