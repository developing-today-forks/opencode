export * as SessionOperation from "./operation.js"

import type { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import type { Database } from "../database/database.js"
import { SessionCommand } from "./command.js"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionShell } from "./shell.js"

/**
 * Records an admitted operation's outcome in the Session: the shell's own
 * started/ended events carry shell results, while this carries the synthetic
 * notice a completion (or a failure) admits for the model.
 */
export type Notify = (input: {
  text: string
  description?: string
  metadata?: Record<string, unknown>
}) => Effect.Effect<void>

// Operations whose execution this process has already started. Admission is
// serialized per Session and a pending row forks only one starter, but the
// recovery sweep in SessionExecution can race that starter; the claim makes
// the second starter stand down. The claim is released when execution
// settles — by then the row is consumed, and only the durable records (the
// shell's message, the row's absence) speak for the operation.
const claimed = new Set<string>()

const claim = (sessionID: Session.ID, id: SessionMessage.ID) =>
  Effect.sync(() => {
    const key = `${sessionID}:${id}`
    if (claimed.has(key)) return false
    claimed.add(key)
    return true
  })

const release = (sessionID: Session.ID, id: SessionMessage.ID) =>
  Effect.sync(() => {
    claimed.delete(`${sessionID}:${id}`)
  })

/**
 * Executes one admitted shell or command operation and consumes its inbox
 * row when execution settles, whatever the outcome. The row therefore reads
 * as pending for exactly the operation's in-flight window: a duplicate
 * admission while it is pending reconciles onto the same item instead of
 * starting the operation twice, and a row still pending when execution next
 * drains belongs to a start this process lost (a crash between admission and
 * start, or a starter that died) and is started then.
 *
 * A shell is never run twice for one admission: its started event projects
 * to a message under the admission's own ID, and `started` reports it, so a
 * recovered row whose shell already ran is only consumed. A command records
 * a durable start marker before its definition is invoked: a recovered row
 * with no marker never started and runs now, while a recovered row with a
 * marker has an ambiguous prior outcome (its definition may have run side
 * effects before the crash) and is NOT rerun — an explicit interrupted
 * notice is surfaced instead, with the command name so it can be retried
 * intentionally.
 */
export const run = Effect.fn("SessionOperation.run")(function* (input: {
  session: Session.Info
  operation: SessionInbox.Operation
  db: Database.Interface["db"]
  bus: Bus.Interface
  notify: Notify
  started: (id: SessionMessage.ID) => Effect.Effect<boolean>
}) {
  const sessionID = input.session.id
  const operation = input.operation
  if (!(yield* claim(sessionID, operation.id))) return
  // Consuming the row is the operation's terminal record. A row the
  // projector already consumed (a duplicate delivery) is not an error.
  const consume = input.bus
    .publish(SessionEvent.InboxDelivered, { sessionID, inboxID: operation.id })
    .pipe(
      Effect.catchDefect((defect) =>
        defect instanceof SessionInbox.LifecycleConflict ? Effect.void : Effect.die(defect),
      ),
      Effect.asVoid,
    )
  yield* Effect.gen(function* () {
    if (operation.type === "shell") {
      if (yield* input.started(operation.id)) return
      yield* SessionShell.execute({
        session: input.session,
        id: operation.id,
        command: operation.payload.command,
        bus: input.bus,
        notify: input.notify,
      })
      return
    }
    // Commands: distinguish never-started from started-with-unknown-outcome.
    // A recovered row with a start marker may have run side effects before
    // the crash; rerunning it silently could apply them twice, so surface an
    // explicit interrupted outcome with the command name for intentional
    // retry instead. A row with no marker never reached its definition and
    // runs now.
    if (yield* SessionInbox.hasStarted(input.db, sessionID, operation.id)) {
      yield* interrupted(input.notify, operation.payload.command, operation.payload.text)
      return
    }
    // The row may already be consumed (a duplicate delivery that lost its
    // race after the claim was taken); without a pending row there is
    // nothing to run.
    if ((yield* SessionInbox.find(input.db, operation.id)) === undefined) return
    yield* SessionInbox.markStarted(input.db, sessionID, operation.id)
    yield* SessionCommand.execute({
      session: input.session,
      command: operation.payload.command,
      text: operation.payload.text,
      files: operation.payload.files,
      agents: operation.payload.agents,
      skills: operation.payload.skills,
      delivery: operation.delivery,
    }).pipe(
      Effect.catchTag("Command.NotFoundError", (error) => failed(input.notify, operation.payload.command, error.message)),
      Effect.catchTag("Command.ExecutionError", (error) =>
        failed(input.notify, operation.payload.command, error.message),
      ),
    )
  }).pipe(Effect.ensuring(consume), Effect.ensuring(release(sessionID, operation.id)))
})

const failed = (notify: Notify, command: string, message: string) =>
  notify({
    text: `User command failed:\n/${command}\n\n${message}`,
    description: command,
    metadata: { source: "command", state: "error" },
  })

const interrupted = (notify: Notify, command: string, text: string) =>
  notify({
    text: `User command interrupted:\n/${command} ${text}\n\nThe command started but its outcome is unknown — it may have run side effects before the interruption. Retry intentionally with /${command} if needed.`,
    description: command,
    metadata: { source: "command", state: "interrupted", retry: `/${command}` },
  })
