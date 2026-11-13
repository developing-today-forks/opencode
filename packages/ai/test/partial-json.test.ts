import { describe, expect, test } from "bun:test"
import { Allow, MalformedJSON, PartialJSON, parse } from "../src/protocols/utils/partial-json.js"

describe("partial JSON", () => {
  test("parses complete JSON", () => {
    expect(parse('{"key":"value","items":[1,true,null]}')).toEqual({
      key: "value",
      items: [1, true, null],
    })

    const object = parse('{"__proto__":{"safe":true}}') as Record<string, unknown>
    expect(Object.hasOwn(object, "__proto__")).toBe(true)
  })

  test("parses partial strings", () => {
    expect(parse('"hello')).toBe("hello")
    expect(parse('"hello \\u12')).toBe("hello ")
    expect(() => parse('"hello', ~Allow.STR)).toThrow(PartialJSON)
  })

  test("repairs invalid escapes and raw control characters", () => {
    expect(parse('{"path":"A\\H","text":"first\tsecond"}')).toEqual({
      path: "A\\H",
      text: "first\tsecond",
    })
  })

  test("preserves prototype keys in partial objects", () => {
    const object = parse('{"__proto__":{"safe":true}') as Record<string, unknown>

    expect(Object.hasOwn(object, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(object)).toBe(Object.prototype)
    expect(object.__proto__).toEqual({ safe: true })
  })

  test("controls partial collection values independently", () => {
    expect(parse('["', Allow.ARR)).toEqual([])
    expect(parse('["', Allow.ARR | Allow.STR)).toEqual([""])
    expect(parse('{"key":"', Allow.OBJ)).toEqual({})
    expect(parse('{"key":"', Allow.OBJ | Allow.STR)).toEqual({ key: "" })
  })

  test("parses partial literals and numbers", () => {
    expect(parse("nu", Allow.NULL)).toBeNull()
    expect(parse("tr", Allow.BOOL)).toBe(true)
    expect(parse("fa", Allow.BOOL)).toBe(false)
    expect(parse("1e", Allow.NUM)).toBe(1)
  })

  test("nested exponent trim requires Allow.NUM and stays within the token", () => {
    // Oracle: the Allow.NUM contract + token scope from #2213 — a nested
    // exponent-truncated number is repaired only when NUM is allowed, and
    // the trim never reaches past the scanned token into later keys.
    expect(parse("[1e]", Allow.ARR | Allow.NUM)).toEqual([1])
    expect(parse("[1e]", Allow.ARR)).toEqual([])
    expect(() => parse("[1e]", 0)).toThrow(PartialJSON)
    expect(parse('{"a":1e,"e":5}', Allow.ALL)).toEqual({ a: 1, e: 5 })
    expect(parse('{"e":5,"a":1e}', Allow.ALL)).toEqual({ e: 5, a: 1 })
  })

  test("distinguishes disallowed partial values from malformed values", () => {
    expect(() => parse("[", Allow.STR)).toThrow(PartialJSON)
    expect(() => parse("n", ~Allow.NULL)).toThrow(MalformedJSON)
  })

  test("rejects empty input", () => {
    expect(() => parse("  ")).toThrow("is empty")
  })
})
