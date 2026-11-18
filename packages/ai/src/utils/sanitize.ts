import { Schema } from "effect"
import { Media } from "../media.js"
import { isRecord } from "./record.js"

/**
 * Replace lone UTF-16 surrogates in every string, key and nested value. Unchanged
 * subtrees are returned by reference so requests with large histories are not copied.
 */
export const sanitizeSurrogates = <T>(value: T): T => {
  if (typeof value === "string") return (value.isWellFormed() ? value : value.toWellFormed()) as T
  if (Array.isArray(value)) {
    const items = value.map(sanitizeSurrogates)
    return (
      Object.getPrototypeOf(value) === Array.prototype && items.every((item, index) => item === value[index])
        ? value
        : items
    ) as T
  }
  // Media assets carry binary or base64 payloads and a lazy byte cache; flattening them into a record would drop both.
  if (value instanceof Uint8Array || value instanceof Error || value instanceof Media.Asset) return value
<<<<<<< HEAD
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
=======
  if (!isRecord(value)) return value
  const entries = Object.entries(value)
  const sanitized = entries.map(([key, entry]) => [sanitizeSurrogates(key), sanitizeSurrogates(entry)] as const)
  // Changed nodes and other objects (such as Date) are copied into plain records as before. Unchanged plain
  // records and Schema class instances are kept: a copy would hold the same fields, and Schema constructors
  // decode such a copy back into an equal instance.
  if (
    sanitized.every(([key, entry], index) => key === entries[index][0] && entry === entries[index][1]) &&
    (Object.getPrototypeOf(value) === Object.prototype || Schema.isSchema(value.constructor))
  )
    return value
  return Object.fromEntries(sanitized) as T
>>>>>>> upstream-anomalyco/dev
}
