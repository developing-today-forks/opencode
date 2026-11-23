import { describe, expect, test } from "bun:test"
import { Mime } from "@opencode/core/mime"

const ftyp = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))

describe("Mime.detect", () => {
  test.each([
    [Uint8Array.of(65), "text/plain"],
    [Uint8Array.of(0xff), "application/octet-stream"],
    [Uint8Array.of(0xe2, 0x82), "text/plain"], // A sample may end inside a UTF-8 character.
  ] as const)("leaves samples without media headers to the text fallback: %j", (bytes, mime) => {
    expect(Mime.detectMedia(bytes)).toBeUndefined()
    expect(Mime.detect(bytes)).toBe(mime)
  })

  test("keeps ordinary text starting with BM as text", () => {
    for (const text of ["BM", "BMW service schedule\n"]) expect(Mime.detect(Buffer.from(text))).toBe("text/plain")
  })

  test("detects Windows and OS/2 bitmaps from a prefix", () => {
    // 1x1, 24-bit bitmaps with a four-byte padded pixel row.
    const windows = "424d3a000000000000003600000028000000010000000100000001001800" + "00".repeat(28)
    const os2 = "424d1e000000000000001a0000000c000000010001000100180000000000"
    for (const hex of [windows, os2]) {
      const bytes = Buffer.from(hex, "hex")
      expect(Mime.detect(bytes)).toBe("image/bmp")
      expect(Mime.detect(bytes.subarray(0, 18))).toBe("image/bmp")
    }
  })

  test("tells ISO-BMFF brands apart", () => {
    expect(Mime.detect(ftyp("000000206674797061766966000000004d695072617669666d6961666d696631"))).toBe("image/avif")
    expect(Mime.detect(ftyp("000000186674797061766973000000006d73663161766973"))).toBe("image/avif")
    expect(Mime.detect(ftyp("00000018667479706d69663100000000617669666d69663100000000"))).toBe("image/avif")
    expect(Mime.detect(ftyp("000000246674797068656963000000006d6966314d6950726d6961664d694842"))).toBe("image/heic")
    expect(Mime.detect(ftyp("00000018667479706d69663100000000686569636d69663100000000"))).toBe("image/heic")
    expect(Mime.detect(ftyp("000000206674797069736f6d0000020069736f6d69736f32617663316d703431"))).toBe("video/mp4")
    expect(Mime.detect(ftyp("00000014667479707174202000000200717420200000000877696465"))).toBe("video/quicktime")
    expect(Mime.detect(ftyp("0000001c667479704d344120000002004d34412069736f6d69736f3200000008"))).toBe("audio/mp4")
  })
})

const ftypBrand = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(4)])

describe("Mime.detect ISO-BMFF brands", () => {
  for (const [brand, mime] of [
    ["avif", "image/avif"],
    ["avis", "image/avif"],
    ["heic", "image/heic"],
    ["heix", "image/heic"],
    // Generic HEIF brands without an AVIF compatible brand are HEIC.
    ["mif1", "image/heic"],
    ["msf1", "image/heic"],
    ["M4A ", "audio/mp4"],
    ["M4B ", "audio/mp4"],
  ] as const) {
    test(`${brand.trim()} maps to ${mime}`, () => {
      expect(Mime.detect(ftypBrand(brand))).toBe(mime)
    })
  }

  test("an unknown ftyp brand is MP4, the container they share", () => {
    expect(Mime.detect(ftypBrand("nope"))).toBe("video/mp4")
  })
})

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

  test("a BMP prefix may be shorter than its declared file size and pixel offset", () => {
    const bytes = new Uint8Array(256 * 1024)
    const view = new DataView(bytes.buffer)
    bytes.set([0x42, 0x4d], 0)
    view.setUint32(2, 300 * 1024, true)
    view.setUint32(10, 270 * 1024, true)
    view.setUint32(14, 40, true)

    expect(Mime.detect(bytes)).toBe("image/bmp")
  })

  test("a BMP whose declared file size is smaller than the available bytes is rejected", () => {
    const bytes = bmp()
    new DataView(bytes.buffer).setUint32(2, bytes.length - 1, true)

    expect(Mime.detect(bytes)).not.toBe("image/bmp")
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
