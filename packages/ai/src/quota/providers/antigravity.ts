import { execFile } from "node:child_process"
import { accessSync, constants, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { AntigravityAuth } from "../../providers/antigravity-auth.js"
import type { JsonValue, QuotaContext, QuotaProvider, QuotaResult, QuotaWindow } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  fetchOf,
  getAuthEntry,
  projectAuth,
  parseJsonValue,
  projectCredentialValue,
  readQuotaJson,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../utils.js"

/**
 * Antigravity quota — ported from the OpenChamber quota module
 * (providers/antigravity/). The wire is Google Cloud Code's own:
 * POST {cloudcode-pa}/v1internal:retrieveUserQuotaSummary and
 * :fetchAvailableModels under the Antigravity client identity, with an
 * access token refreshed from the account's refresh token.
 *
 * This is the quota function of the fork's antigravity provider
 * (config id `antigravity-direct`). Credential candidates, in the
 * module's order: the agy CLI's keyring credential (service "gemini",
 * username "antigravity" — the same in-place read the fork's
 * antigravity-auth bridge performs; read-only, never written back),
 * the legacy antigravity-accounts.json file, and the credential
 * store's `google` OAuth login written by the antigravity auth method.
 */

export const providerId = "antigravity"
export const providerName = "Antigravity"
export const aliases = ["antigravity", "antigravity-direct"]

const DEFAULT_PROJECT_ID = "rising-fact-p41fc"
const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
]
// The token refresh rides the fork's own antigravity-auth bridge:
// it holds the Antigravity installed-app client identity and extracts
// the paired secret from the agy binary at runtime (memory only,
// never persisted) — this file carries no client secret.
const ANTIGRAVITY_CLIENT_VERSION = "2.24.0"

const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60
const DAILY_WINDOW_SECONDS = 24 * 60 * 60

interface AntigravityAuth {
  refreshToken: string
  projectId?: string
  origin: "keyring" | "file" | "store"
}

const parseGoogleRefreshToken = (raw: JsonValue | undefined) => {
  const refreshToken = asNonEmptyString(raw)
  const empty: { refreshToken: string | null; projectId: string | null; managedProjectId: string | null } = {
    refreshToken: null,
    projectId: null,
    managedProjectId: null,
  }
  if (!refreshToken) return empty
  const [token = "", project = "", managed = ""] = refreshToken.split("|")
  return {
    refreshToken: asNonEmptyString(token) ?? null,
    projectId: asNonEmptyString(project) ?? null,
    managedProjectId: asNonEmptyString(managed) ?? null,
  }
}

const readJsonFile = (filePath: string): JsonValue | null => {
  try {
    const raw = readFileSync(filePath, "utf8")
    const trimmed = raw.trim()
    if (!trimmed) return null
    return parseJsonValue(trimmed)
  } catch {
    return null
  }
}

const findSecretTool = (ctx: QuotaContext): string | null => {
  const env = ctx.env ?? process.env
  const candidates: string[] = []
  if (env.SECRET_TOOL_PATH) candidates.push(env.SECRET_TOOL_PATH)
  for (const dir of (env.PATH ?? "").split(":")) if (dir) candidates.push(join(dir, "secret-tool"))
  try {
    for (const store of readdirSync("/nix/store").filter((entry) => entry.includes("libsecret")).sort()) {
      candidates.push(join("/nix/store", store, "bin", "secret-tool"))
    }
  } catch {
    // No nix store on this machine; the PATH candidates stand.
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Next candidate.
    }
  }
  return null
}

const keyringAuth = async (ctx: QuotaContext): Promise<AntigravityAuth | null> => {
  const tool = findSecretTool(ctx)
  if (!tool) return null
  const token = await new Promise<{ access_token?: string; refresh_token?: string } | null>((resolve) => {
    const env = { ...(ctx.env ?? process.env) }
    if (!env.DBUS_SESSION_BUS_ADDRESS && typeof process.getuid === "function") {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${process.getuid()}/bus`
    }
    execFile(
      tool,
      ["lookup", "service", "gemini", "username", "antigravity"],
      { env, timeout: 15_000, maxBuffer: 1 << 20 },
      (error, out) => {
        if (error) return resolve(null)
        const tokenRecord = asObject(asObject(parseJsonValue(out))?.token)
        resolve(
          tokenRecord
            ? {
                access_token: asNonEmptyString(tokenRecord.access_token),
                refresh_token: asNonEmptyString(tokenRecord.refresh_token),
              }
            : null,
        )
      },
    )
  })
  if (!token?.refresh_token) return null
  const parts = parseGoogleRefreshToken(token.refresh_token)
  if (!parts.refreshToken) return null
  return { refreshToken: parts.refreshToken, projectId: parts.projectId ?? parts.managedProjectId ?? undefined, origin: "keyring" }
}

const fileAuth = (ctx: QuotaContext): AntigravityAuth | null => {
  const home = ctx.homeDir ?? homedir()
  const paths = [
    join(ctx.configDir ?? join(home, ".config", "opencode"), "antigravity-accounts.json"),
    join(home, ".local", "share", "opencode", "antigravity-accounts.json"),
  ]
  for (const filePath of paths) {
    const data = asObject(readJsonFile(filePath))
    const accounts = Array.isArray(data?.accounts) ? data.accounts : []
    if (accounts.length === 0) continue
    const parsedIndex = toNumber(data?.activeIndex)
    const account = asObject(accounts[parsedIndex ?? 0] ?? accounts[0])
    if (!account?.refreshToken) continue
    const parts = parseGoogleRefreshToken(account.refreshToken)
    if (!parts.refreshToken) continue
    return {
      refreshToken: parts.refreshToken,
      projectId:
        asNonEmptyString(account.projectId) ??
        asNonEmptyString(account.managedProjectId) ??
        parts.projectId ??
        parts.managedProjectId ??
        undefined,
      origin: "file",
    }
  }
  return null
}

const storeAuth = (ctx: QuotaContext): AntigravityAuth | null => {
  const entry = getAuthEntry(projectAuth(ctx), ["google", "google.oauth"])
  if (!entry) return null
  const parts = parseGoogleRefreshToken(entry.refresh)
  if (!parts.refreshToken) return null
  return { refreshToken: parts.refreshToken, projectId: parts.projectId ?? parts.managedProjectId ?? undefined, origin: "store" }
}

const resolveCandidates = async (ctx: QuotaContext): Promise<AntigravityAuth[]> => {
  const candidates: AntigravityAuth[] = []
  const keyring = await keyringAuth(ctx).catch(() => null)
  if (keyring) candidates.push(keyring)
  const file = fileAuth(ctx)
  if (file && !candidates.some((c) => c.refreshToken === file.refreshToken)) candidates.push(file)
  const store = storeAuth(ctx)
  if (store && !candidates.some((c) => c.refreshToken === store.refreshToken)) candidates.push(store)
  return candidates
}

// ---- wire ----

const antigravityHeaders = (): Record<string, string> => {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined
  const arch = process.arch === "arm64" ? "arm64" : "amd64"
  const platformPart = os ? `${os}/${arch}` : "windows/amd64"
  return {
    "User-Agent": `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${platformPart}`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
  }
}

interface RefreshOutcome {
  ok: boolean
  accessToken?: string
  error?: string
  status?: number
}

const refreshAccessToken = async (_ctx: QuotaContext, refreshToken: string): Promise<RefreshOutcome> => {
  try {
    const token = await Effect.runPromise(
      AntigravityAuth.refresh(refreshToken, 15_000).pipe(Effect.provide(FetchHttpClient.layer)),
    )
    return { ok: true, accessToken: token.accessToken, status: 200 }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" }
  }
}

const isWrongClientRejection = (result: RefreshOutcome): boolean =>
  !result.ok && result.error === "unauthorized_client" && (result.status === 400 || result.status === 401)

const fetchAntigravity = async (
  ctx: QuotaContext,
  path: string,
  accessToken: string,
  projectId: string | undefined,
): Promise<JsonValue> => {
  const body = projectId ? { project: projectId } : {}
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const response = await fetchOf(ctx)(`${endpoint}/v1internal:${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...antigravityHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok) return await readQuotaJson(response)
    } catch {
      continue
    }
  }
  return null
}

// ---- transforms (providers/antigravity/transforms.js) ----

interface ParsedBucket {
  label: string
  seconds: number
  remainingFraction: number | null
  window: QuotaWindow
}

// A bucket is published only when its window string is recognized
// (#1768): an unrecognized string (e.g. MONTHLY) must not fabricate a
// "5h" window that overwrites the real one — honest absence instead.
// A missing remainingFraction likewise propagates as unknown (null),
// never as an invented "fully remaining" 1.
export const parseBucket = (bucket: JsonValue): ParsedBucket | null => {
  const record = asObject(bucket)
  const remainingFraction = toNumber(record?.remainingFraction)
  const remainingPercent = remainingFraction !== null ? Math.round(remainingFraction * 100) : null
  const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null
  const resetAt = toTimestamp(record?.resetTime)
  const windowStr = (asNonEmptyString(record?.window) ?? asNonEmptyString(record?.bucketId) ?? "").toLowerCase()

  let label: string
  let seconds: number
  if (windowStr.includes("week") || windowStr.includes("7d")) {
    label = "weekly"
    seconds = WEEKLY_WINDOW_SECONDS
  } else if (windowStr.includes("day")) {
    label = "daily"
    seconds = DAILY_WINDOW_SECONDS
  } else if (windowStr.includes("five") || windowStr.includes("5h") || windowStr.includes("hour")) {
    label = "5h"
    seconds = FIVE_HOUR_WINDOW_SECONDS
  } else {
    return null
  }
  return {
    label,
    seconds,
    remainingFraction,
    window: toUsageWindow({ usedPercent, windowSeconds: seconds, resetAt }),
  }
}

interface ModelGroup {
  groupType: "3p" | "gemini"
  displayName?: string
  windows: Record<string, QuotaWindow>
  bucket5h: ParsedBucket | null
  bucketWeekly: ParsedBucket | null
}

export const transformSummary = (summaryPayload: JsonValue): ModelGroup[] => {
  const rawGroups = asObject(summaryPayload)?.groups
  const groups: JsonValue[] = Array.isArray(rawGroups) ? rawGroups : []
  const modelGroupWindows: ModelGroup[] = []
  for (const rawGroup of groups) {
    const group = asObject(rawGroup)
    const groupName = (asNonEmptyString(group?.displayName) ?? "").toLowerCase()
    const is3p = groupName.includes("claude") || groupName.includes("gpt") || groupName.includes("3p")
    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    const windows: Record<string, QuotaWindow> = {}
    let bucket5h: ParsedBucket | null = null
    let bucketWeekly: ParsedBucket | null = null
    for (const b of buckets) {
      const parsed = parseBucket(b)
      if (!parsed) continue
      // Same-label collisions keep the FIRST entry (#1750 convention,
      // #1768) — a later bucket must not silently drop or overwrite
      // the window already published for its label.
      if (!windows[parsed.label]) windows[parsed.label] = parsed.window
      if (parsed.label === "5h" && !bucket5h) bucket5h = parsed
      else if (parsed.label === "weekly" && !bucketWeekly) bucketWeekly = parsed
    }
    modelGroupWindows.push({
      groupType: is3p ? "3p" : "gemini",
      displayName: asNonEmptyString(group?.displayName),
      windows,
      bucket5h,
      bucketWeekly,
    })
  }
  return modelGroupWindows
}

export const transformModels = (
  modelsPayload: JsonValue,
  modelGroupWindows: ModelGroup[],
): Record<string, { windows: Record<string, QuotaWindow> }> => {
  const rawModels = asObject(asObject(modelsPayload)?.models) ?? {}
  const transformed: Record<string, { windows: Record<string, QuotaWindow> }> = {}
  for (const [modelName, rawData] of Object.entries(rawModels)) {
    const name = asNonEmptyString(modelName)
    if (!name) continue
    const modelData = asObject(rawData)
    const lowerName = name.toLowerCase()
    const is3p = lowerName.includes("claude") || lowerName.includes("gpt")
    const matchedGroup = modelGroupWindows.find((g) => (is3p ? g.groupType === "3p" : g.groupType === "gemini"))

    if (matchedGroup && Object.keys(matchedGroup.windows).length > 0) {
      // Weekly-constrained ordering requires the fractions it compares
      // to actually be present (#1768): an unknown weekly fraction
      // never constrains, and the weekly-vs-5h comparison needs both.
      const weeklyFraction = matchedGroup.bucketWeekly?.remainingFraction ?? null
      const fiveHourFraction = matchedGroup.bucket5h?.remainingFraction ?? null
      const isWeeklyConstrained =
        weeklyFraction !== null &&
        (weeklyFraction <= 0.001 || (fiveHourFraction !== null && weeklyFraction < fiveHourFraction))
      const reordered: Record<string, QuotaWindow> = {}
      if (isWeeklyConstrained && matchedGroup.windows.weekly) {
        reordered.weekly = matchedGroup.windows.weekly
        if (matchedGroup.windows["5h"]) reordered["5h"] = matchedGroup.windows["5h"]
      } else {
        if (matchedGroup.windows["5h"]) reordered["5h"] = matchedGroup.windows["5h"]
        if (matchedGroup.windows.weekly) reordered.weekly = matchedGroup.windows.weekly
      }
      for (const [label, window] of Object.entries(matchedGroup.windows)) {
        if (!reordered[label]) reordered[label] = window
      }
      transformed[name] = { windows: reordered }
    } else {
      const quotaInfo = asObject(modelData?.quotaInfo)
      const remainingFraction = toNumber(quotaInfo?.remainingFraction)
      const remainingPercent = remainingFraction !== null ? Math.round(remainingFraction * 100) : null
      const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null
      const resetAt = toTimestamp(quotaInfo?.resetTime)
      const remainingSeconds = resetAt !== null ? Math.max(0, Math.round((resetAt - Date.now()) / 1000)) : null
      let label = "5h"
      let seconds = FIVE_HOUR_WINDOW_SECONDS
      if (remainingSeconds !== null && remainingSeconds > 36 * 60 * 60) {
        label = "weekly"
        seconds = WEEKLY_WINDOW_SECONDS
      } else if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
        label = "daily"
        seconds = DAILY_WINDOW_SECONDS
      }
      transformed[name] = {
        windows: { [label]: toUsageWindow({ usedPercent, windowSeconds: seconds, resetAt }) },
      }
    }
  }
  return transformed
}

// ---- provider ----

const fetchWithCandidates = async (ctx: QuotaContext, candidates: AntigravityAuth[]): Promise<QuotaResult> => {
    if (candidates.length === 0) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    let accessToken: string | null = null
    let auth: AntigravityAuth | null = null
    const refreshFailures: { candidate: AntigravityAuth; result: RefreshOutcome }[] = []
    for (const candidate of candidates) {
      const result = await refreshAccessToken(ctx, candidate.refreshToken)
      if (result.ok && result.accessToken) {
        accessToken = result.accessToken
        auth = candidate
        break
      }
      refreshFailures.push({ candidate, result })
    }
    if (!accessToken || !auth) {
      // Every candidate came from the credential store and every refresh
      // was a confirmed wrong-client rejection: the store's google login
      // was issued by another client, so there is no Antigravity source.
      if (refreshFailures.every(({ candidate, result }) => candidate.origin === "store" && isWrongClientRejection(result))) {
        return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
      }
      return buildResult({ providerId, providerName, ok: false, configured: true, error: "Failed to refresh Antigravity token" })
    }

    const projectId = auth.projectId ?? DEFAULT_PROJECT_ID
    const [summaryPayload, modelsPayload] = await Promise.all([
      fetchAntigravity(ctx, "retrieveUserQuotaSummary", accessToken, projectId),
      fetchAntigravity(ctx, "fetchAvailableModels", accessToken, projectId),
    ])
    const modelGroupWindows = transformSummary(summaryPayload)
    const models = transformModels(modelsPayload, modelGroupWindows)
    if (Object.keys(models).length === 0) {
      return buildResult({ providerId, providerName, ok: false, configured: true, error: "Failed to fetch Antigravity quota" })
    }
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: {}, models },
    })
}

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  credentialAliases: ["google"],
  isConfigured: async (ctx) => (await resolveCandidates(ctx)).length > 0,
  fetchQuota: async (ctx) => fetchWithCandidates(ctx, await resolveCandidates(ctx)),
  isCredentialUsable: (_ctx, row) => {
    // Candidates also resolve from machine-level sources (keyring,
    // accounts file), so isConfigured cannot judge a single row: a row
    // serves quota only when it carries its own Google refresh token.
    const entry = projectCredentialValue(row.value)
    return Boolean(parseGoogleRefreshToken(entry.refresh).refreshToken)
  },
  fetchQuotaForCredential: async (ctx, row) => {
    // A google OAuth row answers with its own refresh token alone.
    const entry = projectCredentialValue(row.value)
    const parts = parseGoogleRefreshToken(entry.refresh)
    if (!parts.refreshToken) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }
    return fetchWithCandidates(ctx, [
      {
        refreshToken: parts.refreshToken,
        projectId: parts.projectId ?? parts.managedProjectId ?? undefined,
        origin: "store",
      },
    ])
  },
}
