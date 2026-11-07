import { parseSubscriptionQuota } from "./packages/ai/src/quota/providers/meta.ts"
import { provider as codex } from "./packages/ai/src/quota/providers/codex.ts"

// Meta probes
const base = { tier:"high", window_weighted_used:"50", window_weighted_limit:"100", weekly_weighted_used:"25", weekly_weighted_limit:"100", window_resets_at: 2000000000, weekly_resets_at: 2000000000, window_duration_secs: 18000 }
console.log("META control", JSON.stringify(parseSubscriptionQuota({subscription_quota: base})))
console.log("META windowLimit=0, weekly valid", JSON.stringify(parseSubscriptionQuota({subscription_quota: {...base, window_weighted_limit:"0"}})))
console.log("META weeklyLimit=0, window valid", JSON.stringify(parseSubscriptionQuota({subscription_quota: {...base, weekly_weighted_limit:"0"}})))
console.log("META windowLimit=-100", JSON.stringify(parseSubscriptionQuota({subscription_quota: {...base, window_weighted_limit:"-100"}})))
console.log("META weeklyLimit=-100, weeklyUsed=50", JSON.stringify(parseSubscriptionQuota({subscription_quota: {...base, weekly_weighted_limit:"-100", weekly_weighted_used:"50"}})))
console.log("META windowUsed negative -50", JSON.stringify(parseSubscriptionQuota({subscription_quota: {...base, window_weighted_used:"-50"}})))

// Codex probes via fetchQuota
const ctxBase:any = {
  credentials: [{id:"1", integrationID:"openai", active:true, value:{type:"oauth", access:"tok123", refresh:"r", expires: 9999999999999}}],
  disabledProviders: new Set(), instances: new Map(), providerConfig:{}, env:{},
}
function mkFetch(payload:any){
  return async () => new Response(JSON.stringify(payload), {status:200, headers:{"content-type":"application/json"}})
}
async function codexProbe(label:string, payload:any){
  const ctx = {...ctxBase, fetchImpl: mkFetch(payload)}
  const res:any = await codex.fetchQuota(ctx)
  console.log("CODEX", label, JSON.stringify(res.usage?.windows ?? res))
}
const future = Math.floor(Date.now()/1000)+3600
await codexProbe("control 18000/604800", {rate_limit:{primary_window:{used_percent:50, limit_window_seconds:18000, reset_at:future}, secondary_window:{used_percent:25, limit_window_seconds:604800, reset_at:future}}})
await codexProbe("primary duration -3600", {rate_limit:{primary_window:{used_percent:50, limit_window_seconds:-3600, reset_at:future}, secondary_window:{used_percent:25, limit_window_seconds:604800, reset_at:future}}})
await codexProbe("primary duration 0", {rate_limit:{primary_window:{used_percent:50, limit_window_seconds:0, reset_at:future}}})
await codexProbe("primary duration -86400", {rate_limit:{primary_window:{used_percent:50, limit_window_seconds:-86400, reset_at:future}}})
await codexProbe("both negative equal -3600", {rate_limit:{primary_window:{used_percent:50, limit_window_seconds:-3600, reset_at:future}, secondary_window:{used_percent:25, limit_window_seconds:-3600, reset_at:future}}})
