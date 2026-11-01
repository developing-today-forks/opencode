import { describe, expect, test } from "bun:test"
import { SCAN_ROOTS, isScannedFile, parseAllowlist, scanSource, staleEntries, unlistedHits } from "./check-numeric-boundaries"

describe("scanSource", () => {
  test("flags the bare conversion shapes", () => {
    const hits = scanSource(
      "packages/core/src/example.ts",
      [
        "const a = Number(input)",
        "const b = parseInt(input, 10)",
        "const c = parseFloat(input)",
        "const d = pageLimit(input, 50)",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3])
    expect(hits[0].text).toBe("const a = Number(input)")
  })

  test("internal arithmetic predicates and longer identifiers are not conversions", () => {
    const hits = scanSource(
      "f.ts",
      [
        "const a = Number.isFinite(value)",
        "const b = Number.isNaN(value)",
        "const c = Number.isInteger(value)",
        "const d = toNumber(value)",
        "const e = Math.trunc(value)",
        "const f = Number(value)",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([6])
  })

  test("comment-only lines mentioning a conversion are not hits", () => {
    const hits = scanSource(
      "f.ts",
      ["// never call Number(input) on raw strings", "* parseInt(x) truncates", "const x = 1"].join("\n"),
    )
    expect(hits).toEqual([])
  })
})

describe("SCAN_ROOTS", () => {
  test("includes the server package, the network-boundary root added by #1294", () => {
    expect(SCAN_ROOTS).toContain("packages/server/src")
    expect(SCAN_ROOTS).toEqual(["packages/core/src", "packages/ai/src", "packages/cli/src", "packages/server/src"])
  })
})

describe("isScannedFile", () => {
  test("includes TS/TSX, excludes docs/data", () => {
    expect(isScannedFile("page.ts")).toBe(true)
    expect(isScannedFile("page.tsx")).toBe(true)
    expect(isScannedFile("page.mdx")).toBe(false)
    expect(isScannedFile("page.json")).toBe(false)
  })
})

describe("allowlist accounting", () => {
  const hits = scanSource("f.ts", "const a = Number(input)")
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = Number(input) :: baseline conversion\n")

  test("a listed hit passes and nothing is stale", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })

  test("an unlisted hit fails; a vanished line makes its entry stale", () => {
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = Number(input)"])
  })

  test("removing the entry for an existing conversion fails", () => {
    const emptied = parseAllowlist("# comment\n")
    expect(unlistedHits(hits, emptied)).toHaveLength(1)
  })

  test("one entry does not cover a duplicate identical line", () => {
    const duplicates = scanSource("f.ts", "const a = Number(input)\nconst a = Number(input)")
    expect(duplicates).toHaveLength(2)
    const unlisted = unlistedHits(duplicates, allowlist)
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0].line).toBe(2)
    const twoEntries = parseAllowlist(
      "f.ts :: const a = Number(input) :: baseline conversion\nf.ts :: const a = Number(input) :: copy-paste, same disposition\n",
    )
    expect(unlistedHits(duplicates, twoEntries)).toEqual([])
    expect(staleEntries(duplicates, twoEntries)).toEqual([])
  })

  test("a duplicate entry for a single line is stale", () => {
    const twoEntries = parseAllowlist(
      "f.ts :: const a = Number(input) :: baseline conversion\nf.ts :: const a = Number(input) :: entered twice\n",
    )
    expect(staleEntries(hits, twoEntries)).toEqual(["f.ts :: const a = Number(input)"])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})
