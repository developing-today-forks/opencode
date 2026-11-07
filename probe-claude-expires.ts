import { normalizeTimestamp } from "./packages/ai/src/quota/utils.ts"
import { findClaudeCredential } from "./packages/ai/src/quota/providers/claude.ts"
import { join } from "node:path"

console.log("normalizeTimestamp(-5000) =", normalizeTimestamp(-5000 as never))
console.log("normalizeTimestamp(0) =", normalizeTimestamp(0 as never))
console.log("normalizeTimestamp(-1893456000000) =", normalizeTimestamp(-1893456000000 as never))
console.log("normalizeTimestamp(1893456000) =", normalizeTimestamp(1893456000 as never))
console.log("normalizeTimestamp(1893456000000) =", normalizeTimestamp(1893456000000 as never))

const base = join(process.env.HOME!, "git/fleet/probe-2026-11-06-creator-0935/probe-homes")
for (const name of ["zero", "neg", "sec", "valid"]) {
  const ctx = { homeDir: join(base, name), env: {}, credentials: [], providerConfig: {} } as never
  const cred = findClaudeCredential(ctx)
  const rendered = cred && cred.expiresAt !== null ? new Date(cred.expiresAt).toISOString() : null
  console.log(`findClaudeCredential(${name}) expiresAt =`, cred?.expiresAt, "-> credentialExpiresAt would publish:", rendered)
}
