export * as ModelRouteOverrides from "./model-route-overrides.js"

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"
import { ModelRouteSchedule } from "./model-route-schedule.js"

/** `avoid` takes a target out of rotation, `prefer` favours it, `allow-over-budget` lets it run past
 * its soft budget. Each one lasts until `until`, and applies only to the targets it names. */
export type Action = "avoid" | "prefer" | "allow-over-budget"

export interface Override {
  readonly id: string
  readonly action: Action
  /** Provider IDs, compared case-insensitively. Empty means any provider. */
  readonly providers: readonly string[]
  /** Model ID patterns where `*` matches any run of characters. Empty means every model of the
   * named providers; `*` on its own is the explicit "every model" choice. */
  readonly models: readonly string[]
  /** Route IDs the override is limited to. Empty means every route. */
  readonly routes: readonly string[]
  /** Whether it reaches routes set to `fixed`. On by default: a user's word outranks the route's level. */
  readonly fixed: boolean
  /** For `prefer`: the weight multiplier. Above 1 favours the target, below 1 makes it lighter. */
  readonly factor?: number
  readonly weight?: number
  readonly schedule?: ModelRouteSchedule.Window
  readonly until?: number
  readonly text: string
  readonly source: "user" | "interpreter"
  readonly createdAt: number
}

const ACTIONS: readonly Action[] = ["avoid", "prefer", "allow-over-budget"]

const field = (value: unknown, name: string) =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : []

/** A scope list that is present but not all strings is malformed: emptying it would widen the
 * entry to everything in that dimension, so the entry is dropped instead (#536). */
const malformedList = (value: unknown) =>
  value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))

/** Keeps only well-formed entries. An entry must name at least one provider or model pattern, so a
 * malformed file can never silently apply to everything. */
export const parse = (value: unknown): Override[] => {
  const list = field(value, "overrides")
  if (!Array.isArray(list)) return []
  return list.flatMap((item): Override[] => {
    const action = field(item, "action")
    const id = field(item, "id")
    const until = field(item, "until")
    if (typeof id !== "string" || !ACTIONS.includes(action as Action)) return []
    const rawSchedule = field(item, "schedule")
    const schedule = ModelRouteSchedule.parse(rawSchedule)
    // A schedule that is present but unreadable is malformed, not absent: keeping the
    // entry would drop its time restriction and make a time-boxed override always-on
    // until it expires (the widening shape of #536, one dimension over).
    if (rawSchedule !== undefined && schedule === undefined) return []
    const hasUntil = typeof until === "number" && Number.isFinite(until)
    // An until that is present but not a finite number is malformed, not absent: keeping
    // the entry would drop its expiry and make a time-limited override permanent on
    // its schedule (the widening shape of #536/#570, one dimension over).
    if (until !== undefined && !hasUntil) return []
    if (!hasUntil && schedule === undefined) return []
    if (
      malformedList(field(item, "providers")) ||
      malformedList(field(item, "models")) ||
      malformedList(field(item, "routes"))
    )
      return []
    const providers = strings(field(item, "providers"))
    const models = strings(field(item, "models"))
    if (providers.length === 0 && models.length === 0) return []
    const routes = strings(field(item, "routes"))
    const fixed = field(item, "fixed") !== false
    const factorValue = field(item, "factor")
    const weightValue = field(item, "weight")
    // For `prefer`, a factor/weight that is present but not positive-finite is malformed,
    // not absent: absent means the default PREFERRED_FACTOR lift in routing, so keeping
    // the entry would silently turn a written factor: 0 into that lift — the widening
    // shape of #536/#570, one field over. The schema surface defines these fields as
    // PositiveFinite, so the entry is dropped instead (#662). Factor/weight mean
    // nothing for the other actions, so there the fields are simply ignored as
    // before — dropping an `avoid` entry over an irrelevant field would discard a
    // user instruction that was never widened by it.
    const positiveFinite = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
    if (
      action === "prefer" &&
      ((factorValue !== undefined && positiveFinite(factorValue) === undefined) ||
        (weightValue !== undefined && positiveFinite(weightValue) === undefined))
    )
      return []
    const factor = positiveFinite(factorValue)
    const weight = positiveFinite(weightValue)
    const text = field(item, "text")
    const source = field(item, "source")
    const createdAt = field(item, "createdAt")
    return [
      {
        id,
        action: action as Action,
        providers,
        models,
        routes,
        fixed,
        ...(factor !== undefined ? { factor } : {}),
        ...(weight !== undefined ? { weight } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(hasUntil ? { until } : {}),
        text: typeof text === "string" ? text : "",
        source: source === "interpreter" ? "interpreter" : "user",
        createdAt: typeof createdAt === "number" ? createdAt : 0,
      },
    ]
  })
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`, "i")

/** Whether a `*` pattern matches a provider/model string; shared with scheduled weight rules. */
export const matchesPattern = (pattern: string, value: string) => glob(pattern).test(value)

/** The route a request is being chosen for, and whether that route is set to `fixed`. Without a scope
 * an override applies to every route, as it did before routes had levels. */
export interface Scope {
  readonly routeID?: string
  readonly fixed?: boolean
  /** The route's autonomy level; learned adjustments apply only where it reaches their floor. */
  readonly autonomy?: ModelRouteAutonomy.Level
}

/** Whether an override is in force for a target at `now`, on a given route. */
export const applies = (
  item: Override,
  target: { readonly providerID: string; readonly id: string },
  now: number,
  scope: Scope = {},
) =>
  (item.until === undefined || now < item.until) &&
  (item.schedule === undefined || ModelRouteSchedule.active(item.schedule, now)) &&
  (item.providers.length === 0 || item.providers.some((id) => id.toLowerCase() === target.providerID.toLowerCase())) &&
  (item.models.length === 0 || item.models.some((pattern) => glob(pattern).test(target.id))) &&
  (item.routes.length === 0 ||
    scope.routeID === undefined ||
    item.routes.some((id) => id.toLowerCase() === scope.routeID?.toLowerCase())) &&
  (item.fixed || scope.fixed !== true)

let location: string | undefined
let cache: { file: string; mtime: number; list: readonly Override[] } | undefined

/** Where overrides are kept: a separate file in OpenCode's data directory, so the user's config keys
 * are never rewritten and OpenChamber can read the same file. */
export const filePath = () => location ?? path.join(Global.Path.data, "route-overrides.json")

/** Test seam: point the store at another file. */
export const setFilePath = (file: string | undefined) => {
  location = file
  cache = undefined
}

/** The overrides in force, re-read only when the file changes. A missing or unreadable file is no
 * overrides, never an error that would stop routing. */
export const current = (): readonly Override[] => {
  const file = filePath()
  let mtime: number
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return []
  }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.list
  let list: Override[] = []
  try {
    list = parse(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    list = []
  }
  cache = { file, mtime, list }
  return list
}

const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])
const renameRetryDelays = [10, 25, 50, 100]
const renameWait = new Int32Array(new SharedArrayBuffer(4))

function isTransientRenameError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  if (!("code" in error)) return false
  return typeof error.code === "string" && transientRenameCodes.has(error.code)
}

// Sync writers follow the atomic-replace contract in design #1345.
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

/** Replaces the stored overrides, dropping any that have already expired. The write is atomic —
 * a temporary file in the same directory, then a rename over the old one — so a crash or a
 * concurrent reader (OpenChamber reads this same file) never observes a partially written store
 * whose truncated JSON `current()` would silently treat as no overrides (#924). */
export const save = (overrides: readonly Override[], now = Date.now()) => {
  const requested = path.resolve(filePath())
  fs.mkdirSync(path.dirname(requested), { recursive: true })
  const file = resolveAtomicTarget(requested)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const live = overrides.filter((item) => item.until === undefined || item.until > now)
  const temporary = path.join(path.dirname(file), `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`)
  const mode = fileMode(file)
  let created = false
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600)
    created = true
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, overrides: live }, null, 2))
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(temporary, mode)
    renameSyncWithRetry(temporary, file)
    created = false
  } catch (error) {
    if (created) {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {}
    }
    throw error
  }
  cache = undefined
  return live
}

function resolveAtomicTarget(file: string, remaining = 8): string {
  try {
    return fs.realpathSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }

  let parent: string
  try {
    parent = fs.realpathSync(path.dirname(file))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    parent = path.dirname(file)
  }

  const target = path.join(parent, path.basename(file))
  let link: string
  try {
    link = fs.readlinkSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL") return target
    throw error
  }
  if (remaining === 0) throw new Error(`Too many levels of symbolic links: ${file}`)
  return resolveAtomicTarget(path.resolve(parent, link), remaining - 1)
}

function fileMode(file: string) {
  // These stores use the contract's preserve policy: keep an existing mode, or use 0o600 for a new file.
  try {
    return fs.statSync(file).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600
    throw error
  }
}

/** Adds one override, replacing any with the same id. */
export const add = (item: Override, now = Date.now()) =>
  save([...current().filter((existing) => existing.id !== item.id), item], now)

/** Removes one override, e.g. when the user says the interpretation was wrong. */
export const remove = (id: string, now = Date.now()) =>
  save(
    current().filter((item) => item.id !== id),
    now,
  )
