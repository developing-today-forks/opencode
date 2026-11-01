import { expect, test } from "bun:test"
import { createSubagentTracker } from "../../src/mini/stream-v2.subagent"

test("tracker carries parentage from the session family index into tabs", async () => {
  const sessions: Record<string, { id: string; parentID?: string; agent: string; title: string; time: { updated: number } }> = {
    ses_child: { id: "ses_child", parentID: "ses_root", agent: "explore", title: "Child", time: { updated: 2 } },
    ses_grand: { id: "ses_grand", parentID: "ses_child", agent: "general", title: "Grandchild", time: { updated: 3 } },
  }
  const sdk = {
    session: {
      list: async (input: { parentID: string }) => ({
        data: Object.values(sessions).filter((session) => session.parentID === input.parentID),
      }),
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
  }
  const controller = new AbortController()
  const tracker = createSubagentTracker({
    sessionID: "ses_root",
    thinking: false,
    signal: controller.signal,
    emit: () => {},
  })
  try {
    // The family index walks root -> child -> grandchild; each tab must keep
    // the session that started it so the select menu can nest the list.
    await tracker.hydrate({ sdk: sdk as never, messages: [], active: {}, signal: controller.signal })
    const tabs = Object.fromEntries(tracker.snapshot().tabs.map((tab) => [tab.sessionID, tab.parentID]))
    expect(tabs).toEqual({ ses_child: "ses_root", ses_grand: "ses_child" })
  } finally {
    tracker.close()
    controller.abort()
  }
})
