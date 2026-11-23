import { expect, test } from "bun:test"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/shell/titlebar/session-events"
import { archiveHomeSession, sessionArchiver } from "./archive"
import type { ServerConnection } from "@/runtime/server/registry"

const remote = "remote" as ServerConnection.Key

test("archiving a Home session removes its open titlebar tab", async () => {
  let detail: ReturnType<typeof readSessionTabsRemovedDetail>
  let removed = false
  window.addEventListener(
    SESSION_TABS_REMOVED_EVENT,
    (event) => {
      detail = readSessionTabsRemovedDetail(event)
    },
    { once: true },
  )

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", location: { directory: "/workspace" } },
    archive: async () => undefined,
    remove: () => {
      removed = true
    },
  })

  expect(removed).toBe(true)
  expect(detail).toEqual({ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] })
})

test("reports archive failures without removing the session", async () => {
  const failure = new Error("offline")
  let error: unknown
  let removed = false

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", location: { directory: "/workspace" } },
    archive: async () => Promise.reject(failure),
    remove: () => {
      removed = true
    },
    onError: (value) => {
      error = value
    },
  })

  expect(error).toBe(failure)
  expect(removed).toBe(false)
})

test("archiving a Home session calls session.update with archived: true", async () => {
  const calls: { sessionID: string; archived: boolean }[] = []
  let removed = false

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", location: { directory: "/workspace" } },
    archive: sessionArchiver({
      session: {
        update: async (input) => {
          calls.push(input)
        },
      },
    }),
    remove: () => {
      removed = true
    },
  })

  expect(calls).toEqual([{ sessionID: "ses_1", archived: true }])
  expect(removed).toBe(true)
})
