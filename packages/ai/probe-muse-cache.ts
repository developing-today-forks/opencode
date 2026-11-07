import { Effect, Option } from "effect"
import { Headers } from "effect/http"
import { MuseDirectAuth } from "./src/providers/muse-direct-auth.ts"

const fileFor = (token: string) => JSON.stringify({ providers: { meta: { access_token: token } } })

const makeSources = (token: string, key: string) => {
  const state = { fetches: 0, reads: 0 }
  const fetchFn = (async () => {
    state.fetches++
    return new Response(JSON.stringify({ api_key: key }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const readFile = () => {
    state.reads++
    return fileFor(token)
  }
  return { sources: { readFile, fetchFn }, state }
}

const applyAuth = async (sources: unknown) => {
  const auth = MuseDirectAuth.museDirectAuth({ sources: sources as never })
  const headers = await Effect.runPromise(
    auth.apply({ request: {}, method: "POST", url: "https://api.meta.ai/v1/responses", body: "", headers: Headers.empty }),
  )
  const value = Headers.get(headers, "authorization")
  return Option.isSome(value) ? value.value : null
}

const a = makeSources("token-A", "key-A")
const b = makeSources("token-B", "key-B")

MuseDirectAuth.invalidate()
const first = await applyAuth(a.sources)
console.log("A first apply:", first, "fetchesA:", a.state.fetches, "readsA:", a.state.reads)

const second = await applyAuth(b.sources)
console.log("B apply (no invalidate):", second, "fetchesB:", b.state.fetches, "readsB:", b.state.reads)

MuseDirectAuth.invalidate()
const third = await applyAuth(b.sources)
console.log("B apply (after invalidate):", third, "fetchesB:", b.state.fetches, "readsB:", b.state.reads)
