const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

/** ISO-BMFF ftyp major brands this sniffer claims, by the media type the brand actually denotes. */
const FTYP_BRANDS: Readonly<Record<string, string>> = {
  "M4A ": "audio/mp4",
  "M4B ": "audio/mp4",
  "M4P ": "audio/mp4",
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heix: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  isom: "video/mp4",
  iso2: "video/mp4",
  iso5: "video/mp4",
  iso6: "video/mp4",
  mp41: "video/mp4",
  mp42: "video/mp4",
  avc1: "video/mp4",
  dash: "video/mp4",
  "M4V ": "video/mp4",
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>) =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value)

/**
 * Sniff a media type from leading magic bytes. Covers the containers media routes commonly return; anything else is
 * `undefined` so callers can fall back to a provider-declared type or `application/octet-stream`.
 */
export const detectMediaType = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF") {
    const riffType = ascii(bytes, 8, 12)
    if (riffType === "WEBP") return "image/webp"
    if (riffType === "WAVE") return "audio/wav"
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    // ISO-BMFF is a family, not a type: the major brand (bytes 8-12) names the actual container - an M4A audiobook
    // and an AVIF image both open with ftyp. An unrecognized brand falls through to undefined rather than claiming
    // video/mp4 for a file that may be neither audio nor video (#2127).
    const brand = ascii(bytes, 8, 12)
    if (Object.hasOwn(FTYP_BRANDS, brand)) return FTYP_BRANDS[brand as keyof typeof FTYP_BRANDS]
    return undefined
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg"
  // UTF-16 text opens with a BOM whose bytes mimic an MPEG frame sync (FF FE: sync bits set, layer bits 11), so
  // a UTF-16LE text file would otherwise sniff as audio/mpeg and override its extension (#2151). BOM-prefixed
  // content is text, never framed audio: exclude both BOMs before the frame-sync test.
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return undefined
  // An 11-bit frame sync; layer bits `00` mark AAC ADTS, any other layer is MPEG audio.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    return (bytes[1] & 0x06) === 0 ? "audio/aac" : "audio/mpeg"
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg"
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac"
  return undefined
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
}

const extensionMediaType = (path: string): string | undefined => {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined
}

/** Media type of a file's contents: sniffed magic bytes, then the path's extension. */
export const fileMediaType = (bytes: Uint8Array, path: string) => detectMediaType(bytes) ?? extensionMediaType(path)

const EXTENSION_ALIASES: Readonly<Record<string, string>> = {
  "audio/mp3": "mp3",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/x-flac": "flac",
}

export const mediaTypeExtension = (mediaType: string): string | undefined => {
  const type = mediaType.split(";", 1)[0].trim().toLowerCase()
  return (
    (Object.hasOwn(EXTENSION_ALIASES, type) ? EXTENSION_ALIASES[type] : undefined) ??
    Object.entries(EXTENSIONS).find(([, known]) => known === type)?.[0]
  )
}
