import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { QuotaContext, QuotaProvider, QuotaResult, QuotaWindow, JsonValue } from "../types.js"
import {
  asNonEmptyString,
  asObject,
  buildResult,
  envOf,
  fetchOf,
  toTimestamp,
  toUsageWindow,
  parseJsonValue,
  readQuotaJson,
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
 * Mapping follows the gatherer's entryFromTurso: counts in their own
 * units (storage + sync in GB), the subscription period end as the
 * windows' reset. Plan limits are DYNAMIC: they are resolved from the
 * org's /plans document (GET /v1/organizations/{slug}/plans), matched
 * by the subscription's plan name — the subscription read itself
 * carries only the plan NAME, no quotas. A static per-plan table
 * (TURSO_PLAN_LIMITS, values as published by /plans) is only a
 * FALLBACK for when /plans is unavailable or unmatched, so a non-
 * Starter org can never silently regress to Starter denominators
 * (the 2026-11-08 false over-limit alarms on code#5468: the org has
 * been on Scaler since 2026-11-04, but Starter caps made rows-read
 * read ~235% and storage ~213%).
 */

export const providerId = "turso"
export const providerName = "Turso"
export const aliases = ["turso"]

export const TURSO_SECRET_NAME = "turso.platform-api-token-muse-cli"

export interface TursoLimits {
  databases: number
  storageBytes: number
  rowsRead: number
  rowsWritten: number
  bytesSynced: number
}

/** Starter limits — the pre-/plans behaviour, now only the fallback
 * for an unknown/unreadable plan (see TURSO_PLAN_LIMITS). */
export const TURSO_LIMITS = {
  databases: 100,
  storageBytes: 5_000_000_000,
  rowsRead: 500_000_000,
  rowsWritten: 10_000_000,
  bytesSynced: 3_000_000_000,
} as const

/**
 * FALLBACK ONLY — static per-plan limits, keyed by plan name, with the
 * values the /plans endpoint published on 2026-11-08. The source of
 * truth is the live /plans document (resolveTursoLimits prefers it);
 * this table exists so that when /plans cannot be read, a Scaler (or
 * Developer/Pro) org still divides by its own plan's limits instead of
 * silently regressing to Starter denominators. An unknown plan falls
 * back to TURSO_LIMITS (Starter, the previous behaviour). The /plans
 * document carries no `databases` quota for pro; the fallback uses
 * the same 1e9 ceiling the other paid plans publish.
 */
export const TURSO_PLAN_LIMITS: Record<string, TursoLimits> = {
  starter: { ...TURSO_LIMITS },
  developer: {
    databases: 1_000_000_000,
    storageBytes: 9_000_000_000,
    rowsRead: 2_500_000_000,
    rowsWritten: 25_000_000,
    bytesSynced: 10_000_000_000,
  },
  scaler: {
    databases: 1_000_000_000,
    storageBytes: 24_000_000_000,
    rowsRead: 100_000_000_000,
    rowsWritten: 100_000_000,
    bytesSynced: 24_000_000_000,
  },
  pro: {
    databases: 1_000_000_000,
    storageBytes: 50_000_000_000,
    rowsRead: 250_000_000_000,
    rowsWritten: 250_000_000,
    bytesSynced: 100_000_000_000,
  },
}

const gb = (bytes: number): number => Math.round((bytes / 1e9) * 1e6) / 1e6
const pct3 = (used: number, limit: number): number => Math.round((used / limit) * 100 * 1000) / 1000

const numNonNegative = (value: JsonValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

const positiveOrNull = (value: JsonValue | undefined): number | null => {
  const n = numNonNegative(value)
  return n !== null && n > 0 ? n : null
}

/**
 * Resolve the limits a Turso org's usage divides by. Dynamic first:
 * the /plans document's entry whose name matches the subscription
 * plan name (case-insensitive) supplies quotas {rowsRead, rowsWritten,
 * databases, storage, bytesSynced}; any quota the matched plan omits
 * falls back per-field to the static plan table. Without a plans doc
 * (or a match), the static table keyed by plan name applies; an
 * unknown plan gets Starter (TURSO_LIMITS, the previous behaviour).
 */
export const resolveTursoLimits = (planLabel?: string, plansDoc?: JsonValue | null): TursoLimits => {
  // Plan labels are display strings from the subscription read; match
  // them trimmed and lowercased on both sides so a padded label (or a
  // padded /plans name) cannot silently miss its plan and regress to
  // Starter denominators (#2154).
  const wanted = typeof planLabel === "string" ? planLabel.trim().toLowerCase() : ""
  const fallback: TursoLimits = (wanted ? TURSO_PLAN_LIMITS[wanted] : undefined) ?? { ...TURSO_LIMITS }
  if (plansDoc == null || wanted === "") return fallback
  const plansRoot = asObject(plansDoc)
  const plans = plansRoot?.plans
  if (!Array.isArray(plans)) return fallback
  for (const entry of plans) {
    const plan = asObject(entry)
    if (typeof plan?.name !== "string" || plan.name.trim().toLowerCase() !== wanted) continue
    const quotas = asObject(plan.quotas)
    if (!quotas) return fallback
    return {
      databases: positiveOrNull(quotas.databases) ?? fallback.databases,
      storageBytes: positiveOrNull(quotas.storage) ?? fallback.storageBytes,
      rowsRead: positiveOrNull(quotas.rowsRead) ?? fallback.rowsRead,
      rowsWritten: positiveOrNull(quotas.rowsWritten) ?? fallback.rowsWritten,
      bytesSynced: positiveOrNull(quotas.bytesSynced) ?? fallback.bytesSynced,
    }
  }
  return fallback
}

export const tursoWindows = (
  usageDoc: JsonValue,
  subscriptionDoc: JsonValue,
  plansDoc?: JsonValue | null,
): { windows: Record<string, QuotaWindow>; planLabel?: string } | null => {
  const usageRoot = asObject(usageDoc)
  const usage = asObject(asObject(usageRoot?.organization)?.usage) ?? asObject(usageRoot?.usage)
  if (!usage) return null
  const subRoot = asObject(subscriptionDoc)
  const sub = asObject(subRoot?.subscription) ?? subRoot
  const planRaw = sub?.plan ?? sub?.name
  const planLabel = asNonEmptyString(planRaw)
  const limits = resolveTursoLimits(planLabel, plansDoc ?? null)

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
    // Over-100 is a real state, not bad data (code#6227): these are
    // usage-vs-limit ratios over counts, and an org over its Starter
    // limits must publish that fact — dropping the window erased the
    // over-limit storage / rows-read state from the live quota row
    // (2026-11-05: storage ~147%, rows-read ~165% vanished while the
    // under-limit windows survived). Only non-finite / negative
    // ratios are unusable.
    if (!Number.isFinite(pct) || pct < 0) return
    windows[name] = toUsageWindow({
      usedPercent: pct3(rawUsed, limit),
      windowSeconds,
      resetAt: resetsAt,
      valueLabel,
    })
  }

  const databases = numNonNegative(usage.databases)
  push("databases", databases, limits.databases, `${databases} / ${limits.databases}`)
  const storageBytes = numNonNegative(usage.storage_bytes)
  push(
    "storage",
    storageBytes,
    limits.storageBytes,
    `${storageBytes === null ? "?" : gb(storageBytes)} GB / ${gb(limits.storageBytes)} GB`,
  )
  const rowsRead = numNonNegative(usage.rows_read)
  push(
    "rows-read",
    rowsRead,
    limits.rowsRead,
    `${rowsRead?.toLocaleString("en-US")} / ${limits.rowsRead.toLocaleString("en-US")}`,
  )
  const rowsWritten = numNonNegative(usage.rows_written)
  push(
    "rows-written",
    rowsWritten,
    limits.rowsWritten,
    `${rowsWritten?.toLocaleString("en-US")} / ${limits.rowsWritten.toLocaleString("en-US")}`,
  )
  const bytesSynced = numNonNegative(usage.bytes_synced)
  push("sync", bytesSynced, limits.bytesSynced, `${bytesSynced === null ? "?" : gb(bytesSynced)} GB / ${gb(limits.bytesSynced)} GB`)

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

  const bin: string = bwsBin
  const token: string = accessToken
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { env: { ...process.env, BWS_ACCESS_TOKEN: token }, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
  try {
    const list = parseJsonValue(await run(["secret", "list"]))
    const entries = Array.isArray(list) ? list : []
    const found = entries.map((entry) => asObject(entry)).find((secret) => secret?.key === name)
    const foundId = asNonEmptyString(found?.id)
    if (!foundId) return null
    const got = asObject(parseJsonValue(await run(["secret", "get", foundId])))
    return asNonEmptyString(got?.value) ?? null
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
    const get = async (path: string): Promise<JsonValue> => {
      const response = await fetchOf(ctx)(`${base}/v1/organizations/${slug}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`turso ${path} HTTP ${response.status}`)
      }
      return readQuotaJson(response)
    }
    const usage = await get("/usage")
    const subscription = await get("/subscription")
    // Dynamic plan limits: /plans is fetched alongside, but a failed
    // plans read must not fail the whole quota read — tursoWindows
    // falls back to the static per-plan table (keyed by the
    // subscription's plan name) when the doc is absent.
    let plans: JsonValue | null = null
    try {
      plans = await get("/plans")
    } catch {
      plans = null
    }
    const mapped = tursoWindows(usage, subscription, plans)
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
