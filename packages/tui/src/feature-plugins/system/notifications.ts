import { Plugin } from "@opencode/plugin/tui"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"

function notify(
  context: Plugin.Context,
  sessionID: string | undefined,
  message: string,
  sound: AttentionSoundName,
  title?: string,
) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void context.attention.notify({
    title: title ?? session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

// Only direct children: a grandchild reports to its own parent, so waiting on it could mean no sound at all. Running
// shells don't count, or a session with a dev server running would never play one.
function hasRunningChild(context: Plugin.Context, sessionID: string) {
  return context.data.session
    .family(sessionID)
    .some(
      (child) =>
        child !== sessionID &&
        context.data.session.get(child)?.parentID === sessionID &&
        context.data.session.status(child) === "running",
    )
}

export default Plugin.define({
  id: "opencode.notifications",
  setup(context) {
    const errored = new Set<string>()
    // The current execution's completion per session. A new execution clears it, so a notification deferred
    // while its session loads is dropped once the session has moved on.
    const terminal = new Map<string, symbol>()
    const forms = new Set<string>()
    const permissions = new Set<string>()

    // Events can name a session this client never loaded, such as a nested subagent of a root that is not open.
    // Load it first so a subagent is not announced as a root session. Callers recheck that what they announce
    // is still current, since another client can settle it while the session loads.
    const loaded = (sessionID: string, run: () => void) => {
      if (sessionID === "global" || context.data.session.get(sessionID)) return run()
      void context.data.session.sync(sessionID).then(run, run)
    }

    const started = (sessionID: string) => {
      errored.delete(sessionID)
      terminal.delete(sessionID)
    }
    const ended = (sessionID: string) => {
      if (terminal.has(sessionID)) return
      const completion = Symbol()
      terminal.set(sessionID, completion)
      if (errored.has(sessionID)) {
        errored.delete(sessionID)
        return
      }
      loaded(sessionID, () => {
        if (terminal.get(sessionID) !== completion) return
        notify(
          context,
          sessionID,
          "Session done",
          context.data.session.get(sessionID)?.parentID ? "subagent_done" : "done",
        )
      })
    }

    const dispose = [
      context.data.on("form.created", (event) => {
        if (forms.has(event.data.form.id)) return
        forms.add(event.data.form.id)
        loaded(event.data.form.sessionID, () => {
          if (!forms.has(event.data.form.id)) return
          notify(context, event.data.form.sessionID, "Input needs response", "question", event.data.form.title)
        })
      }),
      context.data.on("form.replied", (event) => forms.delete(event.data.id)),
      context.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
      context.data.on("permission.asked", (event) => {
        if (permissions.has(event.data.id)) return
        permissions.add(event.data.id)
        loaded(event.data.sessionID, () => {
          if (!permissions.has(event.data.id)) return
          notify(context, event.data.sessionID, "Permission needs input", "permission")
        })
      }),
      context.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
      context.data.on("session.execution.started", (event) => started(event.data.sessionID)),
      context.data.on("session.execution.succeeded", (event) => {
        // A running subagent's report wakes the session again, so it isn't done yet. Subagent sounds stay as they were.
        const session = context.data.session.get(event.data.sessionID)
        if (!session?.parentID && hasRunningChild(context, event.data.sessionID)) return
        ended(event.data.sessionID)
      }),
      context.data.on("session.execution.interrupted", (event) => ended(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => {
        const sessionID = event.data.sessionID
        if (terminal.has(sessionID)) return
        if (errored.has(sessionID)) {
          ended(sessionID)
          return
        }
        errored.add(sessionID)
        if (event.data.error.type !== "provider.free-limit" && event.data.error.type !== "provider.go-limit") {
          notify(context, sessionID, event.data.error.message, "error")
          context.ui.toast.show({
            sessionID,
            title: "Session failed",
            message: event.data.error.message,
            variant: "error",
          })
        }
        ended(sessionID)
        const completion = terminal.get(sessionID)
        loaded(sessionID, () => {
          if (terminal.get(sessionID) !== completion) return
          notify(context, sessionID, event.data.error.message, "error")
        })
      }),
    ]

    return () => dispose.reverse().forEach((cleanup) => cleanup())
  },
})
