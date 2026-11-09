import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NativeArch } from "./native-arch"

const X64 = 0x01000007
const ARM64 = 0x0100000c

function thinMacho(cputype: number) {
  const bytes = Buffer.alloc(64)
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(bytes, 0)
  bytes.writeUInt32LE(cputype, 4)
  return bytes
}

function thinElf(machine: number) {
  const bytes = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes, 0)
  bytes[4] = 2 // 64-bit
  bytes[5] = 1 // little-endian
  bytes[6] = 1 // version
  bytes.writeUInt16LE(machine, 18)
  bytes.writeUInt32LE(1, 20)
  return bytes
}

function thinPe(machine: number) {
  const bytes = Buffer.alloc(0x100)
  Buffer.from("MZ", "latin1").copy(bytes, 0)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x4550, 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

function fat(cputypes: ReadonlyArray<number>) {
  const head = 8 + cputypes.length * 20
  const size = 64
  const bytes = Buffer.alloc(head + cputypes.length * size)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(cputypes.length, 4)
  cputypes.forEach((cputype, index) => {
    const entry = 8 + index * 20
    const offset = head + index * size
    bytes.writeUInt32BE(cputype, entry)
    bytes.writeUInt32BE(offset, entry + 8)
    bytes.writeUInt32BE(size, entry + 12)
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(bytes, offset)
    bytes.writeUInt32LE(cputype, offset + 4)
  })
  return bytes
}

function embedded(host: Buffer, inner: Buffer, at: number) {
  const bytes = Buffer.alloc(Math.max(host.length, at + inner.length))
  host.copy(bytes, 0)
  inner.copy(bytes, at)
  return bytes
}

let count = 0
async function fixture(bytes: Buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), "native-arch-"))
  const file = path.join(dir, `fixture-${count++}`)
  await writeFile(file, bytes)
  return file
}

describe("NativeArch.verify", () => {
  test("accepts thin Mach-O, ELF and PE images for their arch", async () => {
    await expect(NativeArch.verify(await fixture(thinMacho(ARM64)), "arm64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(thinMacho(X64)), "x64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(thinElf(183)), "arm64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(thinElf(62)), "x64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(thinPe(0xaa64)), "arm64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(thinPe(0x8664)), "x64")).resolves.toBeUndefined()
  })

  test("rejects thin images for the wrong arch", async () => {
    await expect(NativeArch.verify(await fixture(thinMacho(ARM64)), "x64")).rejects.toThrow("must contain only x64")
    await expect(NativeArch.verify(await fixture(thinMacho(X64)), "arm64")).rejects.toThrow("must contain only arm64")
    await expect(NativeArch.verify(await fixture(thinElf(183)), "x64")).rejects.toThrow("must contain only x64")
    await expect(NativeArch.verify(await fixture(thinPe(0x8664)), "arm64")).rejects.toThrow("must contain only arm64")
  })

  test("rejects an embedded wrong-arch image", async () => {
    const file = await fixture(embedded(thinElf(183), thinMacho(X64), 128))
    await expect(NativeArch.verify(file, "arm64")).rejects.toThrow("must contain only arm64")
    const clean = await fixture(embedded(thinElf(183), thinMacho(ARM64), 128))
    await expect(NativeArch.verify(clean, "arm64")).resolves.toBeUndefined()
  })

  test("rejects a universal x64+arm64 Mach-O for both single-arch gates", async () => {
    const file = await fixture(fat([X64, ARM64]))
    await expect(NativeArch.verify(file, "arm64")).rejects.toThrow("must contain only arm64")
    await expect(NativeArch.verify(file, "x64")).rejects.toThrow("must contain only x64")
  })

  test("accepts a fat image whose slices all map to the target arch", async () => {
    await expect(NativeArch.verify(await fixture(fat([ARM64, ARM64])), "arm64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(fat([X64, X64])), "x64")).resolves.toBeUndefined()
    await expect(NativeArch.verify(await fixture(fat([ARM64, ARM64])), "x64")).rejects.toThrow("must contain only x64")
  })

  test("rejects a non-native file", async () => {
    const file = await fixture(Buffer.from("just some text, not a binary"))
    await expect(NativeArch.verify(file, "arm64")).rejects.toThrow("is not a native executable or library")
  })
})
