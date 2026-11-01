import { describe, expect, test } from "bun:test"
import { parseAllowlist, scanSource, staleEntries, unlistedHits } from "./check-proto-reads"

describe("scanSource", () => {
  test("flags the P-A uppercase-table shape and the P-C ?? shape", () => {
    const hits = scanSource(
      "packages/core/src/example.ts",
      ["const a = TABLE[key]", "const b = weights[index] ?? 1", "const c = ownValue(TABLE, key)"].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
    expect(hits[0].text).toBe("const a = TABLE[key]")
  })

  test("flags computed-key reads with a ?? fallback (P-D, #1086)", () => {
    const hits = scanSource(
      "f.ts",
      [
        "const a = values[key.trim()] ?? 1",
        "const b = TABLE[key.trim()] ?? 1",
        "const c = values[key.trim()]",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
  })

  test("a guarded hasOwn line still matches, so it needs a disposition", () => {
    const hits = scanSource("f.ts", "const arity = Object.hasOwn(ARITY, key) ? ARITY[key] : undefined")
    expect(hits).toHaveLength(1)
  })
})

describe("allowlist accounting", () => {
  const hits = scanSource("f.ts", "const a = TABLE[key]")
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = TABLE[key] :: guarded at the site\n")

  test("a listed hit passes and nothing is stale", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })

  test("an unlisted hit fails; a vanished line makes its entry stale", () => {
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = TABLE[key]"])
  })

  test("one entry does not cover a duplicate identical line (#1086)", () => {
    const duplicates = scanSource("f.ts", "const a = TABLE[key]\nconst a = TABLE[key]")
    expect(duplicates).toHaveLength(2)
    const unlisted = unlistedHits(duplicates, allowlist)
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0].line).toBe(2)
    const twoEntries = parseAllowlist(
      "f.ts :: const a = TABLE[key] :: guarded at the site\nf.ts :: const a = TABLE[key] :: copy-paste, same guard\n",
    )
    expect(unlistedHits(duplicates, twoEntries)).toEqual([])
    expect(staleEntries(duplicates, twoEntries)).toEqual([])
  })

  test("a duplicate entry for a single line is stale (#1086)", () => {
    const twoEntries = parseAllowlist(
      "f.ts :: const a = TABLE[key] :: guarded at the site\nf.ts :: const a = TABLE[key] :: entered twice\n",
    )
    expect(staleEntries(hits, twoEntries)).toEqual(["f.ts :: const a = TABLE[key]"])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})
