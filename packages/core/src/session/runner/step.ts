export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  TransportError,
  UnknownProviderError,
  type ProviderErrorEvent,
  type ToolCall,
} from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import { Cause, Clock, Data, Deferred, Duration, Effect, Exit, Fiber, Option, Result, Scope, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { Location } from "../../location.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteAutonomy } from "../../model-route-autonomy.js"
import { ModelRouteLimits } from "../../model-route-limits.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { SessionRunnerModel } from "./model.js"
import { SessionMembershipGate } from "./membership-gate.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionHedge } from "./hedge.js"
import { SessionRunnerRetry } from "./retry.js"
import { materializeToolResult } from "./tool-result-content.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  Failover: { readonly model: SessionRunnerModel.Resolved; readonly error: SessionError.Error }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
  OutputLimit: { readonly needsContinuation: boolean }
}>
export const Outcome = Data.taggedEnum<Outcome>()

/** The attempt that started a response continued after an output token limit, and which chunk this request is. */
export type ContinuationLink = { readonly of: SessionMessage.ID; readonly index: number }

interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  /** Set when this request continues a response that hit the output token limit: the assistant message of the
   * attempt that started the response, and this chunk's index (1 for the first continuation). */
  readonly continuation?: ContinuationLink
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  /** The membership account the attempt's model draws from (#2253), when its provider
   * declares caps: the gate meters the start before any request goes out. Kept off
   * `model` so failover swaps of the resolved model cannot lose or duplicate it —
   * the attempt re-reads it from each model it actually runs. */
  readonly membership?: { readonly providerID: string; readonly canonical?: string }
  /** Prompt-size estimate for budget accounting when a hedge is cancelled before provider usage arrives. */
  readonly estimatedInputTokens?: number
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** Prepares the same request for another target of the route, so a slow attempt can be hedged. */
  readonly prepareFor?: (
    model: SessionRunnerModel.Resolved,
  ) => Effect.Effect<Omit<SessionModelRequest.Prepared, "event">>
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
}

type Attempt = (input: Input) => Effect.Effect<Outcome, AIError | StepFailedError, Scope.Scope>

/** Failed attempts per assistant message and target, so a route can retry a target before failing over. */
const failedAttempts = new Map<string, number>()
export const FAILED_ATTEMPT_LIMIT = 1_000

/** Notes one more failed attempt for the key and returns how many there now are. Oldest keys are
 * dropped so abandoned turns cannot grow the map without bound. */
export const countFailedAttempt = (key: string) => {
  const count = (failedAttempts.get(key) ?? 0) + 1
  failedAttempts.set(key, count)
  while (failedAttempts.size > FAILED_ATTEMPT_LIMIT) failedAttempts.delete(failedAttempts.keys().next().value!)
  return count
}

export const failedAttemptCount = (key?: string) =>
  key === undefined ? failedAttempts.size : (failedAttempts.get(key) ?? 0)

export const clearFailedAttempt = (key: string) => failedAttempts.delete(key)

/** Assistant messages that already ran a hedge race, so a retry of the winner does not race again. */
const hedgedMessages = new Set<string>()
export const HEDGED_MESSAGE_LIMIT = 1_000

const markHedged = (messageID: string) => {
  hedgedMessages.delete(messageID)
  hedgedMessages.add(messageID)
  while (hedgedMessages.size > HEDGED_MESSAGE_LIMIT) hedgedMessages.delete(hedgedMessages.values().next().value!)
}

const wasHedged = (messageID: string) => hedgedMessages.has(messageID)

/**
 * Reads the rate-limit headers of a request's response as soon as the provider answers, so what a
 * successful request said about its quota is kept as well as what a failed one did. Each snapshot is
 * handed to the routing state immediately: a spent window holds the target back for the next turn.
 */
''/** Reads a response's rate-limit headers as it arrives, and a rejection's own headers too. Kept
 * as the step's name for it so existing callers and tests keep working; the implementation is the
 * shared observer from `ModelRouteLog`, which handles both `onResponse` and `onRejected`. */
''/** Reads a response's rate-limit headers as it arrives, and a rejection's own headers too. Kept
 * as the step's name for it so existing callers and tests keep working; the implementation is the
 * shared observer from `ModelRouteLog`, which handles both `onResponse` and `onRejected`. */
export const captureRateLimit = (target: ModelRoute.Target, credentialID?: string) => {
  const capture: { snapshot?: ModelRouteLimits.Snapshot } = {}
  const seen = ModelRouteLog.observeRateLimits((snapshot) => {
    capture.snapshot = snapshot
    ModelRoute.observeRateLimit(target, snapshot, Date.now(), credentialID)
  })
  return { capture, options: seen.options }
}

/** Text that states a quota window (or a credit balance) is spent, as opposed to a
 * momentary rate limit: providers that report exhaustion without a quota tag (Antigravity's
 * "Individual quota reached") must land in the same class as a `QuotaExceeded` tag, or the
 * identical condition benches two different ways depending on the door (#1806). Deliberately
 * narrower than `exhaustionText` below: that one only opens the quota-failure gate path,
 * while this one decides the bench class, so plain rate-limit phrasing stays out. */
const quotaText =
  /individual quota|quota (?:exhausted|reached|exceeded)|insufficient credits|insufficient balance|insufficient funds|out of credits|usage limit (?:exceeded|reached)|reached your (?:usage|quota|plan) limit/i

/** Transport OS codes that prove a request never reached a provider API: the name did not
 * resolve, or nothing listened at the far end (a dead local service or proxy). Those are
 * path failures — the fleet's DNS, a local proxy, the server itself — not provider health,
 * so they take the infra hold instead of a bench (#1828). Ambiguous codes (resets, generic
 * timeouts) stay on the ordinary network path: they can be the provider's own doing. */
const INFRA_TRANSPORT_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"])

/** Cooldown input from a provider error: a stated retry-after, an exhausted quota, or an
 * authentication refusal (the `Authentication` tag, an HTTP 401/403, or the org-disabled
 * refusal shape), which cannot heal by itself and so takes the long first bench. A quota
 * stated only in the error text classifies as quota too, with the stated reset bound to the
 * bench; a transport path failure classifies as infra. */
export const failureHint = (failure: AIError): ModelRoute.FailureHint => {
  const reason = failure.reason as {
    _tag: string
    retryAfterMs?: number
    rateLimit?: { retryAfterMs?: number }
    http?: { status?: number }
    code?: string
    message?: string
    body?: string
  }
  // The client's own timeout text says how long we waited, not when the provider said to retry:
  // it must not become a rate-limit hint (#1551). A provider-stated wait in any other shape survives.
  const clientTimeoutMessage =
    reason._tag === "Transport" &&
    reason.code === "Timeout" &&
    reason.message?.startsWith("No response output within ")
  const text = `${reason.message ?? ""} ${reason.body ?? ""}`
  const quota = reason._tag === "QuotaExceeded" || quotaText.test(text)
  const tierLimit = reason.code === "tier_limit_exceeded" || TIER_LIMIT_TEXT.test(text)
  // Extraction reads the same combined text classification reads, in the same
  // message-then-body order: a reset stated only in the raw body must bind to
  // the bench exactly as one stated in the message does (#2108). Reading
  // `message ?? body` instead would discard the body whenever a message
  // exists, even when the message states no reset at all.
  const quotaResetAtMs = quota ? ModelRouteLimits.resetAtFromMessage(text, Date.now()) : undefined
  return {
    retryAfterMs:
      reason.retryAfterMs ??
      reason.rateLimit?.retryAfterMs ??
      (clientTimeoutMessage
        ? undefined
        : ModelRouteLimits.retryHintFromMessage(text, Date.now())),
    quota,
    // Optional hint fields are omitted when unset, never present-but-undefined — the
    // same convention the route policy follows.
    ...(quotaResetAtMs !== undefined ? { quotaResetAtMs } : {}),
    ...(tierLimit ? { tierLimit: true } : {}),
    ...(reason._tag === "Transport" &&
    reason.http === undefined &&
    !clientTimeoutMessage &&
    INFRA_TRANSPORT_CODES.has(reason.code ?? "")
      ? { infra: true }
      : {}),
    auth:
      reason._tag === "Authentication" ||
      reason.http?.status === 401 ||
      reason.http?.status === 403 ||
      /organization has disabled/i.test(text),
    network: reason._tag === "Transport" && reason.http === undefined && !clientTimeoutMessage,
  }
}

/** A provider that says it is rate limited or out of quota: moving on beats waiting on the same target. */
const isRateLimited = (failure: AIError) =>
  failure.reason._tag === "RateLimit" ||
  failure.reason._tag === "QuotaExceeded" ||
  failureHint(failure).retryAfterMs !== undefined

/**
 * A failure the credential switch may answer (#6): the provider refused on quota grounds — the
 * `QuotaExceeded` tag, or an HTTP 429 the provider classified as a rate limit. Anything else
 * (transport, unknown, a plain error after dispatch) has unknowable billing state and never
 * triggers a same-request re-issue on another credential.
 */
export const isQuotaFailure = (failure: AIError) => {
  if (failure.reason._tag === "QuotaExceeded") return true
  const reason = failure.reason as { _tag: string; http?: { status?: number } }
  return reason._tag === "RateLimit" && reason.http?.status === 429
}

/** Text reporting that some limit is spent. Broad on purpose: it only opens the quota-failure
 * path (a timed gate); it does NOT by itself prove a balance was exhausted (#1380). */
const exhaustionText = /insufficient credits|quota exhausted|usage limit exceeded|reached your .* limit/i

/** Text that explicitly reports credits/a balance spent — the only text (besides the
 * `QuotaExceeded` tag) that may classify a failure as balance exhaustion. Generic limit
 * wording ("reached your rate limit", "usage limit exceeded", "quota exhausted") is a
 * window/rate statement, not a balance statement (#1380). */
const balanceExhaustionText =
  /insufficient credits|insufficient balance|insufficient funds|out of credits|credits? exhausted|balance exhausted|credit balance is too low|no credits (?:left|remaining)/i

/**
 * How a quota-path failure gates its pool (#1014, #1380): "balance-exhaustion" may install
 * an increase-only balance hold with no expiry, so it requires a `QuotaExceeded` tag or
 * explicitly credit/balance-specific text. A failure that only matches the broad
 * exhaustion wording — a plain HTTP 429 rate limit, say — classifies as "rate-limit" and
 * keeps its timed recovery even when the pool's last snapshot was balance-shaped.
 * Returns undefined when the failure does not enter the quota-failure path at all.
 */
export const quotaFailureClassification = (
  failure: AIError,
): "balance-exhaustion" | "rate-limit" | undefined => {
  // A content-policy rejection is not a quota event, however its text is worded: policy
  // wording must never gate a pool through the broad exhaustion heuristics (#1084).
  if (failure.reason._tag === "ContentPolicy") return undefined
  const reason = failure.reason as { _tag?: string; message?: string; body?: string }
  const text = `${reason.message ?? ""} ${reason.body ?? ""}`
  if (!isQuotaFailure(failure) && !exhaustionText.test(text) && !balanceExhaustionText.test(text)) return undefined
  return reason._tag === "QuotaExceeded" || balanceExhaustionText.test(text) ? "balance-exhaustion" : "rate-limit"
}


const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const fileAccess = yield* FileAccess.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const location = yield* Effect.serviceOption(Location.Service)
  const locationDirectory = Option.match(location, {
    onNone: () => undefined,
    onSome: (value) => value.directory as string,
  })
  const toolOutput = yield* ToolOutput.Service

  const run = Effect.fn("SessionStep.run")(function* (
    input: Input,
    /** Events already being produced for this attempt, from a hedge race. */
    raced?: {
      readonly stream: Stream.Stream<LLMEvent, AIError>
      readonly startedAt: number
      readonly outputAt?: number
      readonly rateLimit?: ReturnType<typeof captureRateLimit>
    },
  ) {
    // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started,
    // so it is captured while the provider request is in flight instead of delaying it.
    const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)
    const rateLimit = raced?.rateLimit ?? captureRateLimit(input.model.ref, input.model.routing?.credentialID)
    const requestStarted = raced?.startedAt ?? performance.now()
    const wallStarted = Date.now() - (performance.now() - requestStarted)
    const firstOutput = yield* Deferred.make<void>()
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      pendingSnapshot: Fiber.join(pendingStartSnapshot),
      started: yield* Clock.currentTimeMillis,
      deferStepStart: input.model.routing !== undefined,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      }).pipe(
        Effect.flatMap((result) =>
          materializeToolResult(
            result.content,
            {
              sessionID: input.sessionID,
              agent: input.agent,
              messageID: input.assistantMessageID,
              id: Tool.CallID.make(call.id),
            },
            fileAccess.authorizeRead,
          ).pipe(Effect.map((content) => ({ ...result, content }))),
        ),
      )
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    let providerFailure: ProviderErrorEvent | undefined
    let firstOutputAt = raced?.outputAt
    if (firstOutputAt !== undefined) yield* Deferred.succeed(firstOutput, undefined)
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = (
      raced?.stream ?? llm.stream(input.prepared.request, rateLimit.options(input.prepared.options))
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || providerFailure || publisher.hasProviderError()) return
          // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
          if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          const outputAlreadyStarted = publisher.record().outputStarted
          if (LLMEvent.is.providerError(event) && input.model.routing) {
            if (!outputAlreadyStarted) {
              providerFailure = event
              return
            }
            if (!event.classification)
              ModelRoute.failed(
                input.model.routing.target,
                input.model.routing.policy,
                undefined,
                undefined,
                undefined,
                locationDirectory,
                input.model.routing.probeClaim,
              )
          }
          const receivedAt = performance.now()
          yield* publisher.publish(event)
          if (!outputAlreadyStarted && publisher.record().outputStarted && firstOutputAt === undefined) {
            firstOutputAt = receivedAt
            yield* Deferred.succeed(firstOutput, undefined)
          }
          if (event.type !== "tool-call" || event.providerExecuted) return
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const firstTokenTimeout = input.model.routing?.policy.firstTokenTimeoutMs
        let stream: Exit.Exit<void, AIError>
        if (typeof firstTokenTimeout !== "number" || raced?.outputAt !== undefined) {
          // Keep the established execution and interruption path unchanged for ordinary models
          // and routes that explicitly disable the first-output deadline.
          stream = yield* restore(providerStream).pipe(Effect.exit)
        } else {
          const streamFiber = yield* Effect.forkScoped(Effect.exit(restore(providerStream)))
          const timedOut = yield* restore(
            Effect.raceFirst(
              Deferred.await(firstOutput).pipe(Effect.as(false)),
              Effect.raceFirst(
                Fiber.await(streamFiber).pipe(Effect.as(false)),
                Effect.sleep(
                  Duration.millis(Math.max(0, firstTokenTimeout - (performance.now() - requestStarted))),
                ).pipe(Effect.as(true)),
              ),
            ),
          )
          stream = timedOut
            ? yield* Fiber.interrupt(streamFiber).pipe(
                Effect.as(
                  Exit.fail(
                    new AIError({
                      reason: new TransportError({
                        message: `No response output within ${firstTokenTimeout}ms`,
                        transport: "http",
                        operation: "request",
                        code: "Timeout",
                      }),
                    }),
                  ),
                ),
              )
            : yield* Fiber.join(streamFiber)
        }
        // The provider's response ends here. Tools or an overflow compaction can keep the step running for
        // minutes after it. That time counts in the step's end (`time_ended`, `time.completed`), while the
        // response time and speed that the route log and pool health judge the model by stop here.
        const streamedAt = performance.now()
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
        if (Exit.hasInterrupts(stream) && !publisher.hasStarted() && !pendingStartSnapshot.pollUnsafe())
          return yield* Effect.failCause(stream.cause)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        const overflow = overflowFailure ?? streamFailure
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflow) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: overflow?.message,
          })
          ModelRouteLog.record({
            kind: "attempt",
            row: {
              time_started: wallStarted,
              time_ended: Date.now(),
              session_id: input.sessionID,
              assistant_message_id: input.assistantMessageID,
              route_id: input.model.routing?.routeID ?? "",
              provider_id: input.model.ref.providerID,
              model_id: input.model.ref.id,
              variant: input.model.ref.variant,
              credential_id: input.model.servingCredentialID ?? input.model.routing?.credentialID,
              outcome: "failure",
              error_tag: "ContextOverflow",
              error_message: overflow?.message,
              retryable: false,
              output_started: false,
              response_ms: streamedAt - requestStarted,
              continuation_index: input.continuation?.index,
            },
            continuationOfMessageID: input.continuation?.of,
          })
          return Outcome.Compacted()
        }

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        let recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure =
          streamFailure instanceof AIError
            ? streamFailure
            : providerFailure
              ? new AIError({ reason: new UnknownProviderError({ message: providerFailure.message }) })
              : unknownFinish
        const failureError = llmFailure
          ? toSessionError(llmFailure, { credentialMethodID: input.model.servingMethodID, model: input.model.ref })
          : undefined
        const llmError = failureError && !recorded.providerFailed ? failureError : undefined
        // Usage and rate-limit state are recorded where the outcome is first known. The attempt
        // row itself is written via recordAttempt below, after the failover decision, so it
        // can name where the attempt failed over to; it still precedes every return past that
        // point, so a failure that fails over, retries or recovers is recorded like any
        // other — and an interruption during the retry hook records it too (see recordAttempt).
        const failed = llmFailure !== undefined
        const timedOut = failed && llmFailure.reason._tag === "Transport" && llmFailure.reason.code === "Timeout"
        const tokens = recorded.finish?.tokens
        ModelRoute.recordRequest(input.model.ref, tokens)
        const failureLog = failed ? ModelRouteLog.failureFields(llmFailure.reason) : undefined
        if (failed)
          ModelRoute.observeRateLimit(
            input.model.ref,
            ModelRouteLimits.snapshot(
              (llmFailure.reason as { rateLimit?: ModelRouteLimits.Details }).rateLimit,
              Date.now(),
            ),
            Date.now(),
            input.model.routing?.credentialID,
          )
        // Backstop (#2253): a tier-limit answer that still slips through — a race,
        // or traffic from another client the local limiter never metered — holds
        // the provider's whole membership account out of rotation until the reset
        // the error states, so no further attempt is spent against the cap.
        if (failed && llmFailure && isTierLimitFailure(llmFailure)) {
          const reason = llmFailure.reason as { message?: string; body?: string }
          ModelRoute.recordTierLimit(
            input.model.ref,
            `${reason.message ?? ""} ${reason.body ?? ""}`,
            Date.now(),
            input.model.membership?.canonical,
          )
        }
        // A quota-exhaustion answer gates its pool until the reset it stated (#984): the
        // credential when the attempt carried one, the provider itself otherwise. Selection
        // then stops spending attempts — and collecting 429s — on an exhausted pool. The
        // text check catches providers that report exhaustion without a quota tag
        // (commandcode's "insufficient credits" arrives as an unknown-provider error).
        const quotaClassification = failed && llmFailure ? quotaFailureClassification(llmFailure) : undefined
        if (llmFailure && quotaClassification) {
          const hint = failureHint(llmFailure)
          ModelRoute.observeQuotaFailure(
            input.model.ref,
            input.model.routing?.credentialID,
            hint.retryAfterMs === undefined ? undefined : Date.now() + hint.retryAfterMs,
            Date.now(),
            // Only a real exhaustion answer may install an increase-only balance hold; a
            // plain HTTP 429 rate limit keeps its stated timed recovery (#1014, #1380).
            quotaClassification,
            locationDirectory,
          )
        }
        // A success that advertised no limit headers replaces the serving credential's hold:
        // the provider's last word for that credential is now a healthy response (#870). Only
        // a successful stream counts: an interrupted one never got the provider's answer, so
        // it must not release a hold the provider may still be enforcing.
        if (!failed && Exit.isSuccess(stream) && rateLimit.capture.snapshot === undefined)
          ModelRoute.clearRateLimit(input.model.ref, input.model.routing?.credentialID)
        const routeFailure =
          llmFailure !== undefined &&
          (SessionRunnerRetry.isRetryable(llmFailure) ||
            llmFailure.reason._tag === "Authentication" ||
            llmFailure.reason._tag === "QuotaExceeded")
        // A content-policy rejection is the provider refusing this request, not the target
        // failing: it never counts against route health, quota or cooldown state, it is
        // never retried on the same target, but the request does fail over (#1084).
        const policyFailure = llmFailure !== undefined && llmFailure.reason._tag === "ContentPolicy"
        // #1806: a failure can indict the target without being retryable, an auth refusal,
        // or a quota tag — a deterministic rejection naming the target's own configuration
        // (a model the provider no longer serves arrives as an unclassified InvalidRequest),
        // a target-side timeout, an operation this target does not support, a route that
        // does not resolve. Those are availability classes the routeFailure test above does
        // not admit, and they cascade like any other target failure: a session moves to the
        // next candidate on ANY candidate error and errors only when every candidate is
        // exhausted (Drew, 2026-11-06). Classified InvalidRequest failures (context
        // overflow, payload too large) indict the request, not the target — size recovery
        // owns them, and every candidate would reject the same request identically — so
        // they stay out.
        const cascadeFailure =
          llmFailure !== undefined &&
          (llmFailure.reason._tag === "Timeout" ||
            llmFailure.reason._tag === "UnsupportedOperation" ||
            llmFailure.reason._tag === "NoRoute" ||
            (llmFailure.reason._tag === "InvalidRequest" &&
              (llmFailure.reason.classification === undefined ||
                // An InvalidRequest whose text carries the provider's own
                // exhaustion wording (code#8086): the failureHint quota
                // evidence indicts the TARGET, not this request, so the
                // session walks to the next candidate instead of dying on a
                // leg that has already answered 100%. The classified
                // shapes (context overflow, payload too large) state no
                // quota in their text and stay out, as before: they indict
                // the request, and size recovery owns them.
                failureHint(llmFailure).quota)))
        // A content-filter finish is the same refusal delivered as a finish reason rather
        // than an error: the attempt is recorded as a policy rejection (below), never as a
        // success or a general failure (#1084).
        const policyFinish = !failed && recorded.finish?.finish === "content-filter"
        // The failover decision: where this attempt moves to, if anywhere. It is computed
        // after the retry hook below, and the attempt row names its destination.
        let failover: { readonly model: SessionRunnerModel.Resolved; readonly overTo: string } | undefined
        // The attempt row is written exactly once, normally after the failover decision so
        // it can name the destination. The retry hook runs behind restore(), so a session
        // interrupted while the hook runs would otherwise exit before that write and the
        // completed attempt would vanish from route history: the hook's interruption path
        // writes the row instead, with no destination known yet.
        let attemptRecorded = false
        const recordAttempt = () => {
          if (attemptRecorded) return
          attemptRecorded = true
          ModelRouteLog.record({
            kind: "attempt",
            row: {
              time_started: wallStarted,
              time_ended: Date.now(),
              session_id: input.sessionID,
              assistant_message_id: input.assistantMessageID,
              route_id: input.model.routing?.routeID ?? "",
              provider_id: input.model.ref.providerID,
              model_id: input.model.ref.id,
              variant: input.model.ref.variant,
              credential_id: input.model.servingCredentialID ?? input.model.routing?.credentialID,
              outcome: streamInterrupted
                ? "interrupted"
                : timedOut
                  ? "timeout"
                  : failed || policyFinish
                    ? "failure"
                    : "success",
              ...failureLog,
              error_tag: failureLog?.error_tag ?? (policyFinish ? "ContentPolicy" : undefined),
              // A failed request's own details win; a successful one keeps what its response said.
              quota: failureLog?.quota ?? (rateLimit.capture.snapshot && { ...rateLimit.capture.snapshot }),
              retryable: failed ? SessionRunnerRetry.isRetryable(llmFailure) : undefined,
              output_started: recorded.outputStarted,
              failed_over_to: failover?.overTo,
              first_token_ms: firstOutputAt === undefined ? undefined : firstOutputAt - requestStarted,
              response_ms: streamedAt - requestStarted,
              tokens_per_second:
                tokens && firstOutputAt !== undefined
                  ? ((tokens.output + tokens.reasoning) * 1_000) / Math.max(1, streamedAt - firstOutputAt)
                  : undefined,
              tokens_input: tokens?.input,
              tokens_estimated: false,
              hedged: raced !== undefined,
              tokens_output: tokens?.output,
              tokens_reasoning: tokens?.reasoning,
              tokens_cache_read: tokens?.cache.read,
              tokens_cache_write: tokens?.cache.write,
              cost_usd: tokens ? SessionUsage.calculateCost(input.model.cost, tokens) : undefined,
              cache_savings_usd: tokens ? SessionUsage.calculateCacheSavings(input.model.cost, tokens) : undefined,
              continuation_index: input.continuation?.index,
            },
            continuationOfMessageID: input.continuation?.of,
          })
        }
        const retry =
          llmFailure && failureError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  failureError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (input.model.routing !== undefined && !recorded.outputStarted && routeFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              ).pipe(Effect.onInterrupt(() => Effect.sync(recordAttempt)))
            : undefined

        // A target gets `attempts` requests before the route moves on. The failure only counts against
        // the target's health once it is given up on.
        const retryKey = `${input.assistantMessageID}|${input.model.ref.providerID}/${input.model.ref.id}`
        const sameTargetRetry =
          input.model.routing !== undefined &&
          llmFailure !== undefined &&
          routeFailure &&
          !recorded.outputStarted &&
          retry?.retry === true &&
          // A transient failure on a target with a good record gets another try; a rate limit or a
          // target that keeps failing moves the turn on immediately.
          !isRateLimited(llmFailure) &&
          ModelRoute.steady(input.model.routing.target, input.model.routing.credentialID, locationDirectory) &&
          (failedAttempts.get(retryKey) ?? 0) + 1 < input.model.routing.attempts
        if (sameTargetRetry) {
          countFailedAttempt(retryKey)
        } else clearFailedAttempt(retryKey)
        // A policy rejection bypasses the health accounting below, so it must also settle
        // any half-open probe claim this attempt carried: failed()/completed() normally
        // settle it, and an outstanding claim would strand the target's route recovery
        // (probeDue stays false) until the bench expires (#1084). The same holds for the
        // refusal delivered as a content-filter finish, which settles nothing either:
        // completed() is gated on !providerFailed and failed() needs an llmFailure (#1620).
        if ((policyFailure || policyFinish) && input.model.routing?.probeClaim) {
          const claim = input.model.routing.probeClaim
          ModelRoute.releaseBenchProbe(input.model.routing.target, undefined, claim.claimedAt, claim.token)
          if (claim.credentialID)
            ModelRoute.releaseBenchProbe(input.model.routing.target, claim.credentialID, claim.claimedAt, claim.token)
        }
        // Health accounting is broader than current-request failover: a terminal non-retryable
        // error still makes the target unhealthy for later selections. Keep the routeFailure gate
        // below so this does not broaden which failures may move the current request elsewhere.
        if (
          input.model.routing &&
          llmFailure &&
          failureError &&
          !policyFailure &&
          !isContextOverflowFailure(llmFailure) &&
          !sameTargetRetry &&
          (routeFailure || !retry?.retry || recorded.outputStarted)
        )
          ModelRoute.failed(
            input.model.routing.target,
            input.model.routing.policy,
            Date.now(),
            failureHint(llmFailure),
            input.model.routing.credentialID,
            locationDirectory,
            input.model.routing.probeClaim,
          )
        // The failover return itself is deferred until after the attempt row is written,
        // so the row can name the destination.
        // Failover is not gated on the retry hook: the hook decides whether the SAME target
        // gets another request (sameTargetRetry / the Retry outcome below), not whether the
        // route may move on. A declined retry therefore cascades instead of killing the turn
        // while eligible candidates remain (#1014).
        // Output already started keeps this gate closed on purpose: partial output is already
        // published on this assistant message, so another model's output must not be appended
        // to it. That case cascades through the Continue outcome below when a retry is
        // authorized -- a new assistant message whose re-selection sees the target marked
        // failed above; a hook that declines any further request ends the turn, as instructed.
        if (input.model.routing && llmFailure && failureError && (routeFailure || policyFailure || cascadeFailure) && !sameTargetRetry) {
          if (!recorded.outputStarted) {
            // #6: before moving to a different target, a quota-class failure with no output yet
            // may switch to the next eligible credential on the same provider and re-issue the
            // same target (proximity: credential -> leaf -> sibling plan -> next route). There
            // is no per-message switch cap: each switched resolution carries its own
            // credentialFallback excluding every credential this chain has already served,
            // so repeated switches walk the provider's eligible credentials in order, try
            // each at most once, and stop when none remain --
            // only then does the route fallback below run.
            if (isQuotaFailure(llmFailure) && input.model.routing.credentialFallback) {
              const switched = yield* Effect.result(input.model.routing.credentialFallback())
              if (Result.isSuccess(switched) && switched.success) {
                const credentialID = switched.success.routing?.credentialID
                failover = { model: switched.success, overTo: `credential:${credentialID ?? "unknown"}` }
                yield* Effect.logInfo("credential failover", {
                  routeID: input.model.routing.routeID,
                  target: `${input.model.routing.target.providerID}/${input.model.routing.target.id}`,
                  credentialID,
                  reason: failureError?.message,
                })
              }
            }
            if (!failover) {
              const fallback = yield* Effect.result(input.model.routing.fallback())
              if (Result.isSuccess(fallback) && fallback.success) {
                failover = {
                  model: fallback.success,
                  overTo: `${fallback.success.ref.providerID}/${fallback.success.ref.id}`,
                }
                yield* Effect.logInfo("model route failover", {
                  routeID: input.model.routing.routeID,
                  from: `${input.model.routing.target.providerID}/${input.model.routing.target.id}`,
                  to: `${fallback.success.ref.providerID}/${fallback.success.ref.id}`,
                  reason: failureError?.message,
                })
              }
            }
            if (failover && input.sessionID)
              ModelRoute.moved(input.model.routing.routeID, input.sessionID, input.model.routing.target)
          }
        }

        recordAttempt()
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        if (failover && failureError) return Outcome.Failover({ model: failover.model, error: failureError })
        if (providerFailure) {
          yield* publisher.publish(providerFailure)
          recorded = publisher.record()
        }
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        if (llmError && !recorded.providerFailed) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // Parsers may leave unfinished calls without an execution event.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
          yield* publisher.failIncompleteTools()
        }

        const record = publisher.record()
        if (
          input.model.routing &&
          Exit.isSuccess(stream) &&
          record.finish &&
          !record.failure &&
          !record.providerFailed &&
          firstOutputAt !== undefined
        ) {
          const outputDuration = Math.max(1, streamedAt - firstOutputAt)
          ModelRoute.completed(
            input.model.routing.target,
            input.model.routing.policy,
            {
              firstTokenMs: firstOutputAt - requestStarted,
              responseMs: streamedAt - requestStarted,
              tokensPerSecond:
                ((record.finish.tokens.output + record.finish.tokens.reasoning) * 1_000) / outputDuration,
            },
            Date.now(),
            input.model.routing.credentialID,
            locationDirectory,
            input.model.routing.probeClaim,
          )
          if (input.sessionID)
            ModelRoute.served(input.model.routing.routeID, input.sessionID, input.model.routing.target, locationDirectory)
        }
        if (record.finish || record.failure) {
          const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const usage = record.finish
            ? { cost: SessionUsage.calculateCost(input.model.cost, record.finish.tokens), tokens: record.finish.tokens }
            : undefined
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              providerState: record.finish.providerState,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        const needsContinuation = input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation
        if (record.finish?.finish === "length") return Outcome.OutputLimit({ needsContinuation })
        return Outcome.Completed({ needsContinuation })
      }),
    )
  }, Effect.scoped)

  /** The part of an attempt after the membership gate: one request, or two
   * when the route hedges (see SessionHedge.race). Split out of `attempt` so a
   * gate-acquired primary composes with hedging (#2383): `attempt` holds the
   * gate slot across this whole body and releases it only when it settles. */
  const attemptAfterGate: Attempt = Effect.fn("SessionStep.attemptAfterGate")(function* (input: Input) {
    const routing = input.model.routing
    const prepareFor = input.prepareFor
    // A target that keeps giving up is raced at once rather than after the hedge delay, on routes whose
    // autonomy allows it; `fixed` and `rules` routes only fail over.
    const escalate =
      routing !== undefined &&
      ModelRouteAutonomy.races(routing.autonomy) &&
      ModelRoute.escalates(routing.target, routing.credentialID, locationDirectory)
    // Once a turn has been hedged, its retries stay on one request rather than racing again.
    if (!routing || (!routing.hedgeAfterMs && !escalate) || !prepareFor || wasHedged(input.assistantMessageID))
      return yield* run(input)
    const primaryLimit = captureRateLimit(input.model.ref, routing?.credentialID)
    markHedged(input.assistantMessageID)
    // Slot ownership in the composed gate + hedge path (#2253, #2383): the
    // primary's slot, when it carries a membership, is the gate slot `attempt`
    // took before this body and holds until the whole attempt settles — there
    // is no second primary slot to take here. Hedge legs against a capped
    // provider take their own slot against its account here, once, and release
    // when this attempt's outcome settles: a hedge leg on the same account as
    // the primary is a second concurrent request and meters separately.
    const hedgeSlots: Array<{ membership: SessionMembershipGate.MembershipRef; result: SessionMembershipGate.GateResult }> = []
    const holdHedgeSlot = (model: SessionRunnerModel.Resolved) =>
      Effect.gen(function* () {
        if (!model.membership) return
        const gated = yield* SessionMembershipGate.gate({
          membership: model.membership,
          routeID: routing?.routeID ?? "",
          sessionID: input.sessionID,
          location: locationDirectory,
          lastResort: true,
        })
        if (gated) hedgeSlots.push({ membership: model.membership, result: gated })
      })
    const raced = yield* SessionHedge.race({
      primary: llm.stream(input.prepared.request, primaryLimit.options(input.prepared.options)),
      afterMs: escalate ? 0 : (routing.hedgeAfterMs ?? 0),
      deadlineMs: typeof routing.policy.firstTokenTimeoutMs === "number" ? routing.policy.firstTokenTimeoutMs : 60_000,
      // No next target, or one that cannot be prepared, simply means there is nothing to hedge with.
      // A session that just moved races its origin, where its cache is, rather than the next fallback.
      start: Effect.suspend(() => (routing.origin ? routing.origin() : routing.fallback())).pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.succeed(Option.none())
            : prepareFor(next).pipe(
                // A preparation that fails or is interrupted never starts the hedge, so
                // the claim the fallback resolution spent is handed back here instead of
                // stranding until the bench expires (#1486, review follow-up). A hedge
                // that does start keeps its claim: the race settles it (the winner via
                // run(), the loser via ModelRoute.slow).
                Effect.onExit((exit) =>
                  exit._tag === "Success" || !next.routing?.probeClaim
                    ? Effect.void
                    : Effect.sync(() => {
                        const claim = next.routing!.probeClaim!
                        ModelRoute.releaseBenchProbe(next.routing!.target, undefined, claim.claimedAt, claim.token)
                        if (claim.credentialID)
                          ModelRoute.releaseBenchProbe(next.routing!.target, claim.credentialID, claim.claimedAt, claim.token)
                      }),
                ),
                Effect.tap(() => holdHedgeSlot(next)),
                Effect.map((prepared) => {
                  const rateLimit = captureRateLimit(next.ref, next.routing?.credentialID)
                  // A hedge has begun: both targets are named before either answers, so the race
                  // itself is visible even if the loser never produces an event.
                  ModelRouteLog.record({
                    kind: "decision",
                    row: {
                      time: Date.now(),
                      session_id: input.sessionID,
                      route_id: routing.routeID,
                      selection: "hedge-race",
                      candidates: [
                        `${input.model.ref.providerID}/${input.model.ref.id}`,
                        `${next.ref.providerID}/${next.ref.id}`,
                      ],
                      reason: "hedge-started" as const,
                    },
                  })
                  return Option.some({
                    value: { model: next, prepared, rateLimit },
                    stream: llm.stream(prepared.request, rateLimit.options(prepared.options)),
                  })
                }),
              ),
        ),
        Effect.orElseSucceed(() => Option.none()),
      ),
    })
    if (raced.hedgeStarted) {
      // The target that lost: the primary when the hedge answered first, otherwise the hedge.
      const loser = raced.winner === "hedge" ? input.model : raced.hedgeValue?.model
      if (loser) {
        ModelRoute.slow(loser.ref, routing.policy)
        ModelRoute.recordUsage(loser.ref, input.estimatedInputTokens ?? 0)
      }
      ModelRouteLog.record({
        kind: "attempt",
        row: {
          time_started: Date.now() - raced.loserElapsedMs,
          time_ended: Date.now(),
          session_id: input.sessionID,
          assistant_message_id: input.assistantMessageID,
          route_id: routing.routeID,
          provider_id: loser?.ref.providerID ?? input.model.ref.providerID,
          model_id: loser?.ref.id ?? input.model.ref.id,
          credential_id: loser?.servingCredentialID ?? loser?.routing?.credentialID,
          outcome: "hedged-out",
          hedged: true,
          output_started: false,
          response_ms: raced.loserElapsedMs,
          tokens_input: input.estimatedInputTokens,
          tokens_estimated: true,
          continuation_index: input.continuation?.index,
        },
        continuationOfMessageID: input.continuation?.of,
      })
    }
    const winner = raced.winner === "hedge" ? raced.value : undefined
    return yield* run(winner ? { ...input, model: winner.model, prepared: winner.prepared } : input, {
      rateLimit: winner ? winner.rateLimit : primaryLimit,
      stream: raced.stream,
      startedAt: raced.startedAt,
      ...(raced.outputAt !== undefined ? { outputAt: raced.outputAt } : {}),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const slot of hedgeSlots) SessionMembershipGate.release(slot.membership, slot.result)
        }),
      ),
    )
  })

  /** One request, or two when the route hedges: see SessionHedge.race. */
  const attempt: Attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    const routing = input.model.routing
    const prepareFor = input.prepareFor
    // Membership gate (#2253): a provider that declares caps meters every start
    // against its one shared account before any request goes out. When the
    // account is full past the bounded wait, the attempt moves to the route's
    // next leg without spending a request — the session never sees the
    // provider's tier-limit refusal. With no next leg the capped target is the
    // last resort and proceeds unmetered rather than failing the session.
    const membership = input.model.membership
    if (membership) {
      const gated = yield* SessionMembershipGate.gate({
        membership,
        routeID: routing?.routeID ?? "",
        sessionID: input.sessionID,
        location: locationDirectory,
        lastResort: routing === undefined,
      })
      if (gated === undefined) {
        const fallback = yield* Effect.result(routing!.fallback())
        const next = Result.isSuccess(fallback) ? fallback.success : undefined
        if (next) {
          if (input.sessionID) ModelRoute.moved(routing!.routeID, input.sessionID, routing!.target)
          return yield* attempt({ ...input, model: next, ...(prepareFor ? { prepared: yield* prepareFor(next) } : {}) })
        }
        return yield* run(input)
      }
      // Composition (#2383): holding the gate slot, the attempt continues
      // into the hedge path instead of returning through run() — a capped
      // primary hedges and escalates like any other — and the gate slot is
      // released only when the whole composed attempt settles.
      return yield* attemptAfterGate(input).pipe(
        Effect.ensuring(Effect.sync(() => SessionMembershipGate.release(membership, gated))),
      )
    }
    return yield* attemptAfterGate(input)
  })

  return { attempt }
})

/** Text and codes that name an upstream membership tier-limit answer (#2253): the
 * provider's account cap answered despite the local limiter (a race, or traffic
 * from another client). Detection is deliberately exact — this wording belongs
 * to membership caps alone — so ordinary rate limits never take the
 * account-wide hold. */
const TIER_LIMIT_TEXT = /tier_limit_exceeded|tier[-_\s]?limit|membership (?:concurrency|rpm) limit/i

/** Whether a failure is an upstream membership tier-limit answer (#2253). */
export const isTierLimitFailure = (failure: AIError): boolean => {
  const reason = failure.reason as { code?: string; message?: string; body?: string }
  return reason.code === "tier_limit_exceeded" || TIER_LIMIT_TEXT.test(`${reason.message ?? ""} ${reason.body ?? ""}`)
}

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
