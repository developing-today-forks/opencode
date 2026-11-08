import { expect, test } from "bun:test"
import { getFilenameTruncated, truncateMiddle } from "../src/path"

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

test("truncateMiddle never splits a surrogate pair", () => {
  for (let offset = 0; offset < 8; offset++) {
    const str = "x".repeat(offset) + "😀" + "y".repeat(12)
    for (let max = 1; max <= 14; max++) {
      const result = truncateMiddle(str, max)
      expect(wellFormed(result)).toBe(true)
      expect(result.length).toBeLessThanOrEqual(max)
    }
  }
  // Head cut straddling the pair drops it whole; tail cut likewise.
  expect(truncateMiddle("a😀bcdefgh", 4)).toBe("a…h")
})

test("getFilenameTruncated never splits a surrogate pair", () => {
  for (let offset = 0; offset < 8; offset++) {
    const str = "a".repeat(offset) + "😀" + "b".repeat(12) + ".txt"
    for (let max = 1; max <= 18; max++) {
      const result = getFilenameTruncated(str, max)
      expect(wellFormed(result)).toBe(true)
      expect(result.length).toBeLessThanOrEqual(max)
    }
  }
  // Extension is preserved when there is room for part of the stem.
  expect(getFilenameTruncated("abc😀defghij.txt", 10)).toEndWith(".txt")
})
