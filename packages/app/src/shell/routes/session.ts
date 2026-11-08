import { base64Encode } from "@opencode/util/encode"
import { ServerConnection } from "@/runtime/server/registry"
import { decode64 } from "@/runtime/persistence/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)

  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")

  return ServerConnection.Key.make(key)
}

type SessionParent = { id: string; parentID?: string; fork?: { sessionID: string } }

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session

  // Follow the fork link where a session has no parent, as core
  // SessionAffinity.resolveRoot does, so a fork resolves to the source
  // tree's root instead of stopping at the fork.
  while (true) {
    const parentID = current.parentID ?? current.fork?.sessionID

    if (!parentID) return current

    if (seen.has(parentID)) throw new Error(`Session parent cycle: ${parentID}`)
    seen.add(parentID)
    current = await get(parentID)
  }
}
