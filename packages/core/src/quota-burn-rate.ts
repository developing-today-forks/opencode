export * as QuotaBurnRate from "./quota-burn-rate.js"

/**
 * Per-session burn-rate estimation for quota windows (epic #568, on the design #587 phase-1 signal):
 * how much of a window a typical session costs, bucketed by provider, model, and effort (the route
 * variant). Like `QuotaSnapshot`, an estimate is a pure derivation over recorded history — derived,
 * never stored — so the same samples plus the same options always give the same estimate, and it can
 * be tested without a database.
 *
 * A sample is one session's measured share of one window, in percent: callers derive it from
 * `ModelUsage.sessionReports` window shares (used / limit for the plan window the session drew on).
 * The sample names that plan window, so shares from distinct windows (different limits and
 * denominators) never average together: buckets group per window, and estimates are scoped to one.
 * Samples whose session ran at a known effort carry it; samples without one land in the effort-less
 * bucket for their provider/model, which is also the fallback every effort bucket draws on while its
 * own history is thin.
 *
 * Cold start is explicit, never invented from data that is not there: below `minSamples` a bucket
 * falls back to the provider/model bucket across efforts, then to the configured prior for the
 * effort, then to the default prior. Every estimate names its `source`, so a consumer can tell a
 * measured rate from a prior at a glance — an observe-mode consumer (the only kind #568 sanctions
 * today) can show both; nothing in the selection path reads these estimates.
 */

export interface Sample {
  readonly providerID: string
  readonly modelID: string
  /** The effort (route variant) the session ran at, when the history records one. */
  readonly effort?: string
  /** The plan whose window the share was measured against (the `ModelPlan` plan id). */
  readonly plan: string
  /** The quota window the share was measured against (the window name within the plan). */
  readonly window: string
  /** Percent of the window this session consumed: 0 or more, in the same units as `ModelUsage.percentOf`. */
  readonly percent: number
}

export interface Options {
  /** Samples a bucket needs before its own mean is trusted over the fallbacks. Default 3. */
  readonly minSamples?: number
  /** Cold-start priors per effort, in percent of window per session. Overrides merge over `DEFAULT_PRIORS`. */
  readonly priors?: Readonly<Record<string, number>>
  /** The prior used when neither history nor an effort prior applies. Default `DEFAULT_PRIOR`. */
  readonly defaultPrior?: number
}

/** Conservative cold-start priors (percent of a window per session) until history exists. */
export const DEFAULT_PRIORS: Readonly<Record<string, number>> = {
  low: 1,
  medium: 3,
  high: 6,
  xhigh: 12,
}

/** The fallback prior: a medium session's cost. */
export const DEFAULT_PRIOR = 3

export const DEFAULT_MIN_SAMPLES = 3

export type Source = "bucket" | "model" | "prior-effort" | "prior-default"

export interface Estimate {
  readonly providerID: string
  readonly modelID: string
  readonly effort: string | null
  /** The plan window this estimate describes: the bucket's own for "bucket"/"model", the query's for priors. */
  readonly plan: string
  /** The quota window (name within the plan) this estimate describes. */
  readonly window: string
  /** Estimated percent of the window one session at this bucket costs, rounded to 0.1 like `percentOf`. */
  readonly percentPerSession: number
  /** How many samples back the figure: the bucket's own for "bucket", the model's for "model", 0 for a prior. */
  readonly sessions: number
  readonly source: Source
}

export interface Query {
  readonly providerID: string
  readonly modelID: string
  readonly effort?: string
  /** Estimates are scoped to one plan window: samples from other windows never average in. */
  readonly plan: string
  readonly window: string
}

const round = (value: number) => Math.round(value * 10) / 10

const mean = (samples: readonly Sample[]) =>
  samples.length === 0 ? null : round(samples.reduce((total, sample) => total + sample.percent, 0) / samples.length)

const keyOf = (providerID: string, modelID: string, effort: string | null, plan: string, window: string) =>
  [providerID, modelID, effort ?? "", plan, window].join("\u0000")

/** Every bucket the samples form, with its measured mean — including thin buckets `estimate` would not trust yet. */
export const buckets = (samples: readonly Sample[]): Estimate[] => {
  const grouped = new Map<
    string,
    {
      providerID: string
      modelID: string
      effort: string | null
      plan: string
      window: string
      rows: Sample[]
    }
  >()
  for (const sample of samples) {
    const effort = sample.effort ?? null
    const key = keyOf(sample.providerID, sample.modelID, effort, sample.plan, sample.window)
    const group = grouped.get(key) ?? {
      providerID: sample.providerID,
      modelID: sample.modelID,
      effort,
      plan: sample.plan,
      window: sample.window,
      rows: [],
    }
    group.rows.push(sample)
    grouped.set(key, group)
  }
  return [...grouped.values()]
    .map((group) => ({
      providerID: group.providerID,
      modelID: group.modelID,
      effort: group.effort,
      plan: group.plan,
      window: group.window,
      percentPerSession: mean(group.rows) ?? 0,
      sessions: group.rows.length,
      source: "bucket" as Source,
    }))
    .sort(
      (a, b) =>
        a.providerID.localeCompare(b.providerID) ||
        a.modelID.localeCompare(b.modelID) ||
        (a.effort ?? "").localeCompare(b.effort ?? "") ||
        a.plan.localeCompare(b.plan) ||
        a.window.localeCompare(b.window),
    )
}

/**
 * The estimate for one provider/model/effort in one plan window: the bucket's own mean once it has
 * `minSamples`, else the window's provider/model mean across efforts, else the effort prior, else the
 * default prior. Samples from other plan windows never average in.
 */
export const estimate = (samples: readonly Sample[], query: Query, options: Options = {}): Estimate => {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES
  const effort = query.effort ?? null
  const base = { providerID: query.providerID, modelID: query.modelID, effort, plan: query.plan, window: query.window }
  const scoped = samples.filter(
    (sample) =>
      sample.providerID === query.providerID &&
      sample.modelID === query.modelID &&
      sample.plan === query.plan &&
      sample.window === query.window,
  )

  if (effort !== null) {
    const own = scoped.filter((sample) => sample.effort === effort)
    if (own.length >= minSamples) {
      return { ...base, percentPerSession: mean(own) ?? 0, sessions: own.length, source: "bucket" }
    }
  }

  if (scoped.length >= minSamples) {
    return {
      ...base,
      percentPerSession: mean(scoped) ?? 0,
      sessions: scoped.length,
      source: effort === null ? "bucket" : "model",
    }
  }

  const priors = { ...DEFAULT_PRIORS, ...options.priors }
  if (effort !== null && Object.hasOwn(priors, effort) && priors[effort] !== undefined) {
    return { ...base, percentPerSession: priors[effort], sessions: 0, source: "prior-effort" }
  }
  return { ...base, percentPerSession: options.defaultPrior ?? DEFAULT_PRIOR, sessions: 0, source: "prior-default" }
}
