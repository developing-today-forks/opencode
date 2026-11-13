import { describe, expect, test } from "bun:test"
import { Identifier } from "../src/identifier.js"

// The wrap boundary that broke ordering on 2026-08-14 (#561): the old
// 48-bit prefix discarded every bit at or above 2^36 ms of timestamp.
const boundary = 26 * 2 ** 36

describe("Identifier", () => {
  test("ascending IDs order across the 2^36 ms wrap boundary", () => {
    const yearBeforeBoundary = Identifier.create(false, boundary - 365 * 24 * 60 * 60 * 1000)
    const justBefore = Identifier.create(false, boundary - 1000)
    const justAfter = Identifier.create(false, boundary + 1000)
    expect(justBefore < justAfter).toBe(true)
    expect(yearBeforeBoundary < justAfter).toBe(true)
  })

  test("descending IDs order across the 2^36 ms wrap boundary", () => {
    const justBefore = Identifier.create(true, boundary - 1000)
    const justAfter = Identifier.create(true, boundary + 1000)
    expect(justBefore > justAfter).toBe(true)
  })

  test("IDs stay ordered for far-future timestamps", () => {
    const before = Identifier.create(false, 2 ** 43 - 1000)
    const after = Identifier.create(false, 2 ** 43 + 1000)
    expect(before < after).toBe(true)
  })

  test("more than 4096 IDs in one millisecond stay strictly increasing", () => {
    const timestamp = 2 ** 43 + 60_000
    let previous = Identifier.create(false, timestamp)
    for (let index = 1; index < 5000; index++) {
      const id = Identifier.create(false, timestamp)
      expect(id > previous).toBe(true)
      previous = id
    }
  })

  test("IDs are 26 chars: 14 hex prefix chars and a 12-char suffix", () => {
    for (const id of [Identifier.ascending(), Identifier.descending()]) {
      expect(id).toHaveLength(26)
      expect(id).toMatch(/^[0-9a-f]{14}[0-9A-Za-z]{12}$/)
    }
  })
})
