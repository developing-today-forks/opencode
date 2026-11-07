import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { QuotaContext, QuotaProvider, QuotaResult, QuotaCredentialSource, JsonValue } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  clampPercent,
  envOf,
  fetchOf,
  formatMoney,
  getAuthEntry,
  isTimeoutError,
  normalizeTimestamp,
  projectAuth,
  readQuotaJson,
  toNumber,
  toTimestamp,
  toUsageWindow,
  parseJsonValue,
} from "../utils.js"

/**
 * Claude subscription quota — ported from the OpenChamber quota module
 * (providers/claude/). Reports the plan limits Claude Code itself is
 * bound by (rolling session window, weekly windows, model-scoped weekly
 * windows, paid extra usage) from GET
 * https://api.anthropic.com/api/oauth/usage with the OAuth credential
 * Claude Code already holds.
 *
 * Credential discovery order (the module's): Claude Code's credentials
 * file (~/.claude/.credentials.json; Keychain on macOS), then OpenCode's
 * stored Anthropic/Claude credential (the fork also stores the Claude
 * Code login under the `claude-code` integration), then the
 * CLAUDE_CODE_OAUTH_TOKEN environment variable. Every source is
 * read-only and read fresh per fetch.
 *
 * Every result that a credential served carries `credentialExpiresAt`
 * (ISO) and `credentialSource` (code#6125 clarification: the gatherer
 * stamps entries from these fields instead of a side read). The module
 * source names map: keychain/credentials-file → "claude-code",
 * opencode-auth → "opencode", env → "environment".
 */

export const providerId = "claude"
export const providerName = "Claude"
export const aliases = ["anthropic", "claude", "claude-code"]

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA_HEADER = "oauth-2025-04-20"

interface ClaudeCredential {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  planLabel: string | null
  source: "keychain" | "credentials-file" | "opencode-auth" | "env"
}

const SOURCE_MAP: Record<ClaudeCredential["source"], QuotaCredentialSource> = {
  keychain: "claude-code",
  "credentials-file": "claude-code",
  "opencode-auth": "opencode",
  env: "environment",
}

const claudeConfigDirectory = (ctx: QuotaContext): string => {
  const override = asNonEmptyString(envOf(ctx).CLAUDE_CONFIG_DIR)
  return override ?? join(ctx.homeDir ?? homedir(), ".claude")
}

const parseClaudeCodeBlob = (blob: JsonValue, source: ClaudeCredential["source"]): ClaudeCredential | null => {
  const oauth = asObject(asObject(blob)?.claudeAiOauth)
  const accessToken = asNonEmptyString(oauth?.accessToken)
  if (!accessToken) return null
  return {
    accessToken,
    refreshToken: asNonEmptyString(oauth?.refreshToken) ?? null,
    expiresAt: normalizeTimestamp(oauth?.expiresAt),
    planLabel: asNonEmptyString(oauth?.subscriptionType) ?? null,
    source,
  }
}

const readCredentialsFile = (ctx: QuotaContext): ClaudeCredential | null => {
  try {
    const raw = readFileSync(join(claudeConfigDirectory(ctx), ".credentials.json"), "utf8")
    return parseClaudeCodeBlob(parseJsonValue(raw), "credentials-file")
  } catch {
    return null
  }
}

const readOpenCodeCredential = (ctx: QuotaContext): ClaudeCredential | null => {
  const entry = getAuthEntry(projectAuth(ctx), ["anthropic", "claude", "claude-code"])
  const accessToken = asNonEmptyString(entry?.access)
  if (!accessToken) return null
  return {
    accessToken,
    refreshToken: asNonEmptyString(entry?.refresh) ?? null,
    expiresAt: normalizeTimestamp(entry?.expires),
    planLabel: null,
    source: "opencode-auth",
  }
}

const readEnvCredential = (ctx: QuotaContext): ClaudeCredential | null => {
  const accessToken = asNonEmptyString(envOf(ctx).CLAUDE_CODE_OAUTH_TOKEN)
  if (!accessToken) return null
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: "env" }
}

/** First credential a source can produce, in the module's priority order. (macOS Keychain omitted on this platform path: the credentials file is the Linux store.) */
export const findClaudeCredential = (ctx: QuotaContext): ClaudeCredential | null =>
  readCredentialsFile(ctx) ?? readOpenCodeCredential(ctx) ?? readEnvCredential(ctx)

const withMetadata = (result: QuotaResult, credential: ClaudeCredential): QuotaResult => ({
  ...result,
  ...(credential.expiresAt !== null
    ? { credentialExpiresAt: new Date(credential.expiresAt).toISOString() }
    : {}),
  ...(Object.hasOwn(SOURCE_MAP, credential.source) ? { credentialSource: SOURCE_MAP[credential.source] } : {}),
})

// ---- usage payload transforms (providers/claude/transforms.js) ----

const SESSION_WINDOW = "5h"
const WEEKLY_WINDOW = "7d"
const EXTRA_USAGE_WINDOW = "extra_usage"
const SESSION_WINDOW_SECONDS = 5 * 60 * 60
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

const toAmount = (value: JsonValue | undefined): number | null => {
  const money = asObject(value)
  const minor = toNumber(money?.amount_minor)
  if (minor === null) return null
  const exponent = toNumber(money?.exponent) ?? 2
  return minor / 10 ** exponent
}

const formatSpendLabel = (used: number | null, limit: number | null, currency: string | undefined): string | null => {
  const usedLabel = formatMoney(used)
  if (usedLabel === null) return null
  const prefix = currency === "USD" || !currency ? "$" : `${currency} `
  const limitLabel = formatMoney(limit)
  return limitLabel === null ? `${prefix}${usedLabel}` : `${prefix}${usedLabel} / ${prefix}${limitLabel}`
}

type WindowMap = Record<string, ReturnType<typeof toUsageWindow>>

const addWindow = (
  target: WindowMap,
  key: string,
  input: { percent: number | null; resetAt: number | null; valueLabel?: string | null; windowSeconds?: number | null },
) => {
  if (input.percent === null && !input.valueLabel) return
  target[key] = toUsageWindow({
    usedPercent: input.percent,
    windowSeconds: input.windowSeconds ?? null,
    resetAt: input.resetAt,
    valueLabel: input.valueLabel,
  })
}

export const toClaudeUsage = (rawPayload: JsonValue): { windows: WindowMap; models: Record<string, { windows: WindowMap }> } => {
  const payload = asObject(rawPayload) ?? {}
  const windows: WindowMap = {}
  const models: Record<string, { windows: WindowMap }> = {}

  const limits = Array.isArray(payload.limits) ? payload.limits : []
  for (const entry of limits) {
    const limit = asObject(entry)
    if (!limit) continue
    const percent = clampPercent(toNumber(limit.percent))
    const resetAt = toTimestamp(limit.resets_at)
    const modelName = asNonEmptyString(asObject(asObject(limit.scope)?.model)?.display_name)
    if (limit.kind === "session") {
      addWindow(windows, SESSION_WINDOW, { percent, resetAt, windowSeconds: SESSION_WINDOW_SECONDS })
    } else if (limit.kind === "weekly_all") {
      addWindow(windows, WEEKLY_WINDOW, { percent, resetAt, windowSeconds: WEEKLY_WINDOW_SECONDS })
    } else if (limit.kind === "weekly_scoped" && modelName) {
      const modelWindows: WindowMap = {}
      addWindow(modelWindows, WEEKLY_WINDOW, { percent, resetAt, windowSeconds: WEEKLY_WINDOW_SECONDS })
      if (Object.keys(modelWindows).length > 0) models[modelName] = { windows: modelWindows }
    }
  }

  // Legacy fallback, per window (#1750): the legacy five_hour/seven_day
  // fields fill any session/weekly window the limits list did not
  // produce. A limits list of only scoped/unrecognized kinds used to
  // discard the legacy windows entirely (the branch was the `else` of
  // `limits.length > 0`); a window the limits list did produce always
  // wins over the legacy figure for the same window.
  const fiveHour = asObject(payload.five_hour)
  const sevenDay = asObject(payload.seven_day)
  if (fiveHour && !(SESSION_WINDOW in windows)) {
    addWindow(windows, SESSION_WINDOW, {
      percent: clampPercent(toNumber(fiveHour.utilization)),
      resetAt: toTimestamp(fiveHour.resets_at),
      windowSeconds: SESSION_WINDOW_SECONDS,
    })
  }
  if (sevenDay && !(WEEKLY_WINDOW in windows)) {
    addWindow(windows, WEEKLY_WINDOW, {
      percent: clampPercent(toNumber(sevenDay.utilization)),
      resetAt: toTimestamp(sevenDay.resets_at),
      windowSeconds: WEEKLY_WINDOW_SECONDS,
    })
  }

  const spend = asObject(payload.spend)
  if (spend && spend.enabled === true) {
    const used = toAmount(spend.used)
    const limit = toAmount(spend.limit)
    addWindow(windows, EXTRA_USAGE_WINDOW, {
      percent: clampPercent(toNumber(spend.percent)),
      resetAt: null,
      valueLabel: formatSpendLabel(used, limit, asNonEmptyString(asObject(spend.used)?.currency)),
    })
  }

  return { windows, models }
}

// ---- provider ----

const failure = (error: string, configured = true): QuotaResult =>
  buildResult({ providerId, providerName, ok: false, configured, error })

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => Boolean(findClaudeCredential(ctx)),
  fetchQuota: async (ctx) => {
    const credential = findClaudeCredential(ctx)
    if (!credential) return failure("Not configured", false)

    const timeoutSignal = AbortSignal.timeout(15_000)
    let response: Response
    try {
      response = await fetchOf(ctx)(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
        },
        signal: timeoutSignal,
      })
    } catch (error) {
      return withMetadata(
        failure(isTimeoutError(error, timeoutSignal) ? "Request timed out" : error instanceof Error ? error.message : "Request failed"),
        credential,
      )
    }

    if (response.status === 429) {
      return withMetadata(failure("Rate limited. Retrying soon."), credential)
    }
    if (response.status === 401 || response.status === 403) {
      return withMetadata(failure("Claude session expired. Open Claude Code to sign in again."), credential)
    }
    if (!response.ok) {
      return withMetadata(failure(`API error: ${response.status}`), credential)
    }

    let payload: JsonValue
    try {
      payload = await readQuotaJson(response)
    } catch {
      return withMetadata(failure("Unexpected response from Anthropic"), credential)
    }

    const { windows, models } = toClaudeUsage(payload)
    const usage = Object.keys(models).length > 0 ? { windows, models } : { windows }
    return withMetadata(
      buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage,
        planLabel: credential.planLabel ?? undefined,
      }),
      credential,
    )
  },
}
