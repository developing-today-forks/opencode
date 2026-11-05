import type { QuotaProvider } from "../types.js"
import {
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
 * DeepSeek quota — ported from the OpenChamber quota module
 * (providers/deepseek.js): GET https://api.deepseek.com/user/balance
 * with the enrolled API key; the balance is the credits_balance window.
 */

export const providerId = "deepseek"
export const providerName = "DeepSeek"
export const aliases = ["deepseek"]

const DEEPSEEK_QUOTA_URL = "https://api.deepseek.com/user/balance"

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    return Boolean(entry?.key)
  },
  fetchQuota: async (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    const apiKey = entry?.key

    if (!apiKey) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    const timeoutSignal = AbortSignal.timeout(15_000)

    try {
      const response = await fetchOf(ctx)(DEEPSEEK_QUOTA_URL, {
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
              ? "Session expired — please re-authenticate with DeepSeek"
              : `API error: ${response.status}`,
        })
      }

      const payload = (await readQuotaJson(response)) as {
        balance_infos?: Array<{ total_balance?: unknown; currency?: unknown }>
      }
      const balanceInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
      const positiveBalances = balanceInfos.filter((info) => {
        const num = toNumber(info?.total_balance)
        return typeof num === "number" && num > 0
      })
      const balanceInfo =
        positiveBalances.find((info) => info?.currency === "USD") ??
        positiveBalances.find((info) => info?.currency === "CNY") ??
        balanceInfos.find((info) => info?.currency === "USD") ??
        balanceInfos.find((info) => info?.currency === "CNY") ??
        null
      const rawBalance = balanceInfo?.total_balance
      const totalBalance =
        typeof rawBalance === "number" || (typeof rawBalance === "string" && rawBalance.trim() !== "")
          ? toNumber(rawBalance)
          : null

      if (totalBalance === null) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: "No quota data in response",
        })
      }

      const isCny = balanceInfo?.currency === "CNY"
      const symbol = isCny ? "¥" : "$"
      const valueLabel = `${symbol}${formatMoney(totalBalance)}`

      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: {
          windows: {
            credits_balance: toUsageWindow({
              usedPercent: null,
              windowSeconds: null,
              resetAt: null,
              valueLabel,
            }),
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
