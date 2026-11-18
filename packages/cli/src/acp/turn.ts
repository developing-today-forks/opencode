import type { CancelNotification, PromptRequest, PromptResponse, RequestError } from "@agentclientprotocol/sdk"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client/effect"
import type { Session } from "@opencode/schema/session"
import { TokenUsage } from "@opencode/schema/token-usage"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Option,
  Queue,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect"
import type { Capabilities } from "./capabilities"
import { findModel, type ACPCatalog } from "./catalog"
import { ACPChild } from "./child"
import { ACPClient } from "./client"
import { currentModel } from "./config-option"
import { ACPConnection } from "./connection"
import { ACPElicitation } from "./elicitation"
import { ACPError } from "./error"
import { ACPPermission } from "./permission"
import { ACPPrompt } from "./prompt"
import type { ACPSessions, Attached } from "./sessions"
import { ACPTranslate } from "./translate"

export type SteeringRequest = { readonly sessionId: string; readonly prompt: PromptRequest["prompt"] }
export type SteeringResponse =
  | { readonly outcome: "injected" }
  | { readonly outcome: "promptRequired"; readonly reason: "noRunningTurn" }

export interface Interface {
  readonly prompt: (input: PromptRequest, signal: AbortSignal) => Effect.Effect<PromptResponse, ACPError.Failure>
  /** Redirects a running turn; an idle session is left alone so a steer never starts a turn. */
  readonly steer: (input: SteeringRequest) => Effect.Effect<SteeringResponse, ACPError.Failure>
  readonly cancel: (input: CancelNotification) => Effect.Effect<void>
  /** Unlike `cancel`, interrupts an idle session too, since server work can outlive its turn. */
  readonly close: (sessionID: string) => Effect.Effect<void, ACPError.Error | RequestError>
  /**
   * Follows a session attached with its history before any prompt: once the attach response is out, asks already
   * pending in its tree reach the client, and later ones keep coming until its next prompt or detach.
   */
  readonly follow: (attached: Attached) => Effect.Effect<void>
}

/** Core acknowledges an interrupt before its cleanup settles, and its shell tool waits 3s before SIGKILL. */
export const CancelDrainTimeout = Context.Reference<Duration.Input>("@opencode/cli/acp/Turn/CancelDrainTimeout", {
  defaultValue: () => "5 seconds",
})

// Deeper than any subagent nesting, so only a broken parent chain reaches it.
const LineageLimit = 64

// The reads asks depend on get a short retry: a blip in the private server must not drop an ask whose creation event
// cannot be seen again.
const AskReadRetry = { times: 2, schedule: Schedule.exponential("100 millis") }

// A scan that still leaves asks unplaced is repeated in the background: 0.5s, 1s, 2s and so on, six times.
const RescanDelay = 500
const RescanAttempts = 6

type Ancestor = { readonly id: string; readonly parentID: string; readonly title?: string }

type Subscription = {
  readonly scope: Scope.Closeable
  readonly events: Queue.Dequeue<OpenCodeEvent, unknown>
  readonly askQueue: Queue.Queue<Effect.Effect<void, ACPError.Error | RequestError>>
  readonly settled: Map<string, Deferred.Deferred<void>>
  /** Sessions whose parent chain leads away from the tree. Lineage never changes, so the answer is kept. */
  readonly outside: Set<string>
  /** Whether the last scan of pending asks read both lists and placed every listed ask's session. */
  readonly placed: Ref.Ref<boolean>
}

type Turn = {
  readonly ctx: ACPTranslate.TurnContext
  readonly state: Ref.Ref<ACPTranslate.TurnState>
  readonly subscription: Subscription
  readonly cancelled: Deferred.Deferred<void>
<<<<<<< HEAD
  readonly background: boolean
  /** The attached session's record of tool calls the client received. */
  readonly sent: Set<string>
=======
}

type Background = {
  readonly state: Ref.Ref<ACPTranslate.TurnState>
  readonly fiber?: Fiber.Fiber<unknown, unknown>
>>>>>>> upstream-anomalyco/dev
}

export const make = Effect.fnUntraced(function* (input: {
  readonly client: OpenCodeClient
  readonly connection: ACPConnection.Interface
  readonly sessions: ACPSessions.Interface
  readonly catalog: ACPCatalog.Interface
  readonly capabilities: Ref.Ref<Capabilities>
}) {
  const scope = yield* Effect.scope
  const drainTimeout = yield* CancelDrainTimeout
  const turns = yield* FiberMap.make<string, PromptResponse, ACPError.Failure>()
<<<<<<< HEAD
  /** The fiber following each session between its prompts; the next prompt stops it. */
  const followers = new Map<string, Fiber.Fiber<void>>()

  const open = Effect.fnUntraced(function* (
    ctx: ACPTranslate.TurnContext,
    state: Ref.Ref<ACPTranslate.TurnState>,
    sent: Set<string>,
  ) {
=======
  const backgrounds = new WeakMap<Attached, Background>()

  const open = Effect.fnUntraced(function* (
    attached: Attached,
    ctx: ACPTranslate.TurnContext,
    state: Ref.Ref<ACPTranslate.TurnState>,
  ) {
    const previous = backgrounds.get(attached)
    if (previous) {
      backgrounds.delete(attached)
      if (previous.fiber) yield* Fiber.interrupt(previous.fiber)
      const inherited = yield* Ref.get(previous.state)
      yield* Ref.set(state, {
        ...ACPTranslate.initial,
        children: inherited.children,
        openChildren: inherited.openChildren,
      })
    }
>>>>>>> upstream-anomalyco/dev
    // Parented to the service scope; the session scope may already be closed.
    const subscriptionScope = yield* Scope.fork(scope)
    const subscription: Subscription = {
      scope: subscriptionScope,
      events: yield* input.client.event
        .subscribe()
        .pipe(Stream.toQueue({ capacity: "unbounded" }), Scope.provide(subscriptionScope)),
      askQueue: yield* Queue.unbounded<Effect.Effect<void, ACPError.Error | RequestError>>(),
      settled: new Map(),
      outside: new Set(),
      placed: yield* Ref.make(true),
    }
    yield* Queue.take(subscription.askQueue).pipe(
      Effect.flatten,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("ACP ask reply failed", cause),
      ),
      Effect.forever,
      Effect.forkIn(subscriptionScope),
    )
<<<<<<< HEAD
    return { ctx, state, subscription, cancelled: yield* Deferred.make<void>(), background: false, sent } satisfies Turn
=======
    return { ctx, state, subscription, cancelled: yield* Deferred.make<void>() } satisfies Turn
>>>>>>> upstream-anomalyco/dev
  })

  const take = (subscription: Subscription) =>
    Queue.take(subscription.events).pipe(
      Effect.catch((error) =>
        Cause.isDone(error) ? Effect.fail(new ACPError.ServerUnavailableError()) : ACPClient.classify(error),
      ),
    )

  // The feed opens with `server.connected`, so every event after it is one the subscription can see.
  const connected = Effect.fnUntraced(function* (subscription: Subscription) {
    const event = yield* take(subscription)
    if (event.type !== "server.connected")
      return yield* Effect.die(new Error(`expected server.connected, got ${event.type}`))
  })

  const markOutside = (turn: Turn, sessionID: string, below: ReadonlyArray<Ancestor>) => {
    turn.subscription.outside.add(sessionID)
    below.forEach((session) => turn.subscription.outside.add(session.id))
    return []
  }

  // Walks parentID up from a session the subscription never saw created, until it reaches the prompt's session or
  // one tracked below it. `below` holds the sessions passed on the way, nearest the known ancestor first.
  const lineage = (
    turn: Turn,
    sessionID: Session.ID,
    below: ReadonlyArray<Ancestor>,
  ): Effect.Effect<ReadonlyArray<ACPChild.Session>> =>
    Effect.gen(function* () {
      const depth = sessionID === turn.ctx.sessionID ? 0 : (yield* Ref.get(turn.state)).children.get(sessionID)?.depth
      if (depth !== undefined) return below.map((session, index) => ({ ...session, depth: depth + index + 1 }))
      if (
        turn.subscription.outside.has(sessionID) ||
        below.length >= LineageLimit ||
        below.some((session) => session.id === sessionID)
      )
        return markOutside(turn, sessionID, below)
      const info = yield* input.client.session.get({ sessionID }).pipe(
        Effect.retry({ ...AskReadRetry, while: (error) => error._tag !== "SessionNotFoundError" }),
        Effect.catchTag("SessionNotFoundError", () =>
          Effect.succeed({ id: sessionID, parentID: undefined, title: "" }),
        ),
        // Unknown for now rather than outside: the session's next event, or the next prompt's pending list, looks
        // again.
        Effect.catch((error) =>
          Effect.logWarning("ACP could not look up a session's parent", error).pipe(Effect.as(undefined)),
        ),
      )
      if (!info) return []
      if (!info.parentID) return markOutside(turn, sessionID, below)
      return yield* lineage(turn, info.parentID, [
        { id: info.id, parentID: info.parentID, ...(info.title ? { title: info.title } : {}) },
        ...below,
      ])
    })

  // A descendant created before this subscription, such as a child continued from an earlier prompt or one woken
  // later, is adopted when it first appears.
  const adopt = Effect.fnUntraced(function* (turn: Turn, sessionID: string | undefined) {
    if (!sessionID || sessionID === turn.ctx.sessionID || turn.subscription.outside.has(sessionID)) return
    if ((yield* Ref.get(turn.state)).children.has(sessionID)) return
    const decoded = yield* ACPClient.decodeSessionID(sessionID).pipe(Effect.option)
    if (Option.isNone(decoded)) {
      turn.subscription.outside.add(sessionID)
      return
    }
    const found = yield* lineage(turn, decoded.value, [])
    if (found.length > 0) yield* Ref.update(turn.state, (state) => ACPTranslate.adopt(state, found))
  })

  // Asks raised while nothing followed the session, or before this process attached it, are still pending. Asked
  // before events are read; one listed here and also seen as an event is asked once.
  const askPending = Effect.fnUntraced(function* (turn: Turn) {
    const location = { directory: turn.ctx.cwd }
    // Each list is retried and falls back on its own, so one that fails does not hide what the other found. A list
    // that still fails reads as undefined, which leaves the scan unplaced.
    const unlisted = (name: string) => (error: unknown) =>
      Effect.logWarning(`ACP could not list pending ${name}`, error).pipe(Effect.as(undefined))
    const [permissions, forms] = yield* Effect.all(
      [
        input.client.permission.request.list({ location }).pipe(
          Effect.map((listed) => listed.data),
          Effect.retry(AskReadRetry),
          Effect.catch(unlisted("permission requests")),
        ),
        input.client.form.list({ location }).pipe(
          Effect.map((listed) => listed.data),
          Effect.retry(AskReadRetry),
          Effect.catch(unlisted("questions")),
        ),
      ],
      { concurrency: "unbounded" },
    )
    const listed = { permissions: permissions ?? [], forms: forms ?? [] }
    const sessions = [
      ...listed.permissions.map((request) => request.sessionID),
      ...listed.forms.map((form) => form.sessionID),
    ]
    yield* Effect.forEach(sessions, (sessionID) => adopt(turn, sessionID), { discard: true })
    yield* apply(turn, (current) => ACPTranslate.pending(current, turn.ctx, listed))
    const children = (yield* Ref.get(turn.state)).children
    yield* Ref.set(
      turn.subscription.placed,
      permissions !== undefined &&
        forms !== undefined &&
        sessions.every((id) => id === turn.ctx.sessionID || children.has(id) || turn.subscription.outside.has(id)),
    )
  })

  // A list or parent lookup that still fails after its retries leaves asks unseen. Scan again with backoff until
  // everything listed is placed, so a session blocked on one of them does not wait unseen until the next prompt.
  const rescan = (turn: Turn, delay: number, attempts: number): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (attempts === 0 || (yield* Ref.get(turn.subscription.placed))) return
      yield* Effect.sleep(Duration.millis(delay))
      yield* askPending(turn)
      yield* rescan(turn, delay * 2, attempts - 1)
    })

  const asksSettled = Effect.fnUntraced(function* (subscription: Subscription) {
    const settled = yield* Deferred.make<void>()
    yield* Queue.offer(subscription.askQueue, Deferred.succeed(settled, undefined).pipe(Effect.asVoid))
    yield* Deferred.await(settled)
  })

  const queueAsk = <A>(
    turn: Turn,
    id: string,
    ask: Effect.Effect<A, unknown>,
    fallback: A,
    respond: (outcome: A) => Effect.Effect<void, ACPError.Error | RequestError>,
  ) =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>()
      turn.subscription.settled.set(id, settled)
      yield* Queue.offer(
        turn.subscription.askQueue,
        Effect.uninterruptibleMask((restore) =>
          // The race starts racers in order and stops once one is done, so an earlier cancel never starts the ask.
          restore(
            Deferred.await(turn.cancelled).pipe(
              Effect.as(fallback),
              Effect.raceFirst(Deferred.await(settled).pipe(Effect.as("settled" as const))),
              Effect.raceFirst(ask),
            ),
          ).pipe(
            Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("ACP ask failed", cause)),
            // An interrupted ask leaves the request pending: the follower stopped for the next prompt, which asks it
            // again, or the session detached. A cancelled prompt answers through `turn.cancelled` instead.
            Effect.catchCause((cause) =>
              Effect.succeed(Cause.hasInterruptsOnly(cause) ? ("settled" as const) : fallback),
            ),
            Effect.flatMap((outcome) => (outcome === "settled" ? Effect.void : respond(outcome))),
          ),
        ).pipe(Effect.withSpan("cli.acp.turn.ask")),
      )
    })

  const interpret = (turn: Turn, output: ACPTranslate.Output) => {
    switch (output._tag) {
      case "SessionUpdate":
        return ACPPermission.withCompletedDiffs(output.update, output.diff, turn.ctx.cwd).pipe(
          Effect.flatMap((update) => input.connection.sessionUpdate({ sessionId: turn.ctx.sessionID, update })),
          Effect.tap(() =>
            Effect.sync(() => {
              if (output.update.sessionUpdate === "tool_call") turn.sent.add(output.update.toolCallId)
            }),
          ),
        )
      case "ChildUpdate":
        return Effect.gen(function* () {
          if (output.update.type !== "update")
            return yield* input.connection.extNotification(ACPChild.UpdateMethod, output.update)
          const update = yield* ACPPermission.withCompletedDiffs(output.update.update, output.diff, turn.ctx.cwd)
          yield* input.connection.extNotification(ACPChild.UpdateMethod, { ...output.update, update })
          if (update.sessionUpdate === "tool_call") turn.sent.add(update.toolCallId)
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("ACP child session update failed", cause),
          ),
        )
      case "PermissionAsk": {
        // Only a tool call the client received can be named: the tracked one, or the one a listed ask came from.
        const toolCall = [output.tool?.id, output.request.source?.id].find(
          (id) => id !== undefined && turn.sent.has(ACPChild.toolCallID(output.child, id)),
        )
        const permission = {
          client: input.client,
          connection: input.connection,
          request: output.request,
          clientSessionID: turn.ctx.sessionID,
          cwd: turn.ctx.cwd,
          tool: output.tool,
          toolCall,
          child: output.child,
        }
        return queueAsk(turn, output.request.id, ACPPermission.ask(permission), "reject", (decision) =>
          ACPPermission.respond(permission, decision),
        )
      }
      case "FormAsk":
        return Effect.gen(function* () {
          const capabilities = yield* Ref.get(input.capabilities)
          const requestedSchema = ACPElicitation.requestedSchema(output.form, capabilities)
          if (!requestedSchema) return yield* ACPElicitation.cancelUnshown(input.client, output.form)
          const source = ACPElicitation.sourceToolCall(output.form)
          const elicitation = {
            client: input.client,
            connection: input.connection,
            form: output.form,
            requestedSchema,
            clientSessionID: turn.ctx.sessionID,
            child: output.child,
<<<<<<< HEAD
            // Only a tool call the client received as `session/update` can be named; a child's tool calls reach a
            // client with child updates through the extension instead.
            toolCallSent:
              source !== undefined &&
              (!output.child || !turn.ctx.childUpdates) &&
              turn.sent.has(ACPChild.toolCallID(output.child, source)),
=======
            toolCallSent: !output.child || ACPTranslate.projectChild(turn.ctx, output.child),
>>>>>>> upstream-anomalyco/dev
          }
          yield* queueAsk(turn, output.form.id, ACPElicitation.ask(elicitation), "cancel", (outcome) =>
            ACPElicitation.respond(elicitation, outcome),
          )
        })
      case "AskSettled":
        return Effect.suspend(() => {
          const settled = turn.subscription.settled.get(output.id)
          turn.subscription.settled.delete(output.id)
          return settled ? Deferred.succeed(settled, undefined) : Effect.void
        })
    }
  }

  const advance = Effect.fnUntraced(function* (turn: Turn) {
    const event = yield* take(turn.subscription)
<<<<<<< HEAD
    yield* adopt(turn, ACPTranslate.placedBy(event))
    return yield* apply(turn, (current) =>
      turn.background && !ACPTranslate.inTree(current, event, turn.ctx)
        ? { state: current, outputs: [] }
        : ACPTranslate.fold(current, event, turn.ctx),
    )
  })

  // Recording asks in the state and queuing them is one step. An interruption between the two, such as a prompt ending
  // mid-rescan, would leave an ask recorded as asked that never reaches the client, and the follower copies that state.
  // Updates go out afterwards, still interruptible, since a slow client can hold a write.
  const apply = Effect.fnUntraced(function* (turn: Turn, fold: (state: ACPTranslate.TurnState) => ACPTranslate.Folded) {
    const folded = yield* Effect.uninterruptible(
      Ref.modify(turn.state, (current) => {
        const next = fold(current)
        return [next, next.state]
      }).pipe(
        Effect.tap((next) =>
          Effect.forEach(next.outputs.filter(isAsk), (output) => interpret(turn, output), { discard: true }),
        ),
      ),
    )
    yield* Effect.forEach(
      folded.outputs.filter((output) => !isAsk(output)),
      (output) => interpret(turn, output),
      { discard: true },
    )
=======
    const folded = yield* Ref.modify(turn.state, (current) => {
      const next = ACPTranslate.fold(current, event, turn.ctx)
      return [next, next.state]
    })
    yield* Effect.forEach(folded.outputs, (output) => interpret(turn, output), { discard: true })
>>>>>>> upstream-anomalyco/dev
    return folded
  })

  const consume = Effect.fnUntraced(function* (turn: Turn) {
    while (true) {
      const folded = yield* advance(turn)
      if (folded.terminal) {
        yield* asksSettled(turn.subscription)
        return folded.terminal
      }
    }
  })

<<<<<<< HEAD
  // Between prompts, asks keep coming: from children still running, from descendants woken later, and from the
  // session itself when a background child's result wakes it. Following runs until the session's next prompt stops
  // it or the session detaches.
  const follow = Effect.fnUntraced(function* (attached: Attached, turn: Turn, ready: Effect.Effect<void, unknown>) {
    const close = Scope.close(turn.subscription.scope, Exit.void)
    // A stale attach (an overlapping load of the same session) must not stop the newer attachment's follower.
    const current = yield* input.sessions.require(attached.id).pipe(Effect.option)
    if (Option.getOrUndefined(current) !== attached) return yield* close
    yield* stopFollowing(attached.id)
    const fiber = yield* input.sessions
      .fork(
        attached,
        ready.pipe(
          Effect.andThen(rescan(turn, RescanDelay, RescanAttempts).pipe(Effect.ignore, Effect.forkChild)),
          Effect.andThen(Effect.forever(advance(turn))),
          Effect.ignore,
          Effect.ensuring(close),
          Effect.withSpan("cli.acp.turn.follow"),
        ),
      )
      .pipe(Effect.catchTag("ACPSessionNotFoundError", () => close.pipe(Effect.as(undefined))))
    if (!fiber) return
    followers.set(attached.id, fiber)
    fiber.addObserver(() => {
      if (followers.get(attached.id) === fiber) followers.delete(attached.id)
    })
  })

  // Asks the follower still has open are cancelled on the client; the prompt asks them again, since they are pending.
  const stopFollowing = Effect.fnUntraced(function* (sessionID: string) {
    const fiber = followers.get(sessionID)
    if (!fiber) return
    followers.delete(sessionID)
    yield* Fiber.interrupt(fiber)
=======
  const followChildren = Effect.fnUntraced(function* (turn: Turn) {
    while (true) {
      const folded = yield* advance(turn)
      if (folded.terminal && folded.state.openChildren.size === 0) return yield* asksSettled(turn.subscription)
    }
>>>>>>> upstream-anomalyco/dev
  })

  const submitSynthetic = Effect.fnUntraced(function* (attached: Attached, prompt: ACPPrompt.Prepared) {
    const sessionID = attached.id
    if (prompt.synthetic.length > 0) {
      yield* input.client.session
        .synthetic({
          sessionID,
          text: prompt.synthetic.join("\n\n"),
          description: "ACP embedded context",
          delivery: "steer",
          resume: false,
        })
        .pipe(Effect.catch(ACPClient.classify))
    }
  })

  const submit = Effect.fnUntraced(function* (attached: Attached, prompt: ACPPrompt.Prepared) {
    const sessionID = attached.id
    yield* submitSynthetic(attached, prompt)
    if (prompt.start.type === "compaction") {
      yield* input.client.session.compact({ sessionID, id: prompt.start.id }).pipe(Effect.catch(ACPClient.classify))
      return
    }
    const command = prompt.command
    if (command) {
      yield* input.client.session
        .command({
          sessionID,
          name: command.name,
          text: prompt.slash?.args ?? "",
          files: prompt.files,
          delivery: "steer",
        })
        .pipe(Effect.catch(ACPClient.classify))
      return
    }
    yield* input.client.session
      .prompt({ sessionID, id: prompt.start.id, text: prompt.text, files: prompt.files, delivery: "steer" })
      .pipe(Effect.catch(ACPClient.classify))
  })

  const windDown = Effect.fnUntraced(function* (
    turn: Turn,
    events: Fiber.Fiber<ACPTranslate.Terminal, ACPError.Failure>,
  ) {
    yield* Deferred.succeed(turn.cancelled, undefined)
    yield* input.client.session
      .interrupt({ sessionID: turn.ctx.sessionID })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("ACP server interrupt failed", cause),
        ),
      )
    if (!(yield* Ref.get(turn.state)).started) return
    if (Option.exists(yield* Fiber.await(events).pipe(Effect.timeoutOption(drainTimeout)), Exit.isSuccess)) return
    yield* Fiber.interrupt(events)
    const abandoned = ACPTranslate.abandon(yield* Ref.get(turn.state), turn.ctx)
    yield* Ref.set(turn.state, abandoned.state)
    yield* Effect.forEach(abandoned.outputs, (output) => interpret(turn, output), { discard: true }).pipe(Effect.ignore)
  })

  const execute = (attached: Attached, prompt: ACPPrompt.Prepared, turn: Turn) =>
    Effect.gen(function* () {
      yield* connected(turn.subscription)
      yield* askPending(turn)
      // Ends with the prompt; the follower that takes over rescans from where it stopped.
      yield* rescan(turn, RescanDelay, RescanAttempts).pipe(Effect.ignore, Effect.forkScoped)
      const events = yield* consume(turn).pipe(Effect.forkScoped)
      return yield* Effect.gen(function* () {
        yield* submit(attached, prompt)
        if (prompt.command) return "succeeded" as const
        return yield* Fiber.join(events)
      }).pipe(Effect.onInterrupt(() => windDown(turn, events)))
    }).pipe(Effect.scoped)

  const handoff = Effect.fnUntraced(function* (
    attached: Attached,
    turn: Turn,
    exit: Exit.Exit<ACPTranslate.Terminal, ACPError.Failure>,
  ) {
<<<<<<< HEAD
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      return yield* Scope.close(turn.subscription.scope, Exit.void)
    // A load or resume during the prompt replaced the attachment and left following to this handoff, so follow the
    // current one. The client received this prompt's tool calls in the same connection.
    const current = Option.getOrUndefined(yield* input.sessions.require(attached.id).pipe(Effect.option))
    if (!current) return yield* Scope.close(turn.subscription.scope, Exit.void)
    turn.sent.forEach((id) => current.sent.add(id))
    // A cancelled prompt hands over too: its children outlive it, so their asks still reach the client.
    yield* follow(
      current,
      {
        ...turn,
        state: yield* Ref.make(yield* Ref.get(turn.state)),
        cancelled: yield* Deferred.make<void>(),
        background: true,
        sent: current.sent,
      },
      Effect.void,
    )
=======
    const close = Scope.close(turn.subscription.scope, Exit.void)
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) return yield* close
    const state = yield* Ref.get(turn.state)
    if (state.openChildren.size === 0) {
      if (state.children.size > 0) backgrounds.set(attached, { state: turn.state })
      return yield* close
    }
    const responded = yield* ACPConnection.Responded
    const nextState = yield* Ref.make({ ...state, started: false })
    const cancelled = yield* Deferred.make<void>()
    // Children outlive a cancelled turn, so their asks and report-triggered turns still reach the client.
    const background = Effect.withFiber((fiber) => {
      backgrounds.set(attached, { state: nextState, fiber })
      return Effect.exit(responded).pipe(
        Effect.andThen(
          followChildren({ ...turn, ctx: { ...turn.ctx, start: undefined }, state: nextState, cancelled }),
        ),
        Effect.interruptible,
      )
    }).pipe(Effect.ignore, Effect.ensuring(close), Effect.withSpan("cli.acp.turn.background"))
    yield* input.sessions.fork(attached, background).pipe(Effect.catchTag("ACPSessionNotFoundError", () => close))
>>>>>>> upstream-anomalyco/dev
  })

  const settle = Effect.fnUntraced(function* (
    attached: Attached,
    current: ACPTranslate.TurnState,
    exit: Exit.Exit<ACPTranslate.Terminal, ACPError.Failure>,
  ) {
    if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)
    const terminal = Exit.isSuccess(exit) ? exit.value : "interrupted"
    const failure = terminal === "interrupted" ? undefined : ACPTranslate.failure(current)
    if (failure) return yield* failure
    yield* sendUsageUpdate(attached, current)
    const cancelledWhileSettling = Exit.isFailure(yield* Effect.exit(Effect.interruptible(Effect.void)))
    return ACPTranslate.response(current, attached.id, cancelledWhileSettling ? "interrupted" : terminal)
  })

  const sendUsageUpdate = Effect.fn("cli.acp.turn.usage")(
    function* (attached: Attached, state: ACPTranslate.TurnState) {
      const used = state.usage ? TokenUsage.total(state.usage.last) : 0
      if (!used) return
      const catalog = yield* input.catalog.get(attached.cwd)
      const model = findModel(catalog.models, currentModel(catalog, yield* Ref.get(attached.selection)))
      if (!model?.limit.context) return
      const info = yield* input.client.session.get({ sessionID: attached.id }).pipe(Effect.catch(ACPClient.classify))
      yield* input.connection.sessionUpdate({
        sessionId: attached.id,
        update: {
          sessionUpdate: "usage_update",
          used,
          size: model.limit.context,
          cost: { amount: info.cost, currency: "USD" },
        },
      })
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("ACP usage update failed", cause),
    ),
  )

  // Forked uninterruptible: interruption lands only in `execute` and the last check in `settle`, so a response follows.
  const run = Effect.fn("cli.acp.turn.run")(function* (params: PromptRequest) {
    const attached = yield* input.sessions.require(params.sessionId)
    const prompt = yield* ACPPrompt.prepare(yield* input.catalog.get(attached.cwd), params.prompt)
    const capabilities = yield* Ref.get(input.capabilities)
    const state = yield* Ref.make(ACPTranslate.initial)
    yield* stopFollowing(attached.id)
    const exit = yield* Effect.acquireUseRelease(
      open(
        attached,
        {
          sessionID: attached.id,
          cwd: attached.cwd,
          start: prompt.start,
          childUpdates: capabilities.childSessionUpdates,
          compaction: capabilities.compaction,
        },
        state,
        attached.sent,
      ),
      (turn) => execute(attached, prompt, turn),
      (turn, exit) => handoff(attached, turn, exit),
    ).pipe(Effect.interruptible, Effect.exit)
    return yield* settle(attached, yield* Ref.get(state), exit)
  })

  return {
    prompt: Effect.fnUntraced(function* (params, signal) {
      // Synchronous and before setup, so concurrent prompts cannot both register and an early cancel still applies.
      const turn = yield* Effect.withFiber((fiber) => {
        if (FiberMap.hasUnsafe(turns, params.sessionId)) {
          return Effect.fail(
            new ACPError.ServiceFailureError({
              safeMessage: `Session already has an active ACP prompt: ${params.sessionId}`,
              service: "session",
            }),
          )
        }
        const forked = Effect.runForkWith(fiber.context)(run(params), { uninterruptible: true })
        FiberMap.setUnsafe(turns, params.sessionId, forked)
        return Effect.succeed(forked)
      })
      // A `$/cancel_request` for this prompt cancels its turn like `session/cancel`, rather than failing the request.
      yield* aborted(signal).pipe(Effect.andThen(Fiber.interrupt(turn)), Effect.forkChild)
      return yield* Fiber.join(turn)
    }),
    steer: Effect.fn("cli.acp.turn.steer")(function* (params) {
      const attached = yield* input.sessions.require(params.sessionId)
      const active = yield* input.client.session.active().pipe(Effect.catch(ACPClient.classify))
      if (!(attached.id in active)) return { outcome: "promptRequired", reason: "noRunningTurn" } as const
      const prompt = yield* ACPPrompt.prepare(yield* input.catalog.get(attached.cwd), params.prompt)
      yield* submitSynthetic(attached, prompt)
      // Without resume, a session that went idle after the check keeps the steer queued instead of starting a turn.
      yield* input.client.session
        .prompt({
          sessionID: attached.id,
          id: prompt.start.id,
          text: prompt.text,
          files: prompt.files,
          delivery: "steer",
          resume: false,
        })
        .pipe(Effect.catch(ACPClient.classify))
      return { outcome: "injected" } as const
    }),
    cancel: Effect.fnUntraced(function* (params) {
      yield* FiberMap.remove(turns, params.sessionId)
    }),
    close: Effect.fn("cli.acp.turn.close")(function* (sessionID) {
      if (FiberMap.hasUnsafe(turns, sessionID)) return yield* FiberMap.remove(turns, sessionID)
      yield* ACPClient.decodeSessionID(sessionID).pipe(
        Effect.flatMap((id) => input.client.session.interrupt({ sessionID: id })),
        Effect.catchTag(["ACPInvalidRequestError", "SessionNotFoundError"], () => Effect.void),
        Effect.catch(ACPClient.classify),
      )
    }),
    follow: Effect.fn("cli.acp.turn.followAttached")(function* (attached) {
      if (FiberMap.hasUnsafe(turns, attached.id)) return
      const responded = yield* ACPConnection.Responded
      const capabilities = yield* Ref.get(input.capabilities)
      // No prompt to wait for: the session's own events count from the start.
      const turn = yield* open(
        {
          sessionID: attached.id,
          cwd: attached.cwd,
          childUpdates: capabilities.childSessionUpdates,
          compaction: capabilities.compaction,
        },
        yield* Ref.make({ ...ACPTranslate.initial, started: true }),
        attached.sent,
      )
      // Asks wait for the attach response, so the client knows the session they name and has any replayed history.
      yield* follow(
        attached,
        { ...turn, background: true },
        responded.pipe(Effect.andThen(connected(turn.subscription)), Effect.andThen(askPending(turn))),
      )
    }),
  } satisfies Interface
})

function isAsk(output: ACPTranslate.Output) {
  return output._tag === "PermissionAsk" || output._tag === "FormAsk" || output._tag === "AskSettled"
}

function aborted(signal: AbortSignal) {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    const abort = () => resume(Effect.void)
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
}

export * as ACPTurn from "./turn"
