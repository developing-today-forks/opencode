export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode/ai/effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Duration, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { FileAccess } from "../../file-access.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionBackground } from "../background.js"
import { Job } from "../../job.js"
import { SessionHistory } from "../history.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { SessionRunnerRenderWiring } from "./render-wiring.js"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { ModelPlan } from "../../model-plan.js"
import { PersistentPty } from "../../persistent-pty/index.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

/**
 * The built-in tools that change files through FileMutation/FileWrite
 * (`write`, `edit`, `patch` in tool/plugin). A call one of them left `running`
 * when its process died may already have applied its change: the mutation
 * result is only recorded when the call settles, so history cannot prove the
 * file state. Resume therefore settles such a call with the dedicated
 * `tool.interrupted` outcome instead of the generic abort — it warns that the
 * change may already be in effect and must be checked before the call is
 * repeated, and the call is never re-executed automatically. A call still
 * `streaming` never started executing, so it cannot have changed anything and
 * keeps the generic outcome.
 */
const FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "patch"])

const interruptedMutationError = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status !== "running" || !FILE_MUTATION_TOOLS.has(tool.name)) return undefined
  const filePath = tool.state.input.filePath
  return {
    type: "tool.interrupted",
    message:
      typeof filePath === "string"
        ? `File mutation interrupted, the server was restarted: ${tool.name} (${filePath}). The change may already have been applied to the file; check its current contents before repeating this call.`
        : `File mutation interrupted, the server was restarted: ${tool.name}. The changes may already have been applied; check the current state of the affected files before repeating this call.`,
  }
}

/** How a step ended: whether the turn needs another step, and the link that step's response continues. */
type StepResult = { readonly needsContinuation: boolean; readonly continuation?: SessionStep.ContinuationLink }

type DrainInput = Parameters<Interface["drain"]>[0]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const jobs = yield* Job.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    const pty = yield* PersistentPty.Service
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    // Each drain is one turn and starts its own trace, whatever fiber woke it.
    const drain = Effect.fn("SessionRunner.drain", { root: true })(function* (input: DrainInput) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      // A step that hit the output token limit with tools left to run ends and continues in the next step; the
      // response's root and chunk index carry over until new input is promoted, including across a Location handoff.
      let stepContinuation: SessionStep.ContinuationLink | undefined = input.continuation?.link
      let entering = true
      let stepped = input.stepped ?? false
      const promotable = input.promotable ?? "input"
      if (!force && !continuing && !stepped) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({
                  force,
                  continuation: continuing
                    ? { step, ...(stepContinuation ? { link: stepContinuation } : {}) }
                    : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({
                  continuation: continuing
                    ? { step, ...(stepContinuation ? { link: stepContinuation } : {}) }
                    : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    yield* plugins.awaitActivation
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session, {
                      kind: "compaction",
                      agent: selected.agent.id,
                    })
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                // Control-only drains such as a manual compaction never ran the model, so they skip the hook.
                if (pending || !stepped) return DrainResult.Complete()
                // The Session would go idle; a plugin may admit input to keep this execution working.
                yield* restore(
                  SessionBackground.outstanding(jobs, store, sessionID).pipe(
                    Effect.flatMap((background) =>
                      hooks.trigger("session", "experimental.idle", { sessionID, background }),
                    ),
                  ),
                )
                if (!(yield* SessionInbox.has(db, sessionID, "input"))) return DrainResult.Complete()
                continue
              }
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected), promoted }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        // Promoted input starts a new response; only a tool-driven step continuation keeps the link.
        if (next.promoted > 0) stepContinuation = undefined
        const completed = yield* runStep(next.context, step, input.interruption, stepContinuation)
        continuing = completed.needsContinuation
        stepContinuation = completed.continuation
        stepped = true
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      // Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
      yield* plugins.awaitActivation
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      interruption: DrainInput["interruption"],
      continuation?: SessionStep.ContinuationLink,
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      // Set once this step's response has been continued after an output token limit. Every later chunk names the
      // attempt that started the response, so a turn's tokens and cost can be read as one figure. A step that
      // continues a previous step's truncated response starts from that link.
      let continuationOf: SessionMessage.ID | undefined = continuation?.of
      let continuationIndex = continuation?.index ?? 0
      // The step's retry bound is the route's own per-target attempt budget when
      // the model resolved through a route (code#9549): the route's `attempts`
      // counts the first attempt, the retry policy counts retries after it, and
      // the policy's own constants cap whatever a route states.
      const retry = yield* SessionRunnerRetry.make(bus, sessionID, {
        maxRetries:
          first.model.routing?.attempts === undefined ? undefined : Math.max(0, first.model.routing.attempts - 1),
      })
      let initial: SessionContext.Loaded | undefined = first
      // Tier chooser (#2384 slice 2): a step that resolved without a route
      // under a hosted session asks the user before provider spend. The
      // directive goes in as a synthetic message and the context reloads
      // below, so this step's own request already carries it. The wiring
      // latches per session and stays inert without the render tool, a
      // bare route, or tiered models in the plan store; a store that
      // cannot be read must not break the step either.
      const chooserDirective = (() => {
        try {
          return SessionRunnerRenderWiring.chooserDirective({
            sessionID,
            toolNames: first.tools.definitions.map((tool) => tool.name),
            routeBare: first.model.routing === undefined,
          })
        } catch {
          return undefined
        }
      })()
      if (chooserDirective !== undefined) {
        yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: chooserDirective })
        initial = undefined
      }
      // Render answers (#2384, PR #2452 review F2/F3): a tier choice or
      // a quota-fallback answer recorded by the previous step's render
      // tap takes effect before this step's request is prepared. A
      // model choice (or a quota switch, resolved through the plan
      // store) is published as ModelSelected — the same event the
      // session service's switchModel publishes, with the previous
      // model — and the context reloads so this step resolves the new
      // model. A quota wait sleeps until the wall's reset. A pending
      // application that cannot be applied must not break the step.
      const pendingRender = (() => {
        try {
          return SessionRunnerRenderWiring.takePendingApplication(sessionID)
        } catch {
          return undefined
        }
      })()
      if (pendingRender !== undefined) {
        const renderModelKey =
          pendingRender.modelChoice?.model ??
          (pendingRender.instruction?.kind === "switch"
            ? (() => {
                try {
                  return SessionRunnerRenderWiring.modelForProviderTier(
                    ModelPlan.readStore(),
                    pendingRender.instruction.providerID,
                    pendingRender.instruction.tier,
                  )
                } catch {
                  return undefined
                }
              })()
            : undefined)
        if (renderModelKey !== undefined) {
          const separator = renderModelKey.indexOf("/")
          if (separator > 0) {
            yield* bus.publish(SessionEvent.ModelSelected, {
              sessionID,
              model: Model.Ref.make({
                providerID: Provider.ID.make(renderModelKey.slice(0, separator)),
                id: Model.ID.make(renderModelKey.slice(separator + 1)),
              }),
              previous: first.session.model,
            })
            initial = undefined
          }
        }
        if (pendingRender.instruction?.kind === "wait" && pendingRender.instruction.until !== undefined) {
          const waitMs = pendingRender.instruction.until - Date.now()
          if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs))
        }
      }
      let recoverOverflow = true
      let recoverContinuation = true
      let retryAttempt: number | undefined
      // The route member a ContinueOn outcome chose: the next step loads on it rather than resolving again.
      let continueOn: SessionContext.Loaded["model"] | undefined
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded =
          initial ??
          (yield* prepareContext(sessionID).pipe(Effect.flatMap((selection) => context.load(selection, continueOn))))
        initial = undefined
        const estimate = SessionCompaction.estimatePrompt(loaded)
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded, estimate })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continuationOf = undefined
          continuationIndex = 0
          continue
        }
        yield* compaction.precompute(Effect.succeed(loaded), estimate)
        continueOn = undefined
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        // The request depends on the model (system prompt, provider options), so a hedge to another
        // target of the route is prepared separately rather than reusing this one.
        const prepareFor = (model: SessionContext.Loaded["model"]) => {
          const transcript = SessionModelRequest.baseTranscript({
            agent: loaded.agent.info,
            model,
            tools: loaded.tools,
            initial: loaded.initial,
            messages: loaded.messages,
          })
          return context.request
            .primary({
              session: loaded.session,
              agent: loaded.agent.id,
              model,
              tools: loaded.tools,
              system: transcript.system,
              messages: stepLimitReached
                ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
                : transcript.messages,
              // Keep tool definitions on the final Step to preserve the provider's cached prefix.
              toolChoice: stepLimitReached ? "none" : undefined,
              webSocket: "session",
              inputTokens: estimate,
            })
            .pipe(
              // The hook event holds every message from before images are bounded, screenshots included, and is a
              // separate copy once a plugin hook has rewritten it. The step and its tool callbacks live as long as the
              // slowest tool, so they keep only what they use.
              Effect.map((prepared) => ({
                request: prepared.request,
                options: prepared.options,
                retry: prepared.retry,
                // A tool call can arrive during a reload; its permission check reads the session's agent.
                executeTool: (call: Parameters<typeof prepared.executeTool>[0]) =>
                  plugins.awaitActivation.pipe(Effect.andThen(prepared.executeTool(call))),
              })),
            )
        }
        const prepared = yield* prepareFor(loaded.model)
        const outcome = yield* Effect.scoped(
          steps.attempt({
            isLocationClosed: lifecycle.isClosed,
            interruption,
            handoffPrepared: pty.handoffPrepared,
            sessionID,
            assistantMessageID,
            ...(continuationOf === undefined ? {} : { continuation: { of: continuationOf, index: continuationIndex } }),
            agent: loaded.agent.id,
            model: loaded.model,
            toolNames: loaded.tools.definitions.map((tool) => tool.name),
            ...(loaded.model.membership ? { membership: loaded.model.membership } : {}),
            prepared,
            estimatedInputTokens: SessionCompaction.estimateContext(loaded),
            prepareFor,
            retryAttempt,
            retry: (cause, error, proposed) =>
              retry.decide({
                cause,
                error,
                agent: loaded.agent.id,
                model: loaded.model.ref,
                hook: prepared.retry,
                retry: proposed,
              }),
            recoverContinuation,
            recoverOverflow: Effect.suspend(() =>
              recoverOverflow
                ? compaction
                    .compact({ reason: "overflow", context: loaded, estimate })
                    .pipe(Effect.map((result) => result.status === "completed"))
                : Effect.succeed(false),
            ),
          }),
        )
        retryAttempt = undefined
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: Effect.fnUntraced(function* (outcome) {
            // The Session is about to go idle, which leaves the background summary time to finish.
            if (!outcome.needsContinuation)
              yield* compaction.precompute(
                store.context(sessionID).pipe(Effect.map((messages) => ({ ...loaded, messages }))),
              )
            const result: StepResult = { needsContinuation: outcome.needsContinuation }
            return result
          }),
          Retry: Effect.fnUntraced(function* (outcome) {
            retryAttempt = outcome.decision.attempt
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            if (outcome.freshAssistant) {
              assistantMessageID = SessionMessage.ID.create()
              continuationOf = undefined
              continuationIndex = 0
            }
          }),
          Failover: Effect.fnUntraced(function* (outcome) {
            yield* modelTransport.close(sessionID)
            initial = { ...loaded, model: outcome.model }
          }),
          QuotaWall: Effect.fnUntraced(function* (outcome) {
            // Quota fallback (#2384 slice 3): direct the next step to
            // render the quota fallback card, and continue the turn into
            // it. When the plan store cannot supply the card's actions,
            // the step keeps its original bare-error ending.
            const directive = (() => {
              try {
                return SessionRunnerRenderWiring.wallDirective(sessionID, outcome.wall)
              } catch {
                // A directive that cannot even be built leaves no
                // card, so the offered wall must not stay latched
                // (#2468, the wallDirective undefined path).
                SessionRunnerRenderWiring.clearWall(sessionID)
                return undefined
              }
            })()
            if (directive === undefined) return yield* new StepFailedError({ error: outcome.error })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: directive })
            const continued: StepResult = { needsContinuation: true }
            return continued
          }),
          ContinueOn: Effect.fnUntraced(function* (outcome) {
            // A different member answers next, so no wait: the failed one is not asked again.
            yield* modelTransport.close(sessionID)
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
            continuationOf = undefined
            continuationIndex = 0
            continueOn = outcome.model
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            const recent = yield* db
              .select({
                type: SessionMessageTable.type,
                finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const exhausted =
              recent.length === 3 && recent.every((row) => row.type === "assistant" && row.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            if (outcome.needsContinuation)
              return {
                needsContinuation: true,
                continuation: { of: continuationOf ?? assistantMessageID, index: continuationIndex + 1 },
              }
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            continuationOf ??= assistantMessageID
            continuationIndex++
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
            continuationOf = undefined
            continuationIndex = 0
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* SessionHistory.incompleteAssistants(db, sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          const error = interruptedMutationError(tool) ?? {
            type: "aborted",
            message: `Tool execution interrupted, the server was restarted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
          }
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error,
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({
      drain: (input) => drain(input).pipe(Effect.annotateSpans("session.id", input.sessionID)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    FileAccess.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    PluginHooks.node,
    Job.node,
    SessionTitle.node,
    Snapshot.node,
    PersistentPty.node,
    ToolOutput.node,
    Database.node,
  ],
})
