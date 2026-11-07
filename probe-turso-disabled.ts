import { listConfiguredQuotaProviders, listQuotaProviderCatalogue } from "./packages/ai/src/quota/index.ts"

const base = {
  credentials: [],
  instances: new Map(),
  providerConfig: {},
  env: {},
  homeDir: "/nonexistent-probe-home",
}

const run = async (label: string, disabled: string[], includeDisabled = false) => {
  const ctx = { ...base, disabledProviders: new Set(disabled) }
  const ids = await listConfiguredQuotaProviders(ctx as never, { includeDisabled })
  const cat = listQuotaProviderCatalogue(ctx as never).find((e) => e.id === "turso")
  console.log(`${label}: listing=${JSON.stringify(ids)} catalogue.turso.disabled=${cat?.disabled}`)
}

await run("control (nothing disabled)", [])
await run("turso disabled", ["turso"])
await run("turso disabled + includeDisabled:true", ["turso"], true)
await run("claude disabled (sibling control, unconfigured anyway)", ["claude"])
