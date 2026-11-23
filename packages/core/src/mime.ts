export * as Mime from "./mime.js"

export function detect(bytes: Uint8Array) {
  return detectMedia(bytes) ?? (isText(bytes) ? "text/plain" : "application/octet-stream")
}

export function detectMedia(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (isGif(bytes)) return "image/gif"
  if (isBmp(bytes)) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    // AVIF, HEIC, QuickTime and M4A share MP4's container; the major brand tells them apart, and generic HEIF brands
    // list `avif`/`avis` among the compatible brands that follow the minor version.
    const brand = ascii(bytes, 8, 12)
    const boxEnd = Math.min(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), bytes.length)
    const compatible = Array.from({ length: Math.floor((boxEnd - 16) / 4) }, (_, index) =>
      ascii(bytes, 16 + index * 4, 20 + index * 4),
    )
    const generic = brand === "mif1" || brand === "msf1"
    if (
      brand === "avif" ||
      brand === "avis" ||
      (generic && (compatible.includes("avif") || compatible.includes("avis")))
    )
      return "image/avif"
    if (generic || ["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic"
    if (brand === "qt  ") return "video/quicktime"
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4"
    return "video/mp4"
  }
  return undefined
}

export const isTextual = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

const u16le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8)
const u32le = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0

// Windows and OS/2 DIB header sizes.
const DIB_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124])

// A bare "BM" prefix is prose ("BM25 is a ranking function..."), not a bitmap (#2149). A real BMP carries a
// structurally plausible header: reserved fields zero, a known DIB header size, a pixel-data offset at or past
// the headers and within the declared file, and a file-size field that is unset or at least the available bytes.
// `detect` is also called on a prefix by the read tool, so these checks need only the 18-byte file and DIB size
// headers, not the whole file.
function isBmp(bytes: Uint8Array) {
  if (!startsWith(bytes, [0x42, 0x4d])) return false
  if (bytes.length < 18) return false
  if (u16le(bytes, 6) !== 0 || u16le(bytes, 8) !== 0) return false
  const dib = u32le(bytes, 14)
  if (!DIB_SIZES.has(dib)) return false
  const pixelOffset = u32le(bytes, 10)
  const fileSize = u32le(bytes, 2)
  if (pixelOffset < 14 + dib) return false
  if (fileSize === 0) return pixelOffset <= bytes.length
  if (pixelOffset > fileSize) return false
  return fileSize >= bytes.length
}

// A bare "GIF8" prefix is prose too (#2149). A real GIF carries the full 6-byte version header, a complete
// logical screen descriptor with non-zero dimensions, room for the global color table when one is flagged, and
// binary image data — text that passes isText() is prose describing GIFs, never a GIF.
function isGif(bytes: Uint8Array) {
  if (!startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) && !startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))
    return false
  if (bytes.length < 13) return false
  if (u16le(bytes, 6) === 0 || u16le(bytes, 8) === 0) return false
  const packed = bytes[10]
  if (packed & 0x80) {
    const tableBytes = 3 * 2 ** ((packed & 0x07) + 1)
    if (bytes.length < 13 + tableBytes) return false
  }
  return !isText(bytes)
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  return controls / bytes.length <= 0.3
}
