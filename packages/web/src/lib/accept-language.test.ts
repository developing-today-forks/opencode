import { describe, expect, test } from "bun:test"
import { localeFromAcceptLanguage } from "./accept-language"

describe("localeFromAcceptLanguage", () => {
  test.each([
    // Controls: normal headers behave exactly as before.
    [null, "root"],
    ["", "root"],
    ["fr", "fr"],
    ["de;q=0.5, fr;q=0.9", "fr"],
    ["en", "root"],
    ["*", "root"],
    ["unknown", "root"],
    // Refused: an explicit finite q<=0 is never served.
    ["fr;q=0", "root"],
    ["fr;q=0.0", "root"],
    ["fr;q=-0.5", "root"],
    ["fr;q=0, de;q=0.5", "de"],
    // All refused: fall through to root, not the first refusal.
    ["fr;q=0, de;q=0", "root"],
    ["de;q=0.0, es;q=0", "root"],
    // Malformed q: a 0-weight last-resort offer, never NaN in the sort.
    ["fr;q=abc, de;q=0.5", "de"],
    ["fr;q=abc", "fr"],
    ["fr;q=abc, de;q=0", "fr"],
  ])("maps %p to %p", (header, expected) => {
    expect(localeFromAcceptLanguage(header)).toBe(expected)
  })
})
