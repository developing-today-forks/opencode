import type { QuotaContext, QuotaProvider, QuotaResult } from "../types.js"
import {
  asNonEmptyString,
  buildResult,
  clampPercent,
  errorText,
  fetchOf,
  getAuthEntry,
  isTimeoutError,
  projectAuth,
  projectCredentialValue,
  readQuotaJson,
  resolveWindowLabel,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../utils.js"

/**
 * Codex / ChatGPT quota — ported from the OpenChamber quota module
 * (providers/codex.js). The wire is ChatGPT's own usage read:
 * GET https://chatgpt.com/backend-api/wham/usage with the account's
 * OAuth access token (and ChatGPT-Account-Id when the credential names
 * one). The ChatGPT accounts live under instance integrations
 * (openai.main, openai.alternate), so the base provider folds instance
 * credentials into its per-credential answer.
 */

export const providerId = "codex"
export const providerName = "Codex"
export const aliases = ["openai", "codex", "chatgpt"]

const fetchQuotaForEntry = async (
  ctx: QuotaContext,
  entry: { access?: string; token?: string; accountId?: string } | null,
): Promise<QuotaResult> => {
  const accessToken = entry?.access ?? entry?.token
  const accountId = entry?.accountId

  if (!accessToken) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
  }

  const timeoutSignal = AbortSignal.timeout(15_000)

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    }
    const response = await fetchOf(ctx)("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: timeoutSignal,
    })

    if (!response.ok) {
      // A 401 is not always an expired token. OpenCode's `chatgpt-token-sharing`
      // sign-in ("Sign in with ChatGPT") holds a token that only reaches the
      // Responses route, and the usage endpoint refuses it with an
      // access-enforcement body. OpenAI has no usage endpoint for that
      // sign-in and sends users to the ChatGPT usage page instead.
      if (response.status === 401) {
        const body = (await readQuotaJson(response).catch(() => null)) as {
          error?: { type?: unknown }
        } | null
        const errorType = asNonEmptyString(body?.error?.type)
        if (errorType === "rejected_by_access_enforcement") {
          return buildResult({
            providerId,
            providerName,
            ok: false,
            configured: true,
            error:
              "OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.",
          })
        }
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: "Session expired — please re-authenticate with OpenAI",
        })
      }
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      })
    }

    const payload = (await readQuotaJson(response)) as {
      rate_limit?: {
        primary_window?: { limit_window_seconds?: unknown; used_percent?: unknown; reset_at?: unknown } | null
        secondary_window?: { limit_window_seconds?: unknown; used_percent?: unknown; reset_at?: unknown } | null
      } | null
      credits?: { balance?: unknown; unlimited?: unknown } | null
      spend_control?: {
        individual_limit?: { used?: unknown; limit?: unknown; used_percent?: unknown } | null
      } | null
      email?: unknown
      account_id?: unknown
    }
    const primary = payload?.rate_limit?.primary_window ?? null
    const secondary = payload?.rate_limit?.secondary_window ?? null
    const credits = payload?.credits ?? null

    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds)
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: clampPercent(toNumber(primary.used_percent)),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at),
      })
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds)
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: clampPercent(toNumber(secondary.used_percent)),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at),
      })
    }
    if (credits) {
      const balance = toNumber(credits.balance)
      const unlimited = Boolean(credits.unlimited)
      const label = unlimited ? "Unlimited" : balance !== null ? String(balance) : null
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label,
      })
    }
    if (payload?.spend_control?.individual_limit) {
      const spendLimit = payload.spend_control.individual_limit
      const used = toNumber(spendLimit.used)
      const limit = toNumber(spendLimit.limit)
      const valueLabel =
        used !== null && limit !== null ? `${used.toFixed(0)} / ${limit.toFixed(0)} used` : null
      windows.credits = toUsageWindow({
        usedPercent: clampPercent(toNumber(spendLimit.used_percent)),
        windowSeconds: null,
        resetAt: null,
        valueLabel,
      })
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      accountLabel: asNonEmptyString(payload?.email) ?? asNonEmptyString(payload?.account_id),
    })
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeoutError(error, timeoutSignal) ? "Request timed out" : errorText(error),
    })
  }
}

const entryWithToken = (entry: { access?: string; token?: string } | null) =>
  entry && (entry.access || entry.token) ? entry : null

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  credentialAliases: ["openai", "codex", "chatgpt"],
  foldInstanceCredentials: true,
  isConfigured: (ctx) => {
    const auth = projectAuth(ctx)
    if (entryWithToken(getAuthEntry(auth, aliases))) return true
    // Instance integrations (openai.main / openai.alternate) hold the accounts.
    for (const [instanceId, instance] of ctx.instances) {
      if (!aliases.includes(instance.base)) continue
      const row = ctx.credentials.find((r) => r.integrationID === instanceId)
      if (row && entryWithToken(projectCredentialValue(row.value))) return true
    }
    return ctx.credentials.some(
      (row) => aliases.includes(row.integrationID) && entryWithToken(projectCredentialValue(row.value)),
    )
  },
  fetchQuota: async (ctx) => {
    const auth = projectAuth(ctx)
    const direct = entryWithToken(getAuthEntry(auth, aliases))
    if (direct) return fetchQuotaForEntry(ctx, direct)
    for (const [instanceId, instance] of ctx.instances) {
      if (!aliases.includes(instance.base)) continue
      const entry = entryWithToken(
        (() => {
          const row = ctx.credentials.find((r) => r.integrationID === instanceId && r.active)
          return row ? projectCredentialValue(row.value) : null
        })(),
      )
      if (entry) return fetchQuotaForEntry(ctx, entry)
    }
    return fetchQuotaForEntry(ctx, null)
  },
  fetchQuotaForCredential: async (ctx, row) =>
    fetchQuotaForEntry(ctx, entryWithToken(projectCredentialValue(row.value))),
}
