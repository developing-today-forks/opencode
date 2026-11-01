import { describe, expect, test } from "bun:test"
import { detectFromAcceptLanguage, fromDocsPathname, localeFromCookieHeader } from "./language"

describe("detectFromAcceptLanguage", () => {
  test("picks the highest-weighted matching locale", () => {
    expect(detectFromAcceptLanguage("fr;q=0.5, de;q=0.9")).toBe("de")
    expect(detectFromAcceptLanguage("fr")).toBe("fr")
    expect(detectFromAcceptLanguage(null)).toBe("en")
  })

  test("a language refused with q=0 is never served (#1309)", () => {
    expect(detectFromAcceptLanguage("fr;q=0")).toBe("en")
    expect(detectFromAcceptLanguage("fr;q=0, de;q=0.5")).toBe("de")
    expect(detectFromAcceptLanguage("fr;q=0, de;q=0")).toBe("en")
    expect(detectFromAcceptLanguage("fr;q=-1")).toBe("en")
  })

  test("a malformed q value sorts last instead of poisoning the comparator with NaN (#1302)", () => {
    expect(detectFromAcceptLanguage("fr;q=abc, de;q=0.5")).toBe("de")
    expect(detectFromAcceptLanguage("de;q=abc")).toBe("de")
  })
})

describe("fromDocsPathname", () => {
  test("resolves known docs locales and rejects unknown segments", () => {
    expect(fromDocsPathname("/docs/de/intro")).toBe("de")
    expect(fromDocsPathname("/docs/en/intro")).toBe("en")
    expect(fromDocsPathname("/docs/pt-br/intro")).toBe("br")
    expect(fromDocsPathname("/docs/xx/intro")).toBeNull()
    expect(fromDocsPathname("/other/de/intro")).toBeNull()
  })

  test("prototype-chain names are not locales (#1323)", () => {
    expect(fromDocsPathname("/docs/constructor/intro")).toBeNull()
    expect(fromDocsPathname("/docs/__proto__/intro")).toBeNull()
  })
})

describe("localeFromCookieHeader", () => {
  test("reads a valid oc_locale cookie", () => {
    expect(localeFromCookieHeader("oc_locale=de")).toBe("de")
    expect(localeFromCookieHeader("other=1; oc_locale=fr")).toBe("fr")
    expect(localeFromCookieHeader("oc_locale=xx")).toBeNull()
    expect(localeFromCookieHeader(null)).toBeNull()
    expect(localeFromCookieHeader("")).toBeNull()
  })

  test("a malformed percent-encoded cookie returns null instead of throwing (#1323)", () => {
    expect(localeFromCookieHeader("oc_locale=%")).toBeNull()
    expect(localeFromCookieHeader("oc_locale=%zz")).toBeNull()
    expect(localeFromCookieHeader("oc_locale=%E0%A4%A")).toBeNull()
    expect(localeFromCookieHeader("oc_locale=en%")).toBeNull()
  })
})
