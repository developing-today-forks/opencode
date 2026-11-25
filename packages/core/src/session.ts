export * as Session from "./session.js"
export * from "./session/schema.js"

import { DateTime, Effect, Equal, Layer, Context, Option, Stream } from "effect"
import { LLMClient } from "@opencode/ai/effect"
import { ListAnchor, ListCursor, ListFilter } from "@opencode/schema/session"
import { and, desc, eq } from "drizzle-orm"
import { Project } from "./project.js"
import { Model } from "@opencode/schema/model"
import { Location } from "./location.js"
import type { FileSystem } from "./filesystem.js"
import { SessionMessage } from "./session/message.js"
import { Bus } from "./bus.js"
import { Instance } from "./instance/service.js"
import { Plugin } from "./plugin/service.js"
import { PluginHooks } from "./plugin/hooks.js"
import { Database } from "./database/database.js"
import { SessionProjector } from "./session/projector.js"
import { SessionMessageTable } from "./session/sql.js"
import { SessionBlob } from "./session/blob.js"
import { SessionSchema } from "./session/schema.js"
import { RelativePath } from "./schema.js"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import { App } from "./app.js"
import { Slug } from "./util/slug.js"
import path from "path"
import { SessionRunner } from "./session/runner/index.js"
import { SessionStore } from "./session/store.js"
import { SessionExecution } from "./session/execution.js"
import {
  AlreadyExistsError,
  AttachmentError,
  BusyError,
  CommandConflictError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  InvalidListCursorError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  RouteTargetError,
  ShellConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
} from "./session/error.js"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionEvent } from "./session/event.js"
import { SessionInbox } from "./session/inbox.js"
import { InstructionState } from "./session/instruction-state.js"
import { SessionGenerate } from "./session/generate.js"
import {
  SessionMove,
  DestinationNotFoundError,
  DestinationNotDirectoryError,
  DestinationUnavailableError,
} from "./session/move.js"
import { SessionModelTransport } from "./session/model-transport.js"
import { llmClient } from "./effect/app-node-platform.js"
import { Snapshot } from "./snapshot.js"
import { Session } from "./session/session.js"
import { ModelGovernance } from "./session/model-governance.js"
import { GovernanceConfig } from "./session/governance-config.js"
import { SessionDiff, TurnRangeError } from "./session/diff.js"
import { LocationServiceMap } from "./location-service-map.js"
import { FSUtil } from "@opencode/util/fs-util"
import type { EventLog } from "@opencode/schema/event-log"
import type { FileDiff } from "@opencode/schema/file-diff"
import { Job } from "./job.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionRouteTarget } from "./session/route-target.js"
import { ModelRoute } from "./model-route.js"
import { InstructionEntry } from "./session/instruction-entry.js"
import { McpxSubagent } from "./tool/plugin/mcpx-subagent.js"
import { MessagingVars } from "./messaging/vars.js"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor, ListCursor }

export const ListInput = SessionStore.ListInput
export type ListInput = SessionStore.ListInput

const DefaultListLimit = 50

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: Agent.ID
  model?: Model.Ref
  metadata?: SessionSchema.Metadata
  permissions?: Permission.Ruleset
  subagentPolicy?: SessionSchema.SubagentPolicy
  /** Detached (non-interactive) mode; children always inherit it from their parent. */
  detached?: true
  /** Per-call governance override from the launching tool; see ModelGovernance. */
  subagentOverride?: SessionSchema.AgentOverride
}
type CreateInput = CreateBaseInput &
  ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })

type CompactInput = Parameters<Session.Handle["compact"]>[0] & { sessionID: SessionSchema.ID }

type ForkInput = {
  sessionID: SessionSchema.ID
  before?: SessionMessage.ID
}

export {
  AlreadyExistsError,
  AttachmentError,
  BusyError,
  CommandConflictError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  InvalidListCursorError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  RouteTargetError,
  ShellConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
}
type InboxItemRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }

export { DestinationNotFoundError, DestinationNotDirectoryError, DestinationUnavailableError }
export { TurnRangeError }

export interface Interface {
  /** A cursor carries the filters of the request that produced it, so filters passed with a cursor are ignored. */
  readonly list: (input?: ListFilter & { readonly limit?: number; readonly cursor?: ListCursor }) => Effect.Effect<
    {
      readonly data: SessionSchema.Info[]
      readonly cursor: { readonly previous?: ListCursor; readonly next?: ListCursor }
    },
    InvalidListCursorError
  >
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<SessionSchema.Info, AlreadyExistsError | NotFoundError | ModelGovernance.DeniedError>
  readonly fork: (
    input: ForkInput,
  ) => Effect.Effect<
    SessionSchema.Info,
    NotFoundError | MessageNotFoundError | ForkEmptyError | ModelGovernance.DeniedError
  >
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly environment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly variables?: SessionEnvironment.Variables
  }) => Effect.Effect<SessionEnvironment.Variables | undefined, NotFoundError>
  readonly view: (input: { sessionID: SessionSchema.ID; idle: number }) => Effect.Effect<void, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined>
  /** Experimental: {@link Interface.messages} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  readonly messagesWithRefs: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.MediaInfo[], NotFoundError | MessageDecodeError>
  /** Experimental: {@link Interface.message} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  readonly messageWithRefs: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.MediaInfo | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  /** Structured diffs of the files changed by a turn or range of turns; see `SessionDiff.turn`. */
  readonly diff: (input: {
    readonly sessionID: SessionSchema.ID
    readonly from?: SessionMessage.ID
    readonly to?: SessionMessage.ID
    readonly context?: number
  }) => Effect.Effect<
    readonly FileDiff.Info[],
    NotFoundError | MessageNotFoundError | TurnRangeError | Snapshot.Error | FileSystem.DirectoryNotFoundError
  >
  /**
   * Durable admitted session work not yet visible in projected history,
   * ordered by admission. Includes unpromoted user and synthetic inputs and
   * unhandled compaction barriers.
   */
  readonly inbox: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.Info[], NotFoundError>
  /** Experimental: {@link Interface.inbox} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  readonly inboxWithRefs: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.MediaInfo[], NotFoundError>
  readonly cancelInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly steerInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly queueInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  /**
   * Durable, ordered session log read. Replays durable session bus after
   * the exclusive `after` cursor, emits a `Synced` marker at the captured
   * replay watermark, then continues live when `follow` is set.
   * The marker's seq may exceed the last emitted event because other durable
   * bus share the aggregate's sequence space.
   */
  readonly log: (input: {
    sessionID: SessionSchema.ID
    after?: number
    follow?: boolean
  }) => Stream.Stream<SessionEvent.DurableEvent | EventLog.Synced, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: Agent.ID
    model?: Model.Ref
  }) => Effect.Effect<void, NotFoundError | ModelGovernance.DeniedError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: Model.Ref
  }) => Effect.Effect<void, NotFoundError | ModelGovernance.DeniedError>
  /**
   * Pins (or, with `target: null`, clears) the session's preferred member of a model pool. The
   * session stays on the pool: the member serves while healthy, failover works as usual, and later
   * requests return to the member once it recovers. Applies from the next model request. Held in
   * memory (see `ModelRoute.pinTarget`), so a restart clears it.
   */
  readonly routeTarget: (input: {
    sessionID: SessionSchema.ID
    routeID: string
    target: Model.Ref | null
  }) => Effect.Effect<void, NotFoundError | RouteTargetError>
  readonly routeTargets: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<ReadonlyArray<{ readonly routeID: string; readonly target: Model.Ref }>, NotFoundError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly archive: (sessionID: SessionSchema.ID, input?: { time?: number }) => Effect.Effect<void, NotFoundError>
  readonly unarchive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly setMetadata: (input: {
    sessionID: SessionSchema.ID
    metadata: SessionSchema.Metadata
  }) => Effect.Effect<void, NotFoundError>
  readonly setPermissions: (input: {
    sessionID: SessionSchema.ID
    permissions: Permission.Ruleset
  }) => Effect.Effect<void, NotFoundError>
  readonly setSubagentPolicy: (input: {
    sessionID: SessionSchema.ID
    subagentPolicy: SessionSchema.SubagentPolicy
  }) => Effect.Effect<void, NotFoundError>
  readonly move: SessionMove.Interface["move"]
  readonly prompt: (
    input: Parameters<Session.Handle["prompt"]>[0] & { sessionID: SessionSchema.ID },
    /** A bounded durability step after successful admission and wake, in the same interruption mask. */
    onAccepted?: Effect.Effect<void>,
  ) => ReturnType<Session.Handle["prompt"]>
  /** Generates text from current Session context without admitting input or mutating history. Its usage counts toward the Session's totals. */
  readonly generate: (input: {
    sessionID: SessionSchema.ID
    prompt: string
  }) => Effect.Effect<SessionGenerate.Result, NotFoundError | SessionGenerate.Error>
  readonly command: (
    input: Parameters<Session.Handle["command"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["command"]>
  readonly shell: (
    input: Parameters<Session.Handle["shell"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["shell"]>
  readonly skill: (
    input: Parameters<Session.Handle["skill"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["skill"]>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<SessionInbox.Compaction, NotFoundError | CompactionConflictError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly background: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: { readonly resume?: boolean; readonly force?: boolean },
  ) => Effect.Effect<boolean>
  readonly synthetic: (
    input: Parameters<Session.Handle["synthetic"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["synthetic"]>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<
      SessionSchema.Revert,
      NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error | FileSystem.DirectoryNotFoundError
    >
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error | FileSystem.DirectoryNotFoundError>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Service
    const database = yield* Database.Service
    const db = database.db
    const bus = yield* Bus.Service
    const projects = yield* Project.Service
    const execution = yield* SessionExecution.Service
    const llm = yield* LLMClient.Service
    const transport = yield* SessionModelTransport.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const moves = yield* SessionMove.Service
    const jobs = yield* Job.Service
    const environments = yield* SessionEnvironment.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.make()
    const mediaBlob = (session: SessionSchema.Info) => SessionBlob.enabledFor(instances, session)
    const isDurableSessionEvent = (item: Bus.LogItem): item is SessionEvent.DurableEvent =>
      Object.hasOwn(SessionEvent.Durable.cases, item.type)
    // Governance inputs (config entries + provider catalog) come from the one
    // shared construction in session/governance-config.ts: GovernanceConfig.load.
    const assertModelAllowed = (input: {
      location: Location.Ref
      parent: SessionSchema.Info
      agent?: Agent.ID
      model?: Model.Ref
      override?: SessionSchema.AgentOverride
    }) =>
      GovernanceConfig.load(locations, input.location).pipe(
        Effect.flatMap(({ entries, catalog }) =>
          ModelGovernance.assertAllowed(
            { get: (sessionID) => result.get(sessionID) },
            { entries: () => Effect.succeed(entries), catalog: () => Effect.succeed(catalog) },
            { parent: input.parent, agent: input.agent, model: input.model, override: input.override },
          ),
        ),
      )

    const stopPolicyOf = (recovery: Job.Recovery): Job.StopPolicy =>
      recovery.kind === "subagent" ? (recovery.stopPolicy ?? "independent") : "independent"

    // A detached background subagent survives every plain interrupt, including a
    // direct one aimed at the child session itself: only force-stop terminates it.
    const detachedRunning = Effect.fn("Session.detachedRunning")(function* (sessionID: SessionSchema.ID) {
      const pending = yield* jobs.pendingBackground
      return pending.some(
        (marker) =>
          marker.status === "running" &&
          marker.recovery.kind === "subagent" &&
          marker.recovery.childSessionID === sessionID &&
          stopPolicyOf(marker.recovery) === "detached",
      )
    })

    const interruptOne = Effect.fn("Session.interruptOne")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return false
      const interrupted = yield* sessions.forSession(sessionID).interrupt()
      const cancelled = yield* jobs.cancel(sessionID)
      return interrupted || cancelled !== undefined
    })

    const cascadeStopDescendants = Effect.fn("Session.cascadeStop")(function* (rootID: SessionSchema.ID) {
      const pending = yield* jobs.pendingBackground
      const policyByChild = new Map<string, { policy: Job.StopPolicy; status: Job.Status }>()
      for (const marker of pending) {
        if (marker.recovery.kind !== "subagent") continue
        policyByChild.set(marker.recovery.childSessionID, {
          policy: stopPolicyOf(marker.recovery),
          status: marker.status,
        })
      }
      const visited = new Set<string>([rootID])
      const queue: SessionSchema.ID[] = [rootID]
      let stopped = false
      while (queue.length > 0) {
        const current = queue.shift() as SessionSchema.ID
        const children = yield* store.list({ parentID: current })
        for (const child of children) {
          if (visited.has(child.id)) continue
          visited.add(child.id)
          const marker = policyByChild.get(child.id)
          if (marker && marker.status === "running") {
            // Background child: only cascade policy follows a plain interrupt.
            // Independent and detached subtrees survive untouched.
            if (marker.policy !== "cascade") continue
            if (yield* interruptOne(child.id)) stopped = true
            queue.push(child.id)
            continue
          }
          // Foreground (or idle) child: tied to the parent's execution through
          // the subagent tool's interrupt handler. Interrupt explicitly so a
          // cascade also settles foreground work below a stopped background child.
          if (yield* interruptOne(child.id)) stopped = true
          queue.push(child.id)
        }
      }
      return stopped
    })

    const forceStopDescendants = Effect.fn("Session.forceStop")(function* (rootID: SessionSchema.ID) {
      const visited = new Set<string>([rootID])
      const queue: SessionSchema.ID[] = [rootID]
      let stopped = false
      while (queue.length > 0) {
        const current = queue.shift() as SessionSchema.ID
        const children = yield* store.list({ parentID: current })
        for (const child of children) {
          if (visited.has(child.id)) continue
          visited.add(child.id)
          if (yield* interruptOne(child.id)) stopped = true
          queue.push(child.id)
        }
      }
      return stopped
    })

    const result = Service.of({
      create: Effect.fn("Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        // A reused id is an idempotent retry only when every identity-defining
        // field the caller supplied matches the recorded session; a differing
        // field is a collision, not a retry (#2796). Fields the caller omitted
        // are not compared: creation may have inherited or resolved them
        // (parent metadata/permissions, governance-checked child model).
        const differsFromRecorded = (recorded: SessionSchema.Info) => {
          const location = input.location && LocationServiceMap.canonical(input.location)
          return (
            input.parentID !== recorded.parentID ||
            (location !== undefined &&
              (location.directory !== recorded.location.directory ||
                location.workspaceID !== recorded.location.workspaceID)) ||
            (input.title !== undefined && input.title !== recorded.title) ||
            (input.agent !== undefined && input.agent !== recorded.agent) ||
            (input.model !== undefined &&
              (input.model.id !== recorded.model?.id ||
                input.model.providerID !== recorded.model?.providerID ||
                input.model.variant !== recorded.model?.variant)) ||
            (input.metadata !== undefined && !Equal.equals(input.metadata, recorded.metadata)) ||
            (input.permissions !== undefined && !Equal.equals(input.permissions, recorded.permissions)) ||
            (input.subagentPolicy !== undefined && !Equal.equals(input.subagentPolicy, recorded.subagentPolicy)) ||
            (input.detached !== undefined && input.detached !== recorded.detached)
          )
        }
        const recorded = yield* store.get(sessionID)
        if (recorded) {
          if (differsFromRecorded(recorded)) return yield* new AlreadyExistsError({ sessionID })
          return recorded
        }
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        const location = parent?.location ?? (input.location && LocationServiceMap.canonical(input.location))
        if (location === undefined)
          return yield* Effect.die(new Error("Session.create requires either location or an existing parentID"))
        const project = yield* projects.resolve(location.directory)
        // Governance is enforced before anything is created: a denied child
        // fails here and no `session.created` is ever published for it.
        let storedModel = input.model
        if (parent !== undefined) {
          yield* assertModelAllowed({
            location,
            parent,
            agent: input.agent,
            model: input.model,
            override: input.subagentOverride,
          })
          // A model-less child is checked against the governance chain
          // (the child agent's configured default, then the parent's model),
          // but the runner resolves a model-less session against the global
          // default — a model governance never saw. Store the checked model
          // on the child so the checked model is the model that runs (#507).
          // switchAgent stays consistent the same way: its check receives
          // the child's now-stored model explicitly.
          if (storedModel === undefined) {
            const { entries } = yield* GovernanceConfig.load(locations, location)
            storedModel = ModelGovernance.checkedModel(entries, {
              parent,
              agent: input.agent,
              model: input.model,
              override: input.subagentOverride,
            })
          }
        }
        const projected = yield* bus
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              slug: Slug.create(),
              version: app.version,
              projectID: project.id,
              parentID: input.parentID,
              location,
              subpath: RelativePath.make(path.relative(project.directory, location.directory).replaceAll("\\", "/")),
              title: input.title,
              agent: input.agent,
              // Children inherit metadata and permissions the way they inherit
              // location, so host policies that read them treat the family uniformly.
              metadata: input.metadata ?? parent?.metadata,
              subagentPolicy: input.subagentPolicy,
              permissions: input.permissions ?? parent?.permissions,
              // A detached tree never sprouts an interactive leaf: a child cannot opt out.
              detached: input.detached ?? parent?.detached,
              model: storedModel
                ? {
                    id: Model.ID.make(storedModel.id),
                    providerID: storedModel.providerID,
                    variant: storedModel.variant,
                  }
                : undefined,
            },
            { location },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") {
          // The projection-race winner is validated with the same comparison
          // as a recorded session: a concurrent create whose supplied fields
          // differ from the winner is a collision, not a retry (#2796).
          if (differsFromRecorded(projected.session)) return yield* new AlreadyExistsError({ sessionID })
          return projected.session
        }
        if (input.parentID) {
          yield* McpxSubagent.initializeSubagentSession({
            parentSessionID: input.parentID,
            childID: sessionID,
            environments,
          }).pipe(Effect.catch(() => Effect.void))
        }
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        // A fork is a child of its source: the copied model must pass the
        // source's subtree governance before anything is published.
        yield* assertModelAllowed({ location: parent.location, parent, agent: parent.agent, model: parent.model })
        const boundary = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              input.before ? eq(SessionMessageTable.id, input.before) : undefined,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!boundary && input.before)
          return yield* new MessageNotFoundError({
            sessionID: input.sessionID,
            messageID: input.before,
          })
        if (!boundary) return yield* new ForkEmptyError({ sessionID: input.sessionID })
        const sessionID = SessionSchema.ID.create()
        const inherited = yield* db
          .transaction(() =>
            Effect.all({
              instructions: InstructionState.current(db, parent.id),
              instructionEntries: InstructionEntry.snapshot(db, parent.id),
            }),
          )
          .pipe(Effect.orDie)
        // The fork adopts the parent's newest instruction values rather than the
        // values in effect at the boundary; copied history may contain frozen
        // instruction-update text the initial baseline already reflects.
        // The parent's location, not the caller's, decides whether the copy's media is stored as blobs.
        const media = yield* mediaBlob(parent)
        yield* bus
          .publish(SessionEvent.Forked, {
            sessionID,
            parentID: parent.id,
            boundary: { type: input.before ? "before" : "through", messageID: boundary.id },
            ...inherited,
          })
          .pipe(Effect.provideService(SessionBlob.ForkMedia, media))
        const forked = yield* result.get(sessionID).pipe(Effect.orDie)
        yield* Effect.gen(function* () {
          yield* Plugin.awaitActivation
          const hooks = yield* PluginHooks.Service
          yield* hooks.trigger("session", "fork", { sessionID })
        }).pipe(
          instances.provide(forked),
          Effect.catchCause((cause) => Effect.logWarning("fork hook failed", { sessionID, cause })),
        )
        return forked
      }),
      get: (sessionID) => sessions.forSession(sessionID).get(),
      environment: Effect.fn("Session.environment")(function* (input) {
        yield* result.get(input.sessionID)
        if (input.variables !== undefined) yield* environments.set(input.sessionID, input.variables)
        return yield* environments.get(input.sessionID)
      }),
      view: (input) => sessions.forSession(input.sessionID).view(input),
      remove: Effect.fn("Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.interrupt(sessionID)
        yield* execution.awaitIdle(sessionID)
        yield* jobs.cancelSession(sessionID)
        yield* transport.close(sessionID)
        const children = yield* store.list({ parentID: sessionID })
        // Delete the parent before its children: an interrupted child settles through the report
        // path, and a report admitted just before the parent's deletion wakes an execution whose
        // lifecycle write then fails on the deleted row.
        yield* McpxSubagent.releaseSubagentSession(sessionID).pipe(Effect.catch(() => Effect.void))
        yield* environments.clear(sessionID)
        ModelRoute.forgetPins(sessionID)
        yield* bus.publish(SessionEvent.Deleted, { sessionID })
        yield* bus.remove(sessionID)
        yield* Effect.forEach(children, (child) => result.remove(child.id), { concurrency: 1, discard: true })
      }),
      list: Effect.fn("Session.list")(function* (input = {}) {
        const filter =
          input.cursor === undefined
            ? input
            : yield* ListCursor.parse(input.cursor).pipe(Effect.mapError(() => new InvalidListCursorError()))
        const data = yield* store.list({ ...filter, limit: input.limit ?? DefaultListLimit })
        const first = data[0]
        const last = data.at(-1)
        return {
          data,
          cursor: {
            previous: first
              ? ListCursor.make({
                  ...filter,
                  anchor: { id: first.id, time: DateTime.toEpochMillis(first.time.updated), direction: "previous" },
                })
              : undefined,
            next: last
              ? ListCursor.make({
                  ...filter,
                  anchor: { id: last.id, time: DateTime.toEpochMillis(last.time.updated), direction: "next" },
                })
              : undefined,
          },
        }
      }),
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* store.messages(input)
      }),
      message: (input) => sessions.forSession(input.sessionID).message(input.messageID),
      messagesWithRefs: Effect.fn("Session.messagesWithRefs")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (!(yield* mediaBlob(session))) return yield* store.messages(input)
        return yield* store.messagesWithRefs(input)
      }),
      messageWithRefs: Effect.fn("Session.messageWithRefs")(function* (input) {
        const session = yield* result.get(input.sessionID).pipe(Effect.option)
        if (Option.isNone(session)) return undefined
        if (!(yield* mediaBlob(session.value))) return yield* result.message(input)
        const stored = yield* store.messageWithRefs(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      diff: Effect.fn("Session.diff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const active = yield* execution.isActive(input.sessionID)
        return yield* SessionDiff.turn(db, locations, {
          session,
          active,
          from: input.from,
          to: input.to,
          context: input.context,
        })
      }),
      inbox: (sessionID) => sessions.forSession(sessionID).inbox(),
      inboxWithRefs: Effect.fn("Session.inboxWithRefs")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        if (!(yield* mediaBlob(session))) return yield* result.inbox(sessionID)
        return yield* SessionInbox.listWithRefs(db, sessionID)
      }),
      cancelInbox: (input) => sessions.forSession(input.sessionID).cancelInbox(input.inboxID),
      steerInbox: (input) => sessions.forSession(input.sessionID).steerInbox(input.inboxID),
      queueInbox: (input) => sessions.forSession(input.sessionID).queueInbox(input.inboxID),
      log: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(bus.log({ aggregateID: input.sessionID, after: input.after, follow: input.follow }))),
        ).pipe(
          Stream.filter(
            (item): item is SessionEvent.DurableEvent | EventLog.Synced =>
              Bus.isSynced(item) || isDurableSessionEvent(item),
          ),
        ),
      prompt: (input, onAccepted) => sessions.forSession(input.sessionID).prompt(input, onAccepted),
      generate: Effect.fn("Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionGenerate.generate({ session, prompt: input.prompt }).pipe(
          Effect.provideService(Instance.Service, instances),
          Effect.provideService(Database.Service, database),
          Effect.provideService(LLMClient.Service, llm),
          Effect.provideService(Bus.Service, bus),
        )
      }),
      command: (input) => sessions.forSession(input.sessionID).command(input),
      shell: (input) => sessions.forSession(input.sessionID).shell(input),
      skill: (input) => sessions.forSession(input.sessionID).skill(input),
      switchAgent: (input) => sessions.forSession(input.sessionID).switchAgent(input),
      switchModel: (input) => sessions.forSession(input.sessionID).switchModel(input),
      routeTarget: Effect.fn("Session.routeTarget")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (input.target === null) return ModelRoute.pinTarget(input.routeID, input.sessionID, undefined)
        const lookup = yield* SessionRouteTarget.lookup(locations, session.location, input.routeID)
        const reason = !lookup.checked
          ? undefined
          : lookup.definition === undefined
            ? "no model pool has this id"
            : ModelRoute.memberIndex(lookup.definition, input.target) === undefined
              ? `${input.target.providerID}/${input.target.id}${input.target.variant ? `#${input.target.variant}` : ""} is not a member of the pool`
              : undefined
        if (reason) return yield* new RouteTargetError({ routeID: input.routeID, reason })
        ModelRoute.pinTarget(input.routeID, input.sessionID, input.target)
      }),
      routeTargets: Effect.fn("Session.routeTargets")(function* (sessionID) {
        yield* result.get(sessionID)
        return ModelRoute.pinnedTargets(sessionID)
      }),
      rename: (input) => sessions.forSession(input.sessionID).rename(input),
      archive: (sessionID, input) => sessions.forSession(sessionID).archive(input),
      unarchive: (sessionID) => sessions.forSession(sessionID).unarchive(),
      setMetadata: (input) => sessions.forSession(input.sessionID).setMetadata(input),
      setPermissions: (input) => sessions.forSession(input.sessionID).setPermissions(input),
      setSubagentPolicy: (input) => sessions.forSession(input.sessionID).setSubagentPolicy(input),
      move: moves.move,
      compact: (input) => sessions.forSession(input.sessionID).compact(input),
      wait: (sessionID) => sessions.forSession(sessionID).wait(),
      active: execution.active,
      background: Effect.fn("Session.background")(function* (sessionID) {
        yield* result.get(sessionID)
        const backgrounded = yield* jobs.backgroundAll({ sessionID })
        if (backgrounded.length === 0) return
        yield* result
          .synthetic({
            sessionID,
            text: [
              "User requested that active blocking work be moved to the background.",
              "",
              "Backgrounded work:",
              ...backgrounded.map((job) => `- ${job.type}: ${job.title && job.title.length > 0 ? job.title : job.id}`),
              "",
              "The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.",
            ].join("\n"),
          })
          .pipe(Effect.catchTag("Session.SyntheticConflictError", Effect.die))
      }),
      resume: (sessionID) => sessions.forSession(sessionID).resume(),
      synthetic: (input) => sessions.forSession(input.sessionID).synthetic(input),
      interrupt: Effect.fn("Session.interrupt")(function* (
        sessionID: SessionSchema.ID,
        options?: { readonly resume?: boolean; readonly force?: boolean },
      ) {
        // Existence is not an error channel on interrupt (the protocol contract is
        // interrupted=false for the idle no-op): a missing session simply has no
        // execution to stop and no descendants to cascade to.
        yield* result.get(sessionID).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
        const force = options?.force === true
        // Policy is checked before anything is stopped: a detached target itself
        // survives a plain interrupt, so neither it nor its subtree is touched.
        if (!force && (yield* detachedRunning(sessionID))) return false
        const selfInterrupted = yield* sessions.forSession(sessionID).interrupt(
          options?.resume !== undefined ? { resume: options.resume } : undefined,
        )
        const childInterrupted = yield* Effect.uninterruptible(
          force ? forceStopDescendants(sessionID) : cascadeStopDescendants(sessionID),
        )
        return selfInterrupted || childInterrupted
      }),
      revert: {
        stage: (input) => sessions.forSession(input.sessionID).revert.stage(input),
        clear: (sessionID) => sessions.forSession(sessionID).revert.clear(),
        commit: (sessionID) => sessions.forSession(sessionID).revert.commit(),
      },
    })

    return result
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Job.node,
    SessionEnvironment.node,
    Database.node,
    Bus.node,
    Project.node,
    SessionExecution.node,
    SessionModelTransport.node,
    llmClient,
    SessionStore.node,
    Instance.node,
    SessionInbox.node,
    SessionMove.node,
    SessionProjector.node,
    LocationServiceMap.node,
    FSUtil.node,
    App.node,
    MessagingVars.node,
  ],
})
