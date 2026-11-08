import type {
  JsonObject,
  JsonValue,
  QuotaAuthEntry,
  QuotaContext,
  QuotaCredentialRow,
  QuotaCredentialValue,
  QuotaResult,
  QuotaUsage,
  QuotaWindow,
} from "./types.js"

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const asObject = (value: JsonValue | undefined): JsonObject | null =>
  value !== undefined && isJsonObject(value) ? value : null

export const asNonEmptyString = (value: JsonValue | undefined): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

export const toNumber = (value: JsonValue | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    // An empty/blank string is an absent field, not zero: Number("") === 0
    // would mint a real 0 (a 0% window, a zero balance, a 100%-used pool
    // computed from 0 remaining) out of no data (#1741).
    const text = value.trim()
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export const toTimestamp = (value: JsonValue | undefined): number | null => {
  if (!value) return null
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    // A non-positive reset is null, never a 1969/1970 date (window
    // contract rule 3; #1821's disposition for command-code, made
    // shared here — #1845).
    return ms > 0 ? ms : null
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) || parsed <= 0 ? null : parsed
  }
  return null
}

export const normalizeTimestamp = (value: JsonValue | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const ms = value < 1_000_000_000_000 ? value * 1000 : value
  // A non-positive expiry is null, never a 1969/1970 date — the same
  // disposition toTimestamp carries for resets (#1845), applied to the
  // credential-expiry converter (#1857).
  return ms > 0 ? ms : null
}

export const clampPercent = (value: number | null): number | null =>
  value === null ? null : Math.min(100, Math.max(0, value))

export const formatMoney = (value: number | null | undefined): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value.toFixed(2)
}

export const resolveWindowLabel = (windowSeconds: number | null): string => {
  if (!windowSeconds) return "tokens"
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400
    return days === 7 ? "weekly" : `${days}d`
  }
  if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600}h`
  return `${windowSeconds}s`
}

export const formatResetTime = (timestamp: number): string | null => {
  try {
    const resetDate = new Date(timestamp)
    if (!Number.isFinite(resetDate.getTime())) return null
    const now = new Date()
    if (resetDate.toDateString() === now.toDateString()) {
      return resetDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    }
    return resetDate.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return null
  }
}

const hasResetTimestamp = (resetAt: number | null | undefined): resetAt is number =>
  resetAt !== null && resetAt !== undefined

export const calculateResetAfterSeconds = (resetAt: number | null | undefined): number | null => {
  if (!hasResetTimestamp(resetAt)) return null
  const resetAtTime = new Date(resetAt).getTime()
  if (!Number.isFinite(resetAtTime)) return null
  const delta = Math.floor((resetAtTime - Date.now()) / 1000)
  return delta < 0 ? 0 : delta
}

/**
 * Human duration for a window's relative reset wait (#2103): the
 * formatted sibling of resetAfterSeconds, derived from that numeric
 * value (never from the absolute resetAt) in the compact unit style
 * resolveWindowLabel uses — e.g. 3600 -> "1h", 5400 -> "1h 30m",
 * 90061 -> "1d 1h 1m 1s". A past reset (0 seconds) is "0s"; a null
 * or non-finite wait has no duration and stays null.
 */
export const formatResetAfter = (seconds: number | null | undefined): string | null => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.floor(seconds)
  if (total === 0) return "0s"
  const parts: string[] = []
  const units: Array<[number, string]> = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ]
  let rest = total
  for (const [size, label] of units) {
    const value = Math.floor(rest / size)
    if (value > 0) {
      parts.push(`${value}${label}`)
      rest -= value * size
    }
  }
  return parts.join(" ")
}

export const toUsageWindow = (input: {
  usedPercent: number | null
  windowSeconds?: number | null
  resetAt?: number | null
  valueLabel?: string | null
}): QuotaWindow => {
  const resetAt = input.resetAt ?? null
  const resetFormatted = hasResetTimestamp(resetAt) ? formatResetTime(resetAt) : null
  const resetAfterSeconds = calculateResetAfterSeconds(resetAt)
  const usedPercent = input.usedPercent
  const hasFiniteUsedPercent = typeof usedPercent === "number" && Number.isFinite(usedPercent)
  return {
    usedPercent,
    // The derived percent is capped on BOTH sides (#1904): an
    // over-100 usedPercent (turso publish-truthfully disposition,
    // code#6227) derives 0 remaining, and a negative usedPercent
    // derives at most 100 - never a remainingPercent above 100.
    // usedPercent itself is published unchanged.
    remainingPercent: hasFiniteUsedPercent ? Math.min(100, Math.max(0, 100 - usedPercent)) : null,
    windowSeconds: input.windowSeconds ?? null,
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: resetFormatted,
    // Derived from resetAfterSeconds, not the absolute time (#2103):
    // resetAtFormatted answers "when", this answers "how long".
    resetAfterFormatted: formatResetAfter(resetAfterSeconds),
    ...(input.valueLabel ? { valueLabel: input.valueLabel } : {}),
  }
}

export const buildResult = (input: {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  usage?: QuotaUsage | null
  error?: string
  errorKind?: string
  failureClass?: string
  planLabel?: string
  credentialId?: string
  credentialLabel?: string
  accountLabel?: string
}): QuotaResult => {
  const result: QuotaResult = {
    providerId: input.providerId,
    providerName: input.providerName,
    ok: input.ok,
    configured: input.configured,
    usage: input.usage ?? null,
    fetchedAt: Date.now(),
  }
  if (input.error) result.error = input.error
  if (input.errorKind) result.errorKind = input.errorKind
  if (input.failureClass) result.failureClass = input.failureClass
  if (input.planLabel) result.planLabel = input.planLabel
  if (input.credentialId) result.credentialId = input.credentialId
  if (input.credentialLabel) result.credentialLabel = input.credentialLabel
  if (input.accountLabel) result.accountLabel = input.accountLabel
  return result
}

/**
 * The most a quota provider answer may weigh: every quota payload is a
 * small per-account usage/balance/credits JSON document, so 1 MiB is
 * orders of magnitude above any legitimate response, and a hostile or
 * misconfigured endpoint cannot grow memory inside the deadline.
 */
export const QUOTA_RESPONSE_MAX_BYTES = 1 * 1024 * 1024

/** Read up to QUOTA_RESPONSE_MAX_BYTES of a response body as text. */
const readBoundedResponseText = async (response: Response): Promise<string> => {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  let totalBytes = 0
  const decoder = new TextDecoder()
  let text = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > QUOTA_RESPONSE_MAX_BYTES) {
        throw new Error(`Quota response exceeded ${QUOTA_RESPONSE_MAX_BYTES} bytes`)
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }

  return text + decoder.decode()
}

export const readQuotaJson = async (response: Response): Promise<JsonValue> => {
  const text = await readBoundedResponseText(response)
  // JSON.parse yields exactly the JsonValue grammar; the annotation
  // records that contract at the boundary.
  const parsed: JsonValue = JSON.parse(text.replace(/^\uFEFF/, ""))
  return parsed
}

/** Decode JSON text (a store file, a CLI's stdout) into a JsonValue, or null when it does not parse. */
export const parseJsonValue = (text: string): JsonValue | null => {
  try {
    const parsed: JsonValue = JSON.parse(text.replace(/^\uFEFF/, ""))
    return parsed
  } catch {
    return null
  }
}

export const isTimeoutError = (cause: unknown, signal?: AbortSignal): boolean =>
  cause instanceof DOMException &&
  (cause.name === "TimeoutError" || (cause.name === "AbortError" && (signal?.aborted ?? false)))

export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : "Request failed")

/** One stored credential value → legacy auth.json entry shape. */
export const projectCredentialValue = (value: QuotaCredentialValue): QuotaAuthEntry => {
  if (value.type === "key") {
    return value.metadata ? { type: "api", key: value.key, metadata: value.metadata } : { type: "api", key: value.key }
  }
  const entry: QuotaAuthEntry = {
    type: "oauth",
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  }
  const metadata = value.metadata ?? {}
  if (typeof metadata.accountID === "string") entry.accountId = metadata.accountID
  if (typeof metadata.enterpriseUrl === "string") entry.enterpriseUrl = metadata.enterpriseUrl
  if (typeof metadata.server === "string") entry.server = metadata.server
  if (typeof metadata.orgID === "string") entry.orgID = metadata.orgID
  if (value.metadata) entry.metadata = value.metadata
  return entry
}

/** Each integration's selected (active) credential, projected. */
export const projectAuth = (ctx: QuotaContext): Record<string, QuotaAuthEntry> => {
  const result: Record<string, QuotaAuthEntry> = {}
  for (const row of ctx.credentials) {
    if (!row.active) continue
    Object.defineProperty(result, row.integrationID, {
      value: projectCredentialValue(row.value),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}

export const getAuthEntry = (auth: Record<string, QuotaAuthEntry>, aliases: string[]): QuotaAuthEntry | null => {
  for (const alias of aliases) {
    if (auth[alias]) return auth[alias]
  }
  return null
}

/** Rows of the given integrations, in store order. */
export const credentialRows = (ctx: QuotaContext, integrationIDs: string[]): QuotaCredentialRow[] =>
  ctx.credentials.filter((row) => integrationIDs.includes(row.integrationID))

export const fetchOf = (ctx: QuotaContext): typeof fetch => ctx.fetchImpl ?? fetch

export const envOf = (ctx: QuotaContext): Record<string, string | undefined> => ctx.env ?? process.env
