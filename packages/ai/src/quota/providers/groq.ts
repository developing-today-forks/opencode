import type { QuotaProvider } from "../types.js"
import {
  buildResult,
  errorText,
  fetchOf,
  getAuthEntry,
  isTimeoutError,
  projectAuth,
  toUsageWindow,
} from "../utils.js"

/**
 * Groq quota — no first-party usage/quota surface exists.
 *
 * Groq's own documentation (console.groq.com/docs/rate-limits) offers
 * exactly two quota surfaces: the console Limits page (browser-only),
 * and the `x-ratelimit-*` response headers carried on inference API
 * responses (per-model, organization-level: limit/remaining for
 * requests-per-day and tokens-per-minute, with reset durations). There
 * is no usage, billing, or quota GET endpoint an API key can call.
 *
 * So this provider makes the one first-party read an API key can make
 * — GET /openai/v1/models — and maps the rate-limit headers when the
 * response carries them. When it does not, the result is
 * configured:true with the explicit `no-quota-surface` error class
 * (evidence filed on developing-today/code#6125): an honest absence,
 * never an invented percentage.
 */

export const providerId = "groq"
export const providerName = "Groq"
export const aliases = ["groq"]

export const NO_QUOTA_SURFACE = "no-quota-surface"

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"

/** Groq reset durations spell like `2m59.56s`, `14h12m`, `7.66s`. */
export const parseGroqResetSeconds = (raw: string | null): number | null => {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  let total = 0
  let matched = false
  for (const match of text.matchAll(/([\d.]+)(h|m|s)/g)) {
    const value = Number(match[1])
    if (!Number.isFinite(value)) return null
    matched = true
    total += match[2] === "h" ? value * 3600 : match[2] === "m" ? value * 60 : value
  }
  return matched ? total : null
}

const headerNumber = (headers: Headers, name: string): number | null => {
  const raw = headers.get(name)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => Boolean(getAuthEntry(projectAuth(ctx), aliases)?.key),
  fetchQuota: async (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    const apiKey = entry?.key
    if (!apiKey) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    const timeoutSignal = AbortSignal.timeout(15_000)
    try {
      const response = await fetchOf(ctx)(GROQ_MODELS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: timeoutSignal,
      })

      if (response.status === 401 || response.status === 403) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: "Invalid or revoked API key — Groq rejected the enrolled credential",
        })
      }
      if (!response.ok) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: `API error: ${response.status}`,
        })
      }

      const now = Date.now()
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}

      const limitRequests = headerNumber(response.headers, "x-ratelimit-limit-requests")
      const remainingRequests = headerNumber(response.headers, "x-ratelimit-remaining-requests")
      if (limitRequests !== null && limitRequests > 0 && remainingRequests !== null) {
        const resetSeconds = parseGroqResetSeconds(response.headers.get("x-ratelimit-reset-requests"))
        windows.requests_daily = toUsageWindow({
          usedPercent: Math.min(100, Math.max(0, ((limitRequests - remainingRequests) / limitRequests) * 100)),
          windowSeconds: 86400,
          resetAt: resetSeconds !== null ? now + resetSeconds * 1000 : null,
          valueLabel: `${remainingRequests} / ${limitRequests} requests remaining`,
        })
      }

      const limitTokens = headerNumber(response.headers, "x-ratelimit-limit-tokens")
      const remainingTokens = headerNumber(response.headers, "x-ratelimit-remaining-tokens")
      if (limitTokens !== null && limitTokens > 0 && remainingTokens !== null) {
        const resetSeconds = parseGroqResetSeconds(response.headers.get("x-ratelimit-reset-tokens"))
        windows.tokens_minute = toUsageWindow({
          usedPercent: Math.min(100, Math.max(0, ((limitTokens - remainingTokens) / limitTokens) * 100)),
          windowSeconds: 60,
          resetAt: resetSeconds !== null ? now + resetSeconds * 1000 : null,
          valueLabel: `${remainingTokens} / ${limitTokens} tokens remaining`,
        })
      }

      if (Object.keys(windows).length === 0) {
        return {
          ...buildResult({
            providerId,
            providerName,
            ok: false,
            configured: true,
            error:
              "Groq exposes no first-party usage/quota endpoint for an API key: rate limits are reported only as x-ratelimit-* headers on inference responses and on the console Limits page, and this read carried neither",
          }),
          errorKind: NO_QUOTA_SURFACE,
          failureClass: NO_QUOTA_SURFACE,
        }
      }

      return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } })
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: isTimeoutError(error, timeoutSignal) ? "Request timed out" : errorText(error),
      })
    }
  },
}
