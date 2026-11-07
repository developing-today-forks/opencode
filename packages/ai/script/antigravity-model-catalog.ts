import { provider } from "../src/quota/providers/antigravity.js"
import type { QuotaContext } from "../src/quota/types.js"

const endpoints = [
  { name: "daily-cloudcode-pa", origin: "https://daily-cloudcode-pa.googleapis.com" },
  { name: "cloudcode-pa", origin: "https://cloudcode-pa.googleapis.com" },
] as const

const context: Omit<QuotaContext, "fetchImpl"> = {
  credentials: [],
  disabledProviders: new Set(),
  instances: new Map(),
  providerConfig: {},
}

const catalogs = []
for (const endpoint of endpoints) {
  let modelIds: string[] | undefined
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== endpoint.origin) throw new Error(`Skipping non-target endpoint ${url.origin}`)

    const response = await fetch(input, init)
    if (url.pathname.endsWith(":fetchAvailableModels") && response.ok) {
      const payload: unknown = await response.clone().json()
      if (typeof payload !== "object" || payload === null || !("models" in payload))
        throw new Error(`Unexpected catalog payload from ${endpoint.name}`)
      const models = payload.models
      if (typeof models !== "object" || models === null || Array.isArray(models))
        throw new Error(`Unexpected model map from ${endpoint.name}`)
      modelIds = Object.keys(models).sort()
    }
    return response
  }

  await provider.fetchQuota({ ...context, fetchImpl })
  if (!modelIds) throw new Error(`No model catalog returned by ${endpoint.name}`)
  catalogs.push({ endpoint: endpoint.name, modelIds })
}

console.log(JSON.stringify({ observedAt: new Date().toISOString(), catalogs }, null, 2))
