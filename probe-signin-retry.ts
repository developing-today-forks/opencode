import { beginClaudeCodeSignIn } from "./packages/ai/src/providers/claude-code-auth.ts"

const deterministic = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251)
function harness(fetchImpl?: typeof fetch) {
  const store = new Map<string, string>()
  const calls: Array<string> = []
  const sources: any = {
    env: {}, configDir: "/fixture/claude-dir", now: () => 1_000_000, randomValues: deterministic,
    readFile: (p: string) => store.get(p),
    writeFile: async (p: string, c: string) => { store.set(p, c) },
    renameFile: async (f: string, t: string) => { store.set(t, store.get(f)!); store.delete(f) },
    fetchFn: fetchImpl ?? (async (url: any, init?: any) => { calls.push(String(init?.body ?? "")); return new Response(JSON.stringify({ access_token: "tok-signed-in", refresh_token: "ref-1", expires_in: 3600 }), { status: 200 }) }),
  }
  return { sources, store, calls }
}
const stateFrom = (url: string) => new URL(url).searchParams.get("state")!

// Case 1: malformed paste first (no exchange happens), then correct paste
{
  const { sources, calls } = harness()
  const s = await beginClaudeCodeSignIn(sources)
  const e1 = await s.callback("   ").catch((e: any) => e)
  console.log("case1 first (blank):", e1?.name, String(e1).slice(0, 90), "fetchCalls=", calls.length)
  const r2 = await s.callback(`auth-code-1#${stateFrom(s.url)}`).catch((e: any) => e)
  console.log("case1 retry (valid):", r2 instanceof Error ? `REJECTED: ${String(r2).slice(0,90)}` : `OK accessToken=${r2.accessToken}`, "fetchCalls=", calls.length)
}
// Case 2: wrong state first, then correct state
{
  const { sources, calls } = harness()
  const s = await beginClaudeCodeSignIn(sources)
  const e1 = await s.callback("auth-code-1#wrong-state").catch((e: any) => e)
  console.log("case2 first (wrong state):", String(e1).slice(0, 90), "fetchCalls=", calls.length)
  const r2 = await s.callback(`auth-code-1#${stateFrom(s.url)}`).catch((e: any) => e)
  console.log("case2 retry (correct):", r2 instanceof Error ? `REJECTED: ${String(r2).slice(0,90)}` : `OK accessToken=${r2.accessToken}`, "fetchCalls=", calls.length)
}
// Case 3: exchange HTTP 400 first (flaky / wrong code), fetch would succeed on 2nd try, retry with a NEW code
{
  let n = 0
  const fetchFn: any = async () => { n++; return n === 1 ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : new Response(JSON.stringify({ access_token: "tok-2", expires_in: 3600 }), { status: 200 }) }
  const { sources } = harness(fetchFn)
  const s = await beginClaudeCodeSignIn(sources)
  const e1 = await s.callback(`bad-code#${stateFrom(s.url)}`).catch((e: any) => e)
  console.log("case3 first (400):", String(e1).slice(0, 90), "fetchCalls=", n)
  const r2 = await s.callback(`good-code#${stateFrom(s.url)}`).catch((e: any) => e)
  console.log("case3 retry (new code):", r2 instanceof Error ? `REJECTED: ${String(r2).slice(0,90)}` : `OK accessToken=${r2.accessToken}`, "fetchCalls=", n)
}
// Control: fresh begin works
{
  const { sources, calls } = harness()
  const s = await beginClaudeCodeSignIn(sources)
  const r = await s.callback(`auth-code-1#${stateFrom(s.url)}`)
  console.log("control fresh:", "OK", r.accessToken, "fetchCalls=", calls.length)
}
