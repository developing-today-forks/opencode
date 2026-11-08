import { describe, expect, test } from "bun:test"
import {
  boundedCount,
  pageLimit,
  pageOffset,
  serverSeconds,
  SET_TIMEOUT_MAX_MS,
  timeoutMs,
} from "@opencode/core/util/number"

/**
 * One conformance suite over the shared edge table (#993, design #992):
 * every primitive answers the same poisoned inputs — undefined, NaN,
 * ±Infinity, negative, zero, fractional (including the (0,1) slice trap),
 * exactly-at-bound, one-over-bound, and a unit-confused oversized value —
 * so "what does this class do with a poisoned value" is pinned once,
 * here, per class.
 */
describe("util/number conformance (#993)", () => {
  test("pageLimit without a ceiling (the sessionListLimit shape)", () => {
    const cases: [number | undefined, number][] = [
      [undefined, 50],
      [Number.NaN, 50],
      [Number.POSITIVE_INFINITY, 50],
      [Number.NEGATIVE_INFINITY, 50],
      [-5, 1],
      [0, 1],
      [0.5, 1],
      [2.9, 2],
      [100, 100],
      [101, 101],
      // Unit-confused oversized passes through: this surface has no ceiling.
      [86_400_000, 86_400_000],
    ]
    for (const [input, expected] of cases) expect(pageLimit(input, { default: 50 })).toBe(expected)
  })

  test("pageLimit with a ceiling (the branchListLimit / KV.scan shape)", () => {
    const cases: [number | undefined, number][] = [
      [undefined, 50],
      [Number.NaN, 50],
      [Number.POSITIVE_INFINITY, 50],
      [Number.NEGATIVE_INFINITY, 50],
      [-5, 1],
      [0, 1],
      [0.5, 1],
      [2.9, 2],
      [100, 100],
      [101, 100],
      [86_400_000, 100],
    ]
    for (const [input, expected] of cases) expect(pageLimit(input, { default: 50, max: 100 })).toBe(expected)
  })

  test("pageOffset", () => {
    const cases: [number | undefined, number][] = [
      [undefined, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
      [-5, 0],
      [0, 0],
      [0.5, 0],
      [2.9, 2],
      [100, 100],
      [101, 101],
      [86_400_000, 86_400_000],
    ]
    for (const [input, expected] of cases) expect(pageOffset(input)).toBe(expected)
  })

  test("boundedCount", () => {
    const cases: [number | undefined, number][] = [
      [undefined, 10],
      [Number.NaN, 10],
      [Number.POSITIVE_INFINITY, 10],
      [Number.NEGATIVE_INFINITY, 10],
      [-5, 1],
      [0, 1],
      [0.5, 1],
      [2.9, 2],
      [100, 100],
      [101, 100],
      [86_400_000, 100],
    ]
    for (const [input, expected] of cases) expect(boundedCount(input, { default: 10, max: 100 })).toBe(expected)
  })

  test("serverSeconds with the fallback oversized policy (the token-lifetime shape)", () => {
    const options = { fallback: 3600, max: 2_592_000, oversized: "fallback" } as const
    const cases: [number | undefined, number][] = [
      [undefined, 3600],
      [Number.NaN, 3600],
      [Number.POSITIVE_INFINITY, 3600],
      [Number.NEGATIVE_INFINITY, 3600],
      [-5, 3600],
      [0, 3600],
      // A positive fractional lifetime is valid and passes through unchanged.
      [0.5, 0.5],
      [2.9, 2.9],
      [2_592_000, 2_592_000],
      [2_592_001, 3600],
      // A lifetime stated in milliseconds is unit-confused oversized.
      [86_400_000, 3600],
    ]
    for (const [input, expected] of cases) expect(serverSeconds(input, options)).toBe(expected)
  })

  test("serverSeconds with the clamp oversized policy (the device-lifetime shape)", () => {
    const options = { fallback: 60, max: 600, oversized: "clamp" } as const
    const cases: [number | undefined, number][] = [
      [undefined, 60],
      [Number.NaN, 60],
      [Number.POSITIVE_INFINITY, 60],
      [Number.NEGATIVE_INFINITY, 60],
      [-5, 60],
      [0, 60],
      [0.5, 0.5],
      [600, 600],
      [601, 600],
      [86_400_000, 600],
    ]
    for (const [input, expected] of cases) expect(serverSeconds(input, options)).toBe(expected)
  })

  test("timeoutMs with the default setTimeout-cliff ceiling", () => {
    const cases: [number | undefined, number][] = [
      [undefined, 5000],
      [Number.NaN, 5000],
      [Number.POSITIVE_INFINITY, 5000],
      [Number.NEGATIVE_INFINITY, 5000],
      [-5, 5000],
      [0, 5000],
      // Sub-millisecond truncates to 0; the timer runtime clamps that to ~1 ms.
      [0.5, 0],
      [2.9, 2],
      [SET_TIMEOUT_MAX_MS, SET_TIMEOUT_MAX_MS],
      [SET_TIMEOUT_MAX_MS + 1, SET_TIMEOUT_MAX_MS],
      // A duration stated in seconds is unit-confused oversized.
      [86_400_000_000, SET_TIMEOUT_MAX_MS],
    ]
    for (const [input, expected] of cases) expect(timeoutMs(input, { fallback: 5000 })).toBe(expected)
  })

  test("timeoutMs with an explicit ceiling", () => {
    expect(timeoutMs(1500.9, { fallback: 5000, max: 10_000 })).toBe(1500)
    expect(timeoutMs(10_000, { fallback: 5000, max: 10_000 })).toBe(10_000)
    expect(timeoutMs(10_001, { fallback: 5000, max: 10_000 })).toBe(10_000)
  })
})
