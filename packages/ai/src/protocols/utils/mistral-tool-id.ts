export const valid = /^[A-Za-z0-9]{9}$/

export const hash = (value: string) => {
  const hash = (seed: number) => {
    let result = seed
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
    return (result >>> 0).toString(36)
  }
  return `${hash(2166136261).padStart(7, "0")}${hash(2246822519).padStart(7, "0")}`.slice(-9)
}

// #2228 (from #1707 §2-G1): the projection is a pure function of the original
// id, so a session's mapping is stable across requests by construction — the
// same original id yields the same normalized id in every request, no matter
// what other ids the history has gained since. The previous per-request
// normalizer salted the hash whenever a candidate was already used in that
// request, so an id's projection depended on the request's other ids and
// could change between requests of one session. Two distinct originals now
// share a projection only when their hashes collide (or one original is
// literally another's hash) — the accepted bound of deterministic hash
// derivation; there is no request state to consult or persist.
export const normalize = (id: string) => (valid.test(id) ? id : hash(id))

export * as MistralToolID from "./mistral-tool-id.js"
