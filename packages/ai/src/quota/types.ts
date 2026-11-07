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
 *
 * THE WINDOW CONTRACT (#1794, phase 1 landed by #1795)
 *
 * Parse the window you were sent, or none. Every parser that puts a
 * window into `usage.windows` owes these seven rules; the shared probe
 * matrix in packages/ai/test/quota.test.ts pins the conforming parsers
 * against them, with this contract as its oracle.
 *
 * 1. Identity is semantic; a derived label never erases a window — the
 *    key names the window's role/kind where the payload carries one;
 *    collisions disambiguate both keys or keep the semantic key;
 *    overwriting a published window is a violation in every spelling.
 * 2. Duplicates keep the first — contradictory duplicates are a payload
 *    anomaly, not an update (the #1750/#1769 wording).
 * 3. Missing is null, and nulls the field — not the window, and never a
 *    number: never 0, never 1-as-fully-remaining, no fabricated default
 *    label. An absent reset is an honest null `resetAt` on the window.
 * 4. No figure, no window — an empty/all-null/zero-limit window-shaped
 *    object publishes no window; only quota figures are windows
 *    (#1746's purchasedCredits READ RULE, generalised).
 * 5. A window's fields agree — derived fields are computed from the
 *    published (post-disposition) values; the out-of-range disposition
 *    (clamp vs publish-truthfully) is the provider's stated choice,
 *    applied to the whole window, never split; out-of-range never
 *    means the window vanishes.
 * 6. Unknown kinds are skipped, not renamed — no fabricated familiar
 *    label; groq's `no-quota-surface` is the same rule at result level.
 * 7. Every pure parser is pinned against this contract — one shared
 *    probe matrix (duplicate, collision, unknown kind, missing figure,
 *    empty object, out-of-range) per parser, and the inventory below
 *    stays complete: a provider with no pure parser says so, with its
 *    reason.
 *
 * PARSER INVENTORY — all 13 providers in the `quotaProviders` registry
 * (src/quota/index.ts), in registry order. "Fetch-only" means the wire
 * parsing lives inline in the fetch path, so the parser is driven in
 * tests through `provider.fetchQuota` with a stubbed fetch, not
 * through an exported pure function. Known-lossy rows are marked and
 * linked; their own issues flip them, this inventory does not fix them.
 *
 * Shared converter: `toTimestamp` (utils.ts) returns null for
 * non-positive timestamps in both its numeric and string spellings
 * (#1845) — #1821's command-code disposition, generalised to every
 * provider parsing resets through the shared converter, so no
 * consumer can publish a 1969/1970 resetAt or fields derived from one.
 *
 *   antigravity — parseBucket / transformSummary / transformModels
 *     (all exported pure transforms). Conforming (unrecognized
 *     window strings skipped, same-label collisions keep-first,
 *     missing remainingFraction propagates as null, #1768; pinned
 *     by its dedicated describe in quota.test.ts, per rule 7).
 *   claude — toClaudeUsage (exported pure transform);
 *     findClaudeCredential (credential lookup, not a window parser).
 *     KNOWN-LOSSY: #1781 (unconditional addWindow overwrites
 *     duplicates instead of keeping the first).
 *   cline-pass — fetch-only: limit parsing is inline in the fetch
 *     path; no exported pure parser. Conforming (keep-first, #1769).
 *   codex — fetch-only: window mapping is inline in the fetch path;
 *     no exported pure parser. Conforming (collision qualifiers and
 *     the phantom-window guard, #1762).
 *   command-code — parseCommandCodeCredits. Conforming
 *     (publish-truthfully over-included credits, #1744; credit
 *     balances are not windows, #1746; windowLimits windows use the
 *     clamp-both disposition — percent and label both derive from
 *     the clamped used figure — and a non-positive resetAt is
 *     null, #1821).
 *   deepseek — fetch-only: balance parsing is inline in
 *     provider.fetchQuota; no exported pure parser (its only window
 *     is a credits_balance label, which carries no figure to parse).
 *   groq — parseGroqResetSeconds (exported scalar duration parser);
 *     window construction from rate-limit headers is inline in the
 *     fetch path.
 *   meta — parseSubscriptionQuota, parseBillingBanner (both
 *     exported); keyUsageResult is module-private. KNOWN-LOSSY:
 *     #1777 (a weekly-length rolling window can be overwritten by
 *     the literal weekly entry at both collision sites).
 *     parseSubscriptionQuota's absent/non-positive-reset-is-null
 *     case conforms to rule 3 and is pinned by the matrix (#1855).
     A zero or negative limit drops only that window (rule 4),
     pinned by the matrix (#1849).
 *   mistral — parseMistralBudget (exported; wraps the module-private
 *     parseBudget). Conforming (usedPercent clamped and usedAmount
 *     derived from the clamped percent, so a window's fields agree
 *     — rule 5, #1785; pinned by the mistral console budget mapping
 *     describe in quota.test.ts).
 *   opencode-go — parseOpenCodeGoUsage, parseConsoleGoUsage,
 *     parseConsoleBillingBalance (all exported). KNOWN-LOSSY:
 *     #1725 (unpinned remainder; a window is dropped when resetAt
 *     is null instead of nulling the field — rule 3 decision is
 *     that issue's, per design #1794 phase 3).
 *   opendesign — parseCodingPlanWindows (exported);
 *     normalizeOpenDesignCredential (credential normalization, not a
 *     window parser). Conforming (keep-first, zero-limit publishes
 *     nothing, unknown durations skipped, #1750).
 *   openrouter — resolveResetAt (exported from the provider module;
 *     the remaining parsing is inline in the fetch path).
 *     KNOWN-LOSSY: #1725 (resolveResetAt unpinned, with opencode-go).
 *     Conforming: zero-limit publishes no window (#1799, rule 4).
 *   turso — tursoWindows (exported pure window builder over the
 *     org-usage figures and TURSO_LIMITS).
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

/**
 * A decoded JSON document — the named domain type every provider's
 * payload parsers accept. Raw wire/store text is decoded into this
 * shape once, at the I/O boundary (readQuotaJson / parseJsonValue);
 * nothing downstream handles bare `unknown`.
 */
export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

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
  providerConfig: Record<string, JsonObject>
  fetchImpl?: typeof fetch
  /** Chrome DevTools Protocol base for console-session reads (Meta portal, Mistral admin console). */
  cdpBase?: string
  /** Per-request timeout for CDP WebSocket requests; defaults to `CDP_REQUEST_TIMEOUT_MS` in cdp.ts. */
  cdpRequestTimeoutMs?: number
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
