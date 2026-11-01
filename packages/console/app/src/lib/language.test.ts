import { describe, expect, test } from "bun:test"
import { detectFromAcceptLanguage } from "./language"

describe("detectFromAcceptLanguage", () => {
  test("picks the highest-weighted matching locale", () => {
    expect(detectFromAcceptLanguage("fr;q=0.5, de;q=0.9")).toBe("de")
    expect(detectFromAcceptLanguage("fr")).toBe("fr")
    expect(detectFromAcceptLanguage(null)).toBe("en")
  })

  test("a malformed q value sorts last instead of poisoning the comparator with NaN (#1302)", () => {
    expect(detectFromAcceptLanguage("fr;q=abc, de;q=0.5")).toBe("de")
    expect(detectFromAcceptLanguage("de;q=abc")).toBe("de")
  })
})
