import { deflateRawSync } from "node:zlib"
import { describe, expect, test } from "bun:test"
import { readArchive } from "./archive"
import { ExtensionError } from "./error"

// Regression coverage for #2487: readArchive used to trust the central
// directory's declared entry sizes and check actual bytes only after every
// entry was materialised, so a size-patched archive (declared 1 KiB,
// actually MiB) decompressed without bound. These fixtures assemble zips
// by hand so the declared sizes can lie while CRCs stay honest.

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

type FixtureEntry = { name: string; actual: Uint8Array; declared: number }

function buildZip(entries: FixtureEntry[]) {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const compressed = deflateRawSync(entry.actual)
    const crc = crc32(entry.actual)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(8, 8, true) // deflate
    local.setUint32(14, crc, true)
    local.setUint32(18, compressed.byteLength, true)
    local.setUint32(22, entry.declared, true)
    local.setUint16(26, name.byteLength, true)
    locals.push(new Uint8Array(local.buffer), name, compressed)

    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true)
    central.setUint16(6, 20, true)
    central.setUint16(10, 8, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, compressed.byteLength, true)
    central.setUint32(24, entry.declared, true)
    central.setUint16(28, name.byteLength, true)
    central.setUint32(42, offset, true)
    centrals.push(new Uint8Array(central.buffer), name)

    offset += 30 + name.byteLength + compressed.byteLength
  }

  const centralSize = centrals.reduce((total, part) => total + part.byteLength, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)]
  const zip = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let cursor = 0
  for (const part of parts) {
    zip.set(part, cursor)
    cursor += part.byteLength
  }
  return zip
}

const manifestJson = JSON.stringify({
  schema: "opencode.gui-extension/1",
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  renderer: "payload.js",
  imports: { renderer: [] },
})

function fixture(payloadDeclared: number, payloadActual: Uint8Array, manifestDeclared?: number) {
  const manifest = new TextEncoder().encode(manifestJson)
  return buildZip([
    { name: "manifest.json", actual: manifest, declared: manifestDeclared ?? manifest.byteLength },
    { name: "payload.js", actual: payloadActual, declared: payloadDeclared },
  ])
}

async function rejection(data: Uint8Array) {
  return readArchive(data).then(
    () => {
      throw new Error("readArchive resolved")
    },
    (error: unknown) => error,
  )
}

describe("readArchive actual-bytes bounds (#2487)", () => {
  const payload = new TextEncoder().encode(`/*${"x".repeat(2 * 1024 * 1024)}*/`)

  test("rejects an entry whose actual bytes exceed its declared size, during decompression", async () => {
    const error = await rejection(fixture(1024, payload))
    expect(error).toBeInstanceOf(ExtensionError)
    expect((error as ExtensionError).code).toBe("invalidArchive")
  })

  test("rejects a size-patched manifest on actual bytes, not the declared size", async () => {
    const error = await rejection(fixture(payload.byteLength, payload, 16))
    expect(error).toBeInstanceOf(ExtensionError)
    expect((error as ExtensionError).code).toBe("invalidArchive")
  })

  test("accepts an honest archive with a large entry", async () => {
    const { manifest, files } = await readArchive(fixture(payload.byteLength, payload))
    expect(manifest.id).toBe("fixture")
    expect(files.find((file) => file.path === "payload.js")?.data.byteLength).toBe(payload.byteLength)
  })
})
