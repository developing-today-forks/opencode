import type { QuotaContext, QuotaProvider, QuotaResult, JsonValue } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  envOf,
  fetchOf,
  getAuthEntry,
  projectAuth,
  projectCredentialValue,
  readQuotaJson,
  toNumber,
  toUsageWindow,
} from "../utils.js"

/**
 * Command Code quota — ported from the OpenChamber quota module
 * (providers/command-code.js). Per Drew's quota READ RULE (2026-11-01)
 * Command Code reads report the PLAN windows; the top-up balance
 * (purchasedCredits) is never a quota figure. The fork's config id for
 * this provider is `commandcode`; the quota id keeps the module's
 * `command-code`.
 */

export const providerId = "_commandcode"
export const providerName = "Command Code"
export const aliases = ["_commandcode", "command-code", "commandcode", "command_code", "command code"]

const API_BASE_URL = "https://api.commandcode.ai"

const getApiKey = (ctx: QuotaContext): string | null => {
  const entry = getAuthEntry(projectAuth(ctx), aliases)
  const stored = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.access)
  return stored ?? asNonEmptyString(envOf(ctx).COMMAND_CODE_API_KEY) ?? null
}

const requestJson = async (ctx: QuotaContext, path: string, apiKey: string): Promise<JsonValue> => {
  const response = await fetchOf(ctx)(`${API_BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "OpenCode quota provider",
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401 || response.status === 403) throw new Error("Command Code authentication failed")
  if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`)
  return readQuotaJson(response).catch(() => null)
}

const formatCredits = (value: number): string => String(Math.round((value + Number.EPSILON) * 100) / 100)

/** The Go plan's included monthly credits. */
export const MONTHLY_INCLUDED_CREDITS = 10

export const parseCommandCodeCredits = (payload: JsonValue) => {
  const root = asObject(payload)
  const credits = asObject(root?.credits)
  const limits = asObject(root?.windowLimits)
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}

  const monthlyRemaining = toNumber(credits?.monthlyCredits)
  if (monthlyRemaining !== null && monthlyRemaining >= 0) {
    // Over-included remaining (plan change, promo/rollover, higher tier) is a fully-unused month, not absent data: publish at 0% used with the real remaining figure in the label (#1744; cf. #1743 Turso).
    const monthlyUsed = Math.max(0, MONTHLY_INCLUDED_CREDITS - monthlyRemaining)
    windows.monthly = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, (monthlyUsed / MONTHLY_INCLUDED_CREDITS) * 100)),
      windowSeconds: null,
      resetAt: null,
      valueLabel:
        monthlyRemaining > MONTHLY_INCLUDED_CREDITS
          ? `${formatCredits(monthlyUsed)} / ${formatCredits(MONTHLY_INCLUDED_CREDITS)} (${formatCredits(monthlyRemaining)} remaining)`
          : `${formatCredits(monthlyUsed)} / ${formatCredits(MONTHLY_INCLUDED_CREDITS)}`,
    })
  }

  for (const [label, field, windowSeconds] of [
    ["5h", "fiveHour", 5 * 60 * 60],
    ["weekly", "weekly", 7 * 24 * 60 * 60],
  ] as const) {
    const limit = asObject(limits?.[field])
    const used = toNumber(limit?.used)
    const cap = toNumber(limit?.cap)
    if (used === null || cap === null || cap <= 0) continue
    const resetAt = toNumber(limit?.resetAt)
    // Clamp the WHOLE window (#1821, contract rule 5): percent and label derive
    // from one clamped used figure, so they can never contradict each other —
    // negative used publishes 0% with '0 / <cap>', over-cap used publishes 100%
    // with '<cap> / <cap>', and the window still publishes either way.
    const clampedUsed = Math.min(cap, Math.max(0, used))
    windows[label] = toUsageWindow({
      usedPercent: (clampedUsed / cap) * 100,
      windowSeconds,
      // A non-positive reset is an invalid reset (contract rule 3): null it BEFORE
      // the seconds/ms conversion — non-positive is non-positive in either unit
      // spelling — so it can never publish as a 1969/1970 date.
      resetAt: resetAt === null || resetAt <= 0 ? null : resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt,
      valueLabel: `${formatCredits(clampedUsed)} / ${formatCredits(cap)}`,
    })
  }

  return windows
}

export const fetchCommandCodeUsage = async (ctx: QuotaContext, apiKey: string) => {
  const identity = asObject(await requestJson(ctx, "/alpha/whoami", apiKey))
  const org = asObject(identity?.org)
  const orgId = asNonEmptyString(org?.id) ?? ""
  const creditsPath = orgId ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}` : "/alpha/billing/credits"
  const credits = await requestJson(ctx, creditsPath, apiKey)
  const windows = parseCommandCodeCredits(credits)
  if (Object.keys(windows).length === 0) throw new Error("Command Code usage data could not be parsed")
  return windows
}

const fetchForKey = async (ctx: QuotaContext, apiKey: string | null): Promise<QuotaResult> => {
  if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
  try {
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: await fetchCommandCodeUsage(ctx, apiKey) },
    })
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
  // #1823 rename: the quota id now equals the config provider id, so the
  // disable key is pinned to the pre-rename quota id — config
  // disabled_providers must not hide this row (module rule, kept).
  disabledBy: ["command-code"],
  credentialAliases: ["command-code", "commandcode"],
  isConfigured: (ctx) => Boolean(getApiKey(ctx)),
  fetchQuota: async (ctx) => fetchForKey(ctx, getApiKey(ctx)),
  fetchQuotaForCredential: async (ctx, row) => {
    const entry = projectCredentialValue(row.value)
    return fetchForKey(ctx, asNonEmptyString(entry.key) ?? asNonEmptyString(entry.access) ?? null)
  },
}
