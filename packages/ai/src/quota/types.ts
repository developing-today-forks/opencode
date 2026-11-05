/**
 * Provider quota — the single source for quota info (developing-today/code#6125).
 *
 * Quota is a provider function: each provider's implementation emulates its
 * first-party billing/usage wire behavior, and the results all carry the
 * shape the OpenChamber quota module established, so downstream consumers
 * (the aggregator gatherer, the dashboard, Supabase recording) map them
 * unchanged:
 *
 *   { providerId, providerName?, ok, configured,
 *     usage: { windows: { <name>: { usedPercent, remainingPercent?,
 *               windowSeconds?, resetAt, resetAfterSeconds?, valueLabel? } } },
 *     fetchedAt, error?, planLabel?, credentialId?, credentialLabel? }
 *
 * `resetAt` is epoch milliseconds. A provider with several stored
 * credentials emits one result per credential instance; consumers group
 * by `providerId`.
 */

export interface QuotaWindow {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAfterSeconds: number | null
  resetAt: number | null
  resetAtFormatted: string | null
  resetAfterFormatted: string | null
  valueLabel?: string
}

export interface QuotaUsage {
  windows: Record<string, QuotaWindow>
  models?: Record<string, { windows: Record<string, QuotaWindow> }> | Array<Record<string, unknown>>
  usageAvailability?: string
}

export type QuotaCredentialSource = "claude-code" | "opencode" | "environment"

export interface QuotaResult {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  usage: QuotaUsage | null
  fetchedAt: number
  error?: string
  /** Machine-readable failure class where a provider defines one (e.g. "no-quota-surface", "session-expired"). */
  errorKind?: string
  failureClass?: string
  planLabel?: string
  credentialId?: string
  credentialLabel?: string
  credentialActive?: boolean
  accountLabel?: string
  /** Claude only: when the credential that served the read expires (ISO 8601). */
  credentialExpiresAt?: string
  /** Claude only: which credential source served the read. */
  credentialSource?: QuotaCredentialSource
  quotaExhausted?: boolean
  quotaResetAt?: number | null
  quotaLimitKind?: string | null
}

/** One stored credential row, in the fork credential store's own shape. */
export interface QuotaCredentialValue {
  type: string
  key?: string
  access?: string
  refresh?: string
  expires?: number
  methodID?: string
  metadata?: Record<string, unknown>
}

export interface QuotaCredentialRow {
  id: string
  integrationID: string
  label?: string
  active: boolean
  value: QuotaCredentialValue
}

/** A credential value projected to the legacy auth.json entry shape the quota fetchers were written against. */
export interface QuotaAuthEntry {
  type: "api" | "oauth"
  key?: string
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
  enterpriseUrl?: string
  server?: string
  orgID?: string
  metadata?: Record<string, unknown>
}

export interface QuotaInstance {
  base: string
  name?: string
}

/**
 * Everything a quota fetch may need, assembled by the caller (the CLI's
 * `quota` handler assembles it from the running server's credential list —
 * the fork's own credential machinery — with a read-only local-store
 * fallback, plus the merged config's facts). Provider implementations
 * never read the credential store directly.
 */
export interface QuotaContext {
  credentials: QuotaCredentialRow[]
  disabledProviders: ReadonlySet<string>
  instances: ReadonlyMap<string, QuotaInstance>
  /** Provider definitions from merged config (`provider`/`providers` sections), for base-URL style lookups. */
  providerConfig: Record<string, Record<string, unknown>>
  fetchImpl?: typeof fetch
  /** Chrome DevTools Protocol base for console-session reads (Meta portal, Mistral admin console). */
  cdpBase?: string
  homeDir?: string
  /** The OpenCode config directory (antigravity accounts file lives here). */
  configDir?: string
  /** OpenChamber's managed credential store root (the OpenDesign session keeper writes under it). */
  openchamberDataDir?: string
  env?: Record<string, string | undefined>
  now?: () => number
}

export interface QuotaProvider {
  providerId: string
  providerName: string
  aliases: string[]
  credentialAliases?: string[]
  /** Config ids that disable this row in the default listing (defaults to id + aliases + credential aliases). */
  disabledBy?: string[]
  /** The base provider folds its instances' credential rows into its own answer (Codex/OpenAI). */
  foldInstanceCredentials?: boolean
  isConfigured: (ctx: QuotaContext) => boolean | Promise<boolean>
  fetchQuota: (ctx: QuotaContext) => Promise<QuotaResult>
  fetchQuotaForCredential?: (ctx: QuotaContext, row: QuotaCredentialRow) => Promise<QuotaResult>
  /**
   * Row-scoped usability, when `isConfigured` against a single-row
   * context cannot judge the row (providers whose candidates also
   * resolve from machine-level sources). The dispatch prefers this
   * hook over the single-row `isConfigured` verdict.
   */
  isCredentialUsable?: (ctx: QuotaContext, row: QuotaCredentialRow) => boolean | Promise<boolean>
}
