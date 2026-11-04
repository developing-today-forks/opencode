import type { JsonSchema } from "../../schema/index.js"
import { isRecord } from "../../utils/record.js"

// Gemini's `parametersJsonSchema` accepts standard JSON Schema, but rejects a few shapes that
// published tool schemas commonly contain. Rewrite only those and send everything else unchanged.
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
])
const VALUES = new Set(["const", "default", "enum", "examples", "dependentRequired"])

const mapValues = (record: Record<string, unknown>, map: (value: unknown, key: string) => unknown) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value, key)]))

const normalizeNode = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(normalizeNode)
  if (!isRecord(schema)) return schema
  const properties = isRecord(schema.properties) ? schema.properties : undefined
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (VALUES.has(key)) return [[key, value]]
      if (SCHEMA_MAPS.has(key) && isRecord(value)) return [[key, mapValues(value, normalizeNode)]]
      // `required` may only name declared properties.
      if (key === "required" && properties && Array.isArray(value))
        return [[key, value.filter((name) => typeof name === "string" && Object.hasOwn(properties, name))]]
      // Draft-04 boolean exclusive bounds become the numeric form.
      if (key === "exclusiveMinimum" && typeof value === "boolean")
        return value && typeof schema.minimum === "number" ? [[key, schema.minimum]] : []
      if (key === "exclusiveMaximum" && typeof value === "boolean")
        return value && typeof schema.maximum === "number" ? [[key, schema.maximum]] : []
      if (key === "minimum" && schema.exclusiveMinimum === true) return []
      if (key === "maximum" && schema.exclusiveMaximum === true) return []
      // Draft-07 tuples (`items` array plus `additionalItems`) are `prefixItems` plus `items` in 2020-12.
      if (key === "items" && Array.isArray(value)) return [["prefixItems", value.map(normalizeNode)]]
      if (key === "additionalItems" && Array.isArray(schema.items)) return [["items", normalizeNode(value)]]
      return [[key, normalizeNode(value)]]
    }),
  )
}

// Gemini accepts a recursive `$ref` only when the loop passes through an optional property or
// potentially empty array `items`. Replace other self-references with an unconstrained schema.
// The loop may span several $defs entries (#1585): cutDefCycles breaks those too.
const cutLoops = (schema: unknown, target: string, safe: boolean): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => cutLoops(item, target, safe))
  if (!isRecord(schema)) return schema
  if (schema.$ref === target && !safe) return {}
  const required = Array.isArray(schema.required) ? schema.required : []
  return mapValues(schema, (value, key) => {
    if (VALUES.has(key)) return value
    if (key === "items") return cutLoops(value, target, safe || !(Number(schema.minItems) > 0))
    if (key === "properties" && isRecord(value))
      return mapValues(value, (child, name) => cutLoops(child, target, safe || !required.includes(name)))
    if (SCHEMA_MAPS.has(key) && isRecord(value)) return mapValues(value, (child) => cutLoops(child, target, safe))
    return cutLoops(value, target, safe)
  })
}

const DEF_REF_PREFIXES = ["#/$defs/", "#/definitions/"] as const

/**
 * Record every def reference reachable from `schema`, flagged hard when the
 * path to it never passes through an optional property or a potentially
 * empty `items` — the same safe-step rules `cutLoops` applies. References
 * are leaves: the walk does not resolve them into the referenced def.
 */
const collectDefRefs = (schema: unknown, safe: boolean, out: Map<string, boolean>): void => {
  if (Array.isArray(schema)) {
    for (const item of schema) collectDefRefs(item, safe, out)
    return
  }
  if (!isRecord(schema)) return
  if (typeof schema.$ref === "string" && DEF_REF_PREFIXES.some((prefix) => (schema.$ref as string).startsWith(prefix)))
    out.set(schema.$ref, (out.get(schema.$ref) ?? false) || !safe)
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const [key, value] of Object.entries(schema)) {
    if (VALUES.has(key)) continue
    if (key === "items") {
      collectDefRefs(value, safe || !(Number(schema.minItems) > 0), out)
      continue
    }
    if (key === "properties" && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) collectDefRefs(child, safe || !required.includes(name), out)
      continue
    }
    collectDefRefs(value, safe, out)
  }
}

/**
 * Cut one reference in every cycle that spans two or more defs (#1585).
 * The per-def passes in `normalize` only ever see one def's literal tree,
 * so a cycle A -> B -> A whose steps are all required (or `items` with
 * `minItems > 0`) is invisible to them: build the def graph with only the
 * hard edges (a reference reached without a safe step), and for every
 * edge that lies on a hard cycle, run the def's body through `cutLoops`
 * with that edge's target — the unsafe occurrences of the reference are
 * replaced with `{}`, breaking the cycle. Cycles with a safe step are
 * never hard edges, so terminable recursion is preserved.
 */
const cutDefCycles = (root: Record<string, unknown>): Record<string, unknown> => {
  const defs = new Map<string, { section: string; name: string; body: unknown }>()
  for (const section of ["$defs", "definitions"] as const) {
    const entries = root[section]
    if (!isRecord(entries)) continue
    for (const [name, body] of Object.entries(entries)) defs.set(`#/${section}/${name}`, { section, name, body })
  }
  if (defs.size === 0) return root
  const hard = new Map<string, Set<string>>()
  for (const [ref, def] of defs) {
    const refs = new Map<string, boolean>()
    collectDefRefs(def.body, false, refs)
    hard.set(ref, new Set([...refs].filter(([target, isHard]) => isHard && defs.has(target)).map(([target]) => target)))
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const stack = [from]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current === to) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const next of hard.get(current) ?? []) stack.push(next)
    }
    return false
  }
  const bodies = new Map<string, unknown>()
  let changed = false
  for (const [ref, def] of defs) {
    let body = def.body
    for (const target of hard.get(ref) ?? []) {
      if (!reaches(target, ref)) continue
      body = cutLoops(body, target, false)
      changed = true
    }
    bodies.set(ref, body)
  }
  if (!changed) return root
  return mapValues(root, (value, key) =>
    (key === "$defs" || key === "definitions") && isRecord(value)
      ? mapValues(value, (def, name) => bodies.get(`#/${key}/${name}`) ?? def)
      : value,
  )
}

export const normalize = (schema: JsonSchema): JsonSchema => {
  const normalized = normalizeNode(schema)
  if (!isRecord(normalized)) return {}
  const acyclic = cutDefCycles(normalized)
  const result = cutLoops(
    mapValues(acyclic, (value, key) =>
      (key === "$defs" || key === "definitions") && isRecord(value)
        ? mapValues(value, (def, name) => cutLoops(def, `#/${key}/${name}`, false))
        : value,
    ),
    "#",
    false,
  )
  return isRecord(result) ? result : {}
}

export * as GeminiJsonSchema from "./gemini-json-schema.js"
