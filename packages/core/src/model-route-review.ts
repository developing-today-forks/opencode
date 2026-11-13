export * as ModelRouteReview from "./model-route-review.js"

import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { ownOr, ownValue } from "./util/record.js"

/**
 * The per-pool view behind `route_stats`: what each pool is configured to do, what it actually did,
 * and how each member fared. Pure over rows read from the routing history, so the arithmetic can be
 * tested without a database.
 */

/** A pool as its configuration states it. Targets and weight keys are `provider/model`, without a variant. */
export interface Configured {
  readonly selection: "ordered" | "round-robin" | "weighted"
  readonly autonomy?: string
  readonly hedgeAfterMs?: number
  readonly targets: readonly string[]
  readonly weights: Readonly<Record<string, number>>
  /** Per-target context ceilings declared in config, keyed by bare `provider/model`. */
  readonly limits: Readonly<Record<string, number>>
}

/** One request to one concrete target (`route_attempt`). */
export interface Attempt {
  readonly routeID: string
  readonly providerID: string
  readonly modelID: string
  readonly sessionID: string | null
  readonly outcome: string
  readonly errorTag: string | null
  readonly firstTokenMs: number | null
  readonly tokensPerSecond: number | null
  readonly tokensInput: number | null
}

/** One selection the router made (`route_decision`): who was eligible, the weights it used, who was left
 * out and why, and who was chosen. */
export interface Decision {
  readonly routeID: string
  readonly sessionID: string | null
  /** The pool's selection mode as recorded for this selection (`route_decision.selection`), when
   * the row carries it. Rows surfaced before this field was read, and hand-built fixtures, omit
   * it; the expectation then falls back to the configured pool's mode, and to the tiers the
   * selection recorded when neither is known. */
  readonly selection?: string
  readonly candidates: readonly string[]
  readonly chosen: string | null
  readonly reason: string
  readonly detail: Record<string, unknown> | null
}

export interface Member {
  readonly target: string
  /** The weight the configuration gives this target on this pool, or null when the pool does not list it. */
  readonly configuredWeight: number | null
  readonly attempts: number
  readonly failures: number
  readonly timeouts: number
  readonly failureRate: number | null
  /** Median time to first output, in milliseconds. */
  readonly firstTokenMs: number | null
  /** Median output speed of the attempts that completed. */
  readonly tokensPerSecond: number | null
  /** Median input size of its requests, in tokens. */
  readonly inputTokens: number | null
  readonly errorTags: Readonly<Record<string, number>>
  /** Selections in which this target was eligible. */
  readonly offered: number
  /** Selections in which it was the one used, sticky turns included. */
  readonly chosen: number
  /** New-session draws it was eligible for. Only draws are decided by weight. */
  readonly draws: number
  readonly drawsWon: number
  /** The share of a draw it should have won under the pool's selection mode, averaged over the
   * draws it was in. Null without draws. In a `weighted` pool that is the proportional share of
   * its effective weight. In a `round-robin` pool weights are priority tiers (#1122), so only
   * the top tier among a draw's candidates expects anything, split evenly (1/n of that tier),
   * and every lower tier expects 0; in a draw whose candidates omit the tiers above, the
   * highest tier present is the top tier for that draw. */
  readonly expectedShare: number | null
  /** The share of those draws it won. Compare with `expectedShare`. */
  readonly takeRate: number | null
  /** Selections in which it was left out, by reason: cooldown, provider-limit, user-skip, soft-budget,
   * over-limit, already-tried, or sits-out-level when its remap sits the requested level out. */
  readonly excluded: Readonly<Record<string, number>>
  /** The per-target context ceiling the pool declares for this target, or null when it declares none. */
  readonly configuredLimit: number | null
  /** Per-layer weight attribution from the most recent selection it was a candidate in, or null
   * when no recorded decision carries layers for it (decisions recorded before #589, or none). */
  readonly weightLayers: WeightLayers | null
}

/** The weight a candidate carried after each layer of the route weight computation in one
 * selection (#589): configured `base`, then `scheduled`, `prefer`, `adjustment`, and `demotion`
 * (the final effective weight). `gate` is the eligibility-gate verdict slot (#566); null until
 * gates exist. */
export interface WeightLayers {
  readonly base: number
  readonly scheduled: number
  readonly prefer: number
  readonly adjustment: number
  readonly demotion: number
  readonly gate: string | null
}

export interface RouteSummary {
  readonly id: string
  readonly configured: Configured | null
  readonly attempts: number
  readonly sessions: number
  readonly decisions: number
  /** Selection counts by reason: ordered, adjusted, sticky, drawn, no-candidates. */
  readonly reasons: Readonly<Record<string, number>>
  /** Request sizes in input tokens: the median and the 90th percentile. */
  readonly inputTokens: { readonly p50: number | null; readonly p90: number | null }
  readonly members: readonly Member[]
}

const FAILED = new Set(["failure", "timeout"])
const MAX_ROUTES = 50
const TOP_ERRORS = 3

const targetOf = (row: { readonly providerID: string; readonly modelID: string }) => `${row.providerID}/${row.modelID}`

const referenceOf = (reference: { readonly providerID: string; readonly model: string }) =>
  `${reference.providerID}/${reference.model}`

/** `provider/model` without the `#variant` a configured reference may carry. */
const bare = (reference: string) => reference.replace(/#.*$/, "")

/** The pool as its configuration states it, in the terms the history uses. Models a pool gains through
 * include, contains or match are not listed here; they appear once the history has offered them. */
export const configured = (route: ConfigModelRoutes.Route): Configured => ({
  selection: route.selection ?? "ordered",
  ...(route.autonomy !== undefined ? { autonomy: route.autonomy } : {}),
  ...(route.hedgeAfterMs !== undefined ? { hedgeAfterMs: route.hedgeAfterMs } : {}),
  targets: (route.targets ?? []).map((target) => {
    if (typeof target === "string") return bare(target)
    return bare("providerID" in target ? referenceOf(target) : referenceOf(target.model))
  }),
  weights: Object.fromEntries(
    Object.entries(route.weights ?? {}).map(([reference, weight]) => [bare(reference), weight]),
  ),
  limits: Object.fromEntries(
    (route.targets ?? []).flatMap((target): [string, number][] => {
      if (typeof target === "string" || "providerID" in target) return []
      const ceiling = target.limit?.context
      return ceiling === undefined ? [] : [[bare(referenceOf(target.model)), ceiling]]
    }),
  ),
})

/** Nearest-rank percentile, or null when there are no values. */
const percentile = (values: readonly number[], rank: number) => {
  if (values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1)]
}

const round = (value: number | null, digits: number) => (value === null ? null : Number(value.toFixed(digits)))

const present = (values: readonly (number | null)[]) => values.filter((value): value is number => value !== null)

const top = (counts: ReadonlyMap<string, number>, limit: number) =>
  Object.fromEntries(
    [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit),
  )

const group = <T>(rows: readonly T[], key: (row: T) => string) => {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const list = groups.get(id)
    if (list) list.push(row)
    else groups.set(id, [row])
  }
  return groups
}

/** The effective weight each candidate carried in a selection. */
const weightsOf = (detail: Record<string, unknown> | null): Readonly<Record<string, number>> => {
  const value = detail?.weights
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  )
}

/** The per-layer weight attribution a selection recorded, per candidate label. */
export const layersOf = (detail: Record<string, unknown> | null): Readonly<Record<string, WeightLayers>> => {
  const value = detail?.layers
  if (typeof value !== "object" || value === null) return {}
  const layers: Record<string, WeightLayers> = {}
  for (const [label, item] of Object.entries(value)) {
    if (typeof item !== "object" || item === null) continue
    const fields = item as Record<string, unknown>
    const numbers = ["base", "scheduled", "prefer", "adjustment", "demotion"].map((key) => fields[key])
    if (numbers.some((field) => typeof field !== "number")) continue
    const [base, scheduled, prefer, adjustment, demotion] = numbers as number[]
    layers[label] = {
      base,
      scheduled,
      prefer,
      adjustment,
      demotion,
      gate: typeof fields.gate === "string" ? fields.gate : null,
    }
  }
  return layers
}

/** The priority tier a candidate sorted into in one selection, as the selector recorded it for
 * round-robin nodes (#1122): the pre-demotion weight it tiers by, and whether quota demotion
 * holds it below every live tier. */
export interface Tier {
  readonly weight: number
  readonly demoted: boolean
}

/** The per-candidate tiers a selection recorded, per candidate label. Empty for non-round-robin
 * selections and for decisions recorded before #1122. */
export const tiersOf = (detail: Record<string, unknown> | null): Readonly<Record<string, Tier>> => {
  const value = detail?.tiers
  if (typeof value !== "object" || value === null) return {}
  const tiers: Record<string, Tier> = {}
  for (const [label, item] of Object.entries(value)) {
    if (typeof item !== "object" || item === null) continue
    const fields = item as Record<string, unknown>
    if (typeof fields.weight !== "number") continue
    tiers[label] = { weight: fields.weight, demoted: fields.demoted === true }
  }
  return tiers
}

/** The share of one draw a candidate should have won, mirroring the selector in model-route.ts.
 * Weighted pools draw in proportion to the effective weights over the whole candidate set.
 * Round-robin pools are tiered (#1122): the tier key is the pre-demotion weight the selection
 * recorded in `tiers` (falling back to the recorded per-layer `adjustment` weight, then to the
 * effective weight, for decisions recorded before tiers were kept), a demoted candidate sorts
 * below every live tier, distinct weights are distinct tiers and equal weights are one tier,
 * and only the top tier among the draw's candidates expects anything, split evenly. Because the
 * candidate set is the draw's own, a draw that omits the higher tiers expects the highest tier
 * present to take it — the selector's fallthrough, stated as an expectation. Null when the draw
 * carries no usable weights (a weighted draw whose weights sum to zero). */
const expectedShareOf = (decision: Decision, pool: Configured | null, target: string): number | null => {
  const tiers = tiersOf(decision.detail)
  const mode = decision.selection ?? pool?.selection ?? (Object.keys(tiers).length > 0 ? "round-robin" : undefined)
  if (mode !== "round-robin") {
    const weights = weightsOf(decision.detail)
    const total = decision.candidates.reduce((sum, candidate) => sum + ownOr(weights, candidate, 1), 0)
    return total > 0 ? ownOr(weights, target, 1) / total : null
  }
  const weights = weightsOf(decision.detail)
  const layers = layersOf(decision.detail)
  const tierOf = (candidate: string): Tier => {
    const recorded = ownValue(tiers, candidate)
    if (recorded) return recorded
    const layer = ownValue(layers, candidate)
    if (layer) return { weight: layer.adjustment, demoted: layer.demotion < layer.adjustment }
    return { weight: ownOr(weights, candidate, 1), demoted: false }
  }
  const entries = decision.candidates.map(tierOf)
  // Tier order, as the selector's byTier: non-demoted first, heavier tier first.
  const head = entries.toSorted((left, right) =>
    left.demoted !== right.demoted ? (left.demoted ? 1 : -1) : right.weight - left.weight,
  )[0]
  if (!head) return null
  const inTop = (tier: Tier) => tier.demoted === head.demoted && tier.weight === head.weight
  return inTop(tierOf(target)) ? 1 / entries.filter(inTop).length : 0
}

/** Who a selection left out and why. The `-until:<time>` suffix is dropped so that reasons group. */
const excludedOf = (detail: Record<string, unknown> | null) => {
  const value = detail?.excluded
  if (!Array.isArray(value)) return []
  return value.flatMap((item: { candidate?: unknown; reason?: unknown } | null) =>
    typeof item?.candidate === "string" && typeof item.reason === "string"
      ? [{ candidate: item.candidate, reason: item.reason.replace(/-until:.*$/, "") }]
      : [],
  )
}

const memberLabels = (pool: Configured | null, attempts: readonly Attempt[], decisions: readonly Decision[]) => {
  const offered = new Map<string, number>()
  const seen = new Set<string>(attempts.map(targetOf))
  for (const decision of decisions) {
    for (const candidate of decision.candidates) {
      offered.set(candidate, (offered.get(candidate) ?? 0) + 1)
      seen.add(candidate)
    }
    for (const item of excludedOf(decision.detail)) seen.add(item.candidate)
  }
  const listed = new Set(pool?.targets ?? [])
  const extra = [...seen]
    .filter((label) => !listed.has(label))
    .sort((left, right) => (offered.get(right) ?? 0) - (offered.get(left) ?? 0) || left.localeCompare(right))
  return [...listed, ...extra]
}

const memberOf = (
  target: string,
  pool: Configured | null,
  attempts: readonly Attempt[],
  decisions: readonly Decision[],
): Member => {
  const failures = attempts.filter((row) => FAILED.has(row.outcome)).length
  const errors = new Map<string, number>()
  for (const row of attempts) if (row.errorTag) errors.set(row.errorTag, (errors.get(row.errorTag) ?? 0) + 1)
  const excluded: Record<string, number> = {}
  let offered = 0
  let chosen = 0
  let draws = 0
  let drawsWon = 0
  let shares = 0
  let shareTotal = 0
  let weightLayers: WeightLayers | null = null
  for (const decision of decisions) {
    if (decision.candidates.includes(target)) {
      offered += 1
      // First found wins: decisions arrive newest-first (see summarize), so the first
      // layers recorded for a target are its most recent selection's. A decision without
      // layers for the target leaves the value untouched rather than clearing it.
      if (weightLayers === null) weightLayers = ownValue(layersOf(decision.detail), target) ?? null
      if (decision.chosen === target) chosen += 1
      if (decision.reason === "drawn") {
        draws += 1
        if (decision.chosen === target) drawsWon += 1
        const share = expectedShareOf(decision, pool, target)
        if (share !== null) {
          shares += 1
          shareTotal += share
        }
      }
    }
    for (const item of excludedOf(decision.detail)) {
      if (item.candidate === target) excluded[item.reason] = ownOr(excluded, item.reason, 0) + 1
    }
  }
  const firstTokens = present(attempts.map((row) => row.firstTokenMs))
  // Speed counts completed attempts only, per the Member doc: failed, timed-out and interrupted
  // attempts can carry a recorded speed for the output they produced, but they never completed.
  const speeds = present(
    attempts.filter((row) => row.outcome === "success").map((row) => row.tokensPerSecond),
  )
  const inputs = present(attempts.map((row) => row.tokensInput))
  return {
    target,
    configuredWeight: pool ? (ownValue(pool.weights, target) ?? null) : null,
    configuredLimit: pool ? (ownValue(pool.limits, target) ?? null) : null,
    attempts: attempts.length,
    failures,
    timeouts: attempts.filter((row) => row.outcome === "timeout").length,
    failureRate: attempts.length === 0 ? null : round(failures / attempts.length, 3),
    firstTokenMs: round(percentile(firstTokens, 0.5), 0),
    tokensPerSecond: round(percentile(speeds, 0.5), 1),
    inputTokens: round(percentile(inputs, 0.5), 0),
    errorTags: top(errors, TOP_ERRORS),
    offered,
    chosen,
    draws,
    drawsWon,
    expectedShare: shares === 0 ? null : round(shareTotal / shares, 3),
    takeRate: draws === 0 ? null : round(drawsWon / draws, 3),
    excluded,
    weightLayers,
  }
}

const routeOf = (
  id: string,
  pool: Configured | null,
  attempts: readonly Attempt[],
  decisions: readonly Decision[],
): RouteSummary => {
  const reasons: Record<string, number> = {}
  for (const decision of decisions) reasons[decision.reason] = ownOr(reasons, decision.reason, 0) + 1
  const sessions = new Set<string>()
  for (const row of attempts) if (row.sessionID) sessions.add(row.sessionID)
  for (const row of decisions) if (row.sessionID) sessions.add(row.sessionID)
  const byTarget = group(attempts, targetOf)
  const inputs = present(attempts.map((row) => row.tokensInput))
  return {
    id,
    configured: pool,
    attempts: attempts.length,
    sessions: sessions.size,
    decisions: decisions.length,
    reasons,
    inputTokens: { p50: percentile(inputs, 0.5), p90: percentile(inputs, 0.9) },
    members: memberLabels(pool, attempts, decisions).map((target) =>
      memberOf(target, pool, byTarget.get(target) ?? [], decisions),
    ),
  }
}

/** Every configured pool first, in configuration order, then pools seen only in history, busiest first.
 * Ordering contract: `decisions` must be newest-first (as ModelRouteLog.decisionRows returns
 * them). Decision carries no timestamp, so summarize cannot reorder; Member.weightLayers
 * relies on this order to report the most recent selection's attribution. */
export const summarize = (input: {
  readonly attempts: readonly Attempt[]
  readonly decisions: readonly Decision[]
  readonly configured: ReadonlyMap<string, Configured>
}): RouteSummary[] => {
  const attempts = group(input.attempts, (row) => row.routeID)
  const decisions = group(input.decisions, (row) => row.routeID)
  const observed = [...new Set([...attempts.keys(), ...decisions.keys()])]
    .filter((id) => !input.configured.has(id))
    .sort(
      (left, right) =>
        (attempts.get(right)?.length ?? 0) - (attempts.get(left)?.length ?? 0) || left.localeCompare(right),
    )
  return [...input.configured.keys(), ...observed]
    .slice(0, MAX_ROUTES)
    .map((id) => routeOf(id, input.configured.get(id) ?? null, attempts.get(id) ?? [], decisions.get(id) ?? []))
}
