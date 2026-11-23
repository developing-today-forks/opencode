export * as SessionShell from "./shell.js"

import type { Session } from "@opencode/schema/session"
import { Event } from "@opencode/schema/event"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { Shell } from "../shell.js"
import { ShellResult } from "../shell/result.js"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"

export const start = Effect.fn("SessionShell.start")(function* (input: { session: Session.Info; command: string }) {
  const instances = yield* Instance.Service
  const shell = yield* Plugin.awaitActivation.pipe(Effect.andThen(Shell.Service), instances.provide(input.session))
  const info = yield* shell.create({
    command: input.command,
    cwd: input.session.location.directory,
    timeout: 0,
    metadata: { sessionID: input.session.id, background: true },
  })
  // Keep completion tied to the original shell even if the Session moves.
  return {
    info,
    result: shell.result(info),
    output: shell
      .output(info.id, { limit: 1024 * 1024 })
      .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(ShellResult.unavailable))),
  }
})

/**
 * Runs one admitted shell to completion in the Session's record: publishes
 * the started and ended events and admits the completion notice through
 * `notify`. The server owns this recording even if the submitting client
 * disconnects — the caller forks it into a scope that outlives the request.
 * A shell that fails to start admits an error notice instead and does not
 * fail the caller: admission already returned, so the Session is where the
 * failure is reported.
 */
export const execute = Effect.fn("SessionShell.execute")(function* (input: {
  session: Session.Info
  id?: SessionMessage.ID
  command: string
  bus: Bus.Interface
  notify: (input: {
    text: string
    description?: string
    metadata?: Record<string, unknown>
  }) => Effect.Effect<void>
}) {
  const sessionID = input.session.id
  const started = yield* start({ session: input.session, command: input.command }).pipe(
    Effect.tapError((error) =>
      input.notify({
        text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
        description: input.command,
        metadata: { source: "shell", state: "error" },
      }),
    ),
    Effect.orDie,
  )
  yield* input.bus.publish(
    SessionEvent.Shell.Started,
    {
      sessionID,
      shell: started.info,
    },
    { id: input.id ? Event.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined },
  )
  const terminal = yield* started.result
  const preview = yield* started.output
  yield* input.bus.publish(SessionEvent.Shell.Ended, {
    sessionID,
    shell: terminal.info,
    output: preview,
  })
  yield* input.notify({ ...ShellResult.userNotification(terminal) })
})
