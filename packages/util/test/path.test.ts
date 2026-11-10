import { describe, expect, test } from "bun:test"
import { getFilenameTruncated, isLineRangeHash, parsePathLineSuffix, truncateMiddle } from "../src/path.js"

describe("parsePathLineSuffix", () => {
  test("parses valid colon forms: single line, line:column, and ranges", () => {
    expect(parsePathLineSuffix("file.ts:42")).toEqual({ path: "file.ts", selection: { start: 42, end: 42 } })
    expect(parsePathLineSuffix("file.ts:42:7")).toEqual({ path: "file.ts", selection: { start: 42, end: 42 } })
    expect(parsePathLineSuffix("file.ts:42-58")).toEqual({ path: "file.ts", selection: { start: 42, end: 58 } })
    expect(parsePathLineSuffix("file.ts:42:1-58:9")).toEqual({
      path: "file.ts",
      selection: { start: 42, end: 58 },
    })
  })

  test("parses valid hash forms: single line, range, and column suffixes", () => {
    expect(parsePathLineSuffix("file.ts#L42")).toEqual({ path: "file.ts", selection: { start: 42, end: 42 } })
    expect(parsePathLineSuffix("file.ts#L42-L58")).toEqual({ path: "file.ts", selection: { start: 42, end: 58 } })
    expect(parsePathLineSuffix("file.ts#L42-58")).toEqual({ path: "file.ts", selection: { start: 42, end: 58 } })
    expect(parsePathLineSuffix("file.ts#L42C3")).toEqual({ path: "file.ts", selection: { start: 42, end: 42 } })
  })

  test("normalizes reversed ranges in both spellings", () => {
    expect(parsePathLineSuffix("file.ts:5-3")).toEqual({ path: "file.ts", selection: { start: 3, end: 5 } })
    expect(parsePathLineSuffix("file.ts#L5-L3")).toEqual({ path: "file.ts", selection: { start: 3, end: 5 } })
  })

  test("keeps the drive-letter guard: a bare drive is not a line suffix", () => {
    expect(parsePathLineSuffix("C:5")).toEqual({ path: "C:5", selection: undefined })
    expect(parsePathLineSuffix("C:\\file.ts:5")).toEqual({
      path: "C:\\file.ts",
      selection: { start: 5, end: 5 },
    })
  })

  test("returns out-of-range suffixes untouched instead of stripping them (#2187)", () => {
    // Consumers treat path !== input as "a suffix was parsed", so an invalid range
    // must leave the whole input intact rather than dropping the suffix silently.
    expect(parsePathLineSuffix("file.ts:0")).toEqual({ path: "file.ts:0", selection: undefined })
    expect(parsePathLineSuffix("notes:1234567")).toEqual({ path: "notes:1234567", selection: undefined })
    expect(parsePathLineSuffix("tel:5551234")).toEqual({ path: "tel:5551234", selection: undefined })
    expect(parsePathLineSuffix("file.ts#L0")).toEqual({ path: "file.ts#L0", selection: undefined })
    expect(parsePathLineSuffix("file.ts#L1234567")).toEqual({ path: "file.ts#L1234567", selection: undefined })
    expect(parsePathLineSuffix("file.ts:42-1000001")).toEqual({
      path: "file.ts:42-1000001",
      selection: undefined,
    })
  })

  test("accepts the maximum line number as the boundary", () => {
    expect(parsePathLineSuffix("file.ts:1000000")).toEqual({
      path: "file.ts",
      selection: { start: 1000000, end: 1000000 },
    })
  })

  test("leaves plain paths and non-numeric suffixes untouched", () => {
    expect(parsePathLineSuffix("file.ts")).toEqual({ path: "file.ts", selection: undefined })
    expect(parsePathLineSuffix("file.ts:abc")).toEqual({ path: "file.ts:abc", selection: undefined })
    expect(parsePathLineSuffix("dir/file.ts#section")).toEqual({
      path: "dir/file.ts#section",
      selection: undefined,
    })
  })
})

describe("isLineRangeHash", () => {
  test("matches the line-range hash grammar", () => {
    expect(isLineRangeHash("#L42")).toBe(true)
    expect(isLineRangeHash("#L42-L58")).toBe(true)
    expect(isLineRangeHash("#L42-58")).toBe(true)
    expect(isLineRangeHash("#L42C3")).toBe(true)
    expect(isLineRangeHash("#L5-3")).toBe(true)
  })

  test("rejects non-range hashes", () => {
    expect(isLineRangeHash("#section")).toBe(false)
    expect(isLineRangeHash("L42")).toBe(false)
    expect(isLineRangeHash("#L")).toBe(false)
    expect(isLineRangeHash("#L42-")).toBe(false)
    expect(isLineRangeHash("")).toBe(false)
  })
})

// Oracle (design #2208): display truncations never split a surrogate
// pair — output is well-formed and within budget. Sweep salvaged from
// PR #2167, re-pointed at the shared @opencode/util primitive (#2209).
describe("display truncations never split a surrogate pair (#2133)", () => {
  test("truncateMiddle sweeps offsets x budgets", () => {
    for (let offset = 0; offset < 8; offset++) {
      const str = "x".repeat(offset) + "\u{1F600}" + "y".repeat(12)
      for (let max = 1; max <= 14; max++) {
        const result = truncateMiddle(str, max)
        expect(result.isWellFormed()).toBe(true)
        expect(result.length).toBeLessThanOrEqual(max)
      }
    }
    expect(truncateMiddle("a\u{1F600}bcdefgh", 4)).toBe("a…h")
  })

  test("getFilenameTruncated sweeps offsets x budgets and preserves the extension", () => {
    for (let offset = 0; offset < 8; offset++) {
      const str = "a".repeat(offset) + "\u{1F600}" + "b".repeat(12) + ".txt"
      for (let max = 1; max <= 18; max++) {
        const result = getFilenameTruncated(str, max)
        expect(result.isWellFormed()).toBe(true)
        expect(result.length).toBeLessThanOrEqual(max)
      }
    }
    expect(getFilenameTruncated("\u{1F600}".repeat(5) + ".txt", 10)).toBe("\u{1F600}\u{1F600}….txt")
  })
})
