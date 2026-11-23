export * as ModelRouteGranularity from "./model-route-granularity.js"

/**
 * Learned bench granularity (code#10367, design points 3–4).
 *
 * The bench seeds its granularity by failure class (point 2, settled in
 * model-route.ts): quota and plan-wall failures bench a model at pool scope
 * from the first failure, while the traffic classes (request-shape, timeout,
 * 5xx, plain auth) bench only the effort that errored. This tracker learns
 * when a traffic failure's true scope is wider than its seed. It runs over
 * attempt history — live, fed by ModelRoute.failed()/completed(), or in bulk
 * from recorded route_attempt rows — and promotes a key's granularity only on
 * perfect concordance:
 *
 * - effort → model: for a (provider, model), every observed failure window
 *   shows all tried efforts failing together, over a minimum sample of
 *   windows (MIN_CONCORDANT_WINDOWS). A window is one failure episode: the
 *   attempts that land within WINDOW_GAP_MS of each other. A window counts as
 *   concordant only when at least two efforts were tried and every success in
 *   it belongs to an effort that also failed in it (an effort recovering from
 *   its own failure ends its part of the episode; it is not evidence either
 *   way about its siblings).
 * - model → provider: the same machine one level up, over models. A promoted
 *   provider feeds the simultaneity bench in model-route.ts
 *   (providerCooldownUntil): its cooling models corroborate a provider-wide
 *   stop on per-provider evidence instead of the one global threshold.
 *
 * Point 4 — instant demotion on the first counterexample: a success at a
 * member that has NOT failed in the open window, while another member's
 * failure stands (Medium answers while a model-level bench from High's
 * failures is active), kills the "100% of the time" claim on the spot. The
 * key drops back to its seed granularity, its concordant count resets to
 * zero — the claim must be re-earned from fresh windows — and the demotion
 * is recorded on the key's state (count + timestamp), where the route-stats
 * surface reports it.
 *
 * What never feeds the learner: quota and plan-wall failures (already
 * model-granular by seed class, so their concordance is by construction, not
 * evidence), infra failures (the request never reached a provider), and
 * network-forgiven failures (a local outage, not a door verdict). Successes
 * always feed it: they are the only source of counterexamples.
 *
 * Credentials stay separate (point 5): the learner's keys name no credential,
 * and its widening applies to the target's own traffic scope only — a
 * credential's traffic bench is never widened by another credential's
 * evidence.
 */

/** Concordant failure windows a key must show before its granularity promotes. */
export const MIN_CONCORDANT_WINDOWS = 3

/** Attempts closer together than this belong to one failure window (episode);
 * a longer silence closes the window and judges it. */
export const WINDOW_GAP_MS = 15 * 60_000

/** One attempt outcome, as the live settle paths report it. The variant is the
 * served effort; undefined reads as the model's own default, matching the
 * traffic bench's key. */
export interface AttemptObservation {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly success: boolean
  readonly at: number
}

/** The route_attempt row shape, as recorded by ModelRouteLog: the bulk entry
 * point consumes history in exactly the columns the table already keeps
 * (provider, model, variant, outcome, start time — no new instrumentation). */
export interface AttemptRow {
  readonly provider_id: string
  readonly model_id: string
  readonly variant?: string | null
  readonly outcome: string
  readonly time_started: number
}

/** One key's learned granularity, as the operator surface reports it. */
export interface GranularityState {
  readonly key: string
  readonly scope: "model" | "provider"
  /** The granularity failures of this key are currently believed to
   * generalize at: "effort" (the seed) or "model" for a model key;
   * "model" (the seed) or "provider" for a provider key. */
  readonly level: string
  /** Attempts observed for this key. */
  readonly evidence: number
  /** Concordant windows counted toward the current claim; reset to zero by
   * the first counterexample. */
  readonly concordantWindows: number
  readonly demotions: number
  readonly lastDemotionAt?: number
  readonly promotedAt?: number
  readonly updatedAt: number
}

interface Window {
  lastAt: number
  failed: Set<string>
  succeeded: Set<string>
}

interface ScopeState {
  level: string
  evidence: number
  concordantWindows: number
  demotions: number
  lastDemotionAt?: number
  promotedAt?: number
  updatedAt: number
  window?: Window
}

const MAX_KEYS = 2_048

const models = new Map<string, ScopeState>()
const providers = new Map<string, ScopeState>()

const entry = (map: Map<string, ScopeState>, id: string, seed: string, at: number) => {
  const current = map.get(id) ?? {
    level: seed,
    evidence: 0,
    concordantWindows: 0,
    demotions: 0,
    updatedAt: at,
  }
  map.delete(id)
  map.set(id, current)
  while (map.size > MAX_KEYS) map.delete(map.keys().next().value!)
  return current
}

/** Judges a closed window: concordant when at least two members were tried,
 * all of them failed, and no success landed on a member that had not failed —
 * then counts it toward promotion. */
const closeWindow = (state: ScopeState, seed: string, promoted: string) => {
  const window = state.window
  state.window = undefined
  if (!window) return
  const concordant = window.failed.size >= 2 && [...window.succeeded].every((member) => window.failed.has(member))
  if (!concordant) return
  state.concordantWindows++
  if (state.level === seed && state.concordantWindows >= MIN_CONCORDANT_WINDOWS) {
    state.level = promoted
    state.promotedAt = window.lastAt
  }
}

const observeInto = (
  state: ScopeState,
  seed: string,
  promoted: string,
  member: string,
  success: boolean,
  at: number,
) => {
  state.evidence++
  state.updatedAt = at
  if (state.window && at - state.window.lastAt > WINDOW_GAP_MS) closeWindow(state, seed, promoted)
  if (!state.window) {
    // A success with no failure window open is no evidence either way: no
    // coarser claim stands over it, so it can neither build nor break one.
    if (!success) state.window = { lastAt: at, failed: new Set([member]), succeeded: new Set() }
    return
  }
  const window = state.window
  window.lastAt = at
  if (!success) {
    window.failed.add(member)
    return
  }
  if (window.failed.has(member)) {
    // The member recovered from its own failure inside its own episode: the
    // episode is ending, not lying about its siblings.
    window.succeeded.add(member)
    return
  }
  if (window.failed.size === 0) {
    window.succeeded.add(member)
    return
  }
  // The first counterexample (point 4): a member that never failed in this
  // window answers while another member's failure stands. The claim dies on
  // the spot — demote, record it, and reset the count so the claim must be
  // re-earned from fresh windows.
  if (state.level === promoted) {
    state.level = seed
    state.promotedAt = undefined
    state.demotions++
    state.lastDemotionAt = at
  }
  state.concordantWindows = 0
  state.window = undefined
}

/** Records one attempt outcome against both scopes: the (provider, model)
 * key, judged over efforts, and the provider key, judged over models. */
export const observe = (input: AttemptObservation) => {
  const effort = input.variant ?? "default"
  observeInto(
    entry(models, `${input.providerID}/${input.modelID}`, "effort", input.at),
    "effort",
    "model",
    effort,
    input.success,
    input.at,
  )
  observeInto(
    entry(providers, input.providerID, "model", input.at),
    "model",
    "provider",
    input.modelID,
    input.success,
    input.at,
  )
}

/** Bulk-feeds recorded route_attempt rows, oldest first. Only outcomes that
 * are evidence about the door count: `success`, plus `failure` and `timeout`
 * as failures. `interrupted`, `hedged-out` and `resolution-failure` rows say
 * nothing about the target and are skipped. */
export const observeAttemptRows = (rows: readonly AttemptRow[]) => {
  for (const row of [...rows].sort((a, b) => a.time_started - b.time_started)) {
    if (row.outcome !== "success" && row.outcome !== "failure" && row.outcome !== "timeout") continue
    observe({
      providerID: row.provider_id,
      modelID: row.model_id,
      variant: row.variant ?? undefined,
      success: row.outcome === "success",
      at: row.time_started,
    })
  }
}

/** The granularity a (provider, model)'s failures are currently believed to
 * generalize at: "model" once promoted, "effort" at the seed. */
export const modelLevel = (providerID: string, modelID: string): "effort" | "model" =>
  models.get(`${providerID}/${modelID}`)?.level === "model" ? "model" : "effort"

/** Whether a provider's failures are currently believed to generalize to the
 * whole provider — the learner's feed into the simultaneity bench. */
export const providerPromoted = (providerID: string): boolean => providers.get(providerID)?.level === "provider"

/** Every tracked key's granularity state, for the operator surface. A key
 * appears once it has any evidence; its level names where its failures are
 * believed to generalize, beside the evidence that earned the belief. */
export const snapshot = (): GranularityState[] => {
  const out: GranularityState[] = []
  for (const [key, state] of models)
    out.push({
      key,
      scope: "model",
      level: state.level,
      evidence: state.evidence,
      concordantWindows: state.concordantWindows,
      demotions: state.demotions,
      lastDemotionAt: state.lastDemotionAt,
      promotedAt: state.promotedAt,
      updatedAt: state.updatedAt,
    })
  for (const [key, state] of providers)
    out.push({
      key,
      scope: "provider",
      level: state.level,
      evidence: state.evidence,
      concordantWindows: state.concordantWindows,
      demotions: state.demotions,
      lastDemotionAt: state.lastDemotionAt,
      promotedAt: state.promotedAt,
      updatedAt: state.updatedAt,
    })
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope))
}

/** Test seam; the tracker is intentionally process-local, like health. */
export const reset = () => {
  models.clear()
  providers.clear()
}
