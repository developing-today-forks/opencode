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

const wellFormed = (str: string) => {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

test("length truncators never split a surrogate pair", () => {
  for (let offset = 0; offset < 8; offset++) {
    const str = "x".repeat(offset) + "😀" + "y".repeat(12)
    for (let len = 1; len <= 14; len++) {
      for (const result of [Locale.truncate(str, len), Locale.truncateLeft(str, len), Locale.truncateMiddle(str, len)]) {
        expect(wellFormed(result)).toBe(true)
        expect(result.length).toBeLessThanOrEqual(len)
      }
    }
  }
  // A pair straddling a cut is dropped whole, not halved.
  expect(Locale.truncate("a😀bcdef", 3)).toBe("a…")
  expect(Locale.truncateLeft("bcdefa😀", 2)).toBe("…")
})
