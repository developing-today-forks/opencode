// Probe: vibe-auth process cache — does a rotated credential ever take effect?
// Drives the REAL vibeAuth({}) (no sources => the process-cache path in
// loadApiKey) exactly as packages/ai/test/provider/vibe-auth.test.ts drives
// auth.apply, with MISTRAL_API_KEY as the winning tier.
import { Effect } from "effect"
import { Headers } from "effect/http"
import { vibeAuth, invalidate } from "./packages/ai/src/providers/vibe-auth.ts"

const apply = (auth: ReturnType<typeof vibeAuth>) =>
  Effect.runPromise(
    auth.apply({
      request: {},
      method: "POST",
      url: "https://api.mistral.ai/v1/chat/completions",
      body: "{}",
      headers: Headers.fromInput({ "User-Agent": "probe" }),
    }),
  )

const auth = vibeAuth({})

process.env.MISTRAL_API_KEY = "key-A-original"
const first = await apply(auth)
console.log("1st apply (env=key-A):", first.authorization)

process.env.MISTRAL_API_KEY = "key-B-rotated"
const second = await apply(auth)
console.log("2nd apply (env=key-B, no invalidate):", second.authorization)

delete process.env.MISTRAL_API_KEY
const third = await apply(auth)
console.log("3rd apply (env removed, no invalidate):", third.authorization)

invalidate()
process.env.MISTRAL_API_KEY = "key-B-rotated"
const fourth = await apply(auth)
console.log("4th apply (env=key-B, after invalidate()):", fourth.authorization)

console.log(
  "VERDICT:",
  second.authorization === "Bearer " + "key-A-original" && fourth.authorization === "Bearer " + "key-B-rotated"
    ? "CONFIRMED — cache serves the stale key until invalidate(); nothing in the repo calls invalidate()"
    : "NOT REPRODUCED",
)
