import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { QuotaContext, QuotaProvider, QuotaWindow, JsonValue } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  envOf,
  fetchOf,
  readQuotaJson,
  toNumber,
  toTimestamp,
  toUsageWindow,
  parseJsonValue,
} from "../utils.js"

/**
 * Open Design quota — ported from the OpenChamber quota module
 * (providers/opendesign.js).
 *
 * The billing usage API refuses the OpenCode-held AMR inference key
 * (verified 403): the read rides the managed Better Auth session
 * credential in OpenChamber's managed credential store
 * ($OPENCHAMBER_DATA_DIR or ~/.config/openchamber, quota/opendesign.json
 * — the store an aggregator-side renewal keeper maintains; see
 * code#5060). This provider reads that same store file, read-only; it
 * never falls back to the AMR key.
 */

export const providerId = "opendesign"
export const providerName = "Open Design"
export const aliases = ["opendesign", "open-design", "amr"]

const API_BASE_URL = "https://amr-api.open-design.ai/api"
const SESSION_COOKIE_NAME = "better-auth.session_token"

export const IMPORT_REQUIRED_ERROR = "Import the Open Design session cookie in Settings to read Open Design quota"
export const SESSION_EXPIRED_ERROR = "Open Design session expired; import a fresh session cookie in Settings"

interface OpenDesignCredential {
  cookie: string
  workspaceId: string
}

const clean = (value: JsonValue | undefined): string =>
  typeof value === "string" && !/[\r\n]/.test(value) ? value.trim() : ""

export const normalizeOpenDesignCredential = (value: JsonValue): OpenDesignCredential | null => {
  const record = asObject(value)
  const cookieInput = clean(record?.cookie)
  const workspaceId = clean(record?.workspaceId)
  if (!cookieInput || !workspaceId) return null
  const cookie = cookieInput.includes("better-auth")
    ? cookieInput
    : `${SESSION_COOKIE_NAME}=${cookieInput}`
  return { cookie, workspaceId }
}

/** The managed-store read: same directory + file + format the keeper writes. */
export const readManagedOpenDesignCredential = (ctx: QuotaContext): OpenDesignCredential | null => {
  const env = envOf(ctx)
  const root =
    ctx.openchamberDataDir ??
    (asNonEmptyString(env.OPENCHAMBER_DATA_DIR) ?? join(ctx.homeDir ?? homedir(), ".config", "openchamber"))
  try {
    return normalizeOpenDesignCredential(parseJsonValue(readFileSync(join(root, "quota", "opendesign.json"), "utf8")))
  } catch {
    return null
  }
}

const WINDOW_LABELS = new Map<number, string>([
  [18000, "5h"],
  [604800, "7d"],
])

export const parseCodingPlanWindows = (payload: JsonValue): Record<string, QuotaWindow> | null => {
  const data = asObject(payload)
  if (!data || !Array.isArray(data.windows)) return null
  const windows: Record<string, QuotaWindow> = {}
  for (const entry of data.windows) {
    const record = asObject(entry)
    if (!record) continue
    const duration = toNumber(record.durationSeconds)
    const label = duration !== null ? WINDOW_LABELS.get(duration) : undefined
    if (!label) continue
    const limit = toNumber(record.limitCredits)
    const remaining = toNumber(record.remainingCredits)
    if (limit === null || limit <= 0 || remaining === null) continue
    const usedPercent = Math.min(100, Math.max(0, (1 - remaining / limit) * 100))
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: duration,
      resetAt: toTimestamp(record.resetsAt),
      valueLabel: `${remaining} / ${limit} credits`,
    })
  }
  return Object.keys(windows).length > 0 ? windows : null
}

const buildHeaders = (credential: OpenDesignCredential): Record<string, string> => ({
  Accept: "application/json",
  Cookie: credential.cookie,
  "x-vela-workspace-id": credential.workspaceId,
  "User-Agent": "OpenCode quota provider",
})

const workspaceUrl = (credential: OpenDesignCredential, suffix: string): string =>
  `${API_BASE_URL}/v1/workspaces/${encodeURIComponent(credential.workspaceId)}/billing/${suffix}`

export const fetchOpenDesignQuota = async (
  ctx: QuotaContext,
  credential: OpenDesignCredential,
): Promise<{ windows: Record<string, QuotaWindow> }> => {
  const fetchImpl = fetchOf(ctx)
  const headers = buildHeaders(credential)

  const sessionResponse = await fetchImpl(`${API_BASE_URL}/auth/get-session`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  const session = sessionResponse.ok ? await readQuotaJson(sessionResponse).catch(() => null) : null
  if (!asObject(session)) throw new Error(SESSION_EXPIRED_ERROR)

  const usageResponse = await fetchImpl(workspaceUrl(credential, "coding-plan-usage"), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  if (usageResponse.status === 401 || usageResponse.status === 403) {
    throw new Error(SESSION_EXPIRED_ERROR)
  }
  if (!usageResponse.ok) {
    throw new Error(`Open Design usage API returned HTTP ${usageResponse.status}`)
  }
  const windows = parseCodingPlanWindows(await readQuotaJson(usageResponse).catch(() => null))
  if (!windows) throw new Error("Open Design usage data could not be parsed")
  return { windows }
}

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => Boolean(readManagedOpenDesignCredential(ctx)),
  fetchQuota: async (ctx) => {
    const credential = readManagedOpenDesignCredential(ctx)
    if (!credential) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: false,
        error: IMPORT_REQUIRED_ERROR,
      })
    }
    try {
      const usage = await fetchOpenDesignQuota(ctx, credential)
      return buildResult({ providerId, providerName, ok: true, configured: true, usage })
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : "Request failed",
      })
    }
  },
}
