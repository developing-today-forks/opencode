import type { QuotaProvider } from "../types.js"
import { asNonEmptyString, buildResult, errorText, fetchOf, isTimeoutError } from "../utils.js"

/**
 * Google AI Studio quota — no API-key-readable quota surface exists.
 *
 * The free tier's per-model, per-project limits (requests/day,
 * requests/minute, tokens/minute) are published only through the
 * Google Cloud console and the Cloud Quotas / Service Usage APIs,
 * which require OAuth or a service account for the project — an AI
 * Studio API key cannot read them. The one first-party read a key
 * can make is the Generative Language model list, so this provider
 * makes that read per project as a key-validity / project-liveness
 * probe and reports groq's `no-quota-surface` disposition
 * (developing-today/code#6125): an honest absence, never an
 * invented percentage.
 *
 * The base id is shared: _antigravity also claims base "google"
 * (its accounts are Google OAuth rows). Instance resolution in
 * src/quota/index.ts breaks the tie by credential shape — a row
 * carrying a Google refresh token belongs to _antigravity, an
 * API-key row belongs here.
 *
 * The fleet's free projects are config instances of this provider
 * (google.muse, google.gen-lang, google.personal, google.drew —
 * the members of the google-free provider route), each with its own
 * credential row and its own free-tier buckets, so the dispatch
 * fetches one result per project credential and labels it with the
 * instance id. There is deliberately no combined "google" figure:
 * the projects' quotas are separate, and a sum would fabricate a
 * pool Google does not meter.
 */

export const providerId = "google"
export const providerName = "Google AI Studio"
export const aliases = ["google"]

export const NO_QUOTA_SURFACE = "no-quota-surface"

const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"

/** A credential row belongs to this provider when it is the base google row or one of its project instances. */
const isGoogleRow = (integrationID: string): boolean =>
  integrationID === providerId || integrationID.startsWith(`${providerId}.`)

export const provider: QuotaProvider = {
  providerId,
  providerName,
  aliases,
  isConfigured: (ctx) =>
    ctx.credentials.some((row) => row.active && isGoogleRow(row.integrationID) && asNonEmptyString(row.value?.key)),
  fetchQuota: async (_ctx) => {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error:
        "Google AI Studio quota is per project: the free projects report individually under their instance ids (google.muse, google.gen-lang, google.personal, google.drew); there is no combined google reading",
    })
  },
  fetchQuotaForCredential: async (ctx, row) => {
    const apiKey = asNonEmptyString(row.value?.key)
    if (!apiKey) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: "Not configured" })
    }

    const timeoutSignal = AbortSignal.timeout(15_000)
    try {
      const response = await fetchOf(ctx)(GOOGLE_MODELS_URL, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
        signal: timeoutSignal,
      })

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: `Invalid or revoked API key — Google rejected the enrolled credential for ${row.integrationID}`,
        })
      }
      if (!response.ok) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: `API error: ${response.status}`,
        })
      }

      return {
        ...buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error:
            "Google AI Studio publishes free-tier limits only through the Cloud console / Cloud Quotas API (OAuth-gated); an API key cannot read them, so there is no figure to report — the project key is valid and the project is live (this read is its validity probe)",
        }),
        errorKind: NO_QUOTA_SURFACE,
        failureClass: NO_QUOTA_SURFACE,
      }
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: isTimeoutError(error, timeoutSignal) ? "Request timed out" : errorText(error),
      })
    }
  },
}
