import type { QuotaContext, QuotaCredentialRow, QuotaProvider, QuotaResult } from "./types.js"
import { buildResult, credentialRows } from "./utils.js"
import { provider as antigravity } from "./providers/antigravity.js"
import { provider as claude } from "./providers/claude.js"
import { provider as clinePass } from "./providers/cline-pass.js"
import { provider as openai } from "./providers/openai.js"
import { provider as commandCode } from "./providers/command-code.js"
import { provider as deepseek } from "./providers/deepseek.js"
import { provider as groq } from "./providers/groq.js"
import { provider as meta } from "./providers/meta.js"
import { provider as mistral } from "./providers/mistral.js"
import { provider as opencodeGo } from "./providers/opencode-go.js"
import { provider as opendesign } from "./providers/opendesign.js"
import { provider as openrouter } from "./providers/openrouter.js"
import { provider as turso } from "./providers/turso.js"

export type * from "./types.js"
export * from "./utils.js"
export { cdpPageFetch, cdpBaseOf, isSessionExpiredStatus } from "./cdp.js"
export { parseMistralBudget } from "./providers/mistral.js"
export { parseSubscriptionQuota, parseBillingBanner } from "./providers/meta.js"
export { tursoWindows, resolveTursoLimits, TURSO_LIMITS, TURSO_PLAN_LIMITS, TURSO_SECRET_NAME } from "./providers/turso.js"
export { parseCommandCodeCredits, MONTHLY_INCLUDED_CREDITS } from "./providers/command-code.js"
export { parseCodingPlanWindows, normalizeOpenDesignCredential } from "./providers/opendesign.js"
export { parseGroqResetSeconds, NO_QUOTA_SURFACE } from "./providers/groq.js"
export { toClaudeUsage, findClaudeCredential } from "./providers/claude.js"

/**
 * The quota registry — one entry per provider that owns a quota
 * function. The built-in turso fetcher is registered alongside the
 * credential providers: the default listing always carries its row
 * (an error row when its token cannot resolve, never silence).
 */
export const quotaProviders: QuotaProvider[] = [
  antigravity,
  claude,
  clinePass,
  openai,
  commandCode,
  deepseek,
  groq,
  meta,
  mistral,
  opencodeGo,
  opendesign,
  openrouter,
  turso,
]

const registry = new Map(quotaProviders.map((provider) => [provider.providerId, provider]))

export const getQuotaProvider = (providerId: string): QuotaProvider | undefined => registry.get(providerId)

// The disabled filter keys on the provider's `disabledBy` (by
// default its own quota id): since the #1823 rename the fleet quota
// ids equal the config provider ids, so the renamed providers pin
// `disabledBy` to their pre-rename quota ids (`claude`,
// `command-code`, `antigravity`) — config disabled_providers must
// not hide live quota rows, and alias matching would hide more —
// the module's rule, kept.

const disabledIdsOf = (provider: QuotaProvider): string[] => provider.disabledBy ?? [provider.providerId]

export const isProviderDisabled = (ctx: QuotaContext, provider: QuotaProvider): boolean =>
  disabledIdsOf(provider).some((id) => ctx.disabledProviders.has(id))

const resolveInstanceProvider = (ctx: QuotaContext, instanceId: string) => {
  const instance = ctx.instances.get(instanceId)
  if (!instance) return null
  for (const provider of quotaProviders) {
    if ((provider.credentialAliases ?? [provider.providerId]).includes(instance.base)) {
      return { provider, instance }
    }
  }
  return null
}

/**
 * Providers with a usable credential, plus the configured provider
 * instances that have one, plus the built-in turso fetcher.
 * Providers turned off in config (`disabled_providers`) are left out
 * unless `includeDisabled` is set. Fetching one by name always works:
 * the filter governs the listing, never an explicit ask
 * (developing-today/code#6125).
 */
/**
 * A configuration probe that threw during listing (#1729): the
 * provider is neither confirmed configured nor confirmed absent —
 * the listing contract is that it surfaces as an error row, never
 * as a silent omission (a named ask bypasses the listing filter and
 * may still answer, so omission makes the two resolutions disagree).
 */
export interface QuotaProbeFailure {
  providerId: string
  providerName: string
  error: string
}

/** The error row a probe failure publishes in a listing. */
export const quotaProbeFailureResult = (failure: QuotaProbeFailure): QuotaResult =>
  buildResult({
    providerId: failure.providerId,
    providerName: failure.providerName,
    ok: false,
    configured: true,
    error: `Quota configuration probe failed: ${failure.error}`,
    failureClass: "probe-failed",
  })

const probeErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface ConfiguredQuotaProviders {
  providerIds: string[]
  probeFailures: QuotaProbeFailure[]
}

/**
 * The listing, with probe failures carried alongside the configured
 * ids instead of dropped: callers that render results (the CLI
 * handler, `fetchAllQuota`) emit one error row per failure, so every
 * provider the listing probed appears exactly once — as a fetch
 * target or as an error row (#1729).
 */
export const listConfiguredQuotaProvidersDetailed = async (
  ctx: QuotaContext,
  { includeDisabled = false }: { includeDisabled?: boolean } = {},
): Promise<ConfiguredQuotaProviders> => {
  const configured: string[] = []
  const probeFailures: QuotaProbeFailure[] = []
  for (const provider of quotaProviders) {
    if (provider.providerId === turso.providerId) continue
    try {
      if (await provider.isConfigured(ctx)) configured.push(provider.providerId)
    } catch (error) {
      probeFailures.push({
        providerId: provider.providerId,
        providerName: provider.providerName,
        error: probeErrorMessage(error),
      })
    }
  }

  const visible = includeDisabled
    ? configured
    : configured.filter((id) => {
        const provider = registry.get(id)
        return provider ? !isProviderDisabled(ctx, provider) : true
      })

  const foldedBases = new Set<string>()
  for (const instanceId of ctx.instances.keys()) {
    if (!includeDisabled && ctx.disabledProviders.has(instanceId)) continue
    const resolved = resolveInstanceProvider(ctx, instanceId)
    if (!resolved?.provider.fetchQuotaForCredential) continue
    const rows = credentialRows(ctx, [instanceId])
    // A row is usable when the provider's row-scoped hook judges it
    // usable, else when the base provider, given that row alone under
    // its base integration id, reads as configured (the module's
    // isCredentialUsable rule — the same verdict fetchPerCredential
    // awaits, so the listing and the fetch agree).
    let usable = false
    for (const row of rows) {
      try {
        if (resolved.provider.isCredentialUsable) {
          if (await resolved.provider.isCredentialUsable(ctx, row)) {
            usable = true
            break
          }
          continue
        }
        const single: QuotaContext = {
          ...ctx,
          credentials: [{ ...row, integrationID: resolved.instance.base, active: true }],
        }
        if (await resolved.provider.isConfigured(single)) {
          usable = true
          break
        }
      } catch {
        // A row that cannot be judged is not usable.
      }
    }
    if (!usable) continue
    visible.push(instanceId)
    if (resolved.provider.foldInstanceCredentials) foldedBases.add(resolved.provider.providerId)
  }

  for (const baseId of foldedBases) {
    if (visible.includes(baseId)) continue
    const provider = registry.get(baseId)
    if (!provider) continue
    if (!includeDisabled && isProviderDisabled(ctx, provider)) continue
    visible.push(baseId)
  }

  // The built-in turso fetcher is part of every default listing,
  // subject to the same disabled filter as every other provider
  // (#1923): a `disabled_providers` entry naming turso leaves it out
  // unless `includeDisabled` is set, so a default run never fetches it.
  if (includeDisabled || !isProviderDisabled(ctx, turso)) visible.push(turso.providerId)
  // A probe failure on a disabled provider is not surfaced: the
  // provider is out of the listing by configuration, not by accident.
  const visibleFailures = probeFailures.filter((failure) => {
    if (visible.includes(failure.providerId)) return false
    if (includeDisabled) return true
    const provider = registry.get(failure.providerId)
    return provider ? !isProviderDisabled(ctx, provider) : true
  })
  return { providerIds: visible, probeFailures: visibleFailures }
}

export const listConfiguredQuotaProviders = async (
  ctx: QuotaContext,
  { includeDisabled = false }: { includeDisabled?: boolean } = {},
): Promise<string[]> => (await listConfiguredQuotaProvidersDetailed(ctx, { includeDisabled })).providerIds

export interface QuotaCatalogueEntry {
  id: string
  name: string
  aliases: string[]
  disabled: boolean
  instanceOf?: string
}

/** Every dispatchable provider and configured instance, with the names a caller may resolve it by. */
export const listQuotaProviderCatalogue = (ctx: QuotaContext): QuotaCatalogueEntry[] => {
  const entries: QuotaCatalogueEntry[] = quotaProviders.map((provider) => ({
    id: provider.providerId,
    name: provider.providerName,
    aliases: [...new Set([...provider.aliases, ...(provider.credentialAliases ?? [])])],
    disabled: isProviderDisabled(ctx, provider),
  }))
  for (const [instanceId, instance] of ctx.instances) {
    const resolved = resolveInstanceProvider(ctx, instanceId)
    if (!resolved) continue
    entries.push({
      id: instanceId,
      name: instance.name ?? resolved.provider.providerName,
      aliases: [],
      disabled: ctx.disabledProviders.has(instanceId),
      instanceOf: resolved.provider.providerId,
    })
  }
  return entries
}

/** Resolve a user-supplied name (id, display name, or alias, case-insensitive) to a canonical dispatch id. */
export const resolveQuotaProviderName = (ctx: QuotaContext, name: string): string | null => {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return null
  for (const entry of listQuotaProviderCatalogue(ctx)) {
    if (entry.id.toLowerCase() === normalized) return entry.id
    if (entry.name.toLowerCase() === normalized) return entry.id
    if (entry.aliases.some((alias) => alias.toLowerCase() === normalized)) return entry.id
  }
  return null
}

const labelResult = (
  result: QuotaResult,
  resultProviderId: string,
  row: QuotaCredentialRow | undefined,
  resultProviderName?: string,
): QuotaResult => {
  const labeled: QuotaResult = { ...result, providerId: resultProviderId }
  if (resultProviderName) labeled.providerName = resultProviderName
  if (row) {
    labeled.credentialId = row.id
    labeled.credentialActive = row.active
    if (row.label) labeled.credentialLabel = row.label
  }
  return labeled
}

const fetchPerCredential = async (
  provider: QuotaProvider,
  ctx: QuotaContext,
  options: { resultProviderId: string; resultProviderName?: string; integrationIds: string[]; authKey: string },
): Promise<QuotaResult[] | null> => {
  if (!provider.fetchQuotaForCredential) return null
  const rows = credentialRows(ctx, options.integrationIds)
  // Only rows the provider can actually use participate (the module's
  // isCredentialUsable rule, verdict awaited): a key row sharing an
  // integration id with an OAuth account must not emit a spurious
  // "Not configured" result next to the working one.
  const usable: QuotaCredentialRow[] = []
  for (const row of rows) {
    try {
      if (provider.isCredentialUsable) {
        if (await provider.isCredentialUsable(ctx, row)) usable.push(row)
        continue
      }
      const single: QuotaContext = {
        ...ctx,
        credentials: [{ ...row, integrationID: options.authKey, active: true }],
      }
      if (await provider.isConfigured(single)) usable.push(row)
    } catch {
      // A row that cannot be judged is not usable.
    }
  }
  if (usable.length === 0) return null
  const results: QuotaResult[] = []
  for (const row of usable) {
    const result = await provider.fetchQuotaForCredential(ctx, row)
    results.push(labelResult(result, options.resultProviderId, row, options.resultProviderName))
  }
  return results
}

const fetchInstanceResults = async (ctx: QuotaContext, providerId: string): Promise<QuotaResult[] | null> => {
  const resolved = resolveInstanceProvider(ctx, providerId)
  if (!resolved?.provider.fetchQuotaForCredential) return null
  const results = await fetchPerCredential(resolved.provider, ctx, {
    resultProviderId: providerId,
    resultProviderName: resolved.instance.name,
    integrationIds: [providerId],
    authKey: resolved.instance.base,
  })
  if (results) return results
  return [
    buildResult({
      providerId,
      providerName: resolved.instance.name ?? providerId,
      ok: false,
      configured: false,
      error: "Not configured",
    }),
  ]
}

const fetchFoldedInstanceResults = async (
  provider: QuotaProvider,
  ctx: QuotaContext,
  providerId: string,
): Promise<QuotaResult[]> => {
  const results: QuotaResult[] = []
  for (const instanceId of ctx.instances.keys()) {
    if (ctx.disabledProviders.has(instanceId)) continue
    const resolved = resolveInstanceProvider(ctx, instanceId)
    if (resolved?.provider.providerId !== providerId) continue
    const folded = await fetchPerCredential(provider, ctx, {
      resultProviderId: providerId,
      resultProviderName: resolved.instance.name,
      integrationIds: [instanceId],
      authKey: resolved.instance.base,
    })
    if (folded) results.push(...folded)
  }
  return results
}

/**
 * One result per usable stored credential of a provider (each labeled
 * with its credential row), or the single active-credential result for
 * providers without a per-credential fetch.
 */
export const fetchQuotaForProviderInstances = async (
  ctx: QuotaContext,
  providerId: string,
): Promise<QuotaResult[]> => {
  const provider = registry.get(providerId)
  if (!provider) {
    return (
      (await fetchInstanceResults(ctx, providerId)) ?? [
        buildResult({
          providerId,
          providerName: providerId,
          ok: false,
          configured: false,
          error: "Unsupported provider",
        }),
      ]
    )
  }

  if (!provider.fetchQuotaForCredential) {
    return [await provider.fetchQuota(ctx)]
  }

  const results = await fetchPerCredential(provider, ctx, {
    resultProviderId: providerId,
    integrationIds: provider.credentialAliases ?? [providerId],
    authKey: providerId,
  })

  if (provider.foldInstanceCredentials) {
    const folded = await fetchFoldedInstanceResults(provider, ctx, providerId)
    if (folded.length > 0) return [...(results ?? []), ...folded]
  }
  return results ?? [await provider.fetchQuota(ctx)]
}

/** Fetch every configured provider (the default `opencode quota` run). */
export const fetchAllQuota = async (
  ctx: QuotaContext,
  { includeDisabled = false }: { includeDisabled?: boolean } = {},
): Promise<{ providerId: string; results: QuotaResult[] }[]> => {
  const { providerIds, probeFailures } = await listConfiguredQuotaProvidersDetailed(ctx, { includeDisabled })
  const out: { providerId: string; results: QuotaResult[] }[] = []
  for (const id of providerIds) {
    out.push({ providerId: id, results: await fetchQuotaForProviderInstances(ctx, id) })
  }
  for (const failure of probeFailures) {
    out.push({ providerId: failure.providerId, results: [quotaProbeFailureResult(failure)] })
  }
  return out
}
