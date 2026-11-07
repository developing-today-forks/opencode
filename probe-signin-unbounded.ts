import { beginClaudeCodeSignIn } from "./packages/ai/src/providers/claude-code-auth.ts"

const deterministic = (length: number) => {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 13) % 256
  return bytes
}
const baseSources = {
  env: {},
  configDir: "/fixture/claude-dir",
  now: () => 1_000_000,
  randomValues: deterministic,
  readFile: () => undefined,
  writeFile: async () => {},
  renameFile: async () => {},
}

// Probe 1: a token endpoint that never replies — does the callback ever settle?
let capturedInit: RequestInit | undefined
const neverFetch = (async (_url: unknown, init?: RequestInit) => {
  capturedInit = init
  return new Promise<Response>(() => {})
}) as unknown as typeof fetch
const signIn1 = await beginClaudeCodeSignIn({ ...baseSources, fetchFn: neverFetch })
const state1 = new URL(signIn1.url).searchParams.get("state")!
let settled = false
void signIn1.callback(`auth-code-1#${state1}`).then(
  () => { settled = true },
  () => { settled = true },
)
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log("PROBE1 settled after 2500ms:", settled)
console.log("PROBE1 fetch init.signal:", capturedInit?.signal ?? "undefined (no deadline)")

// Probe 2: a >3 MiB token response body — is it read/parsed without any cap?
const bigBody = JSON.stringify({ access_token: "tok-big", pad: "x".repeat(3 * 1024 * 1024) })
const bigFetch = (async () =>
  new Response(bigBody, { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch
const signIn2 = await beginClaudeCodeSignIn({ ...baseSources, fetchFn: bigFetch })
const state2 = new URL(signIn2.url).searchParams.get("state")!
const cred = await signIn2.callback(`auth-code-1#${state2}`)
console.log("PROBE2 body bytes:", bigBody.length, "-> callback succeeded with accessToken:", cred.accessToken)
