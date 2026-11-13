/**
 * Own-property lookup for plain-object dictionaries (#865, follow-up to the
 * #833 audit). A bare `record[key]` read walks the prototype chain, so an
 * externally supplied key like "constructor" or "toString" resolves to an
 * inherited member instead of missing — and a `?? fallback` never fires,
 * because inherited members are not nullish. Every dictionary read whose key
 * is not fully constrained by construction (a closed union, a regex capture,
 * a numeric index, an own key) goes through here instead of hand-writing
 * `Object.hasOwn(record, key) ? record[key] : undefined` per site.
 */

/** The record's own value for `key`, or undefined when it has none. */
export function ownValue<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** The record's own value for `key`, or `fallback` when it has none (or holds null/undefined). */
export function ownOr<V>(record: Readonly<Record<string, V>>, key: string, fallback: NoInfer<V>): V {
  return ownValue(record, key) ?? fallback
}
