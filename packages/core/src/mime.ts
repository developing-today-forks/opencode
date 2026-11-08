export * as Mime from "./mime.js"

const FTYP_BRANDS: Readonly<Record<string, string>> = {
  "M4A ": "audio/mp4",
  "M4B ": "audio/mp4",
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heix: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
}

export function detect(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  if (bytes.length >= 12 && startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12))
    if (Object.hasOwn(FTYP_BRANDS, brand)) return FTYP_BRANDS[brand]
  }
  return isText(bytes) ? "text/plain" : "application/octet-stream"
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
