import type { QuotaProvider } from "../types.js"
import {
  asNonEmptyString,
  buildResult,
  errorText,
  fetchOf,
  getAuthEntry,
  isTimeoutError,
  projectAuth,
} from "../utils.js"

/**
 * EXAONE quota — no first-party usage/quota surface exists.
 *
 * The EXAONE API Platform (docs.exaone.ai) publishes no quota, no
 * rate limit, and no usage endpoint for its free tier: the docs name
 * no free-tier quota or rate limit at all, and the only reads an API
 * key can make are the inference endpoints and the OpenAI-compatible
 * model list. So this provider makes that one read — GET
 * /v1/models — as a key-validity probe, and reports groq's
 * `no-quota-surface` disposition (developing-today/code#6125): an
 * honest absence, never an invented percentage. The truthful signals
 * the leg does carry are the key's validity (this read succeeding)
 * and the key's expiry, published as credentialExpiresAt.
 *
 * KEY EXPIRY DIARY: platform keys expire 30 days after issuance
 * (docs.exaone.ai My Profile > API Key). The fleet's enrolled key
 * was issued 2026-11-16 (credential row created
 * 2026-11-16T09:34:42Z), so it dies 2026-12-16 — KEY_EXPIRES_AT is
 * the issuance instant + 30 days. An auth failure on this door from
 * 2026-12-16 is the known expiry, not a new breakage: re-issue the
 * key, rotate the credential-store row (integrationID exaone,
 * Bitwarden item exaone.api-key), and update KEY_EXPIRES_AT here
 * and the diary comment in the fleet config's exaone provider
 * block (developing-today/code .opencode/opencode.jsonc).
 */

export const providerId = "exaone"
export const providerName = "EXAONE"
export const aliases = ["exaone"]

export const NO_QUOTA_SURFACE = "no-quota-surface"

/** The enrolled key's expiry: issued 2026-11-16 + the platform's 30-day key lifetime. */
export const KEY_EXPIRES_AT = "2026-12-16T09:34:42.000Z"

const EXAONE_MODELS_URL = "https://api.exaone.ai/v1/models"

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) => Boolean(asNonEmptyString(getAuthEntry(projectAuth(ctx), aliases)?.key)),
  fetchQuota: async (ctx) => {
    const entry = getAuthEntry(projectAuth(ctx), aliases)
    const apiKey = asNonEmptyString(entry?.key)
    if (!apiKey) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    const timeoutSignal = AbortSignal.timeout(15_000)
    try {
      const response = await fetchOf(ctx)(EXAONE_MODELS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: timeoutSignal,
      })

      if (response.status === 401 || response.status === 403) {
        return {
          ...buildResult({
            providerId,
            providerName,
            ok: false,
            configured: true,
            error:
              "Invalid or expired API key — EXAONE rejected the enrolled credential (the enrolled key expires 2026-12-16, 30 days after its 2026-11-16 issuance; re-issue at docs.exaone.ai)",
          }),
          credentialExpiresAt: KEY_EXPIRES_AT,
        }
      }
      if (!response.ok) {
        return {
          ...buildResult({
            providerId,
            providerName,
            ok: false,
            configured: true,
            error: `API error: ${response.status}`,
          }),
          credentialExpiresAt: KEY_EXPIRES_AT,
        }
      }

      return {
        ...buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error:
            "EXAONE publishes no usage/quota endpoint or limits an API key can read (docs.exaone.ai names no free-tier quota or rate limit), so there is no figure to report; the enrolled key is valid — this read is its validity probe, and the key expires 2026-12-16",
        }),
        errorKind: NO_QUOTA_SURFACE,
        failureClass: NO_QUOTA_SURFACE,
        credentialExpiresAt: KEY_EXPIRES_AT,
      }
    } catch (error) {
      return {
        ...buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: isTimeoutError(error, timeoutSignal) ? "Request timed out" : errorText(error),
        }),
        credentialExpiresAt: KEY_EXPIRES_AT,
      }
    }
  },
}
