import { describe, expect, test } from "bun:test"
import { Text } from "../src/text.js"

const ASTRAL = "\u{1F600}"

// Oracle (design #2208): the contract itself — every cut's output is
// well-formed, survives a UTF-8 round-trip unchanged, stays within its
// code-unit budget, and equals the exact string the drop-whole rule
// prescribes. If a helper's pair disposition changes without the
// contract changing, this matrix goes red.
const wellFormed = (value: string) =>
  value.isWellFormed() && new TextDecoder().decode(new TextEncoder().encode(value)) === value

describe("Text.splitsPair (#2209)", () => {
  test("detects only a high/low straddle", () => {
    const input = "a" + ASTRAL + "b"
    expect(Text.splitsPair(input, 2)).toBe(true)
    expect(Text.splitsPair(input, 1)).toBe(false)
    expect(Text.splitsPair(input, 3)).toBe(false)
    expect(Text.splitsPair(input, 0)).toBe(false)
    expect(Text.splitsPair(input, input.length)).toBe(false)
  })
})

describe("Text.truncate — head cut (#2209)", () => {
  test("a pair straddling the cut is dropped whole", () => {
    const output = Text.truncate("aaaa" + ASTRAL + "bbbb", 5)
    expect(output).toBe("aaaa")
    expect(wellFormed(output)).toBe(true)
  })

  test("a pair fully inside the kept region survives whole", () => {
    const output = Text.truncate("aaa" + ASTRAL + "bbbb", 5)
    expect(output).toBe("aaa" + ASTRAL)
    expect(wellFormed(output)).toBe(true)
  })

  test("controls: pair fully outside, exact-budget ASCII pins equal to core's Text.truncate", () => {
    expect(Text.truncate("aaaaa" + ASTRAL + "bbbb", 5)).toBe("aaaaa")
    expect(Text.truncate("hello world", 5)).toBe("hello")
    expect(Text.truncate("a".repeat(2500), 2000)).toBe("a".repeat(2000))
    expect(Text.truncate("short", 5)).toBe("short")
    expect(Text.truncate("short", 10)).toBe("short")
    expect(Text.truncate("abc", 0)).toBe("")
  })
})

describe("Text.truncateTail — tail cut (#2209)", () => {
  test("a pair straddling the cut is dropped whole", () => {
    const output = Text.truncateTail("xx" + ASTRAL + "aaaa", 5)
    expect(output).toBe("aaaa")
    expect(wellFormed(output)).toBe(true)
  })

  test("a pair fully inside the kept region survives whole", () => {
    const output = Text.truncateTail("zzz" + ASTRAL + "aa", 4)
    expect(output).toBe(ASTRAL + "aa")
    expect(wellFormed(output)).toBe(true)
  })

  test("controls: pair fully outside, exact-budget ASCII pins", () => {
    expect(Text.truncateTail("bbbb" + ASTRAL + "aaaaa", 5)).toBe("aaaaa")
    expect(Text.truncateTail("hello world", 5)).toBe("world")
    expect(Text.truncateTail("short", 5)).toBe("short")
    expect(Text.truncateTail("short", 10)).toBe("short")
    expect(Text.truncateTail("abc", 0)).toBe("")
  })
})

describe("Text.truncateMiddle — both cuts (#2209)", () => {
  test("a pair straddling the head cut is dropped whole", () => {
    const output = Text.truncateMiddle("aa" + ASTRAL + "bbbbxyz", 6)
    expect(output).toBe("aaxyz")
    expect(wellFormed(output)).toBe(true)
  })

  test("a pair straddling the tail cut is dropped whole", () => {
    const output = Text.truncateMiddle("abcdddd" + ASTRAL + "yz", 6)
    expect(output).toBe("abcyz")
    expect(wellFormed(output)).toBe(true)
  })

  test("pairs straddling both cuts are both dropped whole", () => {
    const output = Text.truncateMiddle("aa" + ASTRAL + "bbbb" + ASTRAL + "yz", 6)
    expect(output).toBe("aayz")
    expect(wellFormed(output)).toBe(true)
  })

  test("a pair fully inside the kept head survives whole", () => {
    const output = Text.truncateMiddle("aa" + ASTRAL + "bbbbbbwxyz", 8)
    expect(output).toBe("aa" + ASTRAL + "wxyz")
    expect(wellFormed(output)).toBe(true)
  })

  test("controls: exact-budget ASCII pins, odd budgets, non-positive budgets", () => {
    expect(Text.truncateMiddle("abcdefghij", 6)).toBe("abchij")
    expect(Text.truncateMiddle("abcdefghij", 5)).toBe("abcij")
    expect(Text.truncateMiddle("abcdefghij", 1)).toBe("a")
    expect(Text.truncateMiddle("short", 5)).toBe("short")
    expect(Text.truncateMiddle("short", 10)).toBe("short")
    expect(Text.truncateMiddle("abc", 0)).toBe("")
    expect(Text.truncateMiddle("abc", -3)).toBe("")
  })

  test("every output stays within budget across the straddle matrix", () => {
    const inputs = ["aa" + ASTRAL + "bbbbxyz", "abcdddd" + ASTRAL + "yz", ASTRAL.repeat(10), "abcdefghij"]
    for (const input of inputs) {
      for (let budget = 0; budget <= 10; budget++) {
        const output = Text.truncateMiddle(input, budget)
        expect(output.length).toBeLessThanOrEqual(Math.max(0, budget))
        expect(wellFormed(output)).toBe(true)
      }
    }
  })
})
