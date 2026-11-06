import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { JsonObject, JsonValue, QuotaContext, QuotaProvider, QuotaResult, QuotaWindow } from "../types.js"
import { cdpPageFetch, isSessionExpiredStatus } from "../cdp.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  envOf,
  fetchOf,
  formatMoney,
  getAuthEntry,
  parseJsonValue,
  projectAuth,
  readQuotaJson,
  resolveWindowLabel,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../utils.js"

/**
 * Meta (Muse Code High Usage) quota — the dev.meta.ai portal read is
 * the system of record for percentages (developing-today/code#6079,
 * absorbed into this provider by #6125), with the key endpoint kept as
 * the subscription-active/tier cross-check.
 *
 * Portal: GET https://dev.meta.ai/api/portal/teams/{team}/subscription-quota
 * and .../billing-banner under the portal session, fetched inside the
 * laptop browser's dev.meta.ai page via CDP (cookie auth; the cookie
 * never leaves the browser). used/limit are stringified integers in
 * weighted units; % = used/limit. The 18000s window is the rolling
 * window, plus the weekly window; the banner's remaining minor units
 * are the free credits.
 *
 * A 401 / "Not authenticated" portal answer is failure class
 * `session-expired`: the read falls back to the key endpoint
 * (POST https://api.meta.ai/muse-code/key — the endpoint Meta's own
 * Muse Code CLI reads for /usage), whose exhausted wall (402/429 /
 * require_payment) is reported as the exhausted state with its reset,
 * never as a fabricated percentage. The key endpoint's account token
 * comes from the OpenCode `meta` credential when it holds one, else
 * from the Muse CLI's own OAuth store (~/.config/muse/auth.json).
 */

export const providerId = "meta"
export const providerName = "Meta Model API"
export const aliases = ["meta"]

const META_KEY_URL = "https://api.meta.ai/muse-code/key"
const PORTAL_ORIGIN = "https://dev.meta.ai"
const DEFAULT_TEAM_ID = "1073226932208501"
const WEEKLY_SECONDS = 7 * 24 * 60 * 60

const teamIdOf = (ctx: QuotaContext, pageUrl: string): string => {
  try {
    const fromPage = new URL(pageUrl).searchParams.get("team_id")
    if (fromPage) return fromPage
  } catch {
    // A page URL that does not parse names no team; the default stands.
  }
  return asNonEmptyString(envOf(ctx).META_TEAM_ID) ?? DEFAULT_TEAM_ID
}

// ---- portal mapping (fixture-tested against the 2026-10-27 payload) ----

export const parseSubscriptionQuota = (
  payload: JsonValue,
): { tier: string | null; windows: Record<string, QuotaWindow> } | null => {
  const quota = asObject(asObject(payload)?.subscription_quota)
  if (!quota) return null
  const windowUsed = toNumber(quota.window_weighted_used)
  const windowLimit = toNumber(quota.window_weighted_limit)
  const weeklyUsed = toNumber(quota.weekly_weighted_used)
  const weeklyLimit = toNumber(quota.weekly_weighted_limit)
  const windowReset = toNumber(quota.window_resets_at)
  const weeklyReset = toNumber(quota.weekly_resets_at)
  const durationSecs = toNumber(quota.window_duration_secs)
  // The reset timestamps are NOT part of the null gate: the live
  // portal omits window_resets_at while the rolling window has not
  // started (observed 2026-11-05: window_weighted_used "0" and no
  // window_resets_at field at all). An absent reset is an honest
  // null resetAt on that window, not an unparseable payload. The
  // resets go through the shared toTimestamp converter (#1855): a
  // non-positive reset is likewise an honest null, never a
  // 1969/1970 date published by a raw seconds multiplication
  // (the #1845 disposition, which this parser previously bypassed).
  if (windowUsed === null || windowLimit === null || weeklyUsed === null || weeklyLimit === null) return null
  // A non-positive limit has no percentage to derive (rule 4, no
  // figure no window): that window alone is dropped, the other still
  // publishes, and the parse is null only when neither survives. A
  // negative limit used to clamp to a fabricated 0% / 100% headroom
  // window; a zero limit used to null the whole payload.
  const pct = (used: number, limit: number) => Math.min(100, Math.max(0, (used / limit) * 100))
  const windowSeconds = durationSecs !== null && durationSecs > 0 ? durationSecs : null
  const windows: Record<string, QuotaWindow> = {}
  if (windowLimit > 0) {
    windows[windowSeconds ? resolveWindowLabel(windowSeconds) : "rolling"] = toUsageWindow({
      usedPercent: pct(windowUsed, windowLimit),
      windowSeconds,
      resetAt: toTimestamp(windowReset),
    })
  }
  if (weeklyLimit > 0) {
    windows.weekly = toUsageWindow({
      usedPercent: pct(weeklyUsed, weeklyLimit),
      windowSeconds: WEEKLY_SECONDS,
      resetAt: toTimestamp(weeklyReset),
    })
  }
  if (Object.keys(windows).length === 0) return null
  return { tier: asNonEmptyString(quota.tier) ?? null, windows }
}

export const parseBillingBanner = (payload: JsonValue): number | null => {
  // Shared toNumber, not a hand-rolled typeof check: providers send
  // string-typed numbers, and a string banner must not silently null
  // the cross-check (#1750, the #1741 lesson).
  const minor = toNumber(asObject(payload)?.remaining_minor_units)
  if (minor === null || minor < 0) return null
  if (asObject(payload)?.currency !== "USD") return null
  return minor / 100
}

// ---- key endpoint cross-check (the module's meta.js wire) ----

const readMuseAccountToken = (ctx: QuotaContext): string | null => {
  try {
    const parsed = parseJsonValue(readFileSync(join(ctx.homeDir ?? homedir(), ".config", "muse", "auth.json"), "utf8"))
    const meta = asObject(asObject(asObject(parsed)?.providers)?.meta)
    return asNonEmptyString(meta?.access_token) ?? null
  } catch {
    return null
  }
}

type KeyOutcome =
  | { kind: "usage"; body: JsonObject }
  | { kind: "exhausted"; resetAt: number | null; limitKind: string | null; tier: string | null; message: string | null }
  | { kind: "unauthorized" }
  | { kind: "inactive" }
  | { kind: "error"; failureClass: string; message: string }

const errorMessageOf = (body: JsonObject | null): string | null =>
  asNonEmptyString(asObject(body?.error)?.message) ??
  asNonEmptyString(body?.message) ??
  asNonEmptyString(body?.detail) ??
  null

const readQuotaErrorDetail = (body: JsonObject | null) => {
  const quota = asObject(body?.quota)
  const resetRaw = quota?.resetsAtMs ?? quota?.resets_at ?? quota?.resetsAt ?? body?.resetsAtMs ?? body?.resets_at
  return {
    resetAt: toTimestamp(resetRaw),
    limitKind: asNonEmptyString(quota?.limitKind) ?? asNonEmptyString(quota?.limit_kind) ?? asNonEmptyString(body?.limitKind) ?? null,
    tier: asNonEmptyString(quota?.tier) ?? asNonEmptyString(body?.tier) ?? null,
  }
}

const requestPlanUsage = async (ctx: QuotaContext, bearer: string): Promise<KeyOutcome> => {
  const timeoutSignal = AbortSignal.timeout(15_000)
  let response: Response
  try {
    response = await fetchOf(ctx)(META_KEY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-version": "1.0.0",
      },
      body: JSON.stringify({ onboard: false }),
      signal: timeoutSignal,
    })
  } catch (error) {
    return {
      kind: "error",
      failureClass: error instanceof SyntaxError ? "malformed" : "transport",
      message:
        error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "Request timed out"
          : error instanceof Error
            ? error.message
            : "Request failed",
    }
  }

  const readBody = async (): Promise<JsonObject | null> => {
    try {
      return asObject(await readQuotaJson(response))
    } catch {
      return null
    }
  }

  if (response.status === 401 || response.status === 403) return { kind: "unauthorized" }
  if (response.status === 402 || response.status === 429) {
    const body = await readBody()
    return { kind: "exhausted", ...readQuotaErrorDetail(body), message: errorMessageOf(body) }
  }
  if (!response.ok) return { kind: "error", failureClass: "http-error", message: `API error: ${response.status}` }

  const body = await readBody()
  if (!body) return { kind: "error", failureClass: "malformed", message: "Invalid response from provider" }
  if (body.is_subs_active === false) return { kind: "inactive" }
  if (body.require_payment === true) {
    return { kind: "exhausted", ...readQuotaErrorDetail(body), message: errorMessageOf(body) }
  }
  return { kind: "usage", body }
}

const toUsedPercent = (value: JsonValue | undefined): number | null => {
  const percent = toNumber(value)
  return percent === null ? null : Math.min(100, Math.max(0, percent))
}

const keyUsageResult = (body: JsonObject): QuotaResult => {
  const subsUsage = asObject(body.subs_usage)
  const windows: Record<string, QuotaWindow> = {}
  const rolling = asObject(subsUsage?.window)
  if (rolling) {
    const durationMinutes = toNumber(rolling.window_duration_mins)
    const windowSeconds = durationMinutes !== null && durationMinutes > 0 ? durationMinutes * 60 : null
    windows[windowSeconds ? resolveWindowLabel(windowSeconds) : "rolling"] = toUsageWindow({
      usedPercent: toUsedPercent(rolling.used_percent),
      windowSeconds,
      resetAt: toTimestamp(rolling.resets_at),
    })
  }
  const weekly = asObject(subsUsage?.weekly)
  if (weekly) {
    windows.weekly = toUsageWindow({
      usedPercent: toUsedPercent(weekly.used_percent),
      windowSeconds: WEEKLY_SECONDS,
      resetAt: toTimestamp(weekly.resets_at),
    })
  }
  if (Object.keys(windows).length === 0) {
    if (body.is_subs_active !== true) {
      return {
        ...buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: "Usage unknown — Meta plan-usage read returned no quota data",
        }),
        failureClass: "no-data",
      }
    }
    // Post-roll empty state: a window open with no usage yet.
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      planLabel: asNonEmptyString(body.subs_tier_name) ?? undefined,
      usage: {
        windows: {
          rolling: toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null }),
          weekly: toUsageWindow({ usedPercent: null, windowSeconds: WEEKLY_SECONDS, resetAt: null }),
        },
      },
      accountLabel: asNonEmptyString(body.user_email) ?? undefined,
    })
  }
  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    planLabel: asNonEmptyString(body.subs_tier_name) ?? undefined,
    usage: { windows },
    accountLabel: asNonEmptyString(body.user_email) ?? undefined,
  })
}

const exhaustedResult = (outcome: Extract<KeyOutcome, { kind: "exhausted" }>, note?: string): QuotaResult => {
  const detail = outcome.message && outcome.message !== "Subscription quota exhausted" ? `: ${outcome.message}` : ""
  return {
    ...buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: `Subscription quota exhausted${detail}${note ? ` (${note})` : ""}`,
      planLabel: outcome.tier ?? undefined,
    }),
    quotaExhausted: true,
    quotaResetAt: outcome.resetAt,
    quotaLimitKind: outcome.limitKind,
    failureClass: "exhausted",
  }
}

const keyEndpointRead = async (ctx: QuotaContext, primary: string): Promise<QuotaResult> => {
  const first = await requestPlanUsage(ctx, primary)
  if (first.kind !== "unauthorized") return outcomeToResult(first)
  const fallback = readMuseAccountToken(ctx)
  if (!fallback || fallback === primary) {
    return {
      ...buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: "Meta plan usage needs the account login — sign in with the Muse Code CLI or store its account token",
      }),
      failureClass: "unauthorized",
    }
  }
  return outcomeToResult(await requestPlanUsage(ctx, fallback))
}

const outcomeToResult = (outcome: KeyOutcome): QuotaResult => {
  if (outcome.kind === "exhausted") return exhaustedResult(outcome)
  if (outcome.kind === "inactive") {
    return {
      ...buildResult({ providerId, providerName, ok: false, configured: true, error: "Meta subscription is inactive" }),
      failureClass: "inactive",
    }
  }
  if (outcome.kind === "error") {
    return {
      ...buildResult({ providerId, providerName, ok: false, configured: true, error: outcome.message }),
      failureClass: outcome.failureClass,
    }
  }
  if (outcome.kind === "usage") return keyUsageResult(outcome.body)
  return {
    ...buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: "Meta plan usage needs the account login — sign in with the Muse Code CLI or store its account token",
    }),
    failureClass: "unauthorized",
  }
}

// ---- provider ----

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    return Boolean(asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.key) ?? readMuseAccountToken(ctx))
  },
  fetchQuota: async (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    const primary = asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.key) ?? readMuseAccountToken(ctx)
    if (!primary) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    // Portal first: it is the system of record for percentages.
    let portalFailure: { failureClass: string; message: string } | null = null
    try {
      const team = teamIdOf(ctx, "")
      const paths = [
        `/api/portal/teams/${team}/subscription-quota`,
        `/api/portal/teams/${team}/billing-banner`,
      ]
      const outcome = await cdpPageFetch(ctx, PORTAL_ORIGIN, paths)
      const quotaResult = outcome.results[paths[0]]
      const bannerResult = outcome.results[paths[1]]
      if (quotaResult && isSessionExpiredStatus(quotaResult)) {
        portalFailure = {
          failureClass: "session-expired",
          message: "dev.meta.ai portal session expired — the laptop portal session needs re-login",
        }
      } else if (quotaResult && quotaResult.status === 200) {
        let parsed: ReturnType<typeof parseSubscriptionQuota> = null
        try {
          parsed = parseSubscriptionQuota(JSON.parse(quotaResult.text))
        } catch {
          parsed = null
        }
        if (parsed) {
          const windows = { ...parsed.windows }
          if (bannerResult && bannerResult.status === 200) {
            try {
              const credits = parseBillingBanner(JSON.parse(bannerResult.text))
              if (credits !== null) {
                windows.credits_balance = toUsageWindow({
                  usedPercent: null,
                  windowSeconds: null,
                  resetAt: null,
                  valueLabel: `$${formatMoney(credits)}`,
                })
              }
            } catch {
              // The banner is decoration on the windows; its failure leaves them standing.
            }
          }
          return buildResult({
            providerId,
            providerName,
            ok: true,
            configured: true,
            planLabel: parsed.tier ?? undefined,
            usage: { windows },
          })
        }
        portalFailure = { failureClass: "no-data", message: "dev.meta.ai portal subscription-quota response could not be parsed" }
      } else {
        portalFailure = {
          failureClass: "http-error",
          message: `dev.meta.ai portal subscription-quota returned HTTP ${quotaResult?.status ?? 0}`,
        }
      }
    } catch (error) {
      portalFailure = {
        failureClass: "cdp-unavailable",
        message: error instanceof Error ? error.message : "portal read failed",
      }
    }

    // Cross-check with the key endpoint: an exhausted wall there is the
    // exhausted state; an active answer keeps the portal failure honest
    // on the row instead of inventing percentages.
    const keyResult = await keyEndpointRead(ctx, primary)
    if (keyResult.quotaExhausted) return keyResult
    if (portalFailure.failureClass === "session-expired") {
      if (keyResult.ok) return keyResult
      return {
        ...keyResult,
        error: `${portalFailure.message}; key-endpoint cross-check: ${keyResult.error ?? "no data"}`,
        failureClass: "session-expired",
      }
    }
    if (keyResult.ok) return keyResult
    return {
      ...keyResult,
      error: `${keyResult.error ?? "Meta quota read failed"}; portal: ${portalFailure.message}`,
    }
  },
}
