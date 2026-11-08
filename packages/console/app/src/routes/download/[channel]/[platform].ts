import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

const prodAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "opencode-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "opencode-desktop-mac-x64.dmg",
  "windows-aarch64-nsis": "opencode-desktop-win-arm64.exe",
  "windows-x64-nsis": "opencode-desktop-win-x64.exe",
  "linux-x64-deb": "opencode-desktop-linux-amd64.deb",
  "linux-x64-appimage": "opencode-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "opencode-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

const betaAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "opencode-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "opencode-desktop-mac-x64.dmg",
  "windows-aarch64-nsis": "opencode-desktop-win-arm64.exe",
  "windows-x64-nsis": "opencode-desktop-win-x64.exe",
  "linux-x64-deb": "opencode-desktop-linux-amd64.deb",
  "linux-x64-appimage": "opencode-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "opencode-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

const UPDATE_FETCH_TIMEOUT_MS = 8_000
// The live release-metadata document is ~6 KB (measured 2026-10-31); 1 MiB
// gives it roughly 170x headroom while still bounding per-request memory.
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024

export async function GET({ params: { platform, channel } }: APIEvent) {
  const assetName = channel === "stable" ? prodAssetNames[platform] : betaAssetNames[platform]
  if (!assetName) return new Response(null, { status: 404 })

  const signal = AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS)
  const release = await fetch(
    `https://opencode.ai/update/api/${channel === "stable" ? "latest" : "beta"}/desktop/opencode`,
    { signal },
  ).catch(() => undefined)
  if (!release) return new Response(null, { status: 502 })
  if (!release.ok) return new Response(null, { status: release.status })
  const location = getAssetUrl(await readReleaseMetadata(release, signal), assetName)
  if (!location) return new Response(null, { status: 502 })
  return Response.redirect(location, 302)
}

/** Stream the metadata body with a hard size cap; an abort cancels the read. */
async function readReleaseMetadata(response: Response, signal: AbortSignal) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RELEASE_METADATA_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_RELEASE_METADATA_BYTES) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

function getAssetUrl(input: unknown, assetName: string) {
  if (!isRecord(input) || !isRecord(input.metadata) || !isRecord(input.metadata.files)) return
  const asset = input.metadata.files[assetName]
  if (!isRecord(asset) || typeof asset.url !== "string") return
  return asset.url
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
