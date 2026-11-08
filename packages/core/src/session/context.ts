export * as SessionContext from "./context.js"

import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Agent } from "../agent.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { McpInstructions } from "../mcp/instructions.js"
import { MessagingVars } from "../messaging/vars.js"
import { McpTool } from "../tool/mcp.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { Tool } from "../tool.js"
import { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { Config } from "../config.js"
import { ModelAlias } from "../model-alias.js"
import { ModelRoute } from "../model-route.js"
import { hasPackage } from "../model-resolver.js"
import { Provider } from "../provider.js"
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
  readonly initial: string
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
  /** Resolves the model and active history for that selection. */
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  readonly resolveModel: (
    session: SessionSchema.Info,
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
    const location = yield* Location.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service
    const vars = yield* MessagingVars.Service

    // Explicit session selections are execution, not discovery (#230): resolve
    // against the catalog so a session on a hidden model keeps working.
    const resolveModel = (session: SessionSchema.Info, requestTokens?: number) =>
      models.resolve(session, model.catalog, requestTokens)

    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      const primary = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
      const info = yield* Effect.gen(function* () {
        if (agent.model) return yield* model.get(agent.model.providerID, agent.model.id)
        if (!primary) return
        return yield* model.small(primary.ref.providerID)
      })
      const variant =
        agent.model?.variant ?? MINIMAL_REASONING_VARIANTS.find((id) => info?.variants.some((item) => item.id === id))
      const preferred =
        info &&
        (yield* resolveModel({
          ...session,
          model: Model.Ref.make({
            providerID: info.providerID,
            id: info.id,
            ...(variant ? { variant } : {}),
          }),
        }).pipe(Effect.orElseSucceed(() => undefined)))
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
      // Hide by effective tool name as well as permission action, so a plugin override cannot
      // re-expose `question` by assigning it a different permission action.
      const disabledTools = session.detached ? new Set(["question"]) : undefined
      const loaded = yield* Effect.all(
        {
          tools: registry.snapshot(permissions, disabledTools),
          builtins: builtins.load(),
          discovery: discovered(session.id),
          skills: skillInstructions.load(permissions),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(permissions),
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
          CodeModeInstructions.make(loaded.tools.codeModeCatalog),
          loaded.mcp,
          loaded.references,
          loaded.skills,
          loaded.discovery,
          loaded.builtins,
          loaded.entries,
        ]),
        tools: loaded.tools,
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

    const load = Effect.fn("SessionContext.load")(function* (selection: Selection) {
      // A routed model resolves to a leaf whose per-target context ceiling can only filter
      // live turns if resolution knows the request size (#891). Routed sessions always read
      // the local transcript (a routed model's provenance is undefined), so for a route the
      // history can be read first and sized with compaction's accounting, and that size is
      // threaded into the single resolution. Every other selection keeps the original
      // order and passes no size, so unknown sizes never filter and plain models are
      // unaffected.
      const selected = selection.session.model
      // The catalog lookup must see the effective selection: a bare alias pointing at a
      // route is expanded inside SessionRunnerModel.resolve, so mirror that expansion here
      // or an aliased route would never take the sized path below.
      let effective = selected
      if (selected && Option.isSome(config)) {
        const entries = yield* config.value.entries()
        const aliases = Config.latest(entries, "aliases")
        if (aliases) {
          // Same execution catalog as resolution below (#230): a hidden route
          // keeps precedence over an alias here too, or the sizing preflight
          // would follow the alias and skip the sized path.
          const catalog = yield* model.catalog()
          const exists = ({ providerID, modelID }: { providerID: string; modelID: string }) =>
            catalog.some((item) => item.providerID === providerID && item.id === modelID)
          try {
            const res = ModelAlias.resolveRef(aliases, ModelAlias.refString(selected), exists)
            effective = Model.Ref.make({
              providerID: Provider.ID.make(res.providerID),
              id: Model.ID.make(res.id),
              ...(res.variant ? { variant: Model.VariantID.make(res.variant) } : {}),
            })
          } catch {}
        }
      }
      const catalog = effective ? yield* model.get(effective.providerID, effective.id) : undefined
      // A session with no explicit model resolves through the global default, which can
      // itself be a route: determine the effective default catalog selection the same way
      // ModelResolver.resolve does (the configured default when it is usable, else the
      // first available packaged text model), or default-route sessions would bypass the
      // sized path and their per-target ceilings would never filter (#891).
      let fallback: Model.Info | undefined
      if (!selected) {
        const candidate = yield* model.default()
        fallback =
          candidate && hasPackage(candidate)
            ? candidate
            : (yield* model.available()).find((item) => hasPackage(item) && Model.supportsText(item))
      }
      const routeModel = catalog ?? fallback
      const route = routeModel && ModelRoute.definition(routeModel) !== undefined ? routeModel : undefined
      if (!route || (!selected && !fallback)) {
        const resolved = yield* resolveModel(selection.session)
        const history = yield* SessionHistory.entriesForRunner(
          db,
          selection.session.id,
          selection.instructions,
          SessionProviderContext.provenance(resolved) ?? "local",
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
      const history = yield* SessionHistory.entriesForRunner(db, selection.session.id, selection.instructions, "local")
      const messages = history.entries.map((entry) => entry.message)
      const requestTokens = SessionCompaction.estimateHistoryRequest({
        agent: selection.agent,
        model: {
          ref: effective ?? Model.Ref.make({ providerID: route.providerID, id: route.id }),
          capabilities: route.capabilities,
        },
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
      const resolved = yield* resolveModel(selection.session, requestTokens).pipe(
        Effect.catch(() => resolveModel(selection.session)),
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

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Model.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    McpInstructions.node,
    McpTool.node,
    MessagingVars.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
  ],
})
