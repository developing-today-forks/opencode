export * as Session from "./session.js"

import { DateTime, Effect, Option, Scope } from "effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { Event } from "@opencode/schema/event"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { LocationServiceMap } from "../location-service-map.js"
import { MessagingVars } from "../messaging/vars.js"
import { Command } from "../command.js"
import { Plugin } from "../plugin/service.js"
import type { Skill } from "../skill.js"
import {
  BusyError,
  CommandConflictError,
  CompactionConflictError,
  InboxConflictError,
  NotFoundError,
  PromptConflictError,
  ShellConflictError,
} from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionOperation } from "./operation.js"
import { SessionPrompt } from "./prompt.js"
import { SessionRevert } from "./revert.js"
import { SessionSkill } from "./skill.js"
import { ModelGovernance } from "./model-governance.js"
import { GovernanceConfig } from "./governance-config.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { SessionSynthetic } from "./synthetic.js"

type PromptRequest = SessionPrompt.Input & {
  id?: SessionMessage.ID
  resume?: boolean
}

/**
 * Build once in the host Scope: `const sessions = yield* Session.make()`.
 * Use `sessions.forSession(id)` for handles that share host services and reload current state.
 */
export const make = Effect.fn("Session.make")(function* () {
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  // Optional: hosts that carry the location service map let governance peek
  // at already-initialized location services for agent definitions.
  const locations = Option.getOrUndefined(yield* Effect.serviceOption(LocationServiceMap.Service))
  const execution = yield* SessionExecution.Service
  const admission = yield* SessionInbox.Service
  const fs = yield* FSUtil.Service
  const scope = yield* Scope.Scope
  // Optional: hosts with messaging render template variables in skills that opt in.
  const vars = Option.getOrUndefined(yield* Effect.serviceOption(MessagingVars.Service))
  const render = (sessionID: SessionSchema.ID) => (vars ? (text: string) => vars.expand(text, sessionID) : undefined)

  const get = Effect.fn("Session.get")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    return session
  })
  const message = Effect.fn("Session.message")(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
    const stored = yield* store.message(messageID)
    return stored?.sessionID === sessionID ? stored.message : undefined
  })
  const view = Effect.fn("Session.view")(function* (sessionID: SessionSchema.ID, input: { idle: number }) {
    const session = yield* get(sessionID)
    if (
      session.time.idle === undefined ||
      input.idle > DateTime.toEpochMillis(session.time.idle) ||
      (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
    )
      return
    yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: input.idle })
  })
  const rename = Effect.fn("Session.rename")(function* (sessionID: SessionSchema.ID, input: { title: string }) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Renamed, { sessionID, title: input.title })
  })
  const archive = Effect.fn("Session.archive")(function* (sessionID: SessionSchema.ID, input?: { time?: number }) {
    const session = yield* get(sessionID)
    if (session.time.archived) return
    yield* bus.publish(SessionEvent.Archived, { sessionID, time: input?.time })
  })
  const unarchive = Effect.fn("Session.unarchive")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (!session.time.archived) return
    yield* bus.publish(SessionEvent.Unarchived, { sessionID })
  })
  const setMetadata = Effect.fn("Session.setMetadata")(function* (
    sessionID: SessionSchema.ID,
    input: { metadata: SessionSchema.Metadata },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.MetadataUpdated, { sessionID, metadata: input.metadata })
  })
  const setPermissions = Effect.fn("Session.setPermissions")(function* (
    sessionID: SessionSchema.ID,
    input: { permissions: Permission.Ruleset },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Permissions, { sessionID, permissions: input.permissions })
  })
  const setSubagentPolicy = Effect.fn("Session.setSubagentPolicy")(function* (
    sessionID: SessionSchema.ID,
    input: { subagentPolicy: SessionSchema.SubagentPolicy },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.SubagentPolicyUpdated, { sessionID, subagentPolicy: input.subagentPolicy })
  })
  // Governance inputs (config entries + provider catalog) come from the one
  // shared construction in governance-config.ts: GovernanceConfig.load.
  const switchAgent = Effect.fn("Session.switchAgent")(function* (
    sessionID: SessionSchema.ID,
    input: { agent: Agent.ID; model?: Model.Ref },
  ) {
    const session = yield* get(sessionID)
    // Without a stored agent the Session runs as its Location's default, which its last step records.
    const current =
      session.agent ?? (yield* store.lastAssistantAfter({ sessionID }).pipe(Effect.orElseSucceed(() => undefined)))?.agent
    if (current === input.agent) return
    // A child session may only switch to an agent under which the model it
    // will run is allowed; top-level sessions are unchecked. The model it
    // will run is the caller-supplied upcoming model when one accompanies
    // the switch, else its current model — assertAllowed falls back to the
    // incoming agent's configured default, then the parent's model, when
    // neither exists.
    // A fork has no parentID but is a child of its source for governance
    // (#505), so its switches are checked against the source's chain.
    const governanceParentID = session.parentID ?? session.fork?.sessionID
    if (governanceParentID) {
      const parent = yield* get(governanceParentID)
      const { entries, catalog } = yield* GovernanceConfig.load(locations, session.location)
      yield* ModelGovernance.assertAllowed(
        { get },
        { entries: () => Effect.succeed(entries), catalog: () => Effect.succeed(catalog) },
        {
          parent,
          agent: input.agent,
          model: input.model ?? session.model,
        },
      )
    }
    yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent: input.agent, previous: session.agent })
  })
  const switchModel = Effect.fn("Session.switchModel")(function* (
    sessionID: SessionSchema.ID,
    input: { model: Model.Ref },
  ) {
    const session = yield* get(sessionID)
    if (
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    // A child session may only switch to a model its subtree's governance
    // allows; top-level sessions are unchecked. A fork is governed as a
    // child of its source (#505), as in switchAgent above.
    const governanceParentID = session.parentID ?? session.fork?.sessionID
    if (governanceParentID) {
      const parent = yield* get(governanceParentID)
      const { entries, catalog } = yield* GovernanceConfig.load(locations, session.location)
      yield* ModelGovernance.assertAllowed(
        { get },
        { entries: () => Effect.succeed(entries), catalog: () => Effect.succeed(catalog) },
        {
          parent,
          agent: session.agent,
          model: input.model,
        },
      )
    }
    yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model: input.model, previous: session.model })
  })
  const mutatePending = (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
    mutation: (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
  ) =>
    mutation({ sessionID, id: inboxID }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () =>
        Effect.gen(function* () {
          yield* get(sessionID)
          return yield* new InboxConflictError({ sessionID, inboxID })
        }),
      ),
    )

  const inbox = Effect.fn("Session.inbox")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    return yield* admission.list(sessionID)
  })
  const cancelInbox = Effect.fn("Session.cancelInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.cancel),
    Effect.uninterruptible,
  )
  const steerInbox = Effect.fn("Session.steerInbox")(function* (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
  ) {
    yield* mutatePending(sessionID, inboxID, admission.steer)
    yield* execution.wake(sessionID)
  }, Effect.uninterruptible)
  const queueInbox = Effect.fn("Session.queueInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.queue),
    Effect.uninterruptible,
  )
  const prompt = Effect.fn("Session.prompt")(
    (sessionID: SessionSchema.ID, input: PromptRequest, onAccepted?: Effect.Effect<void>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const session = yield* get(sessionID)
          const messageID = input.id ?? SessionMessage.ID.create()
          const admitted = yield* Effect.gen(function* () {
            const existing = yield* admission.reconcile({
              id: messageID,
              sessionID: session.id,
              type: "user",
              delivery: input.delivery ?? "steer",
            })
            if (existing) return existing
            // Preparation, the staged revert commit and admission share one acquisition of the session's location
            // services, so projections see its config whoever called prompt.
            return yield* Effect.gen(function* () {
              const renderer = render(session.id)
              const item = yield* restore(
                SessionPrompt.prepare({ session, messageID, input, ...(renderer ? { render: renderer } : {}) }),
              )
              // Commit a staged revert only after preparation succeeds, before admitting new work.
              if (session.revert) yield* SessionRevert.commit(bus, session)
              return yield* admission.admit({
                id: messageID,
                sessionID: session.id,
                item,
              })
            }).pipe(
              instances.provide(session),
              Effect.provideService(Database.Service, database),
              Effect.provideService(FSUtil.Service, fs),
            )
          }).pipe(
            Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })),
          )
          if (input.resume !== false) yield* execution.wake(sessionID)
          // Checkpoint an accepted handoff before observing cancellation. Prompt preparation above stays interruptible.
          if (onAccepted) yield* onAccepted
          return admitted
        }),
      ),
  )
  // Starts an admitted operation's execution in the host scope, so the
  // server owns its recording even if the submitting client disconnects.
  // Admission returns as soon as the operation is durable; its start,
  // progress and completion arrive as events.
  const forkOperation = (session: SessionSchema.Info, operation: SessionInbox.Operation) =>
    SessionOperation.run({
      session,
      operation,
      bus,
      db: database.db,
      notify: (note) =>
        synthetic(session.id, { ...note, resume: false }).pipe(
          Effect.catchTag("Session.NotFoundError", () => Effect.void),
          Effect.orDie,
          Effect.asVoid,
        ),
      started: (id) =>
        store.message(id).pipe(
          Effect.map((found) => found?.sessionID === session.id && found.message.type === "shell"),
          Effect.orElseSucceed(() => false),
        ),
    }).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.asVoid,
    )

  const shell = Effect.fn("Session.shell")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; command: string; delivery?: SessionInbox.Delivery },
  ) {
    const session = yield* get(sessionID)
    const inputID = input.id ?? SessionMessage.ID.create()
    const delivery = input.delivery ?? "steer"
    // Reconciliation, the already-ran check and admission share the Session's
    // inbox lock, so a duplicate ID can never admit or start a shell twice.
    const admitted = yield* SessionInbox.serialized(
      sessionID,
      Effect.gen(function* () {
        const existing = yield* admission.reconcile({ id: inputID, sessionID, type: "shell", delivery })
        if (existing) return { item: existing, fresh: false }
        // A shell that already ran projects to a message under this same ID
        // and its admission is long consumed; answer from that record.
        const prior = yield* store.message(inputID).pipe(Effect.orElseSucceed(() => undefined))
        if (prior?.sessionID === sessionID && prior.message.type === "shell")
          return {
            item: SessionInbox.Shell.make({
              id: inputID,
              sessionID,
              time: { created: prior.message.time.created },
              type: "shell" as const,
              payload: SessionInbox.ShellPayload.make({ command: prior.message.command }),
              delivery,
            }),
            fresh: false,
          }
        const item = yield* admission.admit({
          id: inputID,
          sessionID,
          item: {
            type: "shell",
            payload: SessionInbox.ShellPayload.make({ command: input.command }),
            delivery,
          },
        })
        return { item, fresh: true }
      }),
    ).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () => new ShellConflictError({ sessionID, inputID })),
    )
    if (admitted.fresh) yield* forkOperation(session, admitted.item)
    return admitted.item
  })

  const command = Effect.fn("Session.command")(function* (
    sessionID: SessionSchema.ID,
    input: {
      id?: SessionMessage.ID
      command: string
      text: string
      files?: SessionInbox.CommandPayload["files"]
      agents?: SessionInbox.CommandPayload["agents"]
      skills?: SessionInbox.CommandPayload["skills"]
      delivery?: SessionInbox.Delivery
    },
  ) {
    const session = yield* get(sessionID)
    const inputID = input.id ?? SessionMessage.ID.create()
    const delivery = input.delivery ?? "steer"
    const admitted = yield* SessionInbox.serialized(
      sessionID,
      Effect.gen(function* () {
        const existing = yield* admission.reconcile({ id: inputID, sessionID, type: "command", delivery })
        if (existing) return { item: existing, fresh: false }
        // An unknown command still fails the request, as it did when
        // execution was inline; a known one is admitted durably and
        // executes in admission order. Validation waits for plugin
        // activation, as execution does: at a cold Location the registry
        // is not populated until activation settles.
        const known = yield* Plugin.awaitActivation.pipe(
          Effect.andThen(Command.Service),
          Effect.flatMap((commands) => commands.get(input.command)),
          instances.provide(session),
        )
        if (!known)
          return yield* new Command.NotFoundError({
            command: input.command,
            message: `Command not found: ${input.command}`,
          })
        const item = yield* admission.admit({
          id: inputID,
          sessionID,
          item: {
            type: "command",
            payload: SessionInbox.CommandPayload.make({
              command: input.command,
              text: input.text,
              files: input.files,
              agents: input.agents,
              skills: input.skills,
            }),
            delivery,
          },
        })
        return { item, fresh: true }
      }),
    ).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () => new CommandConflictError({ sessionID, inputID })),
    )
    if (admitted.fresh) yield* forkOperation(session, admitted.item)
    return admitted.item
  })
  const skill = Effect.fn("Session.skill")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID?: SessionMessage.ID; skill: Skill.ID; resume?: boolean },
  ) {
    const session = yield* get(sessionID)
    const skill = yield* SessionSkill.get({ session, skill: input.skill }).pipe(
      Effect.provideService(Instance.Service, instances),
    )
    const renderer = skill.vars ? render(sessionID) : undefined
    yield* bus.publish(
      SessionEvent.Skill.Activated,
      {
        sessionID,
        id: skill.id,
        name: skill.name,
        text: renderer ? yield* renderer(skill.content) : skill.content,
      },
      { id: input.messageID ? Event.ID.make(input.messageID.replace(/^msg_/, "evt_")) : undefined },
    )
    if (input.resume !== false)
      yield* execution
        .resume(sessionID)
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  })
  const compact = Effect.fn("Session.compact")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; delivery?: SessionInbox.Delivery },
  ) {
    const session = yield* get(sessionID)
    if (session.revert) yield* SessionRevert.commit(bus, session)
    const inputID = input.id ?? SessionMessage.ID.create()
    const admitted = yield* admission
      .admitCompaction({
        id: inputID,
        sessionID,
        delivery: input.delivery ?? "steer",
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new CompactionConflictError({ sessionID, inputID })),
      )
    yield* execution.wake(sessionID)
    return admitted
  })
  const wait = Effect.fn("Session.wait")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.awaitIdle(sessionID)
  })
  const resume = Effect.fn("Session.resume")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.resume(sessionID)
  })
  const admitSynthetic = SessionSynthetic.make(store, admission, execution.wake)
  const synthetic = (sessionID: SessionSchema.ID, input: Omit<Parameters<typeof admitSynthetic>[0], "sessionID">) =>
    admitSynthetic({ ...input, sessionID })
  const interrupt = Effect.fn("Session.interrupt")(
    (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean; readonly force?: boolean }) =>
      Effect.uninterruptible(
        execution.interrupt(
          sessionID,
          options?.resume !== undefined ? { resume: options.resume } : undefined,
        ),
      ),
  )
  const stage = Effect.fn("Session.revert.stage")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID: SessionMessage.ID; files?: boolean },
  ) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Database.Service, database),
      Effect.provideService(Bus.Service, bus),
    )
  })
  const clear = Effect.fn("Session.revert.clear")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    yield* SessionRevert.clear(session).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Bus.Service, bus),
    )
    return yield* execution.wake(sessionID)
  })
  const commit = Effect.fn("Session.revert.commit")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.commit(bus, session)
  })
  const revert = { stage, clear, commit }
  const operations = {
    get,
    message,
    view,
    rename,
    archive,
    unarchive,
    setMetadata,
    setPermissions,
    setSubagentPolicy,
    switchAgent,
    switchModel,
    inbox,
    prompt,
    synthetic,
    shell,
    command,
    skill,
    compact,
    wait,
    resume,
    interrupt,
    cancelInbox,
    steerInbox,
    queueInbox,
    revert,
  }

  const forSession = (sessionID: SessionSchema.ID) => {
    const get = operations.get.bind(undefined, sessionID)
    const message = operations.message.bind(undefined, sessionID)
    const view = operations.view.bind(undefined, sessionID)
    const rename = operations.rename.bind(undefined, sessionID)
    const archive = operations.archive.bind(undefined, sessionID)
    const unarchive = operations.unarchive.bind(undefined, sessionID)
    const setMetadata = operations.setMetadata.bind(undefined, sessionID)
    const setPermissions = operations.setPermissions.bind(undefined, sessionID)
    const setSubagentPolicy = operations.setSubagentPolicy.bind(undefined, sessionID)
    const switchAgent = operations.switchAgent.bind(undefined, sessionID)
    const switchModel = operations.switchModel.bind(undefined, sessionID)
    const inbox = operations.inbox.bind(undefined, sessionID)
    const prompt = operations.prompt.bind(undefined, sessionID)
    const synthetic = operations.synthetic.bind(undefined, sessionID)
    const shell = operations.shell.bind(undefined, sessionID)
    const command = operations.command.bind(undefined, sessionID)
    const skill = operations.skill.bind(undefined, sessionID)
    const compact = operations.compact.bind(undefined, sessionID)
    const wait = operations.wait.bind(undefined, sessionID)
    const resume = operations.resume.bind(undefined, sessionID)
    const interrupt = operations.interrupt.bind(undefined, sessionID)
    const cancelInbox = operations.cancelInbox.bind(undefined, sessionID)
    const steerInbox = operations.steerInbox.bind(undefined, sessionID)
    const queueInbox = operations.queueInbox.bind(undefined, sessionID)
    const stage = operations.revert.stage.bind(undefined, sessionID)
    const clear = operations.revert.clear.bind(undefined, sessionID)
    const commit = operations.revert.commit.bind(undefined, sessionID)
    const revert = { stage, clear, commit }

    return {
      id: sessionID,
      get,
      message,
      view,
      rename,
      archive,
      unarchive,
      setMetadata,
      setPermissions,
      setSubagentPolicy,
      switchAgent,
      switchModel,
      inbox,
      prompt,
      synthetic,
      shell,
      command,
      skill,
      compact,
      wait,
      resume,
      interrupt,
      cancelInbox,
      steerInbox,
      queueInbox,
      revert,
    }
  }
  return { forSession }
})

export type Handle = ReturnType<Effect.Success<ReturnType<typeof make>>["forSession"]>

// Mirrors the shell tool's in-memory preview safety limit.
