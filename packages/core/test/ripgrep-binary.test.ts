import { describe, expect, test } from "bun:test"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"

// The integrity gate for the downloaded ripgrep archive (#1137). These
// tests exercise the pure digest seam only: no network, no ambient rg
// (packages/core/test/ripgrep.test.ts skips without one; this suite
// must not).

const encode = (text: string) => new TextEncoder().encode(text)

describe("RipgrepBinary archive integrity (#1137)", () => {
  test("sha256Hex matches the known sha256 of 'hello world'", () => {
    expect(RipgrepBinary.sha256Hex(encode("hello world"))).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    )
  })

  test("verifyArchive accepts a body matching the pinned digest", () => {
    const body = encode("release archive bytes")
    expect(RipgrepBinary.verifyArchive(body, RipgrepBinary.sha256Hex(body))).toBe(true)
  })

  test("verifyArchive rejects a tampered body", () => {
    const body = encode("release archive bytes")
    const digest = RipgrepBinary.sha256Hex(body)
    expect(RipgrepBinary.verifyArchive(encode("release archive bytez"), digest)).toBe(false)
  })

  test("verifyArchive rejects a body checked against another platform's pin", () => {
    const pins = Object.values(RipgrepBinary.PLATFORM).map((entry) => entry.sha256)
    const body = encode("some archive")
    for (const pin of pins) expect(RipgrepBinary.verifyArchive(body, pin)).toBe(false)
  })

  test("every PLATFORM entry pins a 64-hex sha256, and the pin set is the upstream 15.1.0 set", () => {
    const pins = Object.values(RipgrepBinary.PLATFORM).map((entry) => entry.sha256)
    expect(pins).toHaveLength(7)
    for (const pin of pins) expect(pin).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(pins)).toEqual(
      new Set([
        "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
        "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
        "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
        "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
        "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
        "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
        "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
      ]),
    )
  })
})
