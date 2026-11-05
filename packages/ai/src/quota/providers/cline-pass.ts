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
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../utils.js"

/**
 * ClinePass quota — ported from the OpenChamber quota module
 * (providers/cline-pass.js): GET
 * https://api.cline.bot/api/v1/users/me/plan/usage-limits with the
 * enrolled token; rolling 5h, weekly, and calendar-month windows.
 */

export const providerId = "cline-pass"
export const providerName = "ClinePass"
export const aliases = ["cline-pass"]

const CLINE_USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits"

const WINDOW_KINDS = new Map<string, { key: string; windowSeconds: number | null }>([
  ["five_hour", { key: "5h", windowSeconds: 5 * 60 * 60 }],
  ["weekly", { key: "weekly", windowSeconds: 7 * 24 * 60 * 60 }],
  ["monthly", { key: "monthly", windowSeconds: null }],
])

const fetchForKey = async (ctx: QuotaContext, apiKey: string | undefined): Promise<QuotaResult> => {
  if (!apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
  }

  const timeoutSignal = AbortSignal.timeout(15_000)

  try {
    const response = await fetchOf(ctx)(CLINE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Accept-Encoding": "identity",
      },
      signal: timeoutSignal,
    })

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error:
          response.status === 401
            ? "Session expired — please re-authenticate with ClinePass"
            : `API error: ${response.status}`,
      })
    }

    const payload = asObject(await readQuotaJson(response))
    const data = asObject(payload?.data)
    const limits = Array.isArray(data?.limits) ? data.limits : []

    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
    for (const item of limits) {
      const limit = asObject(item)
      if (!limit) continue
      const type = asNonEmptyString(limit.type)
      const kind = type ? WINDOW_KINDS.get(type) : undefined
      if (!kind) continue
      const rawUsedPercent = toNumber(
        asNonEmptyString(limit.percentUsed) ?? (Number.isFinite(limit.percentUsed) ? limit.percentUsed : null),
      )
      if (rawUsedPercent === null) continue
      windows[kind.key] = toUsageWindow({
        usedPercent: clampPercent(rawUsedPercent),
        windowSeconds: kind.windowSeconds,
        resetAt: toTimestamp(limit.resetsAt),
      })
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: "No quota data in response",
      })
    }

    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } })
  } catch (error) {
    const isParseError = error instanceof SyntaxError
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeoutError(error, timeoutSignal)
        ? "Request timed out"
        : isParseError
          ? "Invalid response from provider"
          : errorText(error),
    })
  }
}

const keyOf = (entry: { key?: string } | null): string | undefined => asNonEmptyString(entry?.key)

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  credentialAliases: ["cline-pass"],
  isConfigured: (ctx) => Boolean(keyOf(getAuthEntry(projectAuth(ctx), aliases))),
  fetchQuota: async (ctx) => fetchForKey(ctx, keyOf(getAuthEntry(projectAuth(ctx), aliases))),
  fetchQuotaForCredential: async (ctx, row) => fetchForKey(ctx, keyOf(projectCredentialValue(row.value))),
}
