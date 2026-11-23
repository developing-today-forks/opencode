export * as SessionContext from "./context.js"

import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Agent } from "../agent.js"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { CodeModeTool } from "../codemode/tool.js"
import { Database } from "../database/database.js"
import { FileAccess } from "../file-access.js"
import { FileMutation } from "../file-mutation.js"
import { FileWrite } from "../file-write.js"
import { Flag } from "../flag.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { MachineInstructions } from "../machine/instructions.js"
import { McpInstructions } from "../mcp/instructions.js"
import { MessagingVars } from "../messaging/vars.js"
import { McpTool } from "../tool/mcp.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { Tool } from "../tool.js"
import { modelTools } from "../tool/model-policy.js"
import { WebSearch } from "../websearch.js"
import { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRoute } from "../model-route.js"
import { SessionCompaction } from "./compaction.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly tools: Tool.Snapshot
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection. `chosen` is a route member a
   * turn already continues on (the next member after a failure with output): resolving again
   * could choose a different member, so it is kept — unless the active history has outgrown
   * its per-target context ceiling, in which case its own fallback chain is walked to the
   * first later member that fits (#2680). */
  readonly load: (
    selection: Selection,
    chosen?: SessionRunnerModel.Resolved,
  ) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  readonly resolveModel: (
    session: SessionSchema.Info,
    request: { readonly kind: SessionRequestKind; readonly agent: Agent.ID },
    /** The live request's context size in tokens, when known: route targets whose per-target ceiling it exceeds
     * are skipped (#891). */
    requestTokens?: number,
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /** Selects auxiliary title capabilities without instruction or tool preflight. */
  readonly selectTitle: (session: SessionSchema.Info) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  readonly request: SessionModelRequest.Interface
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const builtins = yield* InstructionBuiltIns.Service
    const model = yield* Model.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const flags = yield* Flag.Service
    const location = yield* Location.Service
    const machineInstructions = yield* MachineInstructions.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service
    const vars = yield* MessagingVars.Service
    const services = yield* CodeModeTool.services
    const websearch = yield* WebSearch.Service

    // Explicit session selections are execution, not discovery (#230): resolve
    // against the catalog so a session on a hidden model keeps working.
    const resolveModel = (
      session: SessionSchema.Info,
      request: { readonly kind: SessionRequestKind; readonly agent: Agent.ID },
      requestTokens?: number,
    ) => models.resolve(session, model.catalog, request, requestTokens)

    // A routed resolution spends a bench probe claim at pick time (#1478); a member load
    // resolves but never attempts must hand its claim back, the same release title
    // generation performs for its unused resolutions.
    const releaseProbeClaim = (resolved: SessionRunnerModel.Resolved) => {
      const claim = resolved.routing?.probeClaim
      if (!claim || !resolved.routing) return
      ModelRoute.releaseBenchProbe(resolved.routing.target, undefined, claim.claimedAt, claim.token)
      if (claim.credentialID)
        ModelRoute.releaseBenchProbe(resolved.routing.target, claim.credentialID, claim.claimedAt, claim.token)
    }

    /** The member a continuation should actually run on, when the chosen one no longer
     * fits (#2680). The member a turn continues on was picked by the failed step's
     * fallback, which judged per-target context ceilings with the request size captured
     * when the failed member was resolved — before that step's output entered the
     * history. Re-judged here, where the active history is read: when the member no
     * longer fits, its own fallback chain (which skips every member already served) is
     * walked to the first member that fits the active size. Any doubt — no routing, an
     * unknown size, a route definition that no longer names the member, a fallback that
     * fails — returns undefined and keeps the chosen member, so automatic compaction
     * still gets its chance, the same degrade the sized initial resolution makes. */
    const fitContinuation = Effect.fn("SessionContext.fitContinuation")(function* (
      selection: Selection,
      chosen: SessionRunnerModel.Resolved,
      initial: Loaded["initial"],
      messages: ReadonlyArray<SessionMessage.Info>,
    ) {
      const routing = chosen.routing
      if (!routing) return undefined
      const requestTokens = SessionCompaction.estimateHistoryRequest({
        agent: selection.agent,
        model: { ref: chosen.ref, capabilities: chosen.capabilities },
        tools: selection.tools,
        initial,
        messages,
      })
      if (requestTokens === undefined) return undefined
      const selected = yield* models
        .select(selection.session, model.catalog)
        .pipe(Effect.orElseSucceed(() => undefined))
      const definition = selected && ModelRoute.definition(selected.info)
      if (!definition || definition.id !== routing.routeID) return undefined
      const fits = (member: SessionRunnerModel.Resolved) => {
        const target = member.routing?.target
        const index = target && ModelRoute.memberIndex(definition, target)
        return index === undefined || !ModelRoute.overLimit(definition, index, requestTokens)
      }
      if (fits(chosen)) return undefined
      yield* Effect.logInfo("continuation member is over its context ceiling for the active history", {
        routeID: routing.routeID,
        from: `${routing.target.providerID}/${routing.target.id}`,
        requestTokens,
      })
      releaseProbeClaim(chosen)
      let candidate = yield* routing.fallback().pipe(Effect.orElseSucceed(() => undefined))
      while (candidate) {
        if (fits(candidate)) return candidate
        releaseProbeClaim(candidate)
        const next = candidate.routing?.fallback()
        candidate = next ? yield* next.pipe(Effect.orElseSucceed(() => undefined)) : undefined
      }
      return undefined
    })

    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      const primary = yield* resolveModel(session, { kind: "title", agent: agent.id }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const candidate = yield* Effect.gen(function* () {
        if (agent.model) {
          const info = yield* model.get(agent.model.providerID, agent.model.id)
          return info && { info, variant: agent.model.variant ?? minimalVariant(info) }
        }
        if (!primary) return
        const small = yield* model.small(primary.ref.providerID)
        if (small) return { info: small, variant: minimalVariant(small) }
        // Without a lower variant, the primary model at its selected variant is already the fallback.
        const info = yield* model.get(primary.ref.providerID, primary.ref.id)
        const variant = info && lowerVariant(info, primary.ref.variant)
        return variant && { info, variant }
      })
      const preferred =
        candidate &&
        (yield* resolveModel(
          {
            ...session,
            model: Model.Ref.make({
              providerID: candidate.info.providerID,
              id: candidate.info.id,
              ...(candidate.variant ? { variant: candidate.variant } : {}),
            }),
          },
          { kind: "title", agent: agent.id },
        ).pipe(Effect.orElseSucceed(() => undefined)))
      const selected = preferred ?? primary
      if (!selected) return
      return { agent, primary, selected }
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      yield* mcpTools.flush
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      // Session permissions narrow discovery the same way they narrow the tool snapshot.
      const permissions = Permission.effectiveRules(agent.info.permissions, session)
      const [selected, hasWebSearch, fullCodeMode] = yield* Effect.all(
        [
          models.select(session, model.catalog).pipe(Effect.orElseSucceed(() => undefined)),
          websearch.available(),
          flags.enabled("full_codemode"),
        ],
        { concurrency: "unbounded" },
      )
      const fallbackRef = session.model ?? agent.info.model
      const policyModel = selected?.info ?? (fallbackRef && Model.Info.default(fallbackRef.providerID, fallbackRef.id))
      const policy = modelTools({
        model: policyModel,
        websearch: hasWebSearch,
        fullCodeMode: fullCodeMode && Tool.codeModeAvailable(permissions),
      })
      // A detached session has no one to answer a question, so the tool is hidden by its effective name as well as
      // its permission action: a plugin override cannot re-expose `question` under a different action.
      if (session.detached) policy.hidden.add("question")
      const tools = yield* registry.snapshot(permissions, {
        services,
        // An agent that can't run `execute` (such as explore) keeps every tool direct, so give it the flag-off policy.
        tools: policy,
      })
      const loaded = yield* Effect.all(
        {
          builtins: builtins.load(),
          discovery: discovered(session.id),
          skills: skillInstructions.load(permissions),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(tools),
          machines: machineInstructions.load(),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      return {
        session,
        agent: { ...agent, info: agent.info },
        // Ordered from most to least shared across sessions so the baseline stays a reusable
        // prompt-cache prefix: user-level catalog and guidance, then project instructions, then
        // the date and environment, which vary by day and directory.
        instructions: Instructions.combine([
          CodeModeInstructions.make(tools.codeModeCatalog),
          loaded.mcp,
          loaded.references,
          loaded.skills,
          loaded.machines,
          loaded.discovery,
          loaded.builtins,
          loaded.entries,
        ]),
        tools,
      }
    })

    // Instruction files whose frontmatter sets `vars` render the session's variables, stripped of
    // that frontmatter. Time variables resolve to the session start so the value stays stable.
    const discovered = Effect.fn("SessionContext.discovered")(function* (sessionID: SessionSchema.ID) {
      return (yield* discovery.load()).map((source) => ({
        ...source,
        read: source.read.pipe(
          Effect.flatMap((value) => {
            const files = Option.getOrUndefined(decodeFiles(value))
            if (!files) return Effect.succeed(value)
            return Effect.forEach(files, (file) =>
              vars.inject(file.content, sessionID).pipe(Effect.map((content) => ({ path: file.path, content }))),
            )
          }),
        ),
      }))
    })

    const load = Effect.fn("SessionContext.load")(function* (
      selection: Selection,
      chosen?: SessionRunnerModel.Resolved,
    ) {
      // A route member a turn already continues on is kept: resolving again could choose
      // another member. The one exception is a member the grown history no longer fits
      // (#2680): fitContinuation walks its fallback chain to a later member that fits.
      if (chosen) {
        const history = yield* SessionHistory.entriesForRunner(
          db,
          selection.session.id,
          selection.instructions,
          chosen.ref,
        )
        const messages = history.entries.map((entry) => entry.message)
        const fitted = yield* fitContinuation(selection, chosen, history.initial, messages)
        if (!fitted) {
          return {
            session: selection.session,
            agent: selection.agent,
            model: chosen,
            initial: history.initial,
            messages,
            tools: selection.tools,
          }
        }
        // The substitute replays a different native-compaction boundary — a window only
        // replays on the model that made it — so the history is re-read on its ref.
        const refit = yield* SessionHistory.entriesForRunner(
          db,
          selection.session.id,
          selection.instructions,
          fitted.ref,
        )
        return {
          session: selection.session,
          agent: selection.agent,
          model: fitted,
          initial: refit.initial,
          messages: refit.entries.map((entry) => entry.message),
          tools: selection.tools,
        }
      }
      const request = { kind: "primary" as const, agent: selection.agent.id }
      // A routed model resolves to a leaf whose per-target context ceiling can only filter live turns if resolution
      // knows the request size (#891). For a route the history is read first, shaped for the route's own entry, and
      // sized with compaction's accounting; that size is threaded into the single resolution. Every other selection
      // keeps the original order and passes no size, so unknown sizes never filter and plain models are unaffected.
      const selected = yield* models.select(selection.session, model.catalog).pipe(Effect.option)
      const route =
        Option.isSome(selected) && ModelRoute.definition(selected.value.info) !== undefined ? selected.value : undefined
      if (!route) {
        const resolved = yield* resolveModel(selection.session, request)
        const history = yield* SessionHistory.entriesForRunner(
          db,
          selection.session.id,
          selection.instructions,
          resolved.ref,
        )
        return {
          session: selection.session,
          agent: selection.agent,
          model: resolved,
          initial: history.initial,
          messages: history.entries.map((entry) => entry.message),
          tools: selection.tools,
        }
      }
      const ref = Model.Ref.make({
        providerID: route.info.providerID,
        id: route.info.id,
        ...(route.variant === undefined ? {} : { variant: route.variant }),
      })
      const history = yield* SessionHistory.entriesForRunner(db, selection.session.id, selection.instructions, ref)
      const messages = history.entries.map((entry) => entry.message)
      const requestTokens = SessionCompaction.estimateHistoryRequest({
        agent: selection.agent,
        model: { ref, capabilities: route.info.capabilities },
        tools: selection.tools,
        initial: history.initial,
        messages,
      })
      // If the sized resolution fails, automatic compaction — which runs after load and
      // exists precisely to shrink an oversized history — must still get its chance, so
      // fall back to the unsized resolution (the pre-#891 behaviour) and let it run. That
      // covers both every target being over its ceiling (RouteUnavailableError) and the
      // mixed case where the over-limit targets are filtered out and a fitting target
      // then fails to initialize: resolveRoute surfaces that as the target's own error
      // (e.g. ModelConfigurationError), not RouteUnavailableError. If the unsized
      // resolution also fails, that error surfaces unchanged.
      const resolved = yield* resolveModel(selection.session, request, requestTokens).pipe(
        Effect.catch(() => resolveModel(selection.session, request)),
      )
      return {
        session: selection.session,
        agent: selection.agent,
        model: resolved,
        initial: history.initial,
        messages,
        tools: selection.tools,
      }
    })

    return Service.of({ select, load, resolveModel, selectTitle, request })
  }),
)

/** Variant IDs that minimize reasoning output, in preference order. */
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

// Discovered instruction files as stored: the JSON encoding of `InstructionDiscovery.File[]`.
const decodeFiles = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
)
const minimalVariant = (info: Model.Info) =>
  MINIMAL_REASONING_VARIANTS.find((id) => info.variants.some((item) => item.id === id))

/**
 * `none` and `minimal` always reduce reasoning. `low` can enable reasoning on a model whose default
 * does not reason, so it is only used when it ranks below the variant the session selected.
 */
const lowerVariant = (info: Model.Info, selected: Model.VariantID | undefined) => {
  const rank = (id: Model.VariantID | undefined) => info.variants.findIndex((item) => item.id === id)
  return MINIMAL_REASONING_VARIANTS.find((id) => rank(id) !== -1 && (id !== "low" || rank(id) < rank(selected)))
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Model.node,
    Database.node,
    FileAccess.node,
    FileMutation.node,
    FileWrite.node,
    Flag.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    MachineInstructions.node,
    McpInstructions.node,
    McpTool.node,
    MessagingVars.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
    WebSearch.node,
  ],
})
