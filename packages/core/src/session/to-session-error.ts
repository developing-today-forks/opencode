import { AIError, ToolFailure, type FinishReasonDetails } from "@opencode/ai"
import { Tool } from "@opencode/schema/tool"
import { SessionError } from "@opencode/schema/session-error"
import { Permission } from "../permission.js"
import { Integration } from "../integration.js"
import { AgentNotFoundError, StepFailedError } from "./error.js"
import { ModelResolver } from "../model-resolver.js"
import { SessionRunnerModel } from "./runner/model.js"

const tokenSharingMessages = {
  subscription_sharing_user_not_eligible:
    "ChatGPT token sharing isn't available for this account. Connect with an API key or choose another provider.",
  subscription_sharing_usage_limit_exceeded:
    "ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.",
  subscription_sharing_usage_unavailable: "ChatGPT usage can't be checked right now. Try again later.",
  subscription_sharing_unsupported_capability:
    "This request uses a feature ChatGPT token sharing doesn't support. Remove the unsupported feature and try again.",
  subscription_sharing_route_not_supported:
    "ChatGPT token sharing doesn't support this API route. Check the configured endpoint and HTTP method.",
  subscription_sharing_invalid_user: "This ChatGPT connection is no longer valid. Reconnect to ChatGPT.",
  subscription_sharing_user_unavailable: "Your ChatGPT account is temporarily unavailable. Try again later.",
  chatpass_v2_scope_not_authorized:
    "This ChatGPT connection isn't authorized for this request. Reconnect to ChatGPT or choose another connection.",
  chatpass_v2_invalid_authorization_context:
    "This ChatGPT connection isn't authorized for this request. Reconnect to ChatGPT or choose another connection.",
}

export interface SessionErrorContext {
  /** The integration method that minted the credential which served the failed request
   * (#1119), when the caller knows it (the session runner does, via the resolved model).
   * Method-specific error classification is gated on it: without it, a diagnosis that
   * names a credential method is never asserted from an error body alone. */
  readonly credentialMethodID?: string
  /** The model that served the failed request, when the caller knows it (the session
   * runner does, via the resolved model). Recorded on the outcome for provider
   * errors whose reason does not name a provider/model itself (auth, invalid
   * request), so a startup provider death names its endpoint/model (code#7073). */
  readonly model?: { readonly providerID: string; readonly id: string }
}

export function toSessionError(cause: unknown, context?: SessionErrorContext): SessionError.Error {
  if (cause instanceof AIError) {
    switch (cause.reason._tag) {
      case "RateLimit":
        return providerError("provider.rate-limit", cause.reason, context)
      case "Authentication":
        return providerError("provider.auth", cause.reason, context)
      case "QuotaExceeded":
        return providerError("provider.quota", cause.reason, context)
      case "ContentPolicy":
        return providerError("provider.content-filter", cause.reason, context)
      case "Transport":
        return providerError("provider.transport", cause.reason, context)
      case "ProviderInternal":
        return providerError("provider.internal", cause.reason, context)
      case "InvalidProviderOutput":
        return providerError("provider.invalid-output", cause.reason, context)
      case "InvalidRequest":
        return providerError("provider.invalid-request", cause.reason, context)
      case "UnsupportedOperation":
        return providerError("provider.unsupported-operation", cause.reason, context)
      case "NoRoute":
        return providerError("provider.no-route", cause.reason, context)
      case "UnknownProvider":
        return providerError("provider.unknown", cause.reason, context)
      case "Timeout":
        return providerError("provider.timeout", cause.reason, context)
      default: {
        const exhaustive: never = cause.reason
        return exhaustive
      }
    }
  }
  if (cause instanceof Permission.BlockedError) return { type: "permission.rejected", message: cause.message }
  if (cause instanceof Permission.CorrectedError) return { type: "permission.rejected", message: cause.feedback }
  if (cause instanceof ToolFailure || cause instanceof Tool.Error) {
    if (cause.error === undefined) return { type: "tool.execution", message: cause.message }
    // The canonical error is the sole model-visible representation, so a cause
    // with no message must not erase the tool's curated failure message.
    const unwrapped = toSessionError(cause.error, context)
    return unwrapped.message === "" ? { ...unwrapped, type: "tool.execution", message: cause.message } : unwrapped
  }
  if (cause instanceof StepFailedError) return cause.error
  if (cause instanceof ModelResolver.UnsupportedCompactionError)
    return { type: "provider.unsupported-operation", message: cause.message }
  if (cause instanceof AgentNotFoundError) return { type: "unknown", message: cause.message }
  if (
    cause instanceof SessionRunnerModel.ModelNotSelectedError ||
    cause instanceof SessionRunnerModel.ModelUnavailableError ||
    cause instanceof ModelResolver.VariantUnavailableError ||
    cause instanceof ModelResolver.UnsupportedPackageError ||
    cause instanceof ModelResolver.ModelConfigurationError ||
    cause instanceof ModelResolver.ModelInitializationError ||
    cause instanceof ModelResolver.UnresolvedProviderVariablesError
  )
    return { type: "provider.no-route", message: cause.message }
  if (cause instanceof Integration.AuthorizationError) return { type: "provider.auth", message: cause.message }
  return { type: "unknown", message: cause instanceof Error ? cause.message : String(cause) }
}

export function contentFilterError(summary: string, reason: FinishReasonDetails): SessionError.Error {
  return {
    type: "provider.content-filter",
    message: [reason.category === undefined ? summary : `${summary} (${reason.category})`, reason.explanation]
      .filter(Boolean)
      .join(": "),
  }
}

/**
 * A platform-API 401 reporting missing scopes (api.responses.write / resource.invoke) means the
 * active token-sharing credential holds a token minted by a different sign-in flow (#1119, the
 * code#3216 incident): name the mismatch instead of surfacing a generic provider auth failure.
 * Only called when the serving credential's method is known to be chatgpt-token-sharing —
 * the same scopes error from an API-key or legacy Codex connection is a different problem,
 * and rewriting it would replace its real diagnostic with wrong instructions.
 */
function credentialMethodMismatchMessage(body: string | undefined, status: number | undefined): string | undefined {
  if (!body || (status !== 401 && !body.includes("missing_scopes"))) return undefined
  if (!/missing[^"]*scopes/i.test(body)) return undefined
  const missing = ["api.responses.write", "resource.invoke"].filter((scope) => body.includes(scope))
  if (missing.length === 0) return undefined
  return (
    `Credential-method mismatch: the active OpenAI credential uses method chatgpt-token-sharing, ` +
    `but its token is missing the scopes (${missing.join(", ")}) required by https://api.openai.com/v1. ` +
    `The token was likely minted by a different sign-in flow (for example Codex browser/headless). ` +
    `Reconnect with token sharing, or switch to the credential that matches this token.`
  )
}

function providerError(type: string, reason: AIError["reason"], context?: SessionErrorContext): SessionError.Error {
  const status = reason.http?.status
  // Facts the reason itself carries win (no-route names provider+model); the
  // caller's serving model fills the rest. The HTTP context URL stays unexposed:
  // it is a runtime diagnostic, not outcome state (see the HTTP-status test).
  const named = reason as { provider?: unknown; model?: unknown }
  const provider = typeof named.provider === "string" ? named.provider : context?.model?.providerID
  const model = typeof named.model === "string" ? named.model : context?.model?.id
  return {
    type,
    message:
      (context?.credentialMethodID === "chatgpt-token-sharing"
        ? credentialMethodMismatchMessage(reason.body, status)
        : undefined) ??
      Object.entries(tokenSharingMessages).find(([code]) => reason.body?.includes(code))?.[1] ??
      reason.message,
    ...(status === undefined ? {} : { status }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reason.body === undefined ? {} : { response: { body: reason.body } }),
  }
}
