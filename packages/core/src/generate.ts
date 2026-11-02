export * as Generate from "./generate.js"

import {
  LLM,
  LLMClient,
  AIError,
  type GenerationOptions,
  type LLMEvent,
  type LLMRequest,
  type LLMResponse,
  type Message,
  type ToolChoice,
  type ToolEntryInput,
  type Usage,
} from "@opencode/ai"
import { SessionID } from "@opencode/schema/session-id"
import { Cause, Context, Effect, Exit, Layer, Result, Schema, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "./effect/app-node-platform.js"
import { ModelResolver } from "./model-resolver.js"
import { ModelRoute } from "./model-route.js"
import { ModelRouteLog } from "./model-route-log.js"
import { MuseAttestation } from "./muse-attestation.js"
import { Model } from "./model.js"
import { SessionUsage } from "./session/usage.js"

export interface TextInput {
  readonly prompt: string
  readonly model?: Model.Ref
}

/** The caller-facing wire standards the façade doors speak (#1146). */
export type Dialect = "chat" | "responses" | "messages"

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
  /** The dialect of the door the call arrived through, when it arrived through one. */
  readonly dialect?: Dialect
  /**
   * The caller's request body exactly as the door received it. Only consulted
   * by the native-shape pass-through fast path (see `passthroughDialect`):
   * when the resolved model's native dialect matches `dialect`, this body —
   * not the translated canonical request — is what the provider receives.
   */
  readonly rawBody?: string
}

export class ModelSelectionError extends Schema.TaggedError<ModelSelectionError>()("Generate.ModelSelectionError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Generate.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

/**
 * A quota / rate-limit failure from the provider (#1441, design §2):
 * the attempt was refused because a quota is exhausted or a rate limit
 * was hit, so the façade must answer 429 — not the generic 502 — with
 * this message (which carries the provider's reset hint, when it gave
 * one) preserved verbatim. Distinguished at the Generate boundary,
 * where the provider's typed failure is still available, so HTTP
 * handlers never have to re-classify from message text.
 */
export class QuotaError extends Schema.TaggedError<QuotaError>()("Generate.QuotaError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

/**
 * An attestation denial from the muse backend (#1443): the upstream
 * answered 403 `client_attestation_denied` despite the facade's
 * backend-scoped tool aliasing (see MuseAttestation). The muse door
 * answers this case with a CLI-door fallback and a 200; the facade has
 * no CLI door, so the denial surfaces as a distinct provider failure -
 * failover-eligible, never quota-classified, never retried against the
 * same target - and the handlers map it to the design §2 502 envelope
 * like any other upstream failure.
 */
export class AttestationError extends Schema.TaggedError<AttestationError>()("Generate.AttestationError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = ModelSelectionError | UnavailableError | QuotaError | AttestationError

/**
 * The quota/rate-limit classification the routing and demotion
 * machinery already uses (session runner's `failureHint` /
 * `isQuotaFailure`, model-route bench hints): the provider classified
 * the failure as quota-exceeded or rate-limited, or it arrived as an
 * HTTP 429 — the status `classifyProviderFailure` maps to exactly
 * those two tags, so the status check only catches 429s a protocol
 * constructed without going through that classifier. Auth failures
 * are deliberately NOT quota: they keep their existing mapping.
 */
export const isQuotaFailure = (error: AIError): boolean =>
  error.reason._tag === "QuotaExceeded" || error.reason._tag === "RateLimit" || error.reason.http?.status === 429

export interface Interface {
  readonly text: (input: TextInput) => Effect.Effect<string, Error>
  readonly complete: (input: CompletionInput) => Effect.Effect<LLMResponse, Error>
  readonly stream: (input: CompletionInput) => Stream.Stream<LLMEvent, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Generate") {}

/**
 * The native dialect each wire protocol serves, for the protocols whose wire
 * shape IS one of the door dialects (spec §3, PR #1156): the protocol's body
 * is built directly on that dialect's fields and its stream is that dialect's
 * grammar, so a caller's payload in the dialect is a payload the provider
 * already speaks. Vendor variants qualify only where that holds exactly
 * (e.g. `alibaba-chat`/`zai-chat` reuse the OpenAI chat body fields and
 * stream; `meta-responses`/`xai-responses` reuse the Open Responses body).
 * Protocols with their own wire shape (gemini, bedrock-converse, cohere-chat,
 * mistral-chat, …) are absent: no declared native dialect means mismatch —
 * the safe default is translation.
 */
const NATIVE_DIALECTS: ReadonlyMap<string, Dialect> = new Map([
  ["openai-chat", "chat"],
  ["alibaba-chat", "chat"],
  ["zai-chat", "chat"],
  ["venice-chat", "chat"],
  ["open-responses", "responses"],
  ["openai-responses", "responses"],
  ["meta-responses", "responses"],
  ["xai-responses", "responses"],
  ["alibaba-responses", "responses"],
  ["anthropic-messages", "messages"],
  ["alibaba-messages", "messages"],
  ["meta-messages", "messages"],
  ["zai-messages", "messages"],
])

/** The provider endpoint path each door dialect targets, when the route declares a plain path. */
const DOOR_PATHS: Readonly<Record<Dialect, string>> = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
}

/**
 * Whether a call that arrived in `dialect` may take the native-shape
 * pass-through fast path against this resolved model (spec §3): the match is
 * judged against the resolved concrete model, after route selection. Any
 * doubt is a mismatch — an undeclared protocol dialect, a transport that is
 * not the HTTP JSON transport (a WebSocket-only route cannot take an HTTP
 * body verbatim), or a declared endpoint path that does not end at the
 * dialect's own path all fall back to translation, unchanged.
 */
export const passthroughDialect = (resolved: ModelResolver.Resolved, dialect: Dialect | undefined): Dialect | undefined => {
  if (dialect === undefined) return undefined
  const route = resolved.model.route
  if (NATIVE_DIALECTS.get(String(route.protocol)) !== dialect) return undefined
  if (route.transport.id !== "http-json") return undefined
  const path = route.endpoint.path
  if (typeof path === "string" && !path.endsWith(DOOR_PATHS[dialect])) return undefined
  return dialect
}

const isWhitespace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r"

/** End index (exclusive) of the JSON string starting at `start` (a `"`), or -1 when unterminated. */
const stringEnd = (raw: string, start: number): number => {
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === "\\") index++
    else if (raw[index] === '"') return index + 1
  }
  return -1
}

/** End index (exclusive) of the JSON value starting at `start`, or -1 when malformed. */
const valueEnd = (raw: string, start: number): number => {
  const char = raw[start]
  if (char === '"') return stringEnd(raw, start)
  if (char === "{" || char === "[") {
    const open = char
    const close = open === "{" ? "}" : "]"
    let depth = 0
    for (let index = start; index < raw.length; index++) {
      const current = raw[index]
      if (current === '"') {
        const end = stringEnd(raw, index)
        if (end === -1) return -1
        index = end - 1
      } else if (current === open) depth++
      else if (current === close) {
        depth--
        if (depth === 0) return index + 1
      }
    }
    return -1
  }
  let index = start
  while (index < raw.length && !isWhitespace(raw[index]) && raw[index] !== "," && raw[index] !== "}" && raw[index] !== "]")
    index++
  return index > start ? index : -1
}

/**
 * The pass-through body: the caller's raw body with exactly two fields
 * adapted, every other byte — provider extensions, field order, whitespace —
 * untouched.
 *
 * - `model` is replaced with the resolved concrete model's upstream ID. It
 *   is a façade-local selector (a route name or caller-facing ref), never
 *   the upstream's ID (spec §3: the single named exception to verbatim).
 * - `stream` is set to `true` when the caller did not already send
 *   `stream: true` (a `false` value is rewritten in place; an absent field
 *   is inserted after the opening brace). This codebase's provider layer is
 *   SSE-only on the wire — every protocol body hardcodes `stream: true` and
 *   non-streaming responses are folded from the stream — so a verbatim
 *   `stream: false` body would be unanswerable by the transport that must
 *   carry it. The door's streaming/non-streaming shape is unaffected: it is
 *   decided by what the caller asked the door for, not by this field.
 *
 * Returns undefined when the body cannot be adapted faithfully (not a JSON
 * object, no string `model` field, a duplicate `model` field, or a
 * non-boolean `stream`): any doubt falls back to the translation path.
 */
export const rewriteRawBody = (raw: string, modelID: string): string | undefined => {
  let index = 0
  while (isWhitespace(raw[index])) index++
  if (raw[index] !== "{") return undefined
  const insertAt = index + 1
  index++
  const edits: Array<{ start: number; end: number; text: string }> = []
  let modelSeen = false
  let streamSeen = false
  while (true) {
    while (isWhitespace(raw[index])) index++
    if (raw[index] === "}") break
    if (raw[index] !== '"') return undefined
    const keyStart = index
    const keyEnd = stringEnd(raw, index)
    if (keyEnd === -1) return undefined
    let key: unknown
    try {
      key = JSON.parse(raw.slice(keyStart, keyEnd))
    } catch {
      return undefined
    }
    index = keyEnd
    while (isWhitespace(raw[index])) index++
    if (raw[index] !== ":") return undefined
    index++
    while (isWhitespace(raw[index])) index++
    const start = index
    const end = valueEnd(raw, start)
    if (end === -1) return undefined
    if (key === "model") {
      if (modelSeen || raw[start] !== '"') return undefined
      modelSeen = true
      let current: unknown
      try {
        current = JSON.parse(raw.slice(start, end))
      } catch {
        return undefined
      }
      if (current !== modelID) edits.push({ start, end, text: JSON.stringify(modelID) })
    } else if (key === "stream") {
      streamSeen = true
      const value = raw.slice(start, end)
      if (value === "false") edits.push({ start, end, text: "true" })
      else if (value !== "true") return undefined
    }
    index = end
    while (isWhitespace(raw[index])) index++
    if (raw[index] === ",") {
      index++
      continue
    }
    if (raw[index] === "}") break
    return undefined
  }
  if (!modelSeen) return undefined
  if (!streamSeen) edits.push({ start: insertAt, end: insertAt, text: `"stream":true,` })
  const ordered = edits.toSorted((left, right) => right.start - left.start)
  let result = raw
  for (const edit of ordered) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

/**
 * Whether a provider failure is a shape-class rejection (spec §3): the
 * provider answered 400/422 with a dialect error. Quota and auth failures
 * carry their own error tags, so they never match — they follow the ordinary
 * demotion/failover path, never the translation retry.
 */
export const isShapeRejection = (error: AIError): boolean => {
  const status = error.reason.http?.status
  return error.reason._tag === "InvalidRequest" && (status === 400 || status === 422)
}

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

    const canonicalRequest = (resolved: ModelResolver.Resolved, input: CompletionInput, rawBody?: string) =>
      LLM.request({
        model: resolved.model,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        generation: input.generation,
        // Gateways require session attribution even for a stateless call; no Session is stored.
        http: {
          headers: { "x-opencode-session": SessionID.create() },
          ...(rawBody === undefined ? {} : { rawBody }),
        },
      })

    const build = Effect.fn("Generate.build")(function* (input: CompletionInput) {
      const resolved = yield* resolve(input.model)
      // Muse attestation aliasing (#1443): judged against the resolved
      // concrete model, exactly like the pass-through match below - only
      // the muse backend (provider `meta`) is subject to Meta's
      // subscription-key attestation gate, so only a muse target's
      // shell/bash tool names are presented upstream under the door's
      // aliases, on the translated input and on the raw pass-through
      // body alike. Every other provider keeps the design §9.1 rule:
      // tool names preserved verbatim. The messages dialect is the
      // door's absent front and is never aliased.
      const museTarget =
        String(resolved.ref.providerID) === MuseAttestation.PROVIDER_ID && input.dialect !== "messages"
      const attestation = museTarget ? MuseAttestation.plan(MuseAttestation.toolNames(input.tools)) : undefined
      const effective = attestation ? MuseAttestation.aliasInput(input, attestation) : input
      // The pass-through fast path (spec §3): on a dialect match the caller's
      // raw body, rewritten only as `rewriteRawBody` documents (plus the
      // attestation aliasing above, when it engages), is the body the
      // provider receives. Route selection has already happened above -
      // the same resolver, gates and demotion as the translated path - and
      // the attempt below is ledgered identically whichever path runs.
      const rawBody =
        attestation && input.rawBody !== undefined && (input.dialect === "chat" || input.dialect === "responses")
          ? (MuseAttestation.aliasRawBody(input.rawBody, input.dialect, attestation) ?? input.rawBody)
          : input.rawBody
      const raw =
        rawBody !== undefined && passthroughDialect(resolved, input.dialect) !== undefined
          ? rewriteRawBody(rawBody, String(resolved.model.id))
          : undefined
      return { resolved, raw, request: canonicalRequest(resolved, effective, raw), input: effective, attestation, museTarget }
    })

    const unavailable =
      (resolved: ModelResolver.Resolved, museTarget = false) =>
      (error: AIError): Error =>
        museTarget && MuseAttestation.isAttestationDenial(error)
          ? new AttestationError({ message: error.message, service: resolved.ref.providerID })
          : isQuotaFailure(error)
            ? new QuotaError({ message: error.message, service: resolved.ref.providerID })
            : new UnavailableError({ message: error.message, service: resolved.ref.providerID })

    const observe = (resolved: ModelResolver.Resolved) =>
      ModelRouteLog.observer(
        {
          routeID: resolved.routing?.routeID ?? "",
          providerID: resolved.ref.providerID,
          modelID: resolved.ref.id,
          variant: resolved.ref.variant,
          credentialID: resolved.servingCredentialID ?? resolved.routing?.credentialID,
          startedAt: Date.now(),
        },
        (snapshot) => ModelRoute.observeRateLimit(resolved.ref, snapshot, Date.now(), resolved.routing?.credentialID),
      )

    const tokensOf = (usage: Usage | undefined) => (usage === undefined ? undefined : SessionUsage.tokens(usage))

    /** One ledgered attempt against a resolved model (spec §7): every façade
     * attempt lands in route_attempt with usage accounting, session_id NULL,
     * exactly as a session attempt does — pass-through attempts included. */
    const attempt = Effect.fn("Generate.attempt")(function* (resolved: ModelResolver.Resolved, request: LLMRequest) {
      const observed = observe(resolved)
      const started = Date.now()
      return yield* llm.generate(request, observed.options({})).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const tokens = Exit.isSuccess(exit) ? tokensOf(exit.value.usage) : undefined
            observed.done(Exit.isSuccess(exit) ? "success" : Exit.hasInterrupts(exit) ? "interrupted" : "failure", {
              failure: Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause),
              outputStarted: Exit.isSuccess(exit) && exit.value.text.length > 0,
              firstOutputAt: Exit.isSuccess(exit) ? started : undefined,
              tokens,
            })
            if (tokens) ModelRoute.recordRequest(resolved.ref, tokens)
          }),
        ),
      )
    })

    const runComplete = Effect.fn("Generate.runComplete")(function* (input: CompletionInput) {
      const { resolved, raw, request, input: effective, attestation, museTarget } = yield* build(input)
      // Returned tool calls are translated back under the caller's own
      // names whenever attestation aliasing engaged (#1443).
      const unalias = (response: LLMResponse) => (attestation ? MuseAttestation.unaliasResponse(response, attestation) : response)
      const first = yield* Effect.result(attempt(resolved, request))
      if (Result.isSuccess(first)) return unalias(first.success)
      // Shape-rejection fallback (spec §3): a supposedly-native provider that
      // rejects the verbatim shape is retried ONCE through translation
      // against the same resolved model. Both tries are separate ledger
      // rows (each `attempt` records its own), so the retry is never a
      // silent second billing. Quota/auth failures never reach this branch.
      if (raw !== undefined && first.failure instanceof AIError && isShapeRejection(first.failure)) {
        const second = yield* Effect.result(attempt(resolved, canonicalRequest(resolved, effective)))
        if (Result.isSuccess(second)) return unalias(second.success)
        return yield* Effect.fail(unavailable(resolved, museTarget)(second.failure))
      }
      return yield* Effect.fail(unavailable(resolved, museTarget)(first.failure))
    })

    const complete: Interface["complete"] = (input) =>
      runComplete(input).pipe(
        Effect.catchTag("Integration.Authorization", () =>
          Effect.fail(new UnavailableError({ message: "Generation credentials are unavailable" })),
        ),
      )

    const attemptStream = (resolved: ModelResolver.Resolved, request: LLMRequest, onEvent: () => void) => {
      const observed = observe(resolved)
      let usage: Usage | undefined
      let firstOutputAt: number | undefined
      return llm.stream(request, observed.options({})).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            onEvent()
            if (firstOutputAt === undefined) firstOutputAt = Date.now()
            if ((event.type === "step-finish" || event.type === "finish") && event.usage) usage = event.usage
          }),
        ),
        Stream.onExit((exit) =>
          Effect.sync(() => {
            const tokens = Exit.isSuccess(exit) ? tokensOf(usage) : undefined
            observed.done(Exit.isSuccess(exit) ? "success" : Exit.hasInterrupts(exit) ? "interrupted" : "failure", {
              failure: Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause),
              outputStarted: firstOutputAt !== undefined,
              firstOutputAt,
              tokens,
            })
            if (tokens) ModelRoute.recordRequest(resolved.ref, tokens)
          }),
        ),
      )
    }

    const stream: Interface["stream"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { resolved, raw, request, input: effective, attestation, museTarget } = yield* build(input)
          let emitted = 0
          const primary = attemptStream(resolved, request, () => emitted++)
          // The streaming shape-rejection fallback: only before any event
          // has been emitted (a retry after output would duplicate it), and
          // only for the pass-through path's shape-class failures.
          const composed =
            raw === undefined
              ? primary
              : primary.pipe(
                  Stream.catchCause((cause) => {
                    const error = Cause.squash(cause)
                    return emitted === 0 && error instanceof AIError && isShapeRejection(error)
                      ? attemptStream(resolved, canonicalRequest(resolved, effective), () => {})
                      : Stream.failCause(cause)
                  }),
                )
          // Streamed tool events are translated back under the caller's
          // own names whenever attestation aliasing engaged (#1443).
          const renamed = attestation
            ? composed.pipe(Stream.map((event) => MuseAttestation.unaliasEvent(event, attestation)))
            : composed
          return renamed.pipe(Stream.mapError(unavailable(resolved, museTarget)))
        }).pipe(
          Effect.catchTag("Integration.Authorization", () =>
            Effect.fail(new UnavailableError({ message: "Generation credentials are unavailable" })),
          ),
        ),
      )

    const runText = Effect.fn("Generate.text")(function* (input: TextInput) {
      const response = yield* runComplete({ model: input.model, messages: [{ role: "user", content: input.prompt }] })
      return response.text
    })

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
