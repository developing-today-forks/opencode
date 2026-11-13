export * as SessionTitle from "./title.js"

import { isDeepStrictEqual } from "node:util"
import { AIError, isContextOverflowFailure, LLMClient, LLMEvent, Message, SystemPart } from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionStep } from "./runner/step.js"
import { SessionSchema } from "./schema.js"
import { ModelRoute } from "../model-route.js"
import { ModelRouteLog } from "../model-route-log.js"
import { SessionUsage } from "./usage.js"
import { Text } from "../util/text.js"
import { SessionStore } from "./store.js"

const MAX_LENGTH = 100
const MAX_CONTEXT_LENGTH = 8_000
const MAX_FIRST_MESSAGE_LENGTH = 2_000
const titleChanged = Symbol("Session title changed")

export interface Interface {
  /** Generates an initial title or regenerates one from bounded conversation history. */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTitle") {}

const truncate = (value: string) =>
  value.length <= MAX_LENGTH ? value : `${Text.truncate(value, MAX_LENGTH - 3)}...`

/** Head cut for the title prompt's first user message (#1977): never splits a surrogate pair. */
export const truncateFirstMessageText = (text: string) => Text.truncate(text, MAX_FIRST_MESSAGE_LENGTH)

/** Tail cut for the title prompt's recent-context window (#1977): never splits a surrogate pair. */
export const truncateRecentContextText = (recent: string, budget: number) => Text.truncateTail(recent, budget)
export const isUntitled = (session: SessionSchema.Info) =>
  isExactRootFallback({
    title: session.title,
    time: { created: DateTime.toEpochMillis(session.time.created) },
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const context = yield* SessionContext.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db

    // A routed title resolution may carry a bench probe claim spent at pick time (#1478):
    // an attempt settles its own model's claim with the outcome it reports, while a model
    // that was resolved but never attempted gets its claim released by generate below.
    // The release is timestamp-guarded in ModelRoute, so releasing a claim an attempt
    // already settled is a no-op.
    const releaseProbeClaim = (model: SessionRunnerModel.Resolved) => {
      const claim = model.routing?.probeClaim
      if (!claim || !model.routing) return
      ModelRoute.releaseBenchProbe(model.routing.target, undefined, claim.claimedAt, claim.token)
      if (claim.credentialID) ModelRoute.releaseBenchProbe(model.routing.target, claim.credentialID, claim.claimedAt, claim.token)
    }

    const attempt = Effect.fn("SessionTitle.attempt")(function* (input: {
      readonly session: SessionSchema.Info
      readonly agent: Agent.Info
      readonly text: string
      readonly model: SessionRunnerModel.Resolved
    }) {
      const chunks: string[] = []
      let failed = false
      let firstTextAt: number | undefined
      let usage: SessionUsage.Recorded | undefined
      // Rough prompt size for the attempt record: a title request is small, and the provider's own
      // count replaces this when the response reports usage.
      const promptText = [input.agent.system ?? "", input.text].join("\n")
      const estimate = Math.ceil(promptText.length / 4) || undefined
      let error: unknown
      let failureSource: unknown
      let interrupted = false
      const recordUsage = Effect.suspend(() =>
        usage
          ? bus.publish(SessionEvent.UsageRecorded, {
              sessionID: input.session.id,
              source: "title",
              ...usage,
            })
          : Effect.void,
      )
      // Request preparation runs plugin hooks and can outlive the attempt: an interruption
      // here never reaches the stream below, so the claim is handed back here (#1486).
      const prepared = yield* context.request.title({
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: input.agent.system ? [SystemPart.make(input.agent.system)] : [],
        messages: [Message.user(input.text)],
      }).pipe(
        // Interruption is not the only way preparation dies: a defect skips onInterrupt,
        // so the claim is handed back on any failed exit (#1486, review follow-up).
        Effect.onExit((exit) =>
          exit._tag === "Failure" ? Effect.sync(() => releaseProbeClaim(input.model)) : Effect.void,
        ),
      )
      if (prepared.event.result !== undefined) {
        // A hook supplied the title: no request executed on this model, so its probe
        // claim (if any) goes back instead of settling.
        releaseProbeClaim(input.model)
        return prepared.event.result
      }
      // The attempt clock starts when the request is ready to send, so preparation time
      // (plugin hooks) never lands in the health samples (#1486), mirroring the runner.
      const startedAt = Date.now()
      const observed = ModelRouteLog.observer(
        {
          routeID: input.model.routing?.routeID ?? "",
          providerID: input.model.ref.providerID,
          modelID: input.model.ref.id,
          variant: input.model.ref.variant,
          credentialID: input.model.servingCredentialID ?? input.model.routing?.credentialID,
          sessionID: input.session.id,
          startedAt,
          inputTokens: estimate,
        },
        (snapshot) => ModelRoute.observeRateLimit(input.model.ref, snapshot, Date.now(), input.model.routing?.credentialID),
      )
      yield* llm.stream(prepared.request, observed.options(prepared.options)).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) {
            failed = true
            failureSource = event
          }
          if (LLMEvent.is.textDelta(event)) {
            if (firstTextAt === undefined) firstTextAt = Date.now()
            chunks.push(event.text)
          }
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, input.model.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          return Effect.void
        }),
        Effect.catchTag("AI.Error", (cause) =>
          Effect.sync(() => {
            failed = true
            error = cause
            failureSource = cause
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
            // Interrupting the stream unwinds the attempt before the settlement below
            // can run, so the claim is handed back here (#1486, review follow-up).
            releaseProbeClaim(input.model)
          }).pipe(Effect.andThen(recordUsage), Effect.asVoid),
        ),
      )
      observed.done(interrupted ? "interrupted" : failed ? "failure" : "success", {
        failure: error,
        outputStarted: chunks.length > 0,
        tokens: usage?.tokens,
      })
      ModelRoute.recordRequest(input.model.ref, usage?.tokens, estimate)
      yield* recordUsage
      // Settle this attempt's bench probe claim with the outcome the request actually
      // reported (#1478), mirroring the session runner (runner/step.ts): a success ends
      // a claimed probe's bench, a failure re-benches on the ladder, and an interrupted
      // or output-less attempt reports no outcome, so its claim is released instead.
      if (input.model.routing) {
        const routing = input.model.routing
        const endedAt = Date.now()
        // Settlement is scoped to the owning session's Location and, on failure, keeps
        // the failure's classification (quota / auth / retry-after / network), exactly
        // as the session runner settles its attempts (runner/step.ts failureHint).
        const locationDirectory = input.session.location.directory as string
        // A context-overflow rejection is request-specific, not model ill-health: the
        // runner excludes it from health accounting (runner/step.ts), so the title path
        // does too — the claim is released below instead of benching a healthy target.
        if (!interrupted && failed && !isContextOverflowFailure(failureSource))
          ModelRoute.failed(
            routing.target,
            routing.policy,
            endedAt,
            error instanceof AIError ? SessionStep.failureHint(error) : undefined,
            routing.credentialID,
            locationDirectory,
            routing.probeClaim,
          )
        else if (!interrupted && usage && firstTextAt !== undefined)
          ModelRoute.completed(
            routing.target,
            routing.policy,
            {
              firstTokenMs: firstTextAt - startedAt,
              responseMs: endedAt - startedAt,
              tokensPerSecond:
                ((usage.tokens.output + usage.tokens.reasoning) * 1_000) / Math.max(1, endedAt - firstTextAt),
            },
            endedAt,
            routing.credentialID,
            locationDirectory,
            routing.probeClaim,
          )
        else releaseProbeClaim(input.model)
      }
      if (failed) return
      return chunks
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    })

    const generate = Effect.fn("SessionTitle.generate")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return
      const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
      if (!firstUser) return
      const text = !isUntitled(session)
        ? yield* store.context(session.id).pipe(
            Effect.map((messages) => {
              const original = `Original request:\n${truncateFirstMessageText(firstUser.text)}`
              const recent = messages
                .flatMap((message) => {
                  if (message.type === "user" && message.id !== firstUser.id) return [`User: ${message.text.trim()}`]
                  if (message.type !== "assistant") return []
                  const text = message.content
                    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
                    .filter(Boolean)
                    .join("\n")
                  return text ? [`Assistant: ${text}`] : []
                })
                .join("\n\n")
              if (!recent) return original
              const prefix = `${original}\n\nRecent conversation:\n`
              return `${prefix}${truncateRecentContextText(recent, MAX_CONTEXT_LENGTH - prefix.length)}`
            }),
            Effect.orElseSucceed(() => firstUser.text),
          )
        : firstUser.text
      const selection = yield* context.selectTitle(session)
      if (!selection) return
      const title =
        (yield* attempt({ session, agent: selection.agent, text, model: selection.selected })) ??
        (selection.primary && !isDeepStrictEqual(selection.selected.ref, selection.primary.ref)
          ? yield* attempt({ session, agent: selection.agent, text, model: selection.primary })
          : undefined)
      // The primary was resolved before the preferred model was picked, so it may carry
      // a probe claim title generation never attempted (#1478): hand it back so the
      // bench's probe is due again for a real request. When the primary was attempted
      // as the fallback, its claim already settled inside attempt and this is a no-op.
      if (selection.primary) releaseProbeClaim(selection.primary)
      if (!title) return
      const expectedSequence = (yield* Bus.latestSequence(db, sessionID)) + 1
      const current = yield* store.get(sessionID)
      if (!current || current.title !== session.title || current.title === truncate(title)) return
      yield* bus
        .publish(
          SessionEvent.Renamed,
          {
            sessionID: session.id,
            title: truncate(title),
          },
          { commit: (sequence) => (sequence === expectedSequence ? Effect.void : Effect.die(titleChanged)) },
        )
        .pipe(Effect.catchDefect((defect) => (defect === titleChanged ? Effect.void : Effect.die(defect))))
    })
    return Service.of({ generate })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node],
})
