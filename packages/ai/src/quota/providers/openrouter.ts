import type { QuotaProvider, JsonValue } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  errorText,
  fetchOf,
  formatMoney,
  getAuthEntry,
  isTimeoutError,
  projectAuth,
  readQuotaJson,
  toNumber,
  toUsageWindow,
} from "../utils.js"

/**
 * OpenRouter quota — ported from the OpenChamber quota module
 * (providers/openrouter.js): GET {base}/key with the enrolled key,
 * where {base} follows the configured gateway base URL when one is
 * set. Not a deployed pool today (the provider is routing-disabled);
 * it answers named asks and joins the listing when pooled.
 */

export const providerId = "openrouter"
export const providerName = "OpenRouter"
export const aliases = ["openrouter"]

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"
// The reset periods are OpenRouter's calendar, resolved in UTC (the
// wire format is UTC): daily is the next UTC midnight, monthly the
// first UTC day of the next month. Weekly is the next UTC Monday —
// `getUTCDay()` is 0 on Sunday and 1 on Monday, so `(8 - dow) % 7`
// counts days forward to Monday and its `|| 7` fallback makes Monday
// itself jump a full week rather than resolve to today. Pinned by the
// "OpenRouter calendar reset calculation" suite (#1725).
export const resolveResetAt = (limitReset: JsonValue | undefined, nowMs: number): number | null => {
  const now = new Date(nowMs)
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const d = now.getUTCDate()
  if (limitReset === "daily") return Date.UTC(y, m, d + 1)
  if (limitReset === "weekly") {
    const dow = now.getUTCDay()
    return Date.UTC(y, m, d + ((8 - dow) % 7 || 7))
  }
  if (limitReset === "monthly") return Date.UTC(y, m + 1, 1)
  return null
}

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => Boolean(asNonEmptyString(getAuthEntry(projectAuth(ctx), aliases)?.key)),
  fetchQuota: async (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    const apiKey = asNonEmptyString(entry?.key)
    if (!apiKey) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    const config = asObject(ctx.providerConfig[providerId])
    const settings = asObject(config?.settings)
    const options = asObject(config?.options)
    const configuredBase =
      asNonEmptyString(settings?.baseURL) ?? asNonEmptyString(options?.baseURL) ?? asNonEmptyString(config?.api)
    const base = configuredBase?.replace(/\/+$/, "") ?? OPENROUTER_API_BASE

    const timeoutSignal = AbortSignal.timeout(15_000)
    try {
      const response = await fetchOf(ctx)(`${base}/key`, {
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
            response.status === 401 || response.status === 403
              ? "Session expired — please re-authenticate with OpenRouter"
              : `API error: ${response.status}`,
        })
      }

      const payload = asObject(await readQuotaJson(response))
      const data = asObject(payload?.data)
      if (data === null) {
        return buildResult({ providerId, providerName, ok: false, configured: true, error: "No quota data in response" })
      }
      if (data.is_management_key === true) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: "Management key configured — quota needs an inference API key",
        })
      }

      const limit = toNumber(data.limit)
      const limitRemaining = toNumber(data.limit_remaining)
      if (limit !== null && limitRemaining === null) {
        return buildResult({ providerId, providerName, ok: false, configured: true, error: "No quota data in response" })
      }
      // A zero (or negative) limit is no quota figure at all (#1799):
      // publishing a window for it ($0.00 / $0.00, usedPercent null,
      // ok:true) reads as headroom where there is no limit. It
      // publishes no window — the no-data contract when it is the
      // only data — matching contract rule 4 (types.ts) and the
      // OpenDesign zero-limit disposition (#1750).
      if (limit !== null && limit <= 0) {
        return buildResult({ providerId, providerName, ok: false, configured: true, error: "No quota data in response" })
      }
      const usageMonthly = toNumber(data.usage_monthly)
      // A negative spend is impossible wire data (#1913): read it as
      // absent, the way sibling parsers read negative amounts
      // (turso numNonNegative, opencode-go toMicroCents). On the
      // unlimited path the spend is the only figure, so absent is
      // the no-data contract — the same disposition as the
      // zero/negative limit above (#1799, contract rule 4).
      if (limit === null && (usageMonthly === null || usageMonthly < 0)) {
        return buildResult({ providerId, providerName, ok: false, configured: true, error: "No quota data in response" })
      }

      const nowMs = Date.now()
      let windowKey: string
      let windowSeconds: number | null
      let resetAt: number | null
      let usedPercent: number | null
      let valueLabel: string | null

      if (limit === null) {
        windowKey = "monthly"
        windowSeconds = 30 * 86400
        resetAt = resolveResetAt("monthly", nowMs)
        usedPercent = null
        valueLabel = `$${formatMoney(usageMonthly)} spent`
      } else {
        // limitRemaining is non-null here: the null case returned above.
        const used = Math.max(0, limit - (limitRemaining ?? 0))
        const percent = limit > 0 ? (used / limit) * 100 : null
        usedPercent = percent === null ? null : Math.min(100, percent)
        valueLabel = `$${formatMoney(used)} / $${formatMoney(limit)}`
        if (data.limit_reset === "daily") {
          windowKey = data.limit_reset
          windowSeconds = 86400
          resetAt = resolveResetAt(data.limit_reset, nowMs)
        } else if (data.limit_reset === "weekly") {
          windowKey = data.limit_reset
          windowSeconds = 604800
          resetAt = resolveResetAt(data.limit_reset, nowMs)
        } else if (data.limit_reset === "monthly") {
          windowKey = data.limit_reset
          windowSeconds = 30 * 86400
          resetAt = resolveResetAt(data.limit_reset, nowMs)
        } else {
          windowKey = "key_limit"
          windowSeconds = null
          resetAt = null
        }
      }

      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: {
          windows: {
            [windowKey]: toUsageWindow({ usedPercent, windowSeconds, resetAt, valueLabel }),
          },
        },
      })
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
  },
}
