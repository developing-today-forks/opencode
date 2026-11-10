import { expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

test("truncates text from the right by terminal width", () => {
  expect(Locale.truncateWidth("abcdefgh", 5)).toBe("abcd…")
  expect(Locale.truncateWidth("ab界cd", 5)).toBe("ab界…")
  expect(Locale.truncateWidth("abcdefgh", 1)).toBe("…")
  expect(Locale.truncateWidth("abcdefgh", 0)).toBe("")
})

test("truncators never exceed the requested length at lengths 0-2", () => {
  const str = "abcdefghijklmnop"
  expect(Locale.truncate(str, 0)).toBe("")
  expect(Locale.truncate(str, 1)).toBe("…")
  expect(Locale.truncate(str, 2)).toBe("a…")
  expect(Locale.truncate(str, 5)).toBe("abcd…")
  expect(Locale.truncateLeft(str, 0)).toBe("")
  expect(Locale.truncateLeft(str, 1)).toBe("…")
  expect(Locale.truncateLeft(str, 2)).toBe("…p")
  expect(Locale.truncateLeft(str, 5)).toBe("…mnop")
  expect(Locale.truncateMiddle(str, 0)).toBe("")
  expect(Locale.truncateMiddle(str, 1)).toBe("…")
  expect(Locale.truncateMiddle(str, 2)).toBe("a…")
  expect(Locale.truncateMiddle(str, 3)).toBe("a…p")
  expect(Locale.truncateMiddle(str, 9)).toBe("abcd…mnop")
})

test("takes whole graphemes within terminal width", () => {
  expect(Locale.takeWidth("ab界cd", 4)).toBe("ab界")
  expect(Locale.graphemes("a👨‍👩‍👧‍👦b")).toEqual(["a", "👨‍👩‍👧‍👦", "b"])
})

test("rolls the compact form over at the rounding boundary", () => {
  expect(Locale.number(999949)).toBe("999.9K")
  expect(Locale.number(999950)).toBe("1.0M")
  expect(Locale.number(1000000)).toBe("1.0M")
})

// Oracle (design #2208): the Locale length truncators never split a
// surrogate pair — output is well-formed and within budget. Sweep
// salvaged from PR #2167, re-pointed at the shared @opencode/util
// primitive (#2209).
test("length truncators never split a surrogate pair (#2133)", () => {
  for (let offset = 0; offset < 8; offset++) {
    const str = "x".repeat(offset) + "\u{1F600}" + "y".repeat(12)
    for (let len = 1; len <= 14; len++) {
      for (const result of [Locale.truncate(str, len), Locale.truncateLeft(str, len), Locale.truncateMiddle(str, len)]) {
        expect(result.isWellFormed()).toBe(true)
        expect(result.length).toBeLessThanOrEqual(len)
      }
    }
  }
  expect(Locale.truncate("ab\u{1F600}cdef", 4)).toBe("ab…")
  expect(Locale.truncateLeft("abcd\u{1F600}ef", 4)).toBe("…ef")
  expect(Locale.truncateMiddle("a\u{1F600}bcdefgh", 4)).toBe("a…h")
})
