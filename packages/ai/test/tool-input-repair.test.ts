import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseToolInput, repairTruncatedToolInput } from "../src/protocols/shared.js"
import { it } from "./lib/effect.js"

// #2227: with OPENCODE_TOOL_INPUT_REPAIR=1, parseToolInput attempts a
// bounded completion of a stream-truncated JSON document; with the flag
// off (the default) behavior is exactly the pre-repair fatal error.
const FLAG = "OPENCODE_TOOL_INPUT_REPAIR"
let saved: string | undefined

beforeEach(() => {
  saved = process.env[FLAG]
})

afterEach(() => {
  if (saved === undefined) delete process.env[FLAG]
  else process.env[FLAG] = saved
})

const enableRepair = () => {
  process.env[FLAG] = "1"
}

describe("repairTruncatedToolInput", () => {
  test("closes an unterminated string and the open containers", () => {
    expect(repairTruncatedToolInput('{"path":"src/a.ts","content":"line one')).toBe(
      '{"path":"src/a.ts","content":"line one"}',
    )
    expect(repairTruncatedToolInput('{"a":{"b":[1,2')).toBe('{"a":{"b":[1,2]}}')
  })

  test("drops a trailing comma before closing", () => {
    expect(repairTruncatedToolInput('{"a":1,')).toBe('{"a":1}')
    expect(repairTruncatedToolInput('{"a":1, ')).toBe('{"a":1}')
  })

  test("drops a lone trailing backslash before closing a string", () => {
    expect(repairTruncatedToolInput('{"a":"x\\')).toBe('{"a":"x"}')
  })

  test("keeps escaped quotes inside the string", () => {
    expect(repairTruncatedToolInput('{"a":"x\\"y')).toBe('{"a":"x\\"y"}')
  })

  test("refuses what completion cannot fix", () => {
    expect(repairTruncatedToolInput('{"a":1]')).toBeUndefined() // mismatched closer: not a truncation
    expect(repairTruncatedToolInput("")).toBeUndefined()
    expect(repairTruncatedToolInput('{"a":1}')).toBeUndefined() // nothing to repair
  })

  test("a mid-literal cut still yields a candidate — acceptance is the caller's parse", () => {
    // '{"a": tru' completes to '{"a": tru}', which is not valid JSON;
    // parseToolInput rejects it there and surfaces the original error.
    expect(repairTruncatedToolInput('{"a": tru')).toBe('{"a": tru}')
  })
})

describe("parseToolInput bounded repair (#2227)", () => {
  it.effect("stays fatal with the flag off", () =>
    Effect.gen(function* () {
      delete process.env[FLAG]
      const error = yield* Effect.flip(parseToolInput("test-route", "write", '{"content":"cut off'))
      expect(error.reason.message).toContain("Invalid JSON input for test-route tool call write")
    }),
  )

  it.effect("recovers a string-truncated input with the flag on", () =>
    Effect.gen(function* () {
      enableRepair()
      const value = yield* parseToolInput("test-route", "write", '{"path":"src/a.ts","content":"line one')
      expect(value).toEqual({ path: "src/a.ts", content: "line one" })
    }),
  )

  it.effect("recovers an open-stack truncation with the flag on", () =>
    Effect.gen(function* () {
      enableRepair()
      const value = yield* parseToolInput("test-route", "edit", '{"a":{"b":[1,2')
      expect(value).toEqual({ a: { b: [1, 2] } })
    }),
  )

  it.effect("unrepairable input stays fatal and the error body is the raw input", () =>
    Effect.gen(function* () {
      enableRepair()
      const raw = '{"a": tru'
      const error = yield* Effect.flip(parseToolInput("test-route", "write", raw))
      expect(error.reason.message).toContain("Invalid JSON input for test-route tool call write")
      expect(error.reason.body).toBe(raw)
    }),
  )

  it.effect("a repaired non-object is not accepted as tool input", () =>
    Effect.gen(function* () {
      enableRepair()
      const error = yield* Effect.flip(parseToolInput("test-route", "write", "[1,2"))
      expect(error.reason.body).toBe("[1,2")
    }),
  )

  it.effect("valid input parses identically with the flag on or off", () =>
    Effect.gen(function* () {
      enableRepair()
      expect(yield* parseToolInput("test-route", "write", '{"a":1}')).toEqual({ a: 1 })
      delete process.env[FLAG]
      expect(yield* parseToolInput("test-route", "write", '{"a":1}')).toEqual({ a: 1 })
      expect(yield* parseToolInput("test-route", "write", "")).toEqual({})
    }),
  )
})
