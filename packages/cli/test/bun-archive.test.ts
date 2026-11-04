import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { verifyAndExtractBunArchive } from "../script/bun-archive"

const filename = "bun-linux-x64.zip"
const data = new TextEncoder().encode("verified Bun archive")
const checksum = createHash("sha256").update(data).digest("hex")

test("extracts an archive only after its SHA256 entry matches", async () => {
  let extracted = false
  expect(
    await verifyAndExtractBunArchive(data, `${checksum}  ${filename}\n`, filename, async () => {
      extracted = true
    }),
  ).toBe(checksum)
  expect(extracted).toBe(true)
})

test("rejects a tampered archive before extraction", async () => {
  let extracted = false
  await expect(
    verifyAndExtractBunArchive(new TextEncoder().encode("tampered archive"), `${checksum}  ${filename}\n`, filename, async () => {
      extracted = true
    }),
  ).rejects.toThrow(`Checksum mismatch for ${filename}`)
  expect(extracted).toBe(false)
})

test("fails closed when the checksum entry is missing", async () => {
  let extracted = false
  await expect(
    verifyAndExtractBunArchive(data, `${checksum}  bun-windows-x64.zip\n`, filename, async () => {
      extracted = true
    }),
  ).rejects.toThrow(`Missing checksum for ${filename}`)
  expect(extracted).toBe(false)
})
