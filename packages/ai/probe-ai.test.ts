import { describe, expect, test } from "bun:test"
import { detectMediaType, fileMediaType } from "./src/utils/media-type"
import { sanitizeSurrogates } from "./src/utils/sanitize"
describe("probe ai", () => {
  test("framesync", () => {
    const u16le = new Uint8Array([0xff,0xfe,0x48,0x00,0x65,0x00,0x6c,0x00,0x6c,0x00,0x6f,0x00])
    console.log("utf16le ->", detectMediaType(u16le), "| fileMediaType notes.txt ->", fileMediaType(u16le, "notes.txt"))
    console.log("utf16be ->", detectMediaType(new Uint8Array([0xfe,0xff,0x00,0x48,0x00,0x65])))
    console.log("mp3-control ->", detectMediaType(new Uint8Array([0xff,0xfb,0x90,0x64])))
    expect(true).toBe(true)
  })
  test("sanitize collision", () => {
    const input: Record<string, number> = {}
    Object.defineProperty(input, "\uD800a", { value: 1, enumerable: true })
    Object.defineProperty(input, "\uDC00a", { value: 2, enumerable: true })
    input["\uFFFDa"] = 3
    const out = sanitizeSurrogates(input)
    console.log("keys in:", Object.keys(input).length, "keys out:", Object.keys(out).length, "out:", JSON.stringify(out))
    const ctl = sanitizeSurrogates({ alpha: 1, beta: 2 })
    console.log("control keys:", Object.keys(ctl).length)
    expect(true).toBe(true)
  })
})
