export * as Generate from "./generate.js"

import {
  LLM,
  LLMClient,
  AIError,
  type GenerationOptions,
  type LLMEvent,
  type LLMResponse,
  type Message,
  type ToolChoice,
  type ToolEntryInput,
} from "@opencode/ai"
import { SessionID } from "@opencode/schema/session-id"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "./effect/app-node-platform.js"
import { ModelResolver } from "./model-resolver.js"
import { ModelRoute } from "./model-route.js"
import { Model } from "./model.js"

export interface TextInput {
  readonly prompt: string
  readonly model?: Model.Ref
}

/**
 * One stateless chat completion for an external harness (the server's
 * OpenAI-compatible door, #1405): a full message history plus optional
 * tool definitions, resolved and executed exactly like `text` — through
 * ModelResolver (in-process route resolution) and the LLM client — with
 * no Session created or stored.
 */
export interface CompletionInput {
  readonly model?: Model.Ref
  readonly system?: string
  readonly messages: ReadonlyArray<Message | Message.Input>
  readonly tools?: ReadonlyArray<ToolEntryInput>
  readonly toolChoice?: ToolChoice.Input
  readonly generation?: GenerationOptions.Input
}

export class ModelSelectionError extends Schema.TaggedError<ModelSelectionError>()("Generate.ModelSelectionError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Generate.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = ModelSelectionError | UnavailableError

export interface Interface {
  readonly text: (input: TextInput) => Effect.Effect<string, Error>
  readonly complete: (input: CompletionInput) => Effect.Effect<LLMResponse, Error>
  readonly stream: (input: CompletionInput) => Stream.Stream<LLMEvent, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Generate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const resolver = yield* ModelResolver.Service

    const resolve = Effect.fn("Generate.resolve")(function* (requested?: Model.Ref) {
      const resolved = yield* resolver.resolve(requested).pipe(
        Effect.catchTag("SessionRunnerModel.RouteUnavailableError", (error) =>
          Effect.fail(new UnavailableError({ message: error.message, service: ModelRoute.PROVIDER_ID })),
        ),
        Effect.catchTag(
          [
            "SessionRunnerModel.VariantUnavailableError",
            "SessionRunnerModel.UnsupportedPackageError",
            "SessionRunnerModel.ModelConfigurationError",
            "SessionRunnerModel.ModelInitializationError",
            "SessionRunnerModel.UnresolvedProviderVariablesError",
            "SessionRunnerModel.UnsupportedCompactionError",
          ],
          (error) => {
            const mapped: Error = requested
              ? new ModelSelectionError({ message: error.message })
              : new UnavailableError({ message: error.message, service: error.providerID })
            return Effect.fail(mapped)
          },
        ),
      )
      if (!resolved)
        return yield* new ModelSelectionError({
          message: requested
            ? `Model unavailable: ${requested.providerID}/${requested.id}`
            : "No model specified and no supported model is available",
        })
      return resolved
    })

    const build = Effect.fn("Generate.build")(function* (input: CompletionInput) {
      const resolved = yield* resolve(input.model)
      return {
        resolved,
        request: LLM.request({
          model: resolved.model,
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          toolChoice: input.toolChoice,
          generation: input.generation,
          // Gateways require session attribution even for a stateless call; no Session is stored.
          http: { headers: { "x-opencode-session": SessionID.create() } },
        }),
      }
    })

    const unavailable = (resolved: ModelResolver.Resolved) => (error: AIError) =>
      new UnavailableError({ message: error.message, service: resolved.ref.providerID })

    const runText = Effect.fn("Generate.text")(function* (input: TextInput) {
      const { resolved, request } = yield* build({ model: input.model, messages: [{ role: "user", content: input.prompt }] })
      const response = yield* llm.generate(request).pipe(Effect.mapError(unavailable(resolved)))
      return response.text
    })

    const complete: Interface["complete"] = (input) =>
      Effect.gen(function* () {
        const { resolved, request } = yield* build(input)
        return yield* llm.generate(request).pipe(Effect.mapError(unavailable(resolved)))
      }).pipe(
        Effect.catchTag("Integration.Authorization", () =>
          Effect.fail(new UnavailableError({ message: "Generation credentials are unavailable" })),
        ),
      )

    const stream: Interface["stream"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { resolved, request } = yield* build(input)
          return llm.stream(request).pipe(Stream.mapError(unavailable(resolved)))
        }).pipe(
          Effect.catchTag("Integration.Authorization", () =>
            Effect.fail(new UnavailableError({ message: "Generation credentials are unavailable" })),
          ),
        ),
      )

    const text: Interface["text"] = (input) =>
      runText(input).pipe(
        Effect.catchTag("Integration.Authorization", () =>
          Effect.fail(
            new UnavailableError({
              message: "Generation credentials are unavailable",
            }),
          ),
        ),
      )

    return Service.of({ text, complete, stream })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ModelResolver.node, llmClient],
})
