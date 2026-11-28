import { describe, expect, test } from "bun:test"
import { mergeJsonRecords, mergeProviderOptions } from "../src/schema/options.js"
import { base64Decode, base64Encode } from "../../util/src/encode.js"

describe("probe mergeJsonRecords proto", () => {
  test("top-level __proto__ record value", () => {
    const overlay = JSON.parse('{"__proto__":{"polluted":"yes-merge"}}')
    const merged = mergeJsonRecords({ model: "m" }, overlay) as any
    console.log("keys:", merged && Object.keys(merged), "ownProto:", merged && Object.hasOwn(merged, "__proto__"), "pollutedRead:", merged?.polluted, "globalPolluted:", ({} as any).polluted, "json:", merged && JSON.stringify(merged))
  })
  test("only __proto__ key", () => {
    const merged = mergeJsonRecords({}, JSON.parse('{"__proto__":{"polluted":"solo"}}')) as any
    console.log("solo merged:", merged, "keys:", merged && Object.keys(merged))
  })
  test("primitive __proto__ value", () => {
    const merged = mergeJsonRecords({ a: 1 }, JSON.parse('{"__proto__":"str"}')) as any
    console.log("prim keys:", merged && Object.keys(merged), "json:", merged && JSON.stringify(merged))
  })
  test("nested __proto__", () => {
    const merged = mergeJsonRecords({ cfg: { x: 1 } }, JSON.parse('{"cfg":{"__proto__":{"polluted":"nested"}}}')) as any
    console.log("nested cfg keys:", merged && Object.keys(merged.cfg), "cfg.polluted:", merged?.cfg?.polluted, "globalPolluted:", ({} as any).polluted, "json:", merged && JSON.stringify(merged))
  })
  test("mergeProviderOptions proto", () => {
    const merged = mergeProviderOptions({ openai: { a: 1 } }, JSON.parse('{"__proto__":{"polluted":"po"}}')) as any
    console.log("po keys:", merged && Object.keys(merged), "po.polluted:", merged?.polluted)
  })
  test("control normal merge", () => {
    expect(mergeJsonRecords({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } })
  })
})

describe("probe base64 roundtrip", () => {
  test("all length mods", () => {
    for (const s of ["a", "ab", "abc", "abcd", "hello", "✓ à la mode", "user:pass", ""]) {
      const enc = base64Encode(s)
      console.log(JSON.stringify(s), "->", enc, "->", JSON.stringify(base64Decode(enc)))
      expect(base64Decode(enc)).toBe(s)
    }
  })
})
