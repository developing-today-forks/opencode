import { describe, expect, test } from "bun:test"
import { parseAllowlist, scanSource, staleEntries, unlistedHits } from "./check-bounded-http"

describe("scanSource", () => {
  test("flags the P-A fetch shape, with or without a signal", () => {
    const hits = scanSource(
      "packages/core/src/example.ts",
      [
        "const a = await fetch(url)",
        "const b = await fetch(url, { signal: AbortSignal.timeout(5_000) })",
        "const c = ownValue(TABLE, key)",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
    expect(hits[0].text).toBe("const a = await fetch(url)")
  })

  test("flags the P-B direct response-read shapes", () => {
    const hits = scanSource(
      "f.ts",
      [
        "const a = await response.text()",
        "const b = await response.clone().json()",
        "const c = await readBoundedResponseText(response, cap, tooLarge)",
        "const d = Response.json({ ok: true })",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
  })

  test("calls with arguments are not body reads", () => {
    const hits = scanSource(
      "f.ts",
      [
        "return c.json({ ok: true })",
        "return c.text(\"Not Found\")",
        "yield* api.json(\"POST\", path, { body: {} })",
        "const out = yield* generate.text({ prompt })",
        "const a = await response.json()",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([5])
  })

  test("flags chained reads off a call (the Bun.file / clone shape)", () => {
    const hits = scanSource("f.ts", "const pkg = await Bun.file(path).json()")
    expect(hits).toHaveLength(1)
  })

  test("comment-only lines mentioning a call are not hits", () => {
    const hits = scanSource(
      "f.ts",
      ["// never call fetch(url) without a signal", "* response.text() buffers the body", "const x = 1"].join("\n"),
    )
    expect(hits).toEqual([])
  })
})

describe("allowlist accounting", () => {
  const hits = scanSource("f.ts", "const a = await fetch(url)")
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = await fetch(url) :: bounded at the site\n")

  test("a listed hit passes and nothing is stale", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })

  test("an unlisted hit fails; a vanished line makes its entry stale", () => {
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = await fetch(url)"])
  })

  test("one entry does not cover a duplicate identical line", () => {
    const duplicates = scanSource("f.ts", "const a = await fetch(url)\nconst a = await fetch(url)")
    expect(duplicates).toHaveLength(2)
    const unlisted = unlistedHits(duplicates, allowlist)
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0].line).toBe(2)
    const twoEntries = parseAllowlist(
      "f.ts :: const a = await fetch(url) :: bounded at the site\nf.ts :: const a = await fetch(url) :: copy-paste, same bound\n",
    )
    expect(unlistedHits(duplicates, twoEntries)).toEqual([])
    expect(staleEntries(duplicates, twoEntries)).toEqual([])
  })

  test("a duplicate entry for a single line is stale", () => {
    const twoEntries = parseAllowlist(
      "f.ts :: const a = await fetch(url) :: bounded at the site\nf.ts :: const a = await fetch(url) :: entered twice\n",
    )
    expect(staleEntries(hits, twoEntries)).toEqual(["f.ts :: const a = await fetch(url)"])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})
