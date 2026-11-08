import { describe, expect, test } from "bun:test"
import { sanitizeSurrogates } from "../src/utils/sanitize.js"

describe("sanitizeSurrogates", () => {
  test("preserves every entry when malformed keys sanitize to the same key", () => {
    const input = {
      ["\uD800a"]: 1,
      ["\uDC00a"]: 2,
      ["\uFFFDa"]: 3,
    }

    const result = sanitizeSurrogates(input)

    expect(Object.entries(result)).toEqual([
      ["\uFFFDa", 1],
      ["\uFFFDa~2", 2],
      ["\uFFFDa~3", 3],
    ])
  })

  test("does not rename well-formed keys or steal a later key for a collision suffix", () => {
    const wellFormed = { alpha: 1, nested: { beta: 2 }, gamma: 3 }
    expect(sanitizeSurrogates(wellFormed)).toEqual(wellFormed)
    expect(Object.keys(sanitizeSurrogates(wellFormed))).toEqual(Object.keys(wellFormed))

    const input = {
      ["\uD800a"]: 1,
      ["\uDC00a"]: 2,
      ["\uFFFDa~2"]: 3,
    }
    expect(Object.entries(sanitizeSurrogates(input))).toEqual([
      ["\uFFFDa", 1],
      ["\uFFFDa~3", 2],
      ["\uFFFDa~2", 3],
    ])
  })

  test("applies collision handling recursively through records and arrays", () => {
    const input = {
      nested: {
        ["\uD800k"]: "first\uD800",
        ["\uDC00k"]: "second\uDC00",
      },
      list: [
        {
          ["\uD800x"]: 1,
          ["\uDC00x"]: 2,
        },
        "value\uD800",
      ],
    }

    expect(sanitizeSurrogates(input)).toEqual({
      nested: { ["\uFFFDk"]: "first\uFFFD", ["\uFFFDk~2"]: "second\uFFFD" },
      list: [{ ["\uFFFDx"]: 1, ["\uFFFDx~2"]: 2 }, "value\uFFFD"],
    })
  })
})
