import { describe, expect, test } from "bun:test"
import { ownOr, ownValue } from "@opencode/core/util/record"

describe("ownValue / ownOr (#865)", () => {
  const record: Record<string, number> = { port: 8080, zero: 0 }

  test("returns own values, including falsy ones", () => {
    expect(ownValue(record, "port")).toBe(8080)
    expect(ownValue(record, "zero")).toBe(0)
    expect(ownOr(record, "zero", 1)).toBe(0)
  })

  test("prototype members are not values", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(ownValue(record, key)).toBeUndefined()
      expect(ownOr(record, key, 1)).toBe(1)
    }
  })

  test("missing keys miss", () => {
    expect(ownValue(record, "missing")).toBeUndefined()
    expect(ownOr(record, "missing", 42)).toBe(42)
  })
})
