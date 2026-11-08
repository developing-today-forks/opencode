import { Media } from "../media.js"
import { isRecord } from "./record.js"

export const sanitizeSurrogates = <T>(value: T): T => {
  if (typeof value === "string") return value.toWellFormed() as T
  if (Array.isArray(value)) return value.map(sanitizeSurrogates) as T
  // Media assets carry binary or base64 payloads and a lazy byte cache; flattening them into a record would drop both.
  if (value instanceof Uint8Array || value instanceof Error || value instanceof Media.Asset) return value
  if (isRecord(value)) {
    const entries = Object.entries(value)
    // Keep every sanitized key's original name available to its first entry, including names
    // that appear later in the object. Generated suffixes must not steal those keys.
    const reservedKeys = new Set(entries.map(([key]) => key.toWellFormed()))
    const usedKeys = new Set<string>()
    return Object.fromEntries(
      entries.map(([key, entry]) => {
        const sanitizedKey = key.toWellFormed()
        let outputKey = sanitizedKey
        if (usedKeys.has(outputKey)) {
          let suffix = 2
          do {
            outputKey = `${sanitizedKey}~${suffix++}`
          } while (reservedKeys.has(outputKey) || usedKeys.has(outputKey))
        }
        usedKeys.add(outputKey)
        return [outputKey, sanitizeSurrogates(entry)]
      }),
    ) as T
  }
  return value
}
