import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Session } from "@opencode/schema/session"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { Effect, Option, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { readBoundedResponseBody } from "../../../util/io"

// 256 MiB, sized from 514 real session exports (triage on #942): median
// 0.38 MiB, p90 7.55 MiB, 97.9% under 256 MiB — a lower cap (e.g. 5 MiB)
// would reject 13.2% of legitimate imports, while the ~512 MiB engine
// string ceiling makes an unbounded response.text() fail with an opaque
// RangeError just above this.
export const MAX_SESSION_TRANSFER_BYTES = 256 * 1024 * 1024

// One deadline covers both the fetch and the bounded body read. A remote
// import can legitimately move 256 MiB, so the value is sized for a
// slow-but-real transfer (~3.4 MiB/s floor) rather than the CLI's
// small-payload precedents (5-30 s): it exists to cut header stalls and
// slow drips, which never finish at any speed.
export const SESSION_IMPORT_FETCH_TIMEOUT_MS = 600_000

export function fetchRemote(url: string, timeoutMs = SESSION_IMPORT_FETCH_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs)
  return fetch(url, { signal }).then((response) => {
    if (!response.ok) throw new Error(`Failed to fetch session data: ${response.statusText}`)
    return readBoundedResponseBody(response, MAX_SESSION_TRANSFER_BYTES, signal)
  })
}

export default Runtime.handler(
  Commands.commands.session.commands.import,
  Effect.fn("cli.session.import")(function* (input) {
    const text = yield* Effect.tryPromise({
      try: () =>
        input.file.startsWith("http://") || input.file.startsWith("https://")
          ? fetchRemote(input.file)
          : readFile(input.file, "utf8"),
      catch: (cause) =>
        new Error(`Failed to read session data: ${cause instanceof Error ? cause.message : String(cause)}`),
    })
    const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionTransfer.Data))(text)
    const encoded = Schema.encodeSync(SessionTransfer.Data)(data)
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = OpenCode.make({
      baseUrl: server.endpoint.url,
      headers: Service.headers(server.endpoint),
    })
    const location = yield* Effect.promise(() =>
      client.location.get({
        location: { directory: path.resolve(Option.getOrElse(input.directory, () => process.cwd())) },
      }),
    )
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/session/import", server.endpoint.url), {
        method: "POST",
        headers: { ...Service.headers(server.endpoint), "content-type": "application/json" },
        body: JSON.stringify({
          ...encoded,
          location: { directory: location.directory },
        }),
      }),
    )
    if (response.status === 409) {
      process.stderr.write(`Session already exists${EOL}`)
      return
    }
    if (!response.ok) yield* Effect.fail(new Error(`Failed to import session: ${response.statusText}`))
    const imported = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ data: Session.Info })))(
      yield* Effect.promise(() => response.text()),
    )
    process.stdout.write(`Imported session: ${imported.data.id}${EOL}`)
  }),
)
