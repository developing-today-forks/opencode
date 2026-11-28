export * as PlanInfoTool from "./plan-info.js"

import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import type { Permission } from "../../permission.js"
import { ModelPlan } from "../../model-plan.js"

export const name = "plan_info"

export const description = `Read and record the user's model plans: subscriptions and their quota windows, the cost tier of each model, what each pool is for, and notes about how usage has felt.

Actions:
- list: every plan with the days since it was last verified, the model tiers, the pool tiers and the latest notes.
- get: one plan by id, or the first plan for providerID, with guidance on where to find its current details.
- upsert: create or update a plan. Give providerID, and any of label, plan, coverage, fee, quotas, expiresOn, status, verifiedAt, verifiedFrom, howToCheck, details. A quota window is { name, unit, limit, windowHours, resetRule }.
- tier: set a model's cost tier. model is "provider/model"; tier is cheap, standard or frontier; coveredBy lists the plan ids that cover it.
- pool: set what a pool is for and its tier. id is the pool id.
- note: record what the user said, as text, with a kind (experience, expectation, plan-change, correction, other) and the provider, plan, model or pool it is about. Notes are never rewritten.
- notes: list notes, filtered by providerID, planID, modelID, poolID, kind or since.

Record only what the user said or a source shows, and date every verification. Writes need approval, like route_adjust.`

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "get", "upsert", "tier", "pool", "note", "notes"]),
  id: Schema.String.pipe(Schema.optional).annotate({ description: "Plan id (get, upsert) or pool id (pool)." }),
  providerID: Schema.String.pipe(Schema.optional),
  label: Schema.String.pipe(Schema.optional),
  plan: Schema.String.pipe(Schema.optional).annotate({ description: "The plan's name as the provider calls it." }),
  coverage: ModelPlan.Coverage.pipe(Schema.optional),
  fee: ModelPlan.Fee.pipe(Schema.optional),
  quotas: Schema.Array(ModelPlan.QuotaWindow).pipe(Schema.optional),
  expiresOn: Schema.String.pipe(Schema.optional),
  status: ModelPlan.Status.pipe(Schema.optional),
  verifiedAt: Schema.String.pipe(Schema.optional).annotate({ description: "The date the details were last checked." }),
  verifiedFrom: Schema.String.pipe(Schema.optional).annotate({ description: "Where the details came from." }),
  howToCheck: Schema.String.pipe(Schema.optional),
  details: Schema.String.pipe(Schema.optional).annotate({ description: "Free text about the plan." }),
  model: Schema.String.pipe(Schema.optional).annotate({ description: "A model as provider/model." }),
  tier: ModelPlan.Tier.pipe(Schema.optional),
  coveredBy: Schema.Array(Schema.String).pipe(Schema.optional),
  purpose: Schema.String.pipe(Schema.optional),
  text: Schema.String.pipe(Schema.optional),
  kind: ModelPlan.NoteKind.pipe(Schema.optional),
  planID: Schema.String.pipe(Schema.optional),
  modelID: Schema.String.pipe(Schema.optional),
  poolID: Schema.String.pipe(Schema.optional),
  since: Schema.String.pipe(Schema.optional),
  limit: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({ result: Schema.Unknown })

export interface Options {
  readonly dataDir?: string
  readonly now?: () => Date
}

const daysText = (days: number | null) => (days === null ? "never" : `${days} days ago`)

const quotaText = (window: ModelPlan.QuotaWindow) =>
  `${window.name}: ${window.limit ?? "limit unknown"} ${window.unit}${window.windowHours === undefined ? "" : ` per ${window.windowHours}h`}, resets ${window.resetRule ?? window.resetAt ?? "unknown"}`

const planText = (plan: ModelPlan.Plan, now: number) =>
  [
    `${plan.id} (${plan.providerID}): ${plan.plan ?? plan.label}, ${plan.coverage}, ${plan.status}, verified ${plan.verifiedAt ?? "never"} (${daysText(ModelPlan.daysSince(plan.verifiedAt, now))})`,
    ...plan.quotas.map((window) => `  - ${quotaText(window)}`),
  ].join("\n")

const withoutUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>

/** The tool's effect, separate from permission handling so it can be exercised directly. */
export const apply = (input: Input, options: Options = {}): { output: { result: unknown }; content: string } => {
  const now = options.now?.() ?? new Date()
  const iso = now.toISOString()
  // Per-entry tolerant read (#2922): one malformed entry is skipped and surfaced, not fatal to the
  // whole read. Writes refuse while anything was skipped — writing the tolerated store back would
  // silently drop the skipped entries, which is the silent erase the store contract forbids.
  const { store, skipped } = ModelPlan.readStoreDetailed(options.dataDir)
  const skippedText = skipped.map((entry) => `${entry.kind}${entry.id === undefined ? "" : ` "${entry.id}"`}`).join(", ")
  const skippedNote =
    skipped.length > 0 ? `(${skipped.length} unreadable store entries skipped: ${skippedText})` : ""
  if ((input.action === "upsert" || input.action === "tier" || input.action === "pool") && skipped.length > 0) {
    throw new Error(
      `plans.json has ${skipped.length} unreadable entries (${skippedText}) that this write would drop. Fix or remove them in plans.json before recording plan information.`,
    )
  }
  const done = (result: unknown, content: string) => ({ output: { result }, content })

  if (input.action === "list") {
    const notes = ModelPlan.readNotes({ limit: 5 }, options.dataDir)
    const models = Object.entries(store.models).map(([model, entry]) => `${model}: ${entry.tier}`)
    const pools = Object.entries(store.pools).map(
      ([pool, entry]) => `${pool}: ${entry.tier ?? "no tier"}${entry.purpose ? ` (${entry.purpose})` : ""}`,
    )
    return done(
      { plans: store.plans, models: store.models, pools: store.pools, notes: notes.notes, skipped },
      [
        store.plans.length === 0
          ? "No plans recorded yet."
          : store.plans.map((plan) => planText(plan, now.getTime())).join("\n"),
        models.length ? `Model tiers: ${models.join("; ")}` : "No model tiers recorded.",
        pools.length ? `Pool tiers: ${pools.join("; ")}` : "No pool tiers recorded.",
        notes.notes.length
          ? `Latest notes:\n${notes.notes.map((note) => `  ${note.at.slice(0, 10)} [${note.kind}] ${note.text}`).join("\n")}`
          : "No notes recorded.",
        skippedNote,
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  if (input.action === "get") {
    const plan = store.plans.find(
      (item) => item.id === input.id || (input.id === undefined && item.providerID === input.providerID),
    )
    if (!plan)
      return done(
        null,
        `No plan matches ${input.id ?? input.providerID ?? "that request"}.${skippedNote ? ` ${skippedNote}` : ""}`,
      )
    const guide = ModelPlan.guidance(plan.providerID)
    return done(
      { plan, guidance: guide },
      [
        planText(plan, now.getTime()),
        plan.howToCheck ? `How to check: ${plan.howToCheck}` : "",
        ...guide.map((step) => `- ${step}`),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  if (input.action === "upsert") {
    const patch = withoutUndefined({
      id: input.id,
      providerID: input.providerID,
      label: input.label,
      plan: input.plan,
      coverage: input.coverage,
      fee: input.fee,
      quotas: input.quotas,
      expiresOn: input.expiresOn,
      status: input.status,
      verifiedAt: input.verifiedAt,
      verifiedFrom: input.verifiedFrom,
      howToCheck: input.howToCheck,
      notes: input.details,
    })
    const result = ModelPlan.upsertPlan(store, patch, iso)
    ModelPlan.writeStore(result.store, options.dataDir)
    return done(result.plan, `Saved plan ${result.plan.id}: ${planText(result.plan, now.getTime())}`)
  }

  if (input.action === "tier") {
    if (!input.model) return done(null, "Setting a tier needs model, as provider/model.")
    const next = ModelPlan.setModel(
      store,
      input.model,
      withoutUndefined({ tier: input.tier, coveredBy: input.coveredBy, note: input.details }),
      iso,
    )
    ModelPlan.writeStore(next, options.dataDir)
    return done(next.models[input.model], `Set ${input.model} to the ${next.models[input.model]?.tier} tier.`)
  }

  if (input.action === "pool") {
    if (!input.id) return done(null, "Setting a pool needs its id.")
    const next = ModelPlan.setPool(store, input.id, withoutUndefined({ tier: input.tier, purpose: input.purpose }), iso)
    ModelPlan.writeStore(next, options.dataDir)
    return done(
      next.pools[input.id],
      `Pool ${input.id}: ${next.pools[input.id]?.tier ?? "no tier"}${next.pools[input.id]?.purpose ? `, ${next.pools[input.id]?.purpose}` : ""}.`,
    )
  }

  if (input.action === "note") {
    if (!input.text) return done(null, "A note needs text.")
    const note = ModelPlan.addNote(
      withoutUndefined({
        text: input.text,
        kind: input.kind,
        source: "model" as const,
        providerID: input.providerID,
        planID: input.planID,
        modelID: input.modelID,
        poolID: input.poolID,
      }) as ModelPlan.NoteInput,
      iso,
      options.dataDir,
    )
    return done(note, `Recorded ${note.id} (${note.kind}): ${note.text}`)
  }

  const listed = ModelPlan.readNotes(
    withoutUndefined({
      providerID: input.providerID,
      planID: input.planID,
      modelID: input.modelID,
      poolID: input.poolID,
      kind: input.kind,
      since: input.since,
      limit: input.limit ?? 50,
    }),
    options.dataDir,
  )
  return done(
    listed.notes,
    listed.notes.length === 0
      ? "No matching notes."
      : listed.notes.map((note) => `${note.at.slice(0, 10)} [${note.kind}] ${note.text}`).join("\n") +
          (listed.skipped > 0 ? `\n(${listed.skipped} unreadable lines skipped)` : ""),
  )
}

/** Reads are free. Recording a plan, tier, pool purpose or note needs the same approval as other changes. */
export const add = (editor: ToolEditor, permission: Permission.Interface, options: Options = {}) =>
  editor.add({
    name,
    options: { codemode: false },
    description,
    input: Input,
    output: Output,
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.action !== "list" && input.action !== "get" && input.action !== "notes") {
          yield* permission
            .assert({
              action: name,
              resources: [input.id ?? input.model ?? input.providerID ?? input.poolID ?? "*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: `Permission denied: ${name}`, error })))
        }
        const result = yield* Effect.try({
          try: () => apply(input, options),
          catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        })
        return result
      }),
  })
