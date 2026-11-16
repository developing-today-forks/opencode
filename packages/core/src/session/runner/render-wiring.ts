export * as SessionRunnerRenderWiring from "./render-wiring.js"

import { ModelPlan } from "../../model-plan.js"
import { SessionRunnerRenderCard } from "./render-card.js"

/**
 * The live wiring for the render-card seam (opencode#2384 slices 2–3,
 * design A; follow-on to the seam module in `render-card.ts`).
 *
 * The seam module holds the decisions as pure data; this module holds
 * the session state and the plan-store effects the live runner needs
 * to act on them:
 *
 * - the per-session latches (the tier chooser is asked at most once
 *   per session; a quota wall is offered at most once until a render
 *   answer settles it), kept in module maps like the step's own
 *   attempt accounting in `step.ts`;
 * - the card inputs derived from the plan store the resolver already
 *   reads — the chooser's tiers (one model per tier the store knows)
 *   and the quota card's three actions (a switch needs another
 *   provider the store knows, a downgrade needs a lower tier than the
 *   walled model's). When the store cannot supply a card's inputs,
 *   the wiring produces no directive and behavior is exactly as
 *   before — a card is never fabricated from guessed providers;
 * - answer application: a submitted answer from a real
 *   `openchamber_render` tool result is parsed by the seam and
 *   applied through the plan store (`ModelPlan.setModel` via
 *   `applyTierChoice`, and the user-source note via
 *   `ModelPlan.addNote`), so what the user picked is durable before
 *   the turn moves on.
 */

const STATE_LIMIT = 1_000

const chooserAskedSessions = new Set<string>()
const offeredWalls = new Map<string, SessionRunnerRenderCard.QuotaWall>()
const cardTiers = new Map<string, ModelPlan.Tier>()
const pendingApplications = new Map<string, PendingApplication>()

/** A render answer's not-yet-applied routing effect, drained by the runner loop. */
export interface PendingApplication {
  /** The model a tier-choice answer picked, as a "provider/model" store key. */
  readonly modelChoice?: { readonly tier: ModelPlan.Tier; readonly model: string }
  /** The routing instruction of a quota-fallback answer. */
  readonly instruction?:
    | { readonly kind: "switch"; readonly providerID: string; readonly tier: ModelPlan.Tier }
    | { readonly kind: "wait"; readonly until?: number }
}

const bound = <T>(map: Map<string, T> | Set<string>) => {
  while (map.size > STATE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

/** Whether the tier chooser has already been offered in this session. */
export const chooserAsked = (sessionID: string): boolean => chooserAskedSessions.has(sessionID)

export const markChooserAsked = (sessionID: string) => {
  chooserAskedSessions.delete(sessionID)
  chooserAskedSessions.add(sessionID)
  bound(chooserAskedSessions)
}

/** The quota wall currently offered in this session, if any. */
export const offeredWall = (sessionID: string): SessionRunnerRenderCard.QuotaWall | undefined =>
  offeredWalls.get(sessionID)

export const offerWall = (sessionID: string, wall: SessionRunnerRenderCard.QuotaWall) => {
  offeredWalls.delete(sessionID)
  offeredWalls.set(sessionID, wall)
  bound(offeredWalls)
}

export const clearWall = (sessionID: string) => {
  offeredWalls.delete(sessionID)
  cardTiers.delete(sessionID)
}

/**
 * Takes (and clears) the pending routing effect a render answer left
 * for this session, if any. The runner loop drains this before the
 * next model request: a tier choice or a quota switch selects its
 * model, a quota wait delays the request. Draining is destructive so
 * an answer is applied exactly once.
 */
export const takePendingApplication = (sessionID: string): PendingApplication | undefined => {
  const pending = pendingApplications.get(sessionID)
  pendingApplications.delete(sessionID)
  return pending
}

const recordPending = (sessionID: string, pending: PendingApplication) => {
  pendingApplications.set(sessionID, { ...pendingApplications.get(sessionID), ...pending })
  bound(pendingApplications)
}

/** Drops every latch for a session (tests and session teardown). */
export const clearSession = (sessionID: string) => {
  chooserAskedSessions.delete(sessionID)
  offeredWalls.delete(sessionID)
  cardTiers.delete(sessionID)
  pendingApplications.delete(sessionID)
}

const TIER_ORDER: ReadonlyArray<ModelPlan.Tier> = ["cheap", "standard", "frontier"]

/**
 * The chooser card's tiers from the plan store: the first model (by
 * name) the store carries at each tier, in tier order. An empty
 * result means the store knows no tiered models and no card can be
 * drawn.
 */
export const tiersFromStore = (store: ModelPlan.Store): SessionRunnerRenderCard.TierOption[] => {
  const tiers: SessionRunnerRenderCard.TierOption[] = []
  for (const tier of TIER_ORDER) {
    const model = Object.keys(store.models)
      .filter((key) => store.models[key]?.tier === tier)
      .sort()
      .at(0)
    if (model !== undefined) tiers.push({ tier, model })
  }
  return tiers
}

/** The first model (by store key) a provider carries at a tier, when it carries one. */
export const modelForProviderTier = (
  store: ModelPlan.Store,
  providerID: string,
  tier: ModelPlan.Tier,
): string | undefined =>
  Object.keys(store.models)
    .filter((key) => key.startsWith(`${providerID}/`) && store.models[key]?.tier === tier)
    .sort()
    .at(0)

/** The tier the plan store records for one model, when it records one. */
export const tierOfModel = (store: ModelPlan.Store, providerID: string, modelID: string): ModelPlan.Tier | undefined =>
  store.models[`${providerID}/${modelID}`]?.tier

const DOWNGRADE: Readonly<Record<ModelPlan.Tier, ModelPlan.Tier | undefined>> = {
  frontier: "standard",
  standard: "cheap",
  cheap: undefined,
}

/**
 * The quota card's three actions, derived from the plan store: a
 * switch to another provider the store knows (an active plan's
 * provider first, then any plan, then a tiered model's provider), a
 * downgrade of the walled provider to the next tier down, and the
 * wait on the walled provider/tier itself. Undefined when any action
 * cannot be derived — the card requires all three, and an invented
 * provider would be worse than no card.
 */
export const fallbackActionsFor = (
  store: ModelPlan.Store,
  wall: SessionRunnerRenderCard.QuotaWall,
): ReadonlyArray<SessionRunnerRenderCard.FallbackAction> | undefined => {
  const tier = tierOfModel(store, wall.providerID, wall.modelID) ?? "standard"
  const downgradeTier = DOWNGRADE[tier]
  if (downgradeTier === undefined) return undefined
  const providers = [
    ...store.plans.filter((plan) => ModelPlan.feedsGate(plan)).map((plan) => plan.providerID),
    ...store.plans.map((plan) => plan.providerID),
    ...Object.keys(store.models).map((key) => key.split("/")[0]),
  ]
  const switchProvider = providers.find((provider) => provider !== undefined && provider !== "" && provider !== wall.providerID)
  if (switchProvider === undefined) return undefined
  return [
    { kind: "switch-provider", provider: switchProvider, tier },
    { kind: "downgrade-tier", provider: wall.providerID, tier: downgradeTier },
    { kind: "wait-for-reset", provider: wall.providerID, tier },
  ]
}

/**
 * The step-start chooser directive for a session, when the seam's
 * trigger fires: the render tool is in the step's tool set, the step
 * resolved without a route, and the chooser has not been asked this
 * session. Firing latches the session. Undefined (no injection,
 * behavior unchanged) when the trigger does not fire or the plan
 * store names no tiered model to put on the card.
 */
export const chooserDirective = (input: {
  readonly sessionID: string
  readonly toolNames: Iterable<string>
  readonly routeBare: boolean
  readonly dataDir?: string
}): string | undefined => {
  if (
    !SessionRunnerRenderCard.tierChooserTrigger({
      hasRenderTool: SessionRunnerRenderCard.hasRenderTool(input.toolNames),
      routeBare: input.routeBare,
      alreadyAsked: chooserAsked(input.sessionID),
    })
  )
    return undefined
  const tiers = tiersFromStore(ModelPlan.readStore(input.dataDir))
  if (tiers.length === 0) return undefined
  markChooserAsked(input.sessionID)
  return SessionRunnerRenderCard.tierChooserDirective(tiers)
}

/**
 * The quota-fallback directive for a wall the step ended in, when the
 * plan store can supply the card's three actions. Undefined when it
 * cannot — the caller then ends the step with the original error, as
 * before. A wall that produces no directive must not stay latched
 * (#2468): the step latched it before anyone knew a card could be
 * built, and a latch that outlives a cardless wall disables the
 * fallback remedy for the rest of the session, so an underivable
 * directive clears the session's offered wall here — the mirror of
 * the chooser marking asked only after its tiers are known.
 */
export const wallDirective = (
  sessionID: string,
  wall: SessionRunnerRenderCard.QuotaWall,
  dataDir?: string,
): string | undefined => {
  const actions = fallbackActionsFor(ModelPlan.readStore(dataDir), wall)
  if (actions === undefined) {
    clearWall(sessionID)
    return undefined
  }
  // Capture the tier the card was built with (the wait action carries
  // it, including the "standard" fallback for a walled model the store
  // has no entry for): the answer must be parsed against the card the
  // user actually saw, not a store read at answer time, which may
  // lack the entry or have been edited since (#2452 review F1).
  const waitAction = actions.find((action) => action.kind === "wait-for-reset")
  if (waitAction !== undefined) {
    cardTiers.set(sessionID, waitAction.tier)
    bound(cardTiers)
  }
  return SessionRunnerRenderCard.quotaFallbackDirective(wall, actions)
}

/** What applying one render tool result did, for the caller's record. */
export interface Applied {
  readonly answer: SessionRunnerRenderCard.RenderAnswer
  /** The user-source plan note recorded for the answer, when one was. */
  readonly note?: ModelPlan.NoteInput
  /** The model a tier-choice answer picked, for the runner to select as the session model. */
  readonly modelChoice?: { readonly tier: ModelPlan.Tier; readonly model: string }
  /** The routing instruction of a quota-fallback answer, when the answer was one. */
  readonly instruction?:
    | { readonly kind: "switch"; readonly providerID: string; readonly tier: ModelPlan.Tier }
    | { readonly kind: "wait"; readonly until?: number }
}

/**
 * Applies one real `openchamber_render` tool result for a session:
 * parses it with the seam, then — for a tier choice — records the
 * chosen model's tier in the plan store and appends the user-source
 * note; for a quota fallback — appends the user-source note and
 * returns the routing instruction. Either answer settles the
 * session's offered wall. A chat answer records nothing (the user's
 * own next message is the record) and also settles the wall. Returns
 * undefined for a result that carries no answer (`none`): a failed
 * or unanswered render call changes nothing.
 */
export const applyToolResult = (input: {
  readonly sessionID: string
  readonly result: unknown
  readonly dataDir?: string
  readonly now?: string
}): Applied | undefined => {
  const now = input.now ?? new Date().toISOString()
  const wall = offeredWall(input.sessionID)
  const store = ModelPlan.readStore(input.dataDir)
  const currentTier =
    wall === undefined ? undefined : (cardTiers.get(input.sessionID) ?? tierOfModel(store, wall.providerID, wall.modelID))
  const answer = SessionRunnerRenderCard.parseRenderAnswer(input.result, {
    ...(wall?.providerID !== undefined ? { currentProvider: wall.providerID } : {}),
    ...(currentTier !== undefined ? { currentTier } : {}),
  })
  if (answer.type === "none") return undefined
  clearWall(input.sessionID)
  if (answer.type === "chat") return { answer }
  if (answer.type === "tier-choice") {
    const applied = SessionRunnerRenderCard.applyTierChoice(store, answer.choice, now)
    ModelPlan.writeStore(applied.store, input.dataDir)
    ModelPlan.addNote(applied.note, now, input.dataDir)
    // The choice is recorded as pending so the runner loop selects it
    // as the session model before the next request (#2452 review F2):
    // the plan store alone does not move a session whose current model
    // has no routing.
    recordPending(input.sessionID, { modelChoice: answer.choice })
    return { answer, note: applied.note, modelChoice: answer.choice }
  }
  const effectiveWall: SessionRunnerRenderCard.QuotaWall = wall ?? {
    providerID: answer.choice.provider,
    modelID: "",
  }
  const applied = SessionRunnerRenderCard.applyQuotaFallback(answer.choice, effectiveWall)
  ModelPlan.addNote(applied.note, now, input.dataDir)
  // The instruction is recorded as pending so the runner loop applies
  // it before the next model request (#2452 review F3): returning it
  // alone was not enough while the step's render tap discarded it.
  recordPending(input.sessionID, { instruction: applied.instruction })
  return { answer, note: applied.note, instruction: applied.instruction }
}
