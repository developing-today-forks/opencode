import { describe, expect, test } from "bun:test"
import { Text } from "@opencode/core/util/text"
import { Text as UtilText } from "@opencode/util/text"
import { MessagingLog } from "@opencode/core/messaging/log"

const ASTRAL = "\u{1F600}"

// Oracle (#1973): output is well-formed and survives a UTF-8 round-trip unchanged.
const wellFormed = (value: string) => value.isWellFormed() && new TextDecoder().decode(new TextEncoder().encode(value)) === value

// One row per guarded truncation site in #1973, at its exact unchanged budget.
const sites: Array<[string, number]> = [
  ["session/title.ts truncate cut", 97],
  ["codemode/catalog.ts description cut", 117],
  ["messaging/embedding.ts clip limit", 8_000],
  ["session/runner/publish-llm-event.ts inputExcerpt limit", 2_048],
  ["model-route-log.ts error_body cut", 2_000],
  ["ripgrep.ts match text cut", 2_000],
]

describe("Text.truncate surrogate-pair guard (#1973)", () => {
  for (const [site, cut] of sites) {
    test(site + ": a pair straddling the cut is dropped whole", () => {
      const input = "a".repeat(cut - 1) + ASTRAL + "b".repeat(10)
      const output = Text.truncate(input, cut)
      expect(output).toBe("a".repeat(cut - 1))
      expect(wellFormed(output)).toBe(true)
    })

    test(site + ": a pair fully inside the cut is kept whole", () => {
      const input = "a".repeat(cut - 2) + ASTRAL + "b".repeat(10)
      const output = Text.truncate(input, cut)
      expect(output).toBe("a".repeat(cut - 2) + ASTRAL)
      expect(wellFormed(output)).toBe(true)
    })

    test(site + ": a pair fully outside the cut and ASCII truncation are unchanged", () => {
      expect(Text.truncate("a".repeat(cut) + ASTRAL + "b".repeat(10), cut)).toBe("a".repeat(cut))
      expect(Text.truncate("a".repeat(cut + 50), cut)).toBe("a".repeat(cut))
      expect(Text.truncate("short", cut)).toBe("short")
    })
  }

  test("splitsPair detects only a high/low straddle", () => {
    const input = "a" + ASTRAL + "b"
    expect(Text.splitsPair(input, 2)).toBe(true)
    expect(Text.splitsPair(input, 1)).toBe(false)
    expect(Text.splitsPair(input, 3)).toBe(false)
    expect(Text.splitsPair(input, 0)).toBe(false)
    expect(Text.splitsPair(input, input.length)).toBe(false)
  })

  test("MessagingLog.splitsPair is the shared guard, not a copy", () => {
    expect(MessagingLog.splitsPair).toBe(Text.splitsPair)
  })
})

describe("core Text is the @opencode/util primitive, re-exported (#2209)", () => {
  test("the seam is identity, not a copy", () => {
    expect(Text.splitsPair).toBe(UtilText.splitsPair)
    expect(Text.truncate).toBe(UtilText.truncate)
    expect(Text.truncateTail).toBe(UtilText.truncateTail)
    expect(Text.truncateMiddle).toBe(UtilText.truncateMiddle)
  })

  test("core and util agree on the straddle matrix", () => {
    const inputs = ["aaaa" + ASTRAL + "bbbb", "xx" + ASTRAL + "aaaa", "aa" + ASTRAL + "bbbb" + ASTRAL + "yz", "abcdefghij"]
    for (const input of inputs) {
      for (let budget = 0; budget <= 10; budget++) {
        expect(Text.truncate(input, budget)).toBe(UtilText.truncate(input, budget))
        expect(Text.truncateTail(input, budget)).toBe(UtilText.truncateTail(input, budget))
        expect(Text.truncateMiddle(input, budget)).toBe(UtilText.truncateMiddle(input, budget))
      }
    }
  })
})
