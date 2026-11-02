export * as ModelPlan from "./model-plan.js"

import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { Schema } from "effect"
import { ModelRouteLimits } from "./model-route-limits.js"
import { ownValue } from "./util/record.js"

/**
 * The plan store: subscriptions and their quota windows, the cost tier of each model, what each pool is for,
 * and the notes the user has given about how usage has felt. Plain JSON in OpenCode's data directory, so the
 * tools here and OpenChamber read and write the same file. Notes are an append-only log beside it. Nothing is
 * removed: a plan that ends is marked `expired` or `cancelled`, and the history stays.
 */

export const Coverage = Schema.Literals(["subscription", "credits", "metered", "free", "trial"])
export const Tier = Schema.Literals(["cheap", "standard", "frontier"])
export const Unit = Schema.Literals(["requests", "messages", "tokens", "usd", "percent", "other"])
export const Status = Schema.Literals(["active", "expired", "cancelled", "unknown"])
export const Period = Schema.Literals(["monthly", "yearly", "once"])
export const NoteKind = Schema.Literals(["experience", "expectation", "plan-change", "correction", "other"])
export const NoteSource = Schema.Literals(["user", "model", "ui"])

export const Fee = Schema.Struct({
  amount: Schema.Finite,
  currency: Schema.String,
  period: Period,
  renewsOn: Schema.optional(Schema.String),
})

/** One limit a plan puts on usage: a count, a token budget or a dollar amount, over a window that resets. */
export const QuotaWindow = Schema.Struct({
  name: Schema.String,
  unit: Unit,
  limit: Schema.optional(Schema.Finite),
  windowHours: Schema.optional(Schema.Finite),
  resetRule: Schema.optional(Schema.String),
  resetAt: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})

export const Plan = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  label: Schema.String,
  plan: Schema.optional(Schema.String),
  coverage: Coverage,
  fee: Schema.optional(Fee),
  quotas: Schema.Array(QuotaWindow),
  expiresOn: Schema.optional(Schema.String),
  status: Status,
  verifiedAt: Schema.optional(Schema.String),
  verifiedFrom: Schema.optional(Schema.String),
  howToCheck: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

/** The cost tier the user puts a model in. `plan` means a flat plan covers it, so its marginal cost is zero within quota. */
export const ModelEntry = Schema.Struct({
  tier: Tier,
  coveredBy: Schema.optional(Schema.Array(Schema.String)),
  note: Schema.optional(Schema.String),
  updatedAt: Schema.String,
})

export const PoolEntry = Schema.Struct({
  tier: Schema.optional(Tier),
  purpose: Schema.optional(Schema.String),
  updatedAt: Schema.String,
})

export const Store = Schema.Struct({
  version: Schema.Literal(1),
  plans: Schema.Array(Plan),
  models: Schema.Record(Schema.String, ModelEntry),
  pools: Schema.Record(Schema.String, PoolEntry),
})

export const Note = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  kind: NoteKind,
  text: Schema.String,
  source: NoteSource,
  providerID: Schema.optional(Schema.String),
  planID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  poolID: Schema.optional(Schema.String),
})

export type Fee = typeof Fee.Type
export type QuotaWindow = typeof QuotaWindow.Type
export type Plan = typeof Plan.Type
export type ModelEntry = typeof ModelEntry.Type
export type PoolEntry = typeof PoolEntry.Type
export type Store = typeof Store.Type
export type Note = typeof Note.Type
export type Tier = typeof Tier.Type
export type Coverage = typeof Coverage.Type
export type Status = typeof Status.Type
export type NoteKind = typeof NoteKind.Type

export const emptyStore = (): Store => ({ version: 1, plans: [], models: {}, pools: {} })

const directory = (dataDir?: string) => dataDir ?? Global.Path.data

/** Reads the store. A missing file is an empty store; a malformed one is an error, so a bad write cannot
 * silently erase the user's plans. */
export const readStore = (dataDir?: string): Store => {
  const file = path.join(directory(dataDir), "plans.json")
  if (!fs.existsSync(file)) return emptyStore()
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or move it before recording plan information.`)
  }
  return Schema.decodeUnknownSync(Store)(parsed)
}

/**
 * Whether a plan still describes capacity the quota gate may act on. A plan that has
 * ended (`expired` or `cancelled`) stays in the store as history but must not feed the
 * gate: its smaller window could otherwise produce the gating snapshot for a provider
 * whose current plan has room (#1340). A plan whose status is `unknown` was never
 * verified as ended, so it keeps feeding — only a positively ended plan drops out.
 */
export const feedsGate = (plan: Plan): boolean => plan.status !== "expired" && plan.status !== "cancelled"

const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])
const renameRetryDelays = [10, 25, 50, 100]
const renameWait = new Int32Array(new SharedArrayBuffer(4))

function isTransientRenameError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  if (!("code" in error)) return false
  return typeof error.code === "string" && transientRenameCodes.has(error.code)
}

// On Windows, renaming over a destination another handle is reading fails
// with EPERM and the update would be lost; retry briefly before giving up
// (same fix as #85 for the TUI persistence helper, kept in sync with the
// desktop copy in packages/desktop/src/main/atomic-write.ts).
function renameSyncWithRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination)
      return
    } catch (error) {
      const delay = renameRetryDelays[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      Atomics.wait(renameWait, 0, 0, delay)
    }
  }
}

/** Writes the store atomically: a temporary file in the same directory, then a rename over the old one. */
export const writeStore = (store: Store, dataDir?: string) => {
  const dir = directory(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "plans.json")
  const valid = Schema.decodeUnknownSync(Store)(store)
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`)
    renameSyncWithRetry(temporary, file)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {}
    throw error
  }
}

/** A stable id from a provider and a name: `anthropic-max-20x`. */
export const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    // The slice can cut right after a separator, leaving a trailing dash the trim above missed.
    .replace(/-+$/, "")

/** Fields to change on a plan. A field left out is kept; a field set to null is removed. */
export interface PlanPatch {
  readonly id?: string
  readonly providerID?: string
  readonly label?: string
  readonly plan?: string | null
  readonly coverage?: Coverage
  readonly fee?: Fee | null
  readonly quotas?: readonly QuotaWindow[]
  readonly expiresOn?: string | null
  readonly status?: Status
  readonly verifiedAt?: string | null
  readonly verifiedFrom?: string | null
  readonly howToCheck?: string | null
  readonly notes?: string | null
}

const merge = <T extends object>(base: T, patch: object): T => {
  const next = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next as T
}

/** Creates or updates a plan. A new plan starts as an active subscription with no quota until one is given. */
export const upsertPlan = (store: Store, patch: PlanPatch, now: string): { store: Store; plan: Plan } => {
  const providerID = patch.providerID ?? store.plans.find((plan) => plan.id === patch.id)?.providerID
  if (!providerID) throw new Error("A plan needs a providerID, such as anthropic or openai.")
  const id = patch.id ?? slug(`${providerID}-${patch.plan ?? patch.label ?? "plan"}`)
  const existing = store.plans.find((plan) => plan.id === id)
  const base = existing ?? {
    id,
    providerID,
    label: providerID,
    coverage: "subscription",
    quotas: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
  }
  const plan = Schema.decodeUnknownSync(Plan)(merge(base, { ...patch, id, providerID, updatedAt: now }))
  const plans = existing ? store.plans.map((item) => (item.id === id ? plan : item)) : [...store.plans, plan]
  return { store: { ...store, plans }, plan }
}

/** Sets the cost tier of a model (`provider/model`), and optionally the plans that cover it. */
export const setModel = (
  store: Store,
  model: string,
  patch: { tier?: Tier; coveredBy?: readonly string[] | null; note?: string | null },
  now: string,
): Store => {
  // Own-property reads: an id named for an inherited key ("constructor", "toString") must
  // start from an empty entry rather than merging whatever the prototype chain answers.
  const existing = ownValue(store.models, model)
  const tier = patch.tier ?? existing?.tier
  if (!tier) throw new Error(`${model} needs a tier: cheap, standard or frontier.`)
  const entry = Schema.decodeUnknownSync(ModelEntry)(merge(existing ?? {}, { ...patch, tier, updatedAt: now }))
  return { ...store, models: { ...store.models, [model]: entry } }
}

/** Sets what a pool is for, and the tier it sits at. */
export const setPool = (
  store: Store,
  poolID: string,
  patch: { tier?: Tier | null; purpose?: string | null },
  now: string,
): Store => {
  const existing = ownValue(store.pools, poolID) ?? {}
  const entry = Schema.decodeUnknownSync(PoolEntry)(merge(existing, { ...patch, updatedAt: now }))
  return { ...store, pools: { ...store.pools, [poolID]: entry } }
}

export interface NoteInput {
  readonly text: string
  readonly kind?: NoteKind
  readonly source?: typeof NoteSource.Type
  readonly providerID?: string
  readonly planID?: string
  readonly modelID?: string
  readonly poolID?: string
}

const noteFile = (dataDir?: string) => path.join(directory(dataDir), "plan-notes.jsonl")

/** Appends a note. Notes are never rewritten, so what the user said stays as they said it. */
export const addNote = (input: NoteInput, now: string, dataDir?: string): Note => {
  const text = input.text.trim()
  if (!text) throw new Error("A note needs some text.")
  // Calendar check via ModelRouteLimits.parseAbsoluteTime (#609): a bare Date.parse silently
  // rolls calendar-invalid dates such as 2026-02-30 into the next month, so the id must not
  // embed the rolled instant; a date with no usable instant embeds NaN, as an unparseable
  // date always has.
  const note = Schema.decodeUnknownSync(Note)({
    id: `note_${(ModelRouteLimits.parseAbsoluteTime(now) ?? Number.NaN).toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    kind: input.kind ?? "other",
    text,
    source: input.source ?? "user",
    ...(input.providerID ? { providerID: input.providerID } : {}),
    ...(input.planID ? { planID: input.planID } : {}),
    ...(input.modelID ? { modelID: input.modelID } : {}),
    ...(input.poolID ? { poolID: input.poolID } : {}),
  })
  fs.mkdirSync(directory(dataDir), { recursive: true })
  fs.appendFileSync(noteFile(dataDir), `${JSON.stringify(note)}\n`)
  return note
}

export interface NoteFilter {
  readonly providerID?: string
  readonly planID?: string
  readonly modelID?: string
  readonly poolID?: string
  readonly kind?: NoteKind
  readonly since?: string
  readonly limit?: number
}

/** The notes that match, oldest first, keeping the newest `limit`. A line that does not parse is skipped and
 * counted, so one damaged line cannot hide the rest. A `since` that does not parse is a caller error and
 * throws, rather than silently matching nothing; a note whose own timestamp does not parse cannot be
 * shown to be at or after `since`, so under a `since` filter it is skipped and counted too. */
export const readNotes = (filter: NoteFilter = {}, dataDir?: string): { notes: Note[]; skipped: number } => {
  // Calendar check via ModelRouteLimits.parseAbsoluteTime (#609): a bare Date.parse silently
  // rolls a calendar-invalid since such as 2026-02-30 into Mar 2, so it would filter from
  // the rolled instant instead of throwing the caller error below. Non-ISO parseable forms
  // keep their current behaviour (parseAbsoluteTime only calendar-checks ISO-shaped dates).
  const since = filter.since === undefined ? undefined : ModelRouteLimits.parseAbsoluteTime(filter.since)
  if (filter.since !== undefined && since === undefined)
    throw new Error(`The since filter "${filter.since}" is not a parseable date. Use an ISO timestamp, or omit it.`)
  const file = noteFile(dataDir)
  if (!fs.existsSync(file)) return { notes: [], skipped: 0 }
  let skipped = 0
  const parsed: Note[] = []
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      parsed.push(Schema.decodeUnknownSync(Note)(JSON.parse(line)))
    } catch {
      skipped += 1
    }
  }
  const candidates = parsed
    .filter((note) => filter.providerID === undefined || note.providerID === filter.providerID)
    .filter((note) => filter.planID === undefined || note.planID === filter.planID)
    .filter((note) => filter.modelID === undefined || note.modelID === filter.modelID)
    .filter((note) => filter.poolID === undefined || note.poolID === filter.poolID)
    .filter((note) => filter.kind === undefined || note.kind === filter.kind)
  const matching: Note[] = []
  for (const note of candidates) {
    if (since === undefined) {
      matching.push(note)
      continue
    }
    const at = ModelRouteLimits.parseAbsoluteTime(note.at)
    if (at === undefined) {
      skipped += 1
      continue
    }
    if (at >= since) matching.push(note)
  }
  matching
    .sort((left, right) => {
      const leftAt = ModelRouteLimits.parseAbsoluteTime(left.at)
      const rightAt = ModelRouteLimits.parseAbsoluteTime(right.at)
      if (leftAt === undefined) return rightAt === undefined ? 0 : -1
      if (rightAt === undefined) return 1
      return leftAt - rightAt
    })
  // slice(-0) is slice(0): a limit of 0 (or less) must keep no notes, not every note.
  // A non-finite limit slips past that guard (NaN <= 0 is false, and slice(-Infinity) is
  // also slice(0)), so it keeps no notes either (#733).
  // A fractional limit truncates the same way in slice: slice(-0.5) is also slice(0), so
  // a limit in (0, 1) would return every note (#904). Floor the limit first: a floored
  // limit of 0 keeps no notes, and a fractional limit >= 1 keeps at most the floored count.
  const floored = filter.limit === undefined ? undefined : Math.floor(filter.limit)
  const limited = floored === undefined ? matching : !Number.isFinite(floored) || floored <= 0 ? [] : matching.slice(-floored)
  return { notes: limited, skipped }
}

/** Whole days since a date the user or the model recorded, or null when there is no usable date. */
export const daysSince = (date: string | undefined, now: number) => {
  if (date === undefined) return null
  // Calendar-invalid dates (2026-02-30) have no usable instant either: a bare Date.parse
  // would count from the rolled instant (Mar 2) instead.
  const at = ModelRouteLimits.parseAbsoluteTime(date)
  return at === undefined ? null : Math.max(0, Math.floor((now - at) / 86_400_000))
}

const GENERAL_GUIDANCE = [
  "Open the provider's billing or usage page and read the plan name, the included quota, and when it resets.",
  "In OpenChamber, Settings → Usage shows the windows a provider reports for accounts with saved credentials.",
  "Record the date you checked (verifiedAt) and where the numbers came from (verifiedFrom).",
  "If a number cannot be found, record the plan name and the reset rule, and leave the limit empty.",
  "Check again after a renewal, a plan change, or when the user reports running out or having quota left over.",
]

/** Where to look for a provider's current plan details. The steps are rough and say when a number is unknown. */
export const guidance = (providerID: string): readonly string[] =>
  providerID === "opencode" || providerID === "opencode-go"
    ? [...GENERAL_GUIDANCE, "OpenCode's console at opencode.ai/console shows the account's billing and usage status."]
    : GENERAL_GUIDANCE
