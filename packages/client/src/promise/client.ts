export * as OpenCode from "./client.js"

import { SharedEvents } from "../shared-events.js"
import { OpenCode } from "./generated/index.js"
import type { ClientOptions, RequestOptions } from "./generated/client.js"
import { makeRpc } from "./rpc.js"

export type { ClientOptions, RequestOptions } from "./generated/client.js"

export function make(options: ClientOptions) {
  const raw = OpenCode.make(options)
  const connect = (input: Parameters<typeof raw.server.connect>[0], requestOptions?: RequestOptions) => {
    const headers = new Headers(options.headers)
    new Headers(requestOptions?.headers).forEach((value, key) => headers.set(key, value))
    if (!headers.has("accept")) headers.set("accept", "application/json")
    return raw.server.connect(input, { ...requestOptions, headers })
  }
  const events = SharedEvents.make((signal, onActivity, resume) =>
    raw.event.subscribe({ "last-event-id": resume.lastEventID }, { signal, onActivity, onEventId: resume.onEventId }),
  )
  return {
    ...raw,
    server: { ...raw.server, connect },
    rpc: Object.assign(makeRpc(raw, events), raw.rpc),
    event: events,
  }
}
