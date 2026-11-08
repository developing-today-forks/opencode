import { query } from "@solidjs/router"
import { config } from "~/config"

const GITHUB_FETCH_TIMEOUT_MS = 8_000
// The repo metadata document is ~7 KB (measured 2026-10-31); 1 MiB bounds it
// with wide headroom.
const GITHUB_META_MAX_BYTES = 1024 * 1024
// The releases page (30 releases with full markdown bodies) is ~2.1 MB
// (measured 2026-10-31); 8 MiB gives that roughly fourfold headroom.
const GITHUB_RELEASES_MAX_BYTES = 8 * 1024 * 1024

/** Stream a response body with a hard size cap and parse it as JSON. */
async function readCappedJson(response: Response, signal: AbortSignal, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
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
      if (size > maxBytes) {
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export const github = query(async () => {
  "use server"
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  }
  const apiBaseUrl = config.github.repoUrl.replace("https://github.com/", "https://api.github.com/repos/")
  const signal = AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS)
  try {
    const [meta, releases, contributors] = await Promise.all([
      fetch(apiBaseUrl, { headers, signal }).then((res) => readCappedJson(res, signal, GITHUB_META_MAX_BYTES)),
      fetch(`${apiBaseUrl}/releases`, { headers, signal }).then((res) =>
        readCappedJson(res, signal, GITHUB_RELEASES_MAX_BYTES),
      ),
      fetch(`${apiBaseUrl}/contributors?per_page=1`, { headers, signal }),
    ])
    if (!isRecord(meta) || !Array.isArray(releases) || releases.length === 0) {
      return undefined
    }
    const [release] = releases
    const linkHeader = contributors.headers.get("Link")
    const contributorCount = linkHeader
      ? Number.parseInt(linkHeader.match(/&page=(\d+)>; rel="last"/)?.at(1) ?? "0")
      : 0
    return {
      stars: typeof meta.stargazers_count === "number" ? meta.stargazers_count : undefined,
      release: {
        name: release.name,
        url: release.html_url,
        tag_name: release.tag_name,
      },
      contributors: contributorCount,
    }
  } catch (e) {
    console.error(e)
  }
  return undefined
}, "github")
