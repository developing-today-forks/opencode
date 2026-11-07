import { parseSubscriptionQuota } from "./packages/ai/src/quota/providers/meta.ts"

const base = {
  tier: "fixture",
  window_weighted_used: "50",
  window_weighted_limit: "100",
  weekly_weighted_used: "25",
  weekly_weighted_limit: "100",
  window_duration_secs: "18000",
  window_resets_at: "1893456000",
  weekly_resets_at: "1894060800",
}
const run = (label: string, patch: Record<string, unknown>) => {
  const payload = { subscription_quota: { ...base, ...patch } }
  const out = parseSubscriptionQuota(payload as never)
  console.log(label, JSON.stringify(out?.windows ?? null))
}
run("control           ", {})
run("window reset -5000", { window_resets_at: "-5000" })
run("window reset 0    ", { window_resets_at: "0" })
run("weekly reset -86400", { weekly_resets_at: "-86400" })
run("weekly reset 0    ", { weekly_resets_at: 0 })
run("both resets absent", { window_resets_at: undefined, weekly_resets_at: undefined })
