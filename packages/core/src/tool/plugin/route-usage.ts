export * as RouteUsageTool from "./route-usage.js"

import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Option, Schema } from "effect"
import { ModelPlan } from "../../model-plan.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { ModelRouteReview } from "../../model-route-review.js"
import { ModelUsage } from "../../model-usage.js"
import { QuotaBurnRate } from "../../quota-burn-rate.js"

export const name = "route_usage"

export const description = `Read what routed work has used: totals per provider and model, per session (requests, tokens, cost, the pools and models it used), per day (with cache-read tokens, cache hit ratio and USD saved by cache hits), per continued turn (the chunks of one response joined back together), and each plan's quota windows with the share used in its last window.

Use it for questions like "which sessions used the most", "did any pool use this provider", "how much of my Claude window is gone", or "what did this week cost". When the session input names one session it also reports that session's per-step serving readout: which provider/model leaf actually served each step and whether the last step failed over from another leaf — use it to answer "which model served my last step" (the session's declared route ref is not what served it). It also reports per-model burn rates: the typical percent of a quota window one session costs, derived from the listed sessions' window shares. Set \`hours\` for the window (default 168; up to a year). Set \`provider\` or \`model\` to narrow the totals, \`route\` to one pool, or \`session\` to one session. Every target lists each pool it belongs to: used, offered but never chosen, or configured but never reached. The history is kept indefinitely, so a longer window is always available.`

export const Input = Schema.Struct({
  hours: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 24 * 366 })).pipe(Schema.optional),
  provider: Schema.String.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional).annotate({ description: "A model id, without its provider." }),
  route: Schema.String.pipe(Schema.optional).annotate({ description: "A pool id, such as cheap-fast." }),
  session: Schema.String.pipe(Schema.optional),
  limit: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(Schema.optional),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  targets: Schema.Array(Schema.Unknown),
  sessions: Schema.Array(Schema.Unknown),
  days: Schema.Array(Schema.Unknown),
  turns: Schema.Array(Schema.Unknown),
  serving: Schema.Array(Schema.Unknown),
  lastServing: Schema.Unknown.pipe(Schema.optional),
  plans: Schema.Array(Schema.Unknown),
  burnRates: Schema.Array(Schema.Unknown),
  noDatabase: Schema.Boolean,
})

/** What the configuration says about pools, read when the tool runs. */
export interface Source {
  readonly routes: ReadonlyMap<string, ConfigModelRoutes.Route>
}

export interface Options {
  readonly dataDir?: string
  readonly now?: () => number
}

const NO_SOURCE: Source = { routes: new Map() }

export const collect = (input: Input, source: Source = NO_SOURCE, options: Options = {}) =>
  Effect.gen(function* () {
    const now = options.now?.() ?? Date.now()
    const hours = input.hours ?? 168
    const since = now - hours * 3_600_000
    const pools = new Map<string, readonly string[]>()
    for (const [id, route] of source.routes) {
      if (input.route === undefined || id === input.route) pools.set(id, ModelRouteReview.configured(route).targets)
    }
    const matches = (target: { readonly providerID: string; readonly modelID: string }) =>
      (input.provider === undefined || target.providerID === input.provider) &&
      (input.model === undefined || target.modelID === input.model)

    let plans: readonly ModelPlan.Plan[] = []
    let planError: string | undefined
    try {
      plans = ModelPlan.readStore(options.dataDir).plans.filter(
        (plan) => input.provider === undefined || plan.providerID === input.provider,
      )
    } catch (error) {
      planError = error instanceof Error ? error.message : String(error)
    }
    // Every quota window is reported. A window without windowHours has no defined lookback, so its
    // usage is unknown (null below) rather than a number computed over an invented window.
    const windows = plans.flatMap((plan) => plan.quotas.map((window) => ({ plan, window })))

    const read = yield* ModelRouteLog.withDb((db) =>
      Effect.gen(function* () {
        const sessions = yield* ModelRouteLog.sessionUsage(db, since, input.limit ?? 20, input.session)
        const sessionIDs = sessions.flatMap((row) => (row.sessionID === null ? [] : [row.sessionID]))
        const sessionTargets = yield* ModelRouteLog.sessionTargetUsage(db, since, sessionIDs)
        const windowSessionTargets: (readonly ModelUsage.SessionTargetRow[])[] = []
        for (const { window } of windows) {
          // No windowHours: no defined lookback to attribute session usage over, so no rows; the
          // window is also left out of the session-share list below.
          windowSessionTargets.push(
            window.windowHours === undefined
              ? []
              : ((yield* ModelRouteLog.sessionTargetUsage(
                  db,
                  now - window.windowHours * 3_600_000,
                  sessionIDs,
                )) as ModelUsage.SessionTargetRow[]),
          )
        }
        const targetRows = yield* ModelRouteLog.targetUsage(db, since)
        // targetUsage rows are split by serving credential (#1106); this report is per target,
        // so fold each target's credential rows back into one. The folded rows' `sessions` is
        // replaced below: per-credential distinct counts cannot be summed (one session can sit
        // in several credential groups), so the report takes the exact target-level count.
        const targetsByID = new Map<string, ModelUsage.TargetRow>()
        for (const row of targetRows) {
          const id = `${row.providerID}/${row.modelID}`
          const existing = targetsByID.get(id)
          targetsByID.set(id, {
            ...(existing ? ModelUsage.sum([existing, row]) : ModelUsage.sum([row])),
            providerID: row.providerID,
            modelID: row.modelID,
            sessions: row.sessions,
            first: existing ? Math.min(existing.first, row.first) : row.first,
            last: existing ? Math.max(existing.last, row.last) : row.last,
          })
        }
        const targetSessionCounts = yield* ModelRouteLog.targetSessions(db, since)
        for (const row of targetSessionCounts) {
          const target = targetsByID.get(`${row.providerID}/${row.modelID}`)
          if (target) targetsByID.set(`${row.providerID}/${row.modelID}`, { ...target, sessions: row.sessions })
        }
        const targets = [...targetsByID.values()]
        const servingRows =
          input.session === undefined ? [] : yield* ModelRouteLog.sessionAttempts(db, input.session, 50)
        const days = yield* ModelRouteLog.dailyUsage(db, since)
        const turns = yield* ModelRouteLog.turnAttempts(db, since, input.session)
        const offers = (yield* ModelRouteLog.offerUsage(db, since, input.route)) as ModelUsage.OfferRow[]
        const windowTotals: { plan: string; window: string; totals: ModelUsage.Totals }[] = []
        for (const { plan, window } of windows) {
          if (window.windowHours === undefined) continue
          const rows = yield* ModelRouteLog.targetUsage(db, now - window.windowHours * 3_600_000)
          windowTotals.push({
            plan: plan.id,
            window: window.name,
            totals: ModelUsage.sum(rows.filter((row) => row.providerID === plan.providerID)),
          })
        }
        return { sessions, sessionTargets, targets, days, turns, offers, windowTotals, windowSessionTargets, servingRows }
      }).pipe(Effect.orDie),
    )
    const history = Option.getOrUndefined(read)

    const configuredTargets = [...new Set([...pools.values()].flat())]
    const offers = history?.offers ?? []
    const targets = ModelUsage.targetReports(
      (history?.targets ?? []).filter(matches),
      configuredTargets.filter((target) => matches(ModelUsage.splitTarget(target))),
      offers,
      pools,
    )
    const sessions = ModelUsage.sessionReports(
      (history?.sessions ?? []).flatMap((row) =>
        row.sessionID === null ? [] : [{ ...row, sessionID: row.sessionID }],
      ),
      (history?.sessionTargets ?? []).flatMap((row) =>
        row.sessionID === null ? [] : [{ ...row, sessionID: row.sessionID }],
      ),
      // Session shares are only computed for windows with a defined lookback (windowHours).
      windows.flatMap(({ plan, window }, index) =>
        window.windowHours === undefined
          ? []
          : [
              {
                plan,
                window,
                rows: (history?.windowSessionTargets[index] ?? []).flatMap((row) =>
                  row.sessionID === null ? [] : [{ ...row, sessionID: row.sessionID }],
                ),
              },
            ],
      ),
    ).filter(
      (session) =>
        (input.provider === undefined && input.model === undefined) ||
        session.targets.some((item) => matches(ModelUsage.splitTarget(item.target))),
    )
    // Burn-rate samples (#568): one per listed session, plan window, and model on that window's
    // provider — the session's measured share of the window. A session that used the same model
    // through several pools has one target row per pool, so models dedupe here: each (session,
    // window, model) contributes its share exactly once (#1033). The sample names its plan window,
    // so shares from distinct windows never average together downstream. Session history does not
    // record the effort (variant) per target, so these samples land in the effort-less buckets;
    // effort-tagged callers get effort buckets from the same derivation.
    const providerByPlan = new Map(windows.map(({ plan }) => [plan.id, plan.providerID]))
    const burnSamples: QuotaBurnRate.Sample[] = sessions.flatMap((session) =>
      session.windows.flatMap((share) => {
        const percent = share.percent
        if (percent === null) return []
        const providerID = providerByPlan.get(share.plan)
        if (providerID === undefined) return []
        return [
          ...new Set(
            session.targets
              .map((target) => ModelUsage.splitTarget(target.target))
              .filter((target) => target.providerID === providerID)
              .map((target) => target.modelID),
          ),
        ].map((modelID) => ({ providerID, modelID, plan: share.plan, window: share.window, percent }))
      }),
    )
    const burnRates = QuotaBurnRate.buckets(burnSamples)
    const days = ModelUsage.dayReports((history?.days ?? []).filter(matches))
    // A turn is a root attempt plus every chunk that continued it. Only continued turns are worth listing here:
    // a single-request turn is already a row of the target, session and day totals.
    const turns = ModelUsage.turns(history?.turns ?? [])
      .filter((turn) => turn.chunks > 1 && matches(turn))
      .slice(0, input.limit ?? 20)
    const planReports = windows.map(({ plan, window }) => {
      const found = history?.windowTotals.find((item) => item.plan === plan.id && item.window === window.name)
      const report = ModelUsage.windowReport(plan, window, found?.totals ?? ModelUsage.zero)
      // Usage is unknown when there is no history database, and for a window without windowHours
      // there is no defined period to total over — both are shown as unknown, never as zero.
      return history === undefined || window.windowHours === undefined
        ? { ...report, used: null, percent: null, remaining: null }
        : report
    })
    const serving = ModelUsage.servingSteps(history?.servingRows ?? []).slice(0, 20)
    return {
      hours,
      since: new Date(since).toISOString(),
      noDatabase: history === undefined,
      planError,
      targets,
      sessions,
      days,
      turns,
      serving,
      lastServing: ModelUsage.lastServing(history?.servingRows ?? []),
      plans: planReports,
      burnRates,
    }
  })

const money = (value: number) => `$${value.toFixed(2)}`

/** Cache payoff for one totals row: tokens read from cache, their share of all prompt tokens, and the USD
 * they saved. Savings are summed only over attempts recorded with pricing, so older history contributes
 * $0.00 rather than an estimate priced from a later catalog. */
const cache = (totals: ModelUsage.Totals) => {
  const ratio = ModelUsage.cacheHitRatio(totals)
  return `cache read ${totals.cacheRead} tokens, hit ratio ${ratio === null ? "n/a" : `${Math.round(ratio * 1000) / 10}%`}, saved ${money(totals.cacheSavedUsd)}`
}

const describe = (report: Effect.Success<ReturnType<typeof collect>>) => {
  const lines: string[] = []
  if (report.noDatabase) lines.push("Routing history is unavailable: no database is attached.")
  if (report.planError) lines.push(`Plan records could not be read: ${report.planError}`)
  lines.push(`Window: the last ${report.hours} hours, from ${report.since}.`)
  lines.push(
    `${report.targets.length} targets, ${report.sessions.length} sessions listed, ${report.turns.length} continued turns, ${report.days.length} days.`,
  )
  for (const target of report.targets) {
    const pools = target.pools.map(
      (pool) => `${pool.routeID} ${pool.state} (offered ${pool.offered}, chosen ${pool.chosen})`,
    )
    lines.push(
      `${target.target}: ${target.requests} requests (${target.failures} failed), ${ModelUsage.metered(target)} metered tokens, ${money(target.costUsd)}, ${cache(target)}, ${target.sessions} sessions; pools: ${pools.join("; ") || "none"}`,
    )
  }
  for (const session of report.sessions) {
    const shares = session.windows
      .filter((item) => item.percent !== null)
      .map((item) => `${item.percent}% of ${item.plan} ${item.window}`)
    lines.push(
      `session ${session.sessionID} last ${new Date(session.last).toISOString().slice(0, 16)}: ${session.requests} requests, ${ModelUsage.metered(session)} metered tokens, ${money(session.costUsd)}, ${cache(session)}; pools ${session.pools.join(", ") || "none"}; models ${session.targets.map((item) => `${item.target} x${item.requests}`).join(", ") || "none"}${shares.length > 0 ? `; used ${shares.join(", ")}` : ""}`,
    )
  }
  if (report.lastServing) {
    const last = report.lastServing
    lines.push(
      `serving last step: ${last.leaf}${last.variant ? `#${last.variant}` : ""} via route ${last.routeID} (outcome ${last.outcome})${last.failedOver ? `; attempted ${last.attemptedLeaf} -> failed over${last.failedOverTo ? ` to ${last.failedOverTo}` : ""}, served by ${last.leaf}` : last.hedged ? "; hedged race (no failover)" : "; no failover"}`,
    )
    for (const step of report.serving.slice(0, 10)) {
      lines.push(
        `serving step ${new Date(step.timeStarted).toISOString()}: ${step.leaf}${step.variant ? `#${step.variant}` : ""} via route ${step.routeID}, outcome ${step.outcome}${step.hedged ? ", hedged" : ""}${step.failedOverTo ? `, failed over to ${step.failedOverTo}` : ""}`,
      )
    }
  }
  for (const day of report.days.slice(-14)) {
    lines.push(
      `${day.day}: ${day.requests} requests, ${day.metered} metered tokens, ${money(day.costUsd)}, cache read ${day.cacheRead} tokens, saved ${money(day.cacheSavedUsd)}`,
    )
  }
  // Continued responses: the tokens and cost of every chunk of the turn, not one line per chunk.
  for (const turn of report.turns.slice(0, 10)) {
    lines.push(
      `turn ${turn.rootID}${turn.sessionID === null ? "" : ` (session ${turn.sessionID})`}: ${turn.chunks} chunks, ${turn.requests} requests, ${ModelUsage.metered(turn)} metered tokens, ${money(turn.costUsd)}, ${cache(turn)}, ${(turn.durationMs / 1_000).toFixed(1)}s${turn.failures > 0 ? `, ${turn.failures} failed` : ""}`,
    )
  }
  for (const burn of report.burnRates) {
    lines.push(
      `burn rate ${burn.providerID}/${burn.modelID}${burn.effort === null ? "" : ` (${burn.effort})`} in plan ${burn.plan} window ${burn.window}: ~${burn.percentPerSession}% per session, from ${burn.sessions} listed sessions`,
    )
  }
  for (const plan of report.plans) {
    const limit = plan.limit === null ? "no limit recorded" : `of ${plan.limit} ${plan.unit}`
    lines.push(
      `plan ${plan.plan} window ${plan.window}${plan.windowHours === null ? "" : ` (${plan.windowHours}h)`}: ${plan.used === null ? "usage unknown" : `${plan.used} used ${limit}`}${plan.percent === null ? "" : `, ${plan.percent}% used`}${plan.resetRule === null ? "" : `; resets ${plan.resetRule}`}`,
    )
  }
  return lines.join("\n")
}

export const add = (editor: ToolEditor, source: () => Source = () => NO_SOURCE, options: Options = {}) =>
  editor.add({
    name,
    options: { codemode: false },
    description,
    input: Input,
    output: Output,
    execute: (input) =>
      Effect.gen(function* () {
        const report = yield* collect(input, source(), options)
        return {
          output: {
            targets: report.targets,
            sessions: report.sessions,
            days: report.days,
            turns: report.turns,
            serving: report.serving,
            lastServing: report.lastServing ?? undefined,
            plans: report.plans,
            burnRates: report.burnRates,
            noDatabase: report.noDatabase,
          },
          content: describe(report),
        }
      }),
  })
