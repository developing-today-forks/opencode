import { createHash } from "node:crypto"

export const BUN_DOWNLOAD_TIMEOUT_MS = 600_000

export async function verifyAndExtractBunArchive(
  data: Uint8Array,
  checksums: string,
  filename: string,
  extract: () => Promise<void>,
) {
  const expected = checksums
    .split("\n")
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Missing checksum for ${filename}`)
  if (createHash("sha256").update(data).digest("hex") !== expected)
    throw new Error(`Checksum mismatch for ${filename}`)
  await extract()
  return expected
}
