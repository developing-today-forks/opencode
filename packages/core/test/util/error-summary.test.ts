import { describe, expect, test } from "bun:test"
import { ErrorSummary } from "../../src/util/error-summary"

describe("ErrorSummary", () => {
  test("keeps the message and classification of each error in the cause chain", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED", errno: -61 })
    const error = new Error("Incompatible auth server: does not support dynamic client registration", { cause: root })
    expect(ErrorSummary.from(error)).toEqual([
      { type: "Error", message: "Incompatible auth server: does not support dynamic client registration" },
      { type: "Error", message: "connect ECONNREFUSED 127.0.0.1:443", code: "ECONNREFUSED", errno: -61 },
    ])
  })

  test("omits the stack and empty messages", () => {
    const summary = ErrorSummary.from(new Error(""))
    expect(summary).toEqual([{ type: "Error" }])
    expect(JSON.stringify(summary)).not.toContain("stack")
  })

  test("summarizes a thrown string instead of dropping it", () => {
    expect(ErrorSummary.from("boom string")).toEqual([{ type: "unknown", message: "boom string" }])
  })

  test("summarizes thrown numbers and booleans instead of dropping them", () => {
    expect(ErrorSummary.from(42)).toEqual([{ type: "unknown", message: "42" }])
    expect(ErrorSummary.from(0)).toEqual([{ type: "unknown", message: "0" }])
    expect(ErrorSummary.from(false)).toEqual([{ type: "unknown", message: "false" }])
  })

  test("keeps a cause chain that bottoms out in a primitive", () => {
    const error = new Error("credential refresh failed", { cause: "token endpoint said no" })
    expect(ErrorSummary.from(error)).toEqual([
      { type: "Error", message: "credential refresh failed" },
      { type: "unknown", message: "token endpoint said no" },
    ])
  })

  test("summarizes a thrown symbol instead of dropping it", () => {
    expect(ErrorSummary.from(Symbol("boom"))).toEqual([{ type: "unknown", message: "Symbol(boom)" }])
  })

  test("keeps a cause chain that bottoms out in a symbol", () => {
    const error = new Error("credential refresh failed", { cause: Symbol("token rejected") })
    expect(ErrorSummary.from(error)).toEqual([
      { type: "Error", message: "credential refresh failed" },
      { type: "unknown", message: "Symbol(token rejected)" },
    ])
  })

  test("still returns no entries for null and undefined", () => {
    expect(ErrorSummary.from(null)).toEqual([])
    expect(ErrorSummary.from(undefined)).toEqual([])
  })
})
