import { describe, expect, test } from "bun:test"
import { Mime } from "../src/mime"

const text = (value: string) => new TextEncoder().encode(value)

// A structurally plausible BMP: 54-byte BITMAPINFOHEADER file (DIB 40) plus 4 pixel bytes.
const bmp = () => {
  const bytes = new Uint8Array(58)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d], 0) // "BM"
  view.setUint32(2, bytes.length, true) // file size field is exact
  view.setUint32(10, 54, true) // pixel data starts after 14 + 40 header bytes
  view.setUint32(14, 40, true) // DIB header size
  view.setInt32(18, 1, true) // width
  view.setInt32(22, 1, true) // height
  return bytes
}

// The classic 1x1 transparent GIF89a.
const gif = () => Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0))

describe("Mime.detect (#2149)", () => {
  test("plain text starting with BM is text, not a bitmap", () => {
    expect(Mime.detect(text("BM25 is a ranking function used by search engines."))).toBe("text/plain")
    expect(Mime.detect(text("BM"))).toBe("text/plain")
  })

  test("a structurally plausible BMP header is image/bmp", () => {
    expect(Mime.detect(bmp())).toBe("image/bmp")
  })

  test("a BM header with non-zero reserved bytes is not a bitmap", () => {
    const bytes = bmp()
    bytes[6] = 1
    expect(Mime.detect(bytes)).not.toBe("image/bmp")
  })

  test("plain text starting with GIF8 is text, not a GIF", () => {
    expect(Mime.detect(text("GIF89a is the format this document describes."))).toBe("text/plain")
    expect(Mime.detect(text("GIF87a and other things in prose"))).toBe("text/plain")
    expect(Mime.detect(text("GIF8"))).toBe("text/plain")
  })

  test("a real binary GIF is image/gif", () => {
    expect(Mime.detect(gif())).toBe("image/gif")
  })

  test("other signatures and plain text are unchanged", () => {
    expect(Mime.detect(text("just some plain text"))).toBe("text/plain")
    expect(Mime.detect(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png")
  })
})
