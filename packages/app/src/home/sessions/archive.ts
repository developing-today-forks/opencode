import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import type { ServerConnection } from "@/runtime/server/registry"
import type { SessionInfo } from "@opencode/client/promise"

type HomeSession = Pick<SessionInfo, "id" | "location">

/** The slice of the V2 client the Home archive callback needs. */
export type SessionArchiveClient = {
  session: {
    update: (input: { sessionID: string; archived: boolean }) => Promise<unknown>
  }
}

/** Archive a session through the V2 `session.update` API (`archived: true`). */
export function sessionArchiver(client: SessionArchiveClient) {
  return (sessionID: string) => client.session.update({ sessionID, archived: true })
}

export async function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  archive: (sessionID: string) => Promise<unknown>
  remove: () => void
  onError?: (error: unknown) => void
}) {
  await input
    .archive(input.session.id)
    .then(() => {
      input.remove()
      notifySessionTabsRemoved({
        server: input.server,
        directory: input.session.location.directory,
        sessionIDs: [input.session.id],
      })
    })
    .catch((error) => input.onError?.(error))
}
