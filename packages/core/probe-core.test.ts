import { describe, expect, test } from "bun:test"
import { Mime } from "./src/mime"
const enc = (s: string) => new TextEncoder().encode(s)
describe("probe core Mime", () => {
  test("shapes", () => {
    console.log("BM-text ->", Mime.detect(enc("BM25 is a ranking function used by search engines.\n")))
    console.log("GIF8-text ->", Mime.detect(enc("GIF89a is the format this document describes.\n")))
    const bmp = new Uint8Array([0x42,0x4d,0x36,0,0,0,0,0,0,0,0x36,0,0,0,0x1a,0,0,0])
    console.log("real-bmp ->", Mime.detect(bmp))
    const h = new Uint8Array(16); h.set([0,0,0,24],0); h.set(enc("ftyp"),4); h.set(enc("heic"),8)
    console.log("heic ->", Mime.detect(h))
    const a = new Uint8Array(16); a.set([0,0,0,24],0); a.set(enc("ftyp"),4); a.set(enc("avif"),8)
    console.log("avif ->", Mime.detect(a))
    const m = new Uint8Array(16); m.set([0,0,0,24],0); m.set(enc("ftyp"),4); m.set(enc("M4A "),8)
    console.log("m4a ->", Mime.detect(m))
    console.log("truncated-utf8 ->", Mime.detect(new Uint8Array([0x61,0xe2,0x82])))
    console.log("text ->", Mime.detect(enc("hello world, plain notes\n")))
    expect(true).toBe(true)
  })
})
