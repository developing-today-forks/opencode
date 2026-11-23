export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { LLMClient, LLMResponse, Message, type AIError } from "@opencode/ai/effect"
import { Cause, Effect, Exit } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { ModelRoute } from "../model-route.js"
import { ModelRouteLog } from "../model-route-log.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

export type Result = SessionUsage.Recorded & { readonly text: string }

/**
 * Generates text from current Session context without mutating history.
 * Usage is reported like a step's and added to the Session's totals.
 */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session, { kind: "generate", agent: selection.agent.id })
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        Message.user(input.prompt),
      ],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    // Each attempt is one routed request, observed for route health and usage like a step's.
    const attempt = Effect.suspend(() => {
      const observed = ModelRouteLog.observer(
        {
          routeID: model.routing?.routeID ?? "",
          providerID: model.ref.providerID,
          modelID: model.ref.id,
          variant: model.ref.variant,
          credentialID: model.servingCredentialID ?? model.routing?.credentialID,
          sessionID: selection.session.id,
          startedAt: Date.now(),
        },
        (snapshot) => ModelRoute.observeRateLimit(model.ref, snapshot, Date.now(), model.routing?.credentialID),
      )
      const started = Date.now()
      return llm.generate(prepared.request, observed.options(prepared.options)).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const outcome = Exit.isSuccess(exit) ? "success" : Exit.hasInterrupts(exit) ? "interrupted" : "failure"
            const tokens = Exit.isSuccess(exit) ? responseTokens(exit.value) : undefined
            observed.done(outcome as "success" | "failure" | "interrupted", {
              failure: Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause),
              outputStarted: responseHasOutput(exit),
              firstOutputAt: Exit.isSuccess(exit) ? started : undefined,
              tokens,
            })
            ModelRoute.recordRequest(model.ref, tokens)
          }),
        ),
      )
    })
    const response = yield* attempt.pipe(ModelRetry.retry)
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    const usage = SessionUsage.record(response.usage, model.cost)
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID: selection.session.id, source: "generate", ...usage })
    return { text: response.text, ...usage }
  }).pipe(instances.provide(input.session))
})

const responseHasOutput = (exit: Exit.Exit<LLMResponse, AIError>) => Exit.isSuccess(exit) && exit.value.text.length > 0

const responseTokens = (response: LLMResponse) => {
  const usage = response.usage
  return usage && SessionUsage.tokens(usage)
}
