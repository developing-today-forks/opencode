import { describe, expect, test } from "bun:test"
import { exactLocale, matchLocale } from "./locales"

// `localeAlias` is a plain object, so a membership test that reads the
// prototype chain resolves these names to inherited values instead of null.
const inherited = ["constructor", "__proto__"]

describe("exactLocale", () => {
  test.each(inherited)("does not resolve inherited property %p", (name) => {
    expect(exactLocale(name)).toBeNull()
  })

  test.each([
    ["de", "de"],
    ["en", "root"],
    ["pt", "pt-br"],
    ["zh", "zh-cn"],
    ["zh-tw", "zh-tw"],
    ["DE", "de"],
    ["unknown", null],
  ])("maps %p to %p", (input, expected) => {
    expect(exactLocale(input)).toBe(expected)
  })
})

describe("matchLocale", () => {
  test.each(inherited)("does not resolve inherited property %p", (name) => {
    expect(matchLocale(name)).toBeNull()
  })

  test.each([
    ["en", "root"],
    ["fr-fr", "fr"],
    ["zh-hant", "zh-tw"],
    ["pt-pt", "pt-br"],
    ["unknown", null],
  ])("matches %p to %p", (input, expected) => {
    expect(matchLocale(input)).toBe(expected)
  })
})
