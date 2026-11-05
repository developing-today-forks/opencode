import type { QuotaContext, QuotaProvider, QuotaResult } from "../types.js"
import {
  asNonEmptyString,
  asObject,
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
        const body = asObject(await readQuotaJson(response).catch(() => null))
        const errorType = asNonEmptyString(asObject(body?.error)?.type)
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

    const payload = asObject(await readQuotaJson(response))
    const rateLimit = asObject(payload?.rate_limit)
    const primary = asObject(rateLimit?.primary_window)
    const secondary = asObject(rateLimit?.secondary_window)
    const credits = asObject(payload?.credits)

    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}

    // Rate-limit windows (#1762): a window without a usable
    // used_percent carries no quota figure, so it is dropped — an
    // empty window object used to mint a phantom all-null window, and
    // a duration/reset with no percent is dispositioned the same way
    // (dropped, not published with a null percent). The survivors are
    // keyed by their derived duration label; when the primary and
    // secondary labels collide (equal durations, or both missing),
    // BOTH keys gain a -primary/-secondary qualifier so neither window
    // can silently overwrite the other. Distinct durations keep their
    // plain 5h/weekly keys, unchanged for downstream consumers.
    const rateLimitWindows = (
      [
        ["primary", primary],
        ["secondary", secondary],
      ] as const
    ).flatMap(([role, window]) => {
      if (!window) return []
      const usedPercent = clampPercent(toNumber(window.used_percent))
      if (usedPercent === null) return []
      const windowSeconds = toNumber(window.limit_window_seconds)
      return [
        {
          role,
          label: resolveWindowLabel(windowSeconds),
          window: toUsageWindow({
            usedPercent,
            windowSeconds,
            resetAt: toTimestamp(window.reset_at),
          }),
        },
      ]
    })
    const labelsCollide = rateLimitWindows.length === 2 && rateLimitWindows[0].label === rateLimitWindows[1].label
    for (const entry of rateLimitWindows) {
      windows[labelsCollide ? `${entry.label}-${entry.role}` : entry.label] = entry.window
    }
    if (credits) {
      const balance = toNumber(credits.balance)
      const unlimited = Boolean(credits.unlimited)
      const label = unlimited ? "Unlimited" : balance !== null ? String(balance) : null
      // An empty credits object carries no usable data either (#1762).
      if (label !== null) {
        windows.credits_balance = toUsageWindow({
          usedPercent: null,
          windowSeconds: null,
          resetAt: null,
          valueLabel: label,
        })
      }
    }
    const spendLimit = asObject(asObject(payload?.spend_control)?.individual_limit)
    if (spendLimit) {
      const used = toNumber(spendLimit.used)
      const limit = toNumber(spendLimit.limit)
      const valueLabel =
        used !== null && limit !== null ? `${used.toFixed(0)} / ${limit.toFixed(0)} used` : null
      const usedPercent = clampPercent(toNumber(spendLimit.used_percent))
      if (usedPercent !== null || valueLabel !== null) {
        windows.credits = toUsageWindow({
          usedPercent,
          windowSeconds: null,
          resetAt: null,
          valueLabel,
        })
      }
    }

    // No usable quota or credit data at all: the sibling providers'
    // no-data contract (ClinePass/DeepSeek/OpenRouter), not ok:true
    // with empty windows (#1762).
    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: "No quota data in response",
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
