import { describe, expect, test } from "bun:test"
import { prefersMarkdown } from "./content-negotiation"

describe("prefersMarkdown", () => {
  test("prefers markdown when it is the only or highest-weighted type", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true)
    expect(prefersMarkdown("text/html;q=0.5, text/markdown;q=0.9")).toBe(true)
    expect(prefersMarkdown("text/html")).toBe(false)
    expect(prefersMarkdown(null)).toBe(false)
  })

  test("a malformed q value weights its type 0 instead of producing NaN (#1302)", () => {
    expect(prefersMarkdown("text/markdown;q=abc")).toBe(false)
    expect(prefersMarkdown("text/html;q=abc, text/markdown;q=0.5")).toBe(true)
  })
})
