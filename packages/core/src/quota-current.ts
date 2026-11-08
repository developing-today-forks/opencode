export * as QuotaCurrent from "./quota-current.js"

import fs from "node:fs"
import path from "node:path"

/**
 * The fleet quota gatherer's latest snapshot (`quota-current.json`), the measured quota
 * state the fleet already collects for every provider: the pm-aggregator's gatherer
 * (code#1151) rewrites it every ~15 minutes from the providers' own quota endpoints,
 * with per-provider and per-model windows carrying used percents and the source's own
 * reset times. The file lives in the aggregator's state directory beside OpenCode's
 * state directory; the router reads it from there — or from the standard state root
 * when a mirror is kept there — never from a plan store the fleet does not maintain.
 *
 * This module is the raw read only: parsing stays lenient (a missing or malformed file
 * is no reading at all, never an error into selection), and every judgement over the
 * readings — freshness, headroom, which skip one lifts — belongs to ModelRoute.
 */

export interface Window {
  readonly name: string
  readonly usedPercent: number | null
  /** Epoch ms of the window's next reset per the source; null when it states none. */
  readonly resetAt: number | null
  /** Epoch ms the source measured this window. */
  readonly measuredAt: number
}

export interface ProviderReading {
  readonly providerID: string
  readonly measuredAt: number
  readonly windows: readonly Window[]
  readonly models: Readonly<Record<string, readonly Window[]>>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const asPercent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null

const asTime = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

const windowsOf = (windows: unknown, measuredAt: number): Window[] => {
  if (!Array.isArray(windows)) return []
  const out: Window[] = []
  for (const item of windows) {
    const record = asRecord(item)
    if (!record || typeof record.name !== "string") continue
    out.push({
      name: record.name,
      usedPercent: asPercent(record.pctOfLimit),
      resetAt: asTime(record.resetsAt),
      measuredAt: asTime(record.measuredAt) ?? measuredAt,
    })
  }
  return out
}

const modelWindowsOf = (models: unknown, measuredAt: number): Record<string, readonly Window[]> => {
  const record = asRecord(models)
  if (!record) return {}
  const out: Record<string, readonly Window[]> = {}
  for (const [modelID, entry] of Object.entries(record)) {
    const windows = asRecord(entry)?.windows
    const inner = asRecord(windows)
    if (!inner) continue
    out[modelID] = Object.entries(inner).flatMap(([name, value]) => {
      const window = asRecord(value)
      if (!window) return []
      return [
        {
          name,
          usedPercent: asPercent(window.usedPercent),
          resetAt: asTime(window.resetAt),
          measuredAt,
        },
      ]
    })
  }
  return out
}

/** Parses one snapshot file's contents; an unusable file yields no readings. */
export const parse = (text: string): ProviderReading[] => {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return []
  }
  const providers = asRecord(root)?.providers
  if (!Array.isArray(providers)) return []
  const out: ProviderReading[] = []
  for (const item of providers) {
    const record = asRecord(item)
    if (!record || typeof record.providerId !== "string") continue
    // An errored entry is the gatherer saying it could not measure: it carries no
    // reading, so it can neither lift a skip nor stand as one.
    if (record.state !== "ok") continue
    const measuredAt = asTime(record.measuredAt)
    if (measuredAt === null) continue
    const usage = asRecord(record.usage)
    out.push({
      providerID: record.providerId,
      measuredAt,
      windows: windowsOf(record.windows, measuredAt),
      models: modelWindowsOf(usage?.models, measuredAt),
    })
  }
  return out
}

/**
 * The snapshot's candidate locations for a server whose state root is `stateDir`, in
 * read order: the aggregator's own state directory (its sibling), then a copy kept in
 * the state root itself. The first that exists is the snapshot; when none does, there
 * is simply no reading to judge by.
 */
export const candidatePaths = (stateDir: string): string[] => [
  path.join(path.dirname(stateDir), "pm-aggregator", "quota-current.json"),
  path.join(stateDir, "quota-current.json"),
]

/** Reads the freshest snapshot available beside `stateDir`; no file is no readings. */
export const readSnapshot = (stateDir: string): ProviderReading[] => {
  for (const file of candidatePaths(stateDir)) {
    try {
      return parse(fs.readFileSync(file, "utf8"))
    } catch {
      continue
    }
  }
  return []
}
