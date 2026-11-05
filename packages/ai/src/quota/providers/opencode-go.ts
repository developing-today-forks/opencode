import type { QuotaContext, QuotaProvider, QuotaResult } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  clampPercent,
  formatMoney,
  getAuthEntry,
  projectAuth,
  readQuotaJson,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../utils.js"

/**
 * OpenCode Go quota — ported from the OpenChamber quota module
 * (providers/opencode-go.js). Two credential shapes: an API key (the
 * `opencode-go` integration, or the shared `opencode` one) reads the
 * legacy usage API; a Console sign-in on the shared `opencode`
 * integration reads the Console Go status endpoint (its OAuth token is
 * not interchangeable with a key). Per-credential: one stored Console
 * sign-in per workspace, so each usable row answers its own result —
 * including rows stored under the instance integrations
 * (opencode-go.drewrypope, opencode-go.popesdrew).
 */

export const providerId = "opencode-go"
export const providerName = "OpenCode Go"
export const aliases = ["opencode-go"]

const API_KEY_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const CONSOLE_STATUS_URL = "https://opencode.ai/console/api/go/status"
const CONSOLE_BILLING_STATUS_URL = "https://opencode.ai/console/api/billing/status"
const MICRO_CENTS_PER_DOLLAR = 100_000_000
const CONSOLE_SERVER = "https://opencode.ai/console"
const CONSOLE_INTEGRATION_ID = "opencode"
const ORGANIZATION_ID_PATTERN = /^(?:org|wrk)_[A-Za-z0-9]+$/
const CONSOLE_PRODUCTS = new Set(["go", "go-plus"])
const NO_CONSOLE_SUBSCRIPTION = "No active OpenCode Go subscription on the selected Console account"
const REQUEST_TIMEOUT_MS = 15_000

const API_KEY_WINDOW_FIELDS: Record<string, string> = { "5h": "rolling", weekly: "weekly", monthly: "monthly" }
const CONSOLE_WINDOW_METERS: Record<string, string> = { "5h": "fiveHour", weekly: "week", monthly: "month" }

type WindowMap = Record<string, ReturnType<typeof toUsageWindow>>

export const parseOpenCodeGoUsage = (payload: unknown): WindowMap => {
  const usage = asObject(payload) ? asObject(asObject(payload)?.usage) : null
  if (!usage) return {}
  const windows: WindowMap = {}
  for (const [key, field] of Object.entries(API_KEY_WINDOW_FIELDS)) {
    const entry = asObject(usage[field])
    if (!entry) continue
    const usedPercent = toNumber(entry.percent)
    const resetAt = toTimestamp(entry.resetsAt)
    if (usedPercent === null || resetAt === null) continue
    windows[key] = toUsageWindow({ usedPercent: clampPercent(usedPercent), resetAt, windowSeconds: null })
  }
  return windows
}

const toMicroCents = (value: unknown): number | null => {
  const amount = toNumber(value)
  if (amount === null || amount < 0) return null
  return amount
}

export const parseConsoleGoUsage = (payload: unknown): WindowMap => {
  const access = asObject(payload) ? asObject(asObject(payload)?.access) : null
  const meters = access ? asObject(access.meters) : null
  if (!meters) return {}
  const windows: WindowMap = {}
  for (const [key, meterName] of Object.entries(CONSOLE_WINDOW_METERS)) {
    const meter = asObject(meters[meterName])
    if (!meter) continue
    const limit = toMicroCents(meter.limitMicroCents)
    const used = toMicroCents(meter.usedMicroCents)
    const resetAt = toTimestamp(meter.resetsAt)
    if (limit === null || limit <= 0 || used === null || resetAt === null) continue
    windows[key] = toUsageWindow({ usedPercent: clampPercent((used / limit) * 100), resetAt, windowSeconds: null })
  }
  return windows
}

export const parseConsoleBillingBalance = (payload: unknown): number | null => {
  const microCents = toMicroCents(asObject(payload)?.availableMicroCents)
  if (microCents === null) return null
  return microCents / MICRO_CENTS_PER_DOLLAR
}

export const fetchOpenCodeGoUsage = async (
  ctx: QuotaContext,
  apiKey: string,
  { consoleKey = false } = {},
): Promise<WindowMap> => {
  const fetchImpl = ctx.fetchImpl ?? fetch
  const response = await fetchImpl(API_KEY_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-opencode-session": "opencode-quota",
      "User-Agent": "OpenCode quota provider",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 403 && consoleKey) throw new Error(NO_CONSOLE_SUBSCRIPTION)
  if (response.status === 401 || response.status === 403) throw new Error("OpenCode Go authentication failed")
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`)
  const windows = parseOpenCodeGoUsage(await readQuotaJson(response).catch(() => null))
  if (Object.keys(windows).length === 0) throw new Error("OpenCode Go usage data could not be parsed")
  return windows
}

const isConsoleSignInExpired = (expires: number | null): boolean =>
  expires !== null && expires > 0 && expires <= Date.now()

export const fetchConsoleGoUsage = async (
  ctx: QuotaContext,
  credential: { access: string; orgID: string; expires: number | null },
): Promise<{ windows: WindowMap; planLabel?: string }> => {
  if (isConsoleSignInExpired(credential.expires)) {
    throw new Error("OpenCode Console sign-in expired. Sign in again in Providers.")
  }
  const fetchImpl = ctx.fetchImpl ?? fetch
  const response = await fetchImpl(CONSOLE_STATUS_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential.access}`,
      "x-org-id": credential.orgID,
      "User-Agent": "OpenCode quota provider",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error("OpenCode Console sign-in expired. Sign in again in Providers.")
  }
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned HTTP ${response.status}`)
  const payload = await readQuotaJson(response).catch(() => null)
  if (!asObject(payload)) throw new Error("OpenCode Console Go status returned an unreadable response")
  const product = asObject(payload)?.product
  if (typeof product !== "string" || !CONSOLE_PRODUCTS.has(product)) {
    throw new Error(NO_CONSOLE_SUBSCRIPTION)
  }
  const windows = parseConsoleGoUsage(payload)
  if (Object.keys(windows).length === 0) throw new Error("OpenCode Go usage data could not be parsed")
  return { windows, planLabel: product }
}

export const fetchConsoleBillingBalance = async (
  ctx: QuotaContext,
  credential: { access: string; orgID: string },
): Promise<number | null> => {
  try {
    const fetchImpl = ctx.fetchImpl ?? fetch
    const response = await fetchImpl(CONSOLE_BILLING_STATUS_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.access}`,
        "x-org-id": credential.orgID,
        "User-Agent": "OpenCode quota provider",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return parseConsoleBillingBalance(await readQuotaJson(response).catch(() => null))
  } catch {
    return null
  }
}

const readKey = (entry: { key?: string } | null): string | undefined => asNonEmptyString(entry?.key)

const getApiKey = (ctx: QuotaContext): { key: string; consoleKey: boolean } | null => {
  const auth = projectAuth(ctx)
  const own = readKey(getAuthEntry(auth, aliases))
  if (own) return { key: own, consoleKey: false }
  const consoleEntry = getAuthEntry(auth, [CONSOLE_INTEGRATION_ID])
  if (!consoleEntry || consoleEntry.type === "oauth") return null
  const key = readKey(consoleEntry)
  return key ? { key, consoleKey: true } : null
}

const getConsoleCredential = (
  ctx: QuotaContext,
): { access: string; orgID: string; expires: number | null } | null => {
  const entry = getAuthEntry(projectAuth(ctx), [CONSOLE_INTEGRATION_ID])
  if (!entry || entry.type !== "oauth") return null
  const access = asNonEmptyString(entry.access)
  const orgID = asNonEmptyString(entry.orgID)
  if (!access || entry.server !== CONSOLE_SERVER || !orgID || !ORGANIZATION_ID_PATTERN.test(orgID)) return null
  return { access, orgID, expires: toNumber(entry.expires) }
}

const fetchCombined = async (ctx: QuotaContext): Promise<QuotaResult> => {
  try {
    const consoleCredential = getConsoleCredential(ctx)
    const apiKey = getApiKey(ctx)
    if (consoleCredential) {
      try {
        const balanceRead = isConsoleSignInExpired(consoleCredential.expires)
          ? Promise.resolve(null)
          : fetchConsoleBillingBalance(ctx, consoleCredential)
        const { windows, planLabel } = await fetchConsoleGoUsage(ctx, consoleCredential)
        const balance = await balanceRead
        const usageWindows =
          balance === null
            ? windows
            : {
                ...windows,
                credits_balance: toUsageWindow({
                  usedPercent: null,
                  windowSeconds: null,
                  resetAt: null,
                  valueLabel: `$${formatMoney(balance)}`,
                }),
              }
        return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: usageWindows }, planLabel })
      } catch (consoleError) {
        if (!apiKey) throw consoleError
      }
    }
    if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    const windows = await fetchOpenCodeGoUsage(ctx, apiKey.key, { consoleKey: apiKey.consoleKey })
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } })
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : "Request failed",
    })
  }
}

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  credentialAliases: ["opencode", "opencode-go"],
  isConfigured: (ctx) => Boolean(getConsoleCredential(ctx) || getApiKey(ctx)),
  fetchQuota: fetchCombined,
  fetchQuotaForCredential: async (ctx, row) => {
    const integrationID = asNonEmptyString(row.integrationID)
    if (!integrationID || !row.value) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }
    const authKey =
      integrationID === providerId || integrationID === CONSOLE_INTEGRATION_ID ? integrationID : CONSOLE_INTEGRATION_ID
    const single: QuotaContext = {
      ...ctx,
      credentials: [{ ...row, integrationID: authKey, active: true }],
    }
    const result = await fetchCombined(single)
    const consoleCredential = getConsoleCredential(single)
    return consoleCredential ? { ...result, accountLabel: consoleCredential.orgID } : result
  },
}
