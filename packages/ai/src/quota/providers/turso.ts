import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { QuotaContext, QuotaProvider, QuotaResult, QuotaWindow } from "../types.js"
import {
  asObject,
  buildResult,
  envOf,
  fetchOf,
  toTimestamp,
  toUsageWindow,
} from "../utils.js"

/**
 * Turso quota — a built-in fetcher of the `opencode quota` subcommand
 * (turso is a tick pool, not an OpenCode provider; the single-source
 * rule leaves no gatherer-side reads, code#6125).
 *
 * Wire: GET https://api.turso.tech/v1/organizations/{slug}/usage and
 * /subscription with the platform API token, resolved from Bitwarden
 * Secrets Manager by name (`turso.platform-api-token-muse-cli`) the
 * way the gatherer resolved it — the value moves through the process
 * environment of the `bws` child only and is never logged or stored.
 * Mapping follows the gatherer's entryFromTurso: Starter Free limits,
 * counts in their own units (storage + sync in GB), the subscription
 * period end as the windows' reset.
 */

export const providerId = "turso"
export const providerName = "Turso"
export const aliases = ["turso"]

export const TURSO_SECRET_NAME = "turso.platform-api-token-muse-cli"

export const TURSO_LIMITS = {
  databases: 100,
  storageBytes: 5_000_000_000,
  rowsRead: 500_000_000,
  rowsWritten: 10_000_000,
  bytesSynced: 3_000_000_000,
} as const

const gb = (bytes: number): number => Math.round((bytes / 1e9) * 1e6) / 1e6
const pct3 = (used: number, limit: number): number => Math.round((used / limit) * 100 * 1000) / 1000

const numNonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

export const tursoWindows = (
  usageDoc: unknown,
  subscriptionDoc: unknown,
): { windows: Record<string, QuotaWindow>; planLabel?: string } | null => {
  const usageRoot = asObject(usageDoc)
  const usage = asObject(asObject(usageRoot?.organization)?.usage) ?? asObject(usageRoot?.usage)
  if (!usage) return null
  const subRoot = asObject(subscriptionDoc)
  const sub = asObject(subRoot?.subscription) ?? subRoot
  const planRaw = sub?.plan ?? sub?.name
  const planLabel = typeof planRaw === "string" && planRaw !== "" ? planRaw : undefined

  const periodEnd = sub?.current_billing_period_end ?? sub?.current_period_end ?? sub?.period_end ?? sub?.ends_at
  const periodStart = sub?.current_billing_period_start ?? sub?.current_period_start ?? sub?.period_start ?? sub?.starts_at
  const resetsAt = toTimestamp(periodEnd)
  const startMs = toTimestamp(periodStart)
  const windowSeconds =
    startMs !== null && resetsAt !== null && resetsAt > startMs ? Math.round((resetsAt - startMs) / 1000) : null

  const windows: Record<string, QuotaWindow> = {}
  const push = (name: string, rawUsed: number | null, limit: number, valueLabel: string): void => {
    if (rawUsed === null) return
    const pct = (rawUsed / limit) * 100
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return
    windows[name] = toUsageWindow({
      usedPercent: pct3(rawUsed, limit),
      windowSeconds,
      resetAt: resetsAt,
      valueLabel,
    })
  }

  const databases = numNonNegative(usage.databases)
  push("databases", databases, TURSO_LIMITS.databases, `${databases} / ${TURSO_LIMITS.databases}`)
  const storageBytes = numNonNegative(usage.storage_bytes)
  push(
    "storage",
    storageBytes,
    TURSO_LIMITS.storageBytes,
    `${storageBytes === null ? "?" : gb(storageBytes)} GB / 5 GB`,
  )
  const rowsRead = numNonNegative(usage.rows_read)
  push(
    "rows-read",
    rowsRead,
    TURSO_LIMITS.rowsRead,
    `${rowsRead?.toLocaleString("en-US")} / ${TURSO_LIMITS.rowsRead.toLocaleString("en-US")}`,
  )
  const rowsWritten = numNonNegative(usage.rows_written)
  push(
    "rows-written",
    rowsWritten,
    TURSO_LIMITS.rowsWritten,
    `${rowsWritten?.toLocaleString("en-US")} / ${TURSO_LIMITS.rowsWritten.toLocaleString("en-US")}`,
  )
  const bytesSynced = numNonNegative(usage.bytes_synced)
  push("sync", bytesSynced, TURSO_LIMITS.bytesSynced, `${bytesSynced === null ? "?" : gb(bytesSynced)} GB / 3 GB`)

  return { windows, planLabel }
}

/** Resolve a Bitwarden secret by name with the gatherer's plumbing. The value is returned, never logged. */
export const resolveBwsSecret = async (ctx: QuotaContext, name: string): Promise<string | null> => {
  const env = envOf(ctx)
  const home = ctx.homeDir ?? homedir()
  const candidates = [env.BWS_BIN, join(home, "tools/bin/bws"), join(home, ".local/bin/bws"), "bws"].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
  )
  let bwsBin: string | null = null
  for (const candidate of candidates) {
    if (!candidate.includes("/")) {
      bwsBin = candidate
      break
    }
    if (existsSync(candidate)) {
      bwsBin = candidate
      break
    }
  }
  if (!bwsBin) return null

  const tokenFiles = [
    env.BWS_ACCESS_TOKEN_FILE,
    join(home, ".config/bws/access-token"),
    join(home, ".config/bitwarden/access-token"),
  ].filter((file): file is string => typeof file === "string" && file !== "")
  let accessToken: string | null = null
  for (const file of tokenFiles) {
    try {
      const value = readFileSync(file, "utf8").trim()
      if (value) {
        accessToken = value
        break
      }
    } catch {
      // Next candidate.
    }
  }
  if (!accessToken) return null

  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        bwsBin as string,
        args,
        { env: { ...process.env, BWS_ACCESS_TOKEN: accessToken as string }, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
  try {
    const list = JSON.parse(await run(["secret", "list"])) as { id?: string; key?: string }[]
    const found = list.find((secret) => secret.key === name)
    if (!found?.id) return null
    const got = JSON.parse(await run(["secret", "get", found.id])) as { value?: string }
    return got.value && got.value.trim() ? got.value.trim() : null
  } catch {
    return null
  }
}

export const fetchTursoQuota = async (ctx: QuotaContext): Promise<QuotaResult> => {
  const env = envOf(ctx)
  const token = env.TURSO_API_TOKEN?.trim() || (await resolveBwsSecret(ctx, TURSO_SECRET_NAME))
  if (!token) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: `turso token unavailable (Bitwarden secret ${TURSO_SECRET_NAME})`,
    })
  }
  const base = env.TURSO_API_BASE ?? "https://api.turso.tech"
  const slug = env.TURSO_ORG_SLUG ?? "dezren39"
  try {
    const get = async (path: string): Promise<unknown> => {
      const response = await fetchOf(ctx)(`${base}/v1/organizations/${slug}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`turso ${path} HTTP ${response.status}`)
      return readQuotaJson(response)
    }
    const usage = await get("/usage")
    const subscription = await get("/subscription")
    const mapped = tursoWindows(usage, subscription)
    if (!mapped || Object.keys(mapped.windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: "turso usage response missing organization.usage",
      })
    }
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: mapped.windows },
      planLabel: mapped.planLabel,
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
  isConfigured: () => true,
  fetchQuota: fetchTursoQuota,
}
