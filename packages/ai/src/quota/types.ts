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
 * THE FIGURE CONTRACT (#1942, phase 1 — this task, #1943)
 *
 * The window contract governs what a parser may put into
 * `usage.windows`; this contract governs the figures themselves:
 * every number a quota parser publishes — a percent, a money amount,
 * a balance, a count, in a field or in a `valueLabel` — and every
 * wire scalar that scales one. A figure that cannot exist is not a
 * figure. The shared figure probe matrix in
 * packages/ai/test/quota.test.ts pins the conforming parsers against
 * these rules, with this contract as its oracle.
 *
 * 1. Impossible figures read as absent. Negative money / balance /
 *    spend publishes as absent, never as a formatted label (the
 *    meta parseBillingBanner, opencode-go toMicroCents, turso
 *    numNonNegative and command-code dispositions, generalised).
 *    Zero is a real figure and publishes unchanged.
 * 2. A pair is judged as a pair. remaining <= limit and its kin:
 *    individual well-formedness is not enough. The disposition of
 *    an impossible pair is whole-window and named per provider in
 *    the figure inventory below — read-as-absent, or clamp-both
 *    (percent and label both derive from the one clamped figure),
 *    or publish-truthfully with the real figure annotated — never
 *    split between percent (clamped) and label (raw). This extends
 *    window rule 5 from derived fields to the raw pair.
 * 3. Scaling inputs are figures too. A wire exponent / divisor /
 *    multiplier is validated against its closed range before it
 *    scales anything (money exponents: ISO 4217, integers 0-3).
 *    Out of range reads the scaled figure as absent; sibling
 *    figures on the same window still publish.
 * 4. Precision is part of the figure. A published percent keeps the
 *    wire's precision; rounding is a display act (the CLI, #1797),
 *    never a parser act.
 * 5. A result whose only figure is impossible is no result.
 *    Refusing impossible figures that empties a result fires the
 *    provider's existing no-data contract (`ok: false`) — the
 *    #1915/#1762 figure-less disposition, extended to
 *    impossible-only payloads.
 * 6. Every figure path is pinned against this contract. One shared
 *    figure probe matrix (negative figure, zero control, impossible
 *    pair, out-of-range scaling input, sub-percent precision) per
 *    parser family that publishes figures, and the figure inventory
 *    below rides this same inventory — not a second table.
 *
 * Named exception: turso's publish-truthfully over-100% disposition
 * (#1743, code#6227) stands — a provider's stated disposition
 * governs its out-of-range figures, as under window rule 5. The
 * contract forbids unstated and split dispositions, not stated
 * ones.
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
 * FIGURE INVENTORY — the figures each provider publishes, and each
 * figure's named disposition under the figure contract above, in
 * the same registry order. The seven rows the design (#1942) filed
 * as known-lossy are no longer lossy: #1928, #1924, #1919, #1897,
 * #1879, #1920 and #1941 have all landed and are pinned by their
 * dedicated describes plus the shared figure probe matrix; they are
 * stated here by their dispositions, not marked lossy.
 *
 *   antigravity — percent only (the remainingFraction-derived used /
 *     remaining percent; no money or count label). Disposition:
 *     float precision published, never integer-quantized (#1941);
 *     the used percent is clamped to [0, 100] as one figure.
 *   claude — percent (clampPercent utilization) and a money pair
 *     (extra-usage used / limit in the valueLabel, scaled by the
 *     wire exponent). Dispositions: a negative amount reads as
 *     absent (#1919); the exponent is validated to the ISO 4217
 *     range 0-3 and an out-of-range exponent reads the scaled
 *     amount as absent while the percent still publishes (#1920).
 *   cline-pass — percent only (percentUsed, clampPercent; no
 *     money, balance or count label). Disposition: the percent is
 *     the only figure, clamped whole.
 *   _openai — percent (used_percent, clampPercent), a credits
 *     balance count label, and a spend count pair (used / limit).
 *     Dispositions: a negative balance reads as absent — no
 *     credits_balance window, and alone it is the no-data contract
 *     (#1924); the spend pair is clamp-both, percent and label from
 *     the one clamped used figure (#1882).
 *   command-code — credit counts: a monthly remaining figure and
 *     window used / cap pairs, each with its percent. Dispositions:
 *     a negative monthly remaining reads as absent; over-included
 *     remaining publishes truthfully at 0% used with the real
 *     remaining figure annotated in the label (#1744); the
 *     windowLimits pairs are clamp-both (#1821).
 *   deepseek — a money balance label (the credits_balance window).
 *     Disposition: a positive balance wins, zero publishes, and a
 *     negative-only response is no result — the no-data contract,
 *     with no unfiltered fallback (#1928).
 *   groq — request / token count pairs (remaining / limit in the
 *     valueLabel) with their percents. Disposition: a remaining
 *     above its limit is an impossible pair — the remaining is
 *     clamped to the limit whole-window, so percent and label
 *     derive from the same published figure (#1897).
 *   meta — percent (weighted used / limit) and a money balance
 *     (parseBillingBanner: minor units scaled by 100 into the
 *     credits_balance label). Dispositions: a negative minor-unit
 *     figure reads as absent (null), zero publishes unchanged,
 *     and a non-USD banner reads as absent.
 *   mistral — percent plus a money pair (usedAmount / budgetAmount
 *     in the valueLabel). Disposition: the amount derives from the
 *     clamped percent, so percent and label agree whole-window
 *     (#1785); a non-positive budget publishes no window.
 *   opencode-go — percent, console meter counts in micro-cents,
 *     and a money balance (parseConsoleBillingBalance).
 *     Dispositions: toMicroCents reads a negative amount as absent
 *     — a negative meter figure publishes no window and a negative
 *     balance reads as null; zero publishes unchanged.
 *   opendesign — a credit count pair (remaining / limit in the
 *     valueLabel) with its percent. Disposition: the remaining is
 *     clamped to [0, limit] once and percent and label both derive
 *     from the clamped figure (#1879).
 *   openrouter — a money pair (used / limit in the valueLabel, the
 *     used figure derived as limit minus limit_remaining) with its
 *     percent, or a lone monthly spend label when unlimited.
 *     Dispositions: a negative spend reads as absent (#1913); a
 *     zero or negative limit publishes no window (#1799); a
 *     remaining above the limit derives a zero used figure, so
 *     percent and label agree.
 *   turso — usage counts (databases, storage bytes, rows read /
 *     written, bytes synced) against the TURSO_LIMITS counts, each
 *     with its percent and count label. Dispositions:
 *     numNonNegative reads a negative or non-finite count as
 *     absent; over-limit counts publish truthfully — the standing
 *     named exception above (#1743).
 *
 *   antigravity — parseBucket / transformSummary / transformModels
 *     (all exported pure transforms). Conforming (unrecognized
 *     window strings skipped and same-label collisions keep-first,
 *     #1768; figure-less summary buckets are dropped (#1917/#1940),
 *     as are fallback models without a usable figure (#1912/#1937).
 *   claude — toClaudeUsage (exported pure transform);
 *     findClaudeCredential (credential lookup, not a window parser).
 *     Conforming (addWindow keeps the first duplicate per window,
 *     and scoped model windows reuse the model's map, #1781).
 *     Spend defects #1919 and #1920 were fixed by #1957 and
 *     #1949, respectively.
 *   cline-pass — fetch-only: limit parsing is inline in the fetch
 *     path; no exported pure parser. Conforming (keep-first, #1769).
 *   _openai — fetch-only: window mapping is inline in the fetch path;
 *     no exported pure parser. Conforming (a negative
 *     credits.balance reads as absent, #1924). Rate-limit windows
 *     retain the collision qualifiers and phantom-window guard
 *     from #1762.
 *   command-code — parseCommandCodeCredits. Conforming
 *     (publish-truthfully over-included credits, #1744; credit
 *     balances are not windows, #1746; windowLimits windows use the
 *     clamp-both disposition — percent and label both derive from
 *     the clamped used figure — and a non-positive resetAt is
 *     null, #1821).
 *   deepseek — fetch-only: balance parsing is inline in
 *     provider.fetchQuota; no exported pure parser. Conforming
 *     (a negative-only balance response is the no-data contract,
 *     #1928).
 *   groq — parseGroqResetSeconds (exported scalar duration parser);
 *     header window construction is inline and clamps over-limit
 *     remaining whole-window (#1897/#1921; rule 5).
 *   meta — parseSubscriptionQuota, parseBillingBanner (both
 *     exported); keyUsageResult is module-private. Conforming: a
 *     weekly-length rolling window publishes under its semantic role
 *     key instead of overwriting the literal weekly entry, at both
 *     collision sites (#1777, rule 1). parseSubscriptionQuota's
 *     absent/non-positive-reset-is-null case conforms to rule 3 and
 *     is pinned by the matrix (#1855).
     A zero or negative limit drops only that window (rule 4),
     pinned by the matrix (#1849).
 *   mistral — parseMistralBudget (exported; wraps the module-private
 *     parseBudget). Conforming (usedPercent clamped and usedAmount
 *     derived from the clamped percent, so a window's fields agree
 *     — rule 5, #1785; pinned by the mistral console budget mapping
 *     describe in quota.test.ts).
 *   opencode-go — parseOpenCodeGoUsage, parseConsoleGoUsage,
 *     parseConsoleBillingBalance (all exported). Conforming: a
 *     percent-bearing entry keeps its window with an absent reset as
 *     an honest null resetAt (rule 3, #1725), and an entry with no
 *     usable percent publishes no window (rule 4) — matching _openai's
 *     percent-less case. Pinned by the OpenCode Go API-key usage
 *     mapping describe in quota.test.ts.
 *   opendesign — parseCodingPlanWindows (exported);
 *     normalizeOpenDesignCredential (credential normalization, not a
 *     window parser). Conforming: remaining is clamped to [0, limit]
 *     once and both the percent and the value label derive from the
 *     clamped figure, so a window's fields agree (rule 5, #1879;
 *     pinned by the matrix). Keep-first, zero-limit, and
 *     unknown-duration cases remain conforming (#1750).
 *   openrouter — resolveResetAt (exported from the provider module;
 *     the remaining parsing is inline in the fetch path).
 *     Conforming: zero-limit publishes no window (#1799, rule 4);
 *     resolveResetAt's UTC daily/weekly (next Monday, +7d on Monday)
 *     and monthly arithmetic is pinned (#1725).
 *   turso — tursoWindows (exported pure window builder over the
 *     org-usage figures and TURSO_LIMITS). Conforming: only finite,
 *     nonnegative counts publish; each percent and value label derive
 *     from the same count, including intentionally preserved over-limit
 *     usage (#6227); invalid period bounds leave reset fields null.
 */

export interface QuotaWindow {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAfterSeconds: number | null
  resetAt: number | null
  /** Absolute reset instant, formatted (answers "when"). */
  resetAtFormatted: string | null
  /**
   * Relative reset wait, formatted as a human duration derived from
   * resetAfterSeconds (answers "how long"; #2103). "0s" for a past
   * reset, null when there is no reset.
   */
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
  /** The base provider folds its instances' credential rows into its own answer (OpenAI). */
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
