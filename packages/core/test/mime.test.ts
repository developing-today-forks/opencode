import { describe, expect, test } from "bun:test"
import { Mime } from "@opencode/core/mime"

const ftyp = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(4)])

describe("Mime.detect ISO-BMFF brands", () => {
  for (const [brand, mime] of [
    ["avif", "image/avif"],
    ["avis", "image/avif"],
    ["heic", "image/heic"],
    ["heix", "image/heic"],
    ["mif1", "image/heif"],
    ["msf1", "image/heif"],
    ["M4A ", "audio/mp4"],
    ["M4B ", "audio/mp4"],
  ]) {
    test(`${brand.trim()} maps to ${mime}`, () => {
      expect(Mime.detect(ftyp(brand))).toBe(mime)
    })
  }

  test("retains the binary fallback for an unknown ftyp brand", () => {
    expect(Mime.detect(ftyp("nope"))).toBe("application/octet-stream")
  })
})
