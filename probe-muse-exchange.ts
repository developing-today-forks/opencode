import { exchangeMintedKey } from "./packages/ai/src/providers/muse-direct-auth.ts"

// Case 1: oversized SUCCESS body — valid JSON, api_key present, padded to ~3 MiB
const pad = "x".repeat(3_145_763)
const bigOk = JSON.stringify({ api_key: "LLM|minted-key", pad })
console.log("case1 body bytes:", new TextEncoder().encode(bigOk).byteLength)
const fetchOk = (async () => new Response(bigOk, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
try {
  const key = await exchangeMintedKey("dca:account-token", { fetchFn: fetchOk })
  console.log("case1 RESULT: ACCEPTED, key =", key)
} catch (e) {
  console.log("case1 RESULT: REJECTED:", e instanceof Error ? e.message.slice(0, 120) : String(e))
}

// Case 2: oversized ERROR body — exchange must buffer it whole before slicing 200 chars for the message
const bigErr = "E".repeat(5_000_000)
const fetchErr = (async () => new Response(bigErr, { status: 500 })) as typeof fetch
try {
  await exchangeMintedKey("dca:account-token", { fetchFn: fetchErr })
  console.log("case2 RESULT: no error (unexpected)")
} catch (e) {
  console.log("case2 RESULT: error after full buffer, msg =", (e instanceof Error ? e.message : String(e)).slice(0, 80), "... msgLen:", (e instanceof Error ? e.message : "").length)
}

// Control: normal small success body
const fetchSmall = (async () => new Response(JSON.stringify({ api_key: "LLM|small" }), { status: 200 })) as typeof fetch
console.log("control RESULT: key =", await exchangeMintedKey("dca:account-token", { fetchFn: fetchSmall }))
