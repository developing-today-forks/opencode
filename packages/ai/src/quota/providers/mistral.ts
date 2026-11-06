import type { QuotaContext, QuotaProvider, QuotaResult, QuotaWindow, JsonValue } from "../types.js"
import { cdpPageFetch, isSessionExpiredStatus } from "../cdp.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  envOf,
  errorText,
  fetchOf,
  formatMoney,
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
 * Mistral quota — the admin console budget read.
 *
 * Mistral exposes no usage or balance read to a standard API key
 * (`GET /v1/usage` and `/v1/billing` return 404; the Admin usage API is
 * Enterprise-only behind a separate Admin key — probed 2026-11-04,
 * openchamber#1619). The plan's real figures live on the Mistral admin
 * console: GET https://admin.mistral.ai/api/local-trpc/billing.budget
 * under the console session. The payload carries both budgets of the
 * account — the API budget and the Vibe budget (the same account funds
 * vibe-direct; the figures surface here, through the mistral provider
 * that owns the account credential):
 *
 *   { result: { data: { json: {
 *       api_budget:  { usage_percentage, initial_budget, currency, reset_at },
 *       vibe_budget: { usage_percentage, initial_budget, currency, reset_at } } } } }
 *
 * `usage_percentage` is a percent (4.66 means 4.66% of the budget
 * consumed — verified against the console's own dollar figures
 * 2026-11-05). Each budget becomes a dollar window whose valueLabel
 * carries the used/budget dollars.
 *
 * Session sourcing, in order: a console cookie the provider's
 * credential machinery holds (the mistral credential's
 * `consoleCookie`/`cookie` metadata, or the MISTRAL_ADMIN_COOKIE
 * environment variable) is presented directly; otherwise the read runs
 * inside the laptop browser's admin.mistral.ai page via CDP, so the
 * cookie never leaves the browser. When neither path can read the
 * console, the result is an honest error with its failure class —
 * never the API key's empty "console-only" picture dressed as data.
 */

export const providerId = "mistral"
export const providerName = "Mistral AI"
export const aliases = ["mistral"]

const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models"
const ADMIN_ORIGIN = "https://admin.mistral.ai"
const BUDGET_PATH = "/api/local-trpc/billing.budget"

export interface MistralBudgetWindow {
  usedPercent: number
  usedAmount: number
  budgetAmount: number
  currency: string
  resetAt: number | null
}

const parseBudget = (raw: JsonValue | undefined): MistralBudgetWindow | null => {
  const budget = asObject(raw)
  if (!budget) return null
  const usedPercent = toNumber(budget.usage_percentage)
  const budgetAmount = toNumber(budget.initial_budget)
  if (usedPercent === null || budgetAmount === null || budgetAmount <= 0) return null
  const clampedUsedPercent = Math.min(100, Math.max(0, usedPercent))
  return {
    usedPercent: clampedUsedPercent,
    usedAmount: (clampedUsedPercent / 100) * budgetAmount,
    budgetAmount,
    currency: asNonEmptyString(budget.currency) ?? "USD",
    resetAt: toTimestamp(budget.reset_at),
  }
}

/** The billing.budget payload → the two dollar windows (api, vibe). */
export const parseMistralBudget = (
  payload: JsonValue,
): { api: MistralBudgetWindow | null; vibe: MistralBudgetWindow | null } => {
  const root = asObject(payload)
  const json = asObject(asObject(asObject(root?.result)?.data)?.json) ?? root
  return {
    api: parseBudget(json?.api_budget ?? json),
    vibe: parseBudget(json?.vibe_budget),
  }
}

const budgetWindow = (budget: MistralBudgetWindow): QuotaWindow =>
  toUsageWindow({
    usedPercent: budget.usedPercent,
    windowSeconds: null,
    resetAt: budget.resetAt,
    valueLabel: `$${formatMoney(budget.usedAmount)} / $${formatMoney(budget.budgetAmount)}`,
  })

const windowsFromPayload = (payload: JsonValue): Record<string, QuotaWindow> | null => {
  const { api, vibe } = parseMistralBudget(payload)
  const windows: Record<string, QuotaWindow> = {}
  if (api) windows.api = budgetWindow(api)
  if (vibe) windows.vibe = budgetWindow(vibe)
  return Object.keys(windows).length > 0 ? windows : null
}

const consoleCookieOf = (ctx: QuotaContext): string | null => {
  const env = envOf(ctx)
  const fromEnv = asNonEmptyString(env.MISTRAL_ADMIN_COOKIE) ?? asNonEmptyString(env.MISTRAL_CONSOLE_COOKIE)
  if (fromEnv) return fromEnv
  const entry = getAuthEntry(projectAuth(ctx), aliases)
  const metadata = entry?.metadata
  const cookieField = (field: string) => {
    const value = metadata?.[field]
    return typeof value === "string" ? value : null
  }
  return asNonEmptyString(cookieField("consoleCookie")) ?? asNonEmptyString(cookieField("cookie")) ?? null
}

type ConsoleRead =
  | { kind: "ok"; windows: Record<string, QuotaWindow> }
  | { kind: "error"; failureClass: string; message: string }

const readConsoleBudget = async (ctx: QuotaContext): Promise<ConsoleRead> => {
  const cookie = consoleCookieOf(ctx)
  if (cookie) {
    try {
      const response = await fetchOf(ctx)(`${ADMIN_ORIGIN}${BUDGET_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json", Cookie: cookie },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 401 || response.status === 403) {
        return { kind: "error", failureClass: "session-expired", message: "Mistral console session expired" }
      }
      if (!response.ok) {
        return { kind: "error", failureClass: "http-error", message: `Mistral console budget API returned HTTP ${response.status}` }
      }
      const windows = windowsFromPayload(await readQuotaJson(response))
      if (!windows) return { kind: "error", failureClass: "no-data", message: "Mistral console budget response carried no budgets" }
      return { kind: "ok", windows }
    } catch (error) {
      return { kind: "error", failureClass: "transport", message: errorText(error) }
    }
  }

  try {
    const outcome = await cdpPageFetch(ctx, ADMIN_ORIGIN, [BUDGET_PATH])
    const result = outcome.results[BUDGET_PATH]
    if (!result || result.status === 0) {
      return { kind: "error", failureClass: "cdp-unavailable", message: "Mistral console read produced no response in the browser" }
    }
    if (isSessionExpiredStatus(result)) {
      return { kind: "error", failureClass: "session-expired", message: "Mistral console session expired — sign in to admin.mistral.ai again" }
    }
    if (result.status !== 200) {
      return { kind: "error", failureClass: "http-error", message: `Mistral console budget API returned HTTP ${result.status}` }
    }
    let payload: JsonValue
    try {
      // JSON.parse yields exactly the JsonValue grammar; the
      // annotation records that contract at the boundary.
      payload = JSON.parse(result.text)
    } catch {
      return { kind: "error", failureClass: "no-data", message: "Mistral console budget response was not JSON" }
    }
    const windows = windowsFromPayload(payload)
    if (!windows) return { kind: "error", failureClass: "no-data", message: "Mistral console budget response carried no budgets" }
    return { kind: "ok", windows }
  } catch (error) {
    const message = errorText(error)
    return {
      kind: "error",
      failureClass: message.startsWith("cdp-unavailable") ? "cdp-unavailable" : "transport",
      message,
    }
  }
}

/** The API key's one provable fact, used only to word the console failure. */
const keyValidity = async (ctx: QuotaContext, apiKey: string): Promise<string> => {
  const timeoutSignal = AbortSignal.timeout(15_000)
  try {
    const response = await fetchOf(ctx)(MISTRAL_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Accept-Encoding": "identity" },
      signal: timeoutSignal,
    })
    if (response.status === 401 || response.status === 403) return "the enrolled API key is invalid or revoked"
    if (!response.ok) return `the API key check returned HTTP ${response.status}`
    const payload = asObject(await readQuotaJson(response))
    return Array.isArray(payload?.data) ? "the enrolled API key is live" : "the API key check returned no model data"
  } catch (error) {
    return isTimeoutError(error, timeoutSignal) ? "the API key check timed out" : "the API key check failed"
  }
}

const fetchForEntry = async (ctx: QuotaContext, entry: { key?: string } | null): Promise<QuotaResult> => {
  const apiKey = asNonEmptyString(entry?.key)
  if (!apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
  }
  const console = await readConsoleBudget(ctx)
  if (console.kind === "ok") {
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: console.windows } })
  }
  const validity = await keyValidity(ctx, apiKey)
  return {
    ...buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: `Mistral console budget read failed (${console.failureClass}): ${console.message}; ${validity}`,
    }),
    failureClass: console.failureClass,
  }
}

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  credentialAliases: ["mistral"],
  isConfigured: (ctx) => Boolean(asNonEmptyString(getAuthEntry(projectAuth(ctx), aliases)?.key)),
  fetchQuota: async (ctx) => fetchForEntry(ctx, getAuthEntry(projectAuth(ctx), aliases)),
  fetchQuotaForCredential: async (ctx, row) => fetchForEntry(ctx, projectCredentialValue(row.value)),
}
