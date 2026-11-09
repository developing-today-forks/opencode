import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeArch } from "./native-arch"

/**
 * `NativeArch.verify` is a release gate: a shipped image must contain only code for the arch being
 * packaged. These fixtures are the smallest headers each parser accepts, so a change to a magic, an
 * offset, or the arch table fails here first. The universal (fat) cases pin #2211: a fat x64+arm64
 * image carries arm64 code and must not pass the x64 gate (nor the reverse), while a fat image whose
 * every slice is the target arch carries only that arch and is accepted.
 */

const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 } as const
const ELF_MACHINE = { x64: 62, arm64: 183 } as const
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c } as const

const pe = (arch: "x64" | "arm64") => {
  const bytes = Buffer.alloc(0x200)
  bytes.write("MZ", 0, "latin1")
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x4550, 0x80)
  bytes.writeUInt16LE(PE_MACHINE[arch], 0x84)
  return bytes
}

const elf = (arch: "x64" | "arm64") => {
  const bytes = Buffer.alloc(0x40)
  bytes.write("\x7fELF", 0, "latin1")
  bytes[4] = 2
  bytes[5] = 1
  bytes[6] = 1
  bytes.writeUInt16LE(ELF_MACHINE[arch], 18)
  bytes.writeUInt32LE(1, 20)
  return bytes
}

const macho = (arch: "x64" | "arm64") => {
  const bytes = Buffer.alloc(0x40)
  bytes.write("\xcf\xfa\xed\xfe", 0, "latin1")
  bytes.writeUInt32LE(MACHO_CPU[arch], 4)
  return bytes
}

const fat = (arches: readonly ("x64" | "arm64")[]) => {
  const bytes = Buffer.alloc(0x100)
  bytes.write("\xca\xfe\xba\xbe", 0, "latin1")
  bytes.writeUInt32BE(arches.length, 4)
  arches.forEach((arch, index) => {
    const slice = 8 + index * 20
    bytes.writeUInt32BE(MACHO_CPU[arch], slice)
    bytes.writeUInt32BE(arch === "x64" ? 3 : 0, slice + 4)
    bytes.writeUInt32BE(0x40 + index * 0x20, slice + 8)
    bytes.writeUInt32BE(0x20, slice + 12)
  })
  return bytes
}

const dirs: string[] = []

const fixture = (bytes: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), "native-arch-"))
  dirs.push(dir)
  const file = join(dir, "image")
  writeFileSync(file, bytes)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const message = async (file: string, arch: "x64" | "arm64") =>
  await NativeArch.verify(file, arch).then(
    () => undefined,
    (error: Error) => error.message,
  )

describe("NativeArch.verify thin images", () => {
  test("a thin image for the target arch is accepted", async () => {
    for (const arch of ["x64", "arm64"] as const) {
      for (const bytes of [pe(arch), elf(arch), macho(arch)]) {
        expect(await NativeArch.verify(fixture(bytes), arch)).toBeUndefined()
      }
    }
  })

  test("a thin image for the other arch is rejected in both directions", async () => {
    for (const [target, other] of [["x64", "arm64"], ["arm64", "x64"]] as const) {
      for (const bytes of [pe(other), elf(other), macho(other)]) {
        const error = await message(fixture(bytes), target)
        expect(error).toContain(`must contain only ${target} code`)
      }
    }
  })

  test("a file that does not start with a native image is rejected", async () => {
    const file = fixture(Buffer.from("#!/bin/sh\n"))
    expect(await message(file, "x64")).toBe(`${file} is not a native executable or library`)
  })
})

describe("NativeArch.verify embedded and universal images (#2211)", () => {
  test("a thin image with an embedded wrong-arch image is rejected", async () => {
    const bytes = Buffer.concat([pe("x64"), macho("arm64")])
    const error = await message(fixture(bytes), "x64")
    expect(error).toContain("must contain only x64 code")
    expect(error).toContain("Mach-O arm64 at byte 512")
  })

  test("a universal x64+arm64 image is rejected for both single-arch gates", async () => {
    for (const arch of ["x64", "arm64"] as const) {
      const error = await message(fixture(fat(["x64", "arm64"])), arch)
      expect(error).toContain(`must contain only ${arch} code`)
      expect(error).toContain("Mach-O x64+arm64 at byte 0")
    }
  })

  test("a universal image whose slices are all the target arch is accepted", async () => {
    expect(await NativeArch.verify(fixture(fat(["arm64", "arm64"])), "arm64")).toBeUndefined()
    expect(await NativeArch.verify(fixture(fat(["x64"])), "x64")).toBeUndefined()
  })
})
