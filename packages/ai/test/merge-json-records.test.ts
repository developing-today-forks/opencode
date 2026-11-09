import { describe, expect, test } from "bun:test"
import { mergeJsonRecords, mergeProviderOptions } from "../src/schema/options.js"

const protoRecord = (value: unknown) => Object.fromEntries([["__proto__", value]])

describe("mergeJsonRecords __proto__ handling", () => {
  test("preserves a record-valued __proto__ as an ordinary own property", () => {
    const merged = mergeJsonRecords({ model: "m" }, protoRecord({ polluted: "yes-merge" }))
    expect(merged).toBeDefined()
    expect(Object.hasOwn(merged!, "__proto__")).toBe(true)
    expect(Object.keys(merged!)).toContain("__proto__")
    expect(JSON.parse(JSON.stringify(merged))).toEqual(
      JSON.parse('{"model":"m","__proto__":{"polluted":"yes-merge"}}'),
    )
    expect(Object.getPrototypeOf(merged!)).toBe(Object.prototype)
    expect((merged as Record<string, unknown>)["polluted"]).toBeUndefined()
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  test("preserves a primitive-valued __proto__", () => {
    const merged = mergeJsonRecords({ model: "m" }, protoRecord("plain-string"))
    expect(Object.hasOwn(merged!, "__proto__")).toBe(true)
    expect(JSON.stringify(merged)).toBe(JSON.stringify(JSON.parse('{"model":"m","__proto__":"plain-string"}')))
    expect(Object.getPrototypeOf(merged!)).toBe(Object.prototype)
  })

  test("a merge whose only incoming key is __proto__ does not return undefined", () => {
    const merged = mergeJsonRecords({}, protoRecord({ only: true }))
    expect(merged).toBeDefined()
    expect(JSON.parse(JSON.stringify(merged))).toEqual(JSON.parse('{"__proto__":{"only":true}}'))
  })

  test("preserves a nested __proto__", () => {
    const merged = mergeJsonRecords({ cfg: { keep: 1 } }, { cfg: protoRecord({ polluted: "nested" }) })
    const cfg = merged!["cfg"] as Record<string, unknown>
    expect(Object.hasOwn(cfg, "__proto__")).toBe(true)
    expect(JSON.parse(JSON.stringify(merged))).toEqual(JSON.parse('{"cfg":{"keep":1,"__proto__":{"polluted":"nested"}}}'))
    expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype)
    expect(cfg["polluted"]).toBeUndefined()
  })

  test("preserves __proto__ through mergeProviderOptions", () => {
    const merged = mergeProviderOptions({ model: "m" }, protoRecord({ polluted: "provider" }))
    expect(Object.hasOwn(merged!, "__proto__")).toBe(true)
    expect(JSON.parse(JSON.stringify(merged))).toEqual(JSON.parse('{"model":"m","__proto__":{"polluted":"provider"}}'))
    expect(Object.getPrototypeOf(merged!)).toBe(Object.prototype)
  })

  test("deep-merges two __proto__ records instead of replacing or prototyping", () => {
    const merged = mergeJsonRecords(protoRecord({ a: 1 }), protoRecord({ b: 2 }), { model: "m" })
    expect(JSON.parse(JSON.stringify(merged))).toEqual(JSON.parse('{"__proto__":{"a":1,"b":2},"model":"m"}'))
    expect(Object.getPrototypeOf(merged!)).toBe(Object.prototype)
  })

  test("ordinary deep merge, undefined-skipping, and single-item behaviour are unchanged", () => {
    expect(mergeJsonRecords({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({ a: { x: 1, y: 3, z: 4 } })
    expect(mergeJsonRecords({ a: 1, b: undefined }, { b: 2 })).toEqual({ a: 1, b: 2 })
    expect(mergeJsonRecords({ a: 1 })).toEqual({ a: 1 })
    expect(mergeJsonRecords()).toBeUndefined()
    expect(mergeJsonRecords({})).toEqual({})
  })
})
