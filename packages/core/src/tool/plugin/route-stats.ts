export * as RouteStatsTool from "./route-stats.js"

import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { ToolFailure } from "@opencode/ai"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Option, Schema } from "effect"
import type { Permission } from "../../permission.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteLimits } from "../../model-route-limits.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { ModelRouteReview } from "../../model-route-review.js"
import { ModelRouteTuning } from "../../model-route-tuning.js"

export const name = "route_stats"

export const description = `Read how routed models (opencode-route/*) have actually performed, to explain a routing problem or tune it.

Returns, for the last \`hours\` (default 24): attempts, failures, timeouts and average first-output latency and speed per provider/model; failures grouped by exact error tag, code and HTTP status with the latest provider message; current cooldowns; the active benches with which leaves are benched, until when, and why (including any known quota reset and probe state); request and token usage; and the adjustments in force.
It also returns each pool: its configuration, and per member how often it was offered and chosen, how often its new-session draws matched its weight, why it was left out (cooldown, provider limit, budget, user skip, context limit), and its latency, speed, errors and request sizes. Set \`route\` to one pool id to narrow that view. The tuner's notes come back too.
It lists suggested adjustments derived from that history (a high failure rate, repeated quota errors, unusually slow first output). Set \`apply\` to true to put the suggestions in force; they only lower a target's share or skip it, expire in 30 minutes, and are replaced by the next run. Apply them only when asked to tune routing or when the data clearly shows a problem.`

export const Input = Schema.Struct({
  hours: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 24 * 14 })).pipe(Schema.optional),
  route: Schema.String.pipe(Schema.optional).annotate({
    description: "A pool id, such as cheap-fast, to narrow the per-pool view to.",
  }),
  apply: Schema.Boolean.pipe(Schema.optional),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  benches: Schema.Array(Schema.Unknown),
  targets: Schema.Array(Schema.Unknown),
  hedges: Schema.Array(Schema.Unknown),
  predictions: Schema.Array(Schema.Unknown),
  errors: Schema.Array(Schema.Unknown),
  suggestions: Schema.Array(Schema.Unknown),
  adjustments: Schema.Array(Schema.Unknown),
  routes: Schema.Array(Schema.Unknown),
  notes: Schema.Array(Schema.String),
})

/** What the configuration says about pools and tuning. Read when the tool runs, so edits apply without a restart. */
export interface Source {
  readonly routes: ReadonlyMap<string, ConfigModelRoutes.Route>
  readonly notes: readonly string[]
  /** The Location directory whose quota gate judges tuning predictions (#1461). */
  readonly location?: string
}

const NO_SOURCE: Source = { routes: new Map(), notes: [] }

const MESSAGE_LIMIT = 300

/** The provider's reported windows, with how old the report is and when each resets. */
export const summarizeRateLimit = (snapshot: ModelRouteLimits.Snapshot | undefined, now: number) =>
  snapshot && {
    ageSeconds: Math.max(0, Math.round((now - snapshot.at) / 1000)),
    windows: ModelRouteLimits.windows(snapshot).map((window) => ({
      name: window.name,
      remaining: window.remaining,
      limit: window.limit ?? null,
      resetsInSeconds: window.resetAt === undefined ? null : Math.max(0, Math.round((window.resetAt - now) / 1000)),
    })),
  }

export const collect = (input: Input, source: Source = NO_SOURCE) =>
  Effect.gen(function* () {
    const now = Date.now()
    const since = now - (input.hours ?? 24) * 3_600_000
    const read = yield* ModelRouteLog.withDb((db) =>
      Effect.all({
        stats: ModelRouteLog.targetStats(db, since),
        errors: ModelRouteLog.errorBreakdown(db, since),
        hedges: ModelRouteLog.hedgeAccuracy(db, since),
        hourly: ModelRouteLog.hourlyStats(db, since),
        attempts: ModelRouteLog.attemptRows(db, since, input.route),
        decisions: ModelRouteLog.decisionRows(db, since, input.route),
      }).pipe(Effect.orDie),
    )
    const { stats, errors, hedges, hourly, attempts, decisions } = Option.getOrElse(read, () => ({
      stats: [],
      errors: [],
      hedges: [],
      hourly: [],
      attempts: [],
      decisions: [],
    }))
    const targets = stats.map((row) => {
      const ref = ModelRoute.ref({ providerID: row.providerID, model: row.modelID })
      const used = ModelRoute.usageOf(ref, now)
      return {
        ...row,
        cooldownSeconds: Math.max(0, Math.round((ModelRoute.cooldownUntil(ref, now) - now) / 1000)),
        // What the provider last said about its rate-limit windows, and how long that holds the target.
        rateLimit: summarizeRateLimit(ModelRoute.rateLimitOfAny(ref), now),
        heldBackSeconds: Math.max(0, Math.round((ModelRoute.limitedUntilAny(ref, now) - now) / 1000)),
        usedLastMinute: used.minute,
        usedLastDay: used.day,
      }
    })
    const predictions = ModelRouteTuning.predict({ hourly, errors, now, location: source.location })
    const suggestions = ModelRouteTuning.suggest({ stats, errors, now })
    const pools = new Map<string, ModelRouteReview.Configured>()
    for (const [id, route] of source.routes) {
      if (input.route === undefined || id === input.route) pools.set(id, ModelRouteReview.configured(route))
    }
    return {
      benches: ModelRoute.activeBenches(now),
      targets,
      hedges,
      predictions,
      errors: errors.map((error) => ({ ...error, lastMessage: error.lastMessage?.slice(0, MESSAGE_LIMIT) ?? null })),
      suggestions,
      // Only adjustments that apply to this Location are in force for it (#1461):
      // a tuning result computed under another Location's policy is not its rule.
      adjustments: ModelRoute.activeAdjustments(now).filter(
        (item) => item.location === undefined || item.location === source.location,
      ),
      routes: ModelRouteReview.summarize({ attempts, decisions, configured: pools }),
      notes: [...source.notes],
      noDatabase: Option.isNone(read),
    }
  })

const rateLimitText = (summary: ReturnType<typeof summarizeRateLimit>) =>
  summary && summary.windows.length > 0
    ? `; provider reported ${summary.windows
        .map(
          (window) =>
            `${window.name} ${window.remaining}${window.limit === null ? "" : `/${window.limit}`}${window.resetsInSeconds === null ? "" : ` (resets in ${window.resetsInSeconds}s)`}`,
        )
        .join(", ")} ${summary.ageSeconds}s ago`
    : ""

const counts = (values: Readonly<Record<string, number>>) =>
  Object.entries(values)
    .map(([key, count]) => `${key} ${count}`)
    .join(", ") || "none"

const describeRoute = (route: ModelRouteReview.RouteSummary) => {
  const pool = route.configured
  const settings = pool
    ? [
        pool.selection,
        pool.autonomy ? `autonomy ${pool.autonomy}` : undefined,
        pool.hedgeAfterMs ? `hedge after ${pool.hedgeAfterMs}ms` : undefined,
      ]
        .filter((item) => item !== undefined)
        .join(", ")
    : "not in the configuration"
  const header = `pool ${route.id} (${settings}): ${route.attempts} attempts, ${route.sessions} sessions, ${route.decisions} selections; input tokens p50 ${route.inputTokens.p50 ?? "n/a"}, p90 ${route.inputTokens.p90 ?? "n/a"}; selections by reason: ${counts(route.reasons)}`
  return [header, ...route.members.map(describeMember)]
}

const describeMember = (member: ModelRouteReview.Member) => {
  const parts: string[] = []
  if (member.configuredWeight !== null) parts.push(`weight ${member.configuredWeight}`)
  if (member.configuredLimit !== null) parts.push(`ceiling ${member.configuredLimit}`)
  if (member.attempts === 0 && member.offered === 0 && Object.keys(member.excluded).length === 0) {
    return `  ${member.target}: ${parts.join(", ") || "not listed"}, no traffic in this window`
  }
  parts.push(`${member.attempts} attempts`)
  if (member.failureRate !== null)
    parts.push(
      `${Math.round(member.failureRate * 100)}% failed${member.timeouts ? `, ${member.timeouts} timed out` : ""}`,
    )
  if (member.firstTokenMs !== null) parts.push(`first output ${member.firstTokenMs}ms`)
  if (member.tokensPerSecond !== null) parts.push(`${member.tokensPerSecond} tok/s`)
  if (member.inputTokens !== null) parts.push(`median input ${member.inputTokens} tokens`)
  parts.push(`offered ${member.offered}, chosen ${member.chosen}`)
  if (member.takeRate !== null)
    parts.push(
      `won ${member.drawsWon} of ${member.draws} new-session draws (${Math.round(member.takeRate * 100)}%, expected ${member.expectedShare === null ? "n/a" : `${Math.round(member.expectedShare * 100)}%`})`,
    )
  if (member.weightLayers)
    parts.push(
      `weight layers: base ${member.weightLayers.base}, scheduled ${member.weightLayers.scheduled}, prefer ${member.weightLayers.prefer}, adjustment ${member.weightLayers.adjustment}, final ${member.weightLayers.demotion}${member.weightLayers.gate ? `, gate: ${member.weightLayers.gate}` : ""}`,
    )
  if (Object.keys(member.excluded).length > 0) parts.push(`excluded: ${counts(member.excluded)}`)
  if (Object.keys(member.errorTags).length > 0) parts.push(`errors: ${counts(member.errorTags)}`)
  return `  ${member.target}: ${parts.join(", ")}`
}

const describe = (report: Effect.Success<ReturnType<typeof collect>>, applied: number, requested?: string) => {
  const routes = report.routes.flatMap(describeRoute)
  const notes = report.notes.length > 0 ? [`Tuner notes: ${report.notes.join("; ")}`] : []
  const missing =
    requested !== undefined && report.routes.length === 0
      ? [`No pool named ${requested} is in the configuration or has traffic in this window.`]
      : []
  if (report.noDatabase)
    return ["Routing history is unavailable: no database is attached.", ...routes, ...missing, ...notes].join("\n")
  const lines = [`${report.targets.length} targets with attempts in the window.`]
  for (const row of report.targets)
    lines.push(
      `${row.providerID}/${row.modelID}: ${row.attempts} attempts, ${row.failures} failed, ${row.timeouts} timed out, first output ${row.avgFirstTokenMs === null ? "n/a" : `${Math.round(row.avgFirstTokenMs)}ms`}, ${row.avgTokensPerSecond === null ? "n/a" : `${row.avgTokensPerSecond.toFixed(1)} tok/s`}${row.cooldownSeconds > 0 ? `, cooling ${row.cooldownSeconds}s` : ""}${row.heldBackSeconds > 0 ? `, held back ${row.heldBackSeconds}s by the provider's rate limit` : ""}${rateLimitText(row.rateLimit)}; used ${row.usedLastDay.requests} requests / ${row.usedLastDay.tokens} tokens in 24h`,
    )
  for (const bench of report.benches)
    lines.push(
      `benched: ${bench.providerID}/${bench.modelID}${bench.credentialID ? ` credential:${bench.credentialID}` : ""} until ${new Date(bench.until).toISOString()} (${bench.reason}, ${bench.consecutiveFailures} consecutive failures${bench.quotaResetAt !== undefined ? `, quota reset ${new Date(bench.quotaResetAt).toISOString()}` : ""}${bench.probeClaimed ? ", probe in flight" : bench.probeDue ? ", probe due" : ""})`,
    )
  for (const error of report.errors)
    lines.push(
      `${error.providerID}/${error.modelID} x${error.count}: ${error.tag ?? "unknown"} ${error.code ?? ""} ${error.status ?? ""} ${error.lastMessage ?? ""}`
        .replace(/\s+/g, " ")
        .trim(),
    )
  for (const prediction of report.predictions) {
    if (prediction.state === "busy-hour")
      lines.push(`predicted: ${prediction.target} is historically unreliable at this hour: ${prediction.detail}`)
    else if (prediction.until !== undefined)
      lines.push(
        `predicted: ${prediction.target} quota returns ${new Date(prediction.until).toISOString()}: ${prediction.detail}`,
      )
  }
  for (const hedge of report.hedges) {
    const rate = hedge.hedges === 0 ? 0 : Math.round((hedge.wins / hedge.hedges) * 100)
    lines.push(
      `hedge accuracy ${hedge.providerID}/${hedge.modelID}: ${hedge.wins}/${hedge.hedges} races won (${rate}%)`,
    )
  }
  lines.push(
    report.suggestions.length === 0
      ? "No adjustments suggested."
      : `${applied > 0 ? "Applied" : "Suggested"}: ${report.suggestions.map((item) => `${item.action} ${item.match}${item.factor ? ` x${item.factor}` : ""} (${item.note})`).join("; ")}`,
  )
  return [...lines, ...missing, ...routes, ...notes].join("\n")
}

/** Reading is free; putting suggestions in force needs the same approval as `route_adjust`. */
export const add = (editor: ToolEditor, permission: Permission.Interface, source: () => Source = () => NO_SOURCE) =>
  editor.add({
    name,
    options: { codemode: false },
    description,
    input: Input,
    output: Output,
    execute: (input, context) =>
      Effect.gen(function* () {
        const report = yield* collect(input, source())
        const apply = input.apply === true && report.suggestions.length > 0
        if (apply) {
          yield* permission
            .assert({
              action: name,
              resources: report.suggestions.map((item) => item.match),
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: `Permission denied: ${name}`, error })))
          for (const item of report.suggestions) ModelRoute.addAdjustment(item, item.note)
        }
        return {
          output: {
            benches: report.benches,
            targets: report.targets,
            hedges: report.hedges,
            predictions: report.predictions,
            errors: report.errors,
            suggestions: report.suggestions,
            adjustments: ModelRoute.activeAdjustments().filter(
              (item) => item.location === undefined || item.location === source().location,
            ),
            routes: report.routes,
            notes: report.notes,
          },
          content: describe(report, apply ? report.suggestions.length : 0, input.route),
        }
      }),
  })
